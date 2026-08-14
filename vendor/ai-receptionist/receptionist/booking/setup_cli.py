from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

from receptionist.runtime import app_config_path, ensure_app_runtime, runtime_root


logger = logging.getLogger("receptionist")

SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/gmail.send",
]
EMBEDDED_OAUTH_ENV = "RECEPTIONIST_EMBEDDED_OAUTH_CLIENT"


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m receptionist.booking",
        description="Google Calendar and Gmail setup utilities for AIReceptionist.",
    )
    setup = parser.add_subparsers(dest="command", required=True).add_parser(
        "setup",
        help="Connect the single application Google account.",
    )
    setup.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    _configure_logging(getattr(args, "verbose", False))
    if args.command != "setup":
        parser.error(f"Unknown command: {args.command}")
    return _run_setup()


def _run_setup() -> int:
    ensure_app_runtime()
    config_path = app_config_path()
    if not config_path.exists():
        print(f"Application config not found: {config_path}", file=sys.stderr)
        return 2

    secrets_dir = runtime_root() / "secrets"
    secrets_dir.mkdir(parents=True, exist_ok=True)
    client_file = secrets_dir / "google-calendar-oauth-client.json"
    token_file = secrets_dir / "google-oauth.json"

    embedded_client = os.getenv(EMBEDDED_OAUTH_ENV, "").strip()
    if embedded_client and Path(embedded_client).exists():
        shutil.copyfile(embedded_client, client_file)
        print(f"Synced OAuth client JSON from bundled resource: {embedded_client}")

    if not client_file.exists():
        print(
            f"OAuth client JSON not found at {client_file}. "
            "Create a Google Desktop OAuth client and connect again.",
            file=sys.stderr,
        )
        return 2

    try:
        raw = json.loads(client_file.read_text(encoding="utf-8"))
        installed = raw.get("installed") if isinstance(raw, dict) else None
        client_id = (installed or {}).get("client_id", "")
        if not client_id or not (installed or {}).get("client_secret"):
            raise ValueError("missing client_id/client_secret")
        if "REPLACE_IN_CI" in client_id:
            raise ValueError("placeholder client ID; replace config/secrets/google-calendar-oauth-client.json with a downloaded Google Desktop OAuth client JSON")
    except Exception as exc:
        print(f"OAuth client JSON is invalid at {client_file}: {exc}", file=sys.stderr)
        return 2

    print("Starting Google connection...")
    print("A browser window will open. Sign in with the Google account used by the receptionist.")
    flow = InstalledAppFlow.from_client_secrets_file(str(client_file), SCOPES)
    creds = flow.run_local_server(port=0)
    token_file.write_text(creds.to_json(), encoding="utf-8")
    _set_0600(token_file)
    print(f"[OK] Google credentials saved to {token_file}")
    return 0


def _set_0600(path: Path) -> None:
    if sys.platform != "win32":
        import stat
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


if __name__ == "__main__":
    sys.exit(main())
