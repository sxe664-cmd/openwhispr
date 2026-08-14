"""Read-only deployment readiness checks for the desktop console."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import asdict, dataclass
from typing import Any

import httpx
from dotenv import load_dotenv
from livekit import api
from livekit.protocol import sip

from receptionist.config import load_app_config


@dataclass(frozen=True)
class CheckResult:
    state: str
    detail: str


def _result(state: str, detail: str) -> dict[str, str]:
    return asdict(CheckResult(state=state, detail=detail))


def _safe_error(error: Exception) -> str:
    message = str(error).replace("\n", " ").replace("\r", " ").strip()
    return message[:300] or "The provider could not be verified."


def _agent_name() -> str:
    return os.environ.get("RECEPTIONIST_AGENT_NAME", "receptionist")


async def _check_livekit(config) -> tuple[dict[str, str], dict[str, str]]:
    telephony = config.telephony
    if not telephony.enabled:
        disabled = _result("unconfigured", "Add and enable the telephony block in config/app.yaml.")
        return disabled, disabled
    try:
        client = api.LiveKitAPI()
        try:
            trunks = await client.sip.list_sip_inbound_trunk(sip.ListSIPInboundTrunkRequest())
            rules = await client.sip.list_sip_dispatch_rule(sip.ListSIPDispatchRuleRequest())
        finally:
            await client.aclose()
    except Exception as exc:
        failure = _result("error", f"LiveKit read-only check failed: {_safe_error(exc)}")
        return failure, failure

    trunk = next((item for item in trunks.items if getattr(item, "sip_trunk_id", "") == telephony.livekit_inbound_trunk_id), None)
    if trunk is None:
        trunk_result = _result("error", "Configured LiveKit inbound trunk was not found.")
    else:
        numbers = set(getattr(trunk, "numbers", []) or [])
        trunk_result = _result("ready" if telephony.inbound_number in numbers else "error", "Inbound trunk matches the expected DID." if telephony.inbound_number in numbers else "Inbound trunk does not list the expected DID.")

    rule = next((item for item in rules.items if getattr(item, "sip_dispatch_rule_id", "") == telephony.livekit_dispatch_rule_id), None)
    if rule is None:
        return trunk_result, _result("error", "Configured LiveKit dispatch rule was not found.")
    rule_trunks = set(getattr(rule, "trunk_ids", []) or [])
    room_config = getattr(rule, "room_config", None)
    agents = getattr(room_config, "agents", []) if room_config else []
    agent_names = {getattr(item, "agent_name", "") for item in agents}
    valid = telephony.livekit_inbound_trunk_id in rule_trunks and _agent_name() in agent_names
    return trunk_result, _result("ready" if valid else "error", "Dispatch rule targets the configured worker and inbound trunk." if valid else "Dispatch rule must target the configured worker and inbound trunk.")


async def _check_twilio(config) -> dict[str, str]:
    telephony = config.telephony
    if not telephony.enabled:
        return _result("unconfigured", "Enable telephony readiness before checking Twilio.")
    sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
    token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
    if not sid or not token:
        return _result("unconfigured", "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN for read-only verification.")
    try:
        async with httpx.AsyncClient(auth=(sid, token), timeout=10.0) as client:
            numbers = await client.get(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/IncomingPhoneNumbers.json", params={"PhoneNumber": telephony.inbound_number})
            numbers.raise_for_status()
            records = numbers.json().get("incoming_phone_numbers", [])
            if not records:
                return _result("error", "Twilio could not find the configured inbound DID.")
            trunk_sid = records[0].get("trunk_sid")
            if not trunk_sid:
                return _result("error", "The Twilio DID is not assigned to an Elastic SIP Trunk.")
            origins = await client.get(f"https://trunking.twilio.com/v1/Trunks/{trunk_sid}/OriginationUrls")
            origins.raise_for_status()
            uris = {str(item.get("sip_url", "")).rstrip("/") for item in origins.json().get("origination_urls", [])}
    except Exception as exc:
        return _result("error", f"Twilio read-only check failed: {_safe_error(exc)}")
    expected = telephony.livekit_sip_uri.rstrip("/")
    return _result("ready" if expected in uris else "error", "Twilio DID is assigned to a trunk with the expected LiveKit origination URI." if expected in uris else "Twilio trunk does not contain the configured LiveKit origination URI.")


async def readiness() -> dict[str, Any]:
    config = load_app_config()
    livekit_trunk, livekit_dispatch = await _check_livekit(config)
    return {"telephony": {"enabled": config.telephony.enabled, "inbound_number": config.telephony.inbound_number}, "livekit_trunk": livekit_trunk, "livekit_dispatch": livekit_dispatch, "twilio": await _check_twilio(config)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only AIReceptionist routing readiness check")
    parser.add_argument("command", choices=["readiness"], nargs="?", default="readiness")
    parser.parse_args(argv)
    load_dotenv(".env.local")
    load_dotenv(".env")
    print(json.dumps(asyncio.run(readiness()), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
