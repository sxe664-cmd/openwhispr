# receptionist/config.py
from __future__ import annotations

import ipaddress
import logging
import os
import re
from string import Formatter
from pathlib import Path
from typing import Annotated, Literal, Union
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger("receptionist")

DEFAULT_GOOGLE_REVIEW_URL = (
    "https://www.google.com/search?q=hira+restorative+wellness+center+boca+raton+reviews"
    "&rlz=1C1VDKB_enUS1102US1102&oq=hira+res&gs_lcrp=EgZjaHJvbWUqBggBECMYJzIGCAAQRRg5"
    "MgYIARAjGCcyBggCECMYJzIQCAMQLhivARjHARiABBiOBTIHCAQQABiABDIHCAUQABiABDIGCAYQRRg8"
    "MgYIBxBFGD3SAQgzNzExajBqN6gCALACAA&sourceid=chrome&source=chrome.ob&ie=UTF-8"
    "#lrd=0x88d91b27bb8fd007:0xbe531cb4ca72f018,3,,,,"
)


def _has_https_url(value: str | None) -> bool:
    for candidate in re.findall(r"https://[^\s<>\"]+", value or ""):
        parsed = urlparse(candidate.rstrip(".,)"))
        if parsed.scheme == "https" and parsed.netloc:
            return True
    return False


def _expand_path(path_str: str) -> Path:
    return Path(path_str).expanduser()


class ConfigError(Exception):
    """Raised when a business config YAML can't be parsed or doesn't validate.

    Wraps both yaml.YAMLError (parse-time) and pydantic.ValidationError
    (schema-time) so callers don't need to catch both.
    """


# ---------------------------------------------------------------------------
# Existing unchanged-ish models
# ---------------------------------------------------------------------------

class BusinessInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    type: str
    timezone: str

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except ZoneInfoNotFoundError as e:
            raise ValueError(f"Invalid IANA timezone: {v!r}") from e
        return v


class APIKeyVoiceAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["api_key"]
    env: str = "OPENAI_API_KEY"


class CodexOAuthVoiceAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["oauth_codex"]
    path: str = "~/.codex/auth.json"


class StaticOAuthVoiceAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["oauth_static"]
    token: str | None = None
    token_env: str | None = None

    @model_validator(mode="after")
    def validate_single_token_source(self) -> StaticOAuthVoiceAuth:
        if bool(self.token) == bool(self.token_env):
            raise ValueError("oauth_static auth requires exactly one of token or token_env")
        return self


VoiceAuth = Annotated[
    Union[APIKeyVoiceAuth, CodexOAuthVoiceAuth, StaticOAuthVoiceAuth],
    Field(discriminator="type"),
]


class VoiceIdleConfig(BaseModel):
    """Issue #11 safety nets: silence timeout, max-duration cap, and
    unproductive-turn ceiling. Defaults are conservative so existing YAMLs
    remain backward-compatible: silence hangup is on (15s away + 30s grace =
    45s total caller silence before the agent says goodbye), max duration
    is OFF, and the unproductive-turn ceiling is 5 consecutive replies that
    look like the agent is stuck.
    """
    model_config = ConfigDict(extra="forbid")

    # ---- Silence hangup --------------------------------------------------
    silence_hangup_enabled: bool = True
    """Master switch for the silence-timeout path. When False, the agent
    never hangs up just because the caller stopped talking. The
    `away_seconds` value is still applied to LiveKit's `user_state` so
    other downstream consumers (analytics, dashboards) keep working."""

    away_seconds: float = Field(default=15.0, gt=0)
    """How long of silence flips LiveKit's `user_state` to `away`. Maps
    one-to-one to `AgentSession.user_away_timeout`. Below this, the caller
    is just thinking; above, they may have walked away from the phone."""

    silence_grace_seconds: float = Field(default=30.0, ge=0)
    """How long the agent waits after `user_state` becomes `away` before
    triggering the silence-timeout hangup. Set to 0 to hang up immediately
    on `away` (aggressive). Default 30s gives a long pause for callers who
    are looking up information or muting their phone."""

    # ---- Max call duration ----------------------------------------------
    max_call_duration_seconds: int | None = Field(default=None, gt=0)
    """Optional ceiling on the total call duration. None disables the cap
    entirely (default - preserve original behavior). Set to e.g. 900 to
    cap calls at 15 minutes; the agent will say goodbye and disconnect
    when the cap is reached."""

    # ---- Wall-clock silence fallback ------------------------------------
    absolute_silence_seconds: int | None = Field(default=None, gt=0)
    """Optional wall-clock silence fallback. None disables the fallback
    (default - preserve original behavior). Set to e.g. 120 to hang up when
    no final user transcript arrives for two minutes, even if SIP comfort
    noise keeps LiveKit's user_state from becoming away."""

    # ---- Unproductive turn ceiling --------------------------------------
    unproductive_hangup_enabled: bool = True
    """Master switch for the unproductive-turn safety net."""

    unproductive_turn_threshold: int = Field(default=5, gt=0)
    """How many consecutive `unproductive` agent replies trigger a hangup.
    A reply is considered unproductive if (a) the agent did NOT invoke any
    function tool that turn AND (b) the reply text matches one of the
    `unproductive_phrases` substrings (case-insensitive). Productive turns
    (any function tool call OR a substantive reply) reset the counter to 0.
    """

    unproductive_phrases: list[str] = Field(
        default_factory=lambda: [
            "i'm here to help",
            "i'm here to assist",
            "could you rephrase",
            "could you clarify",
            "i didn't quite catch",
            "i don't have specific information",
            "i'm not able to help with that",
            "i'm not sure i understand",
            "if you have a specific question",
        ]
    )
    """Substrings that signal the agent is stuck. Tunable per business so a
    plain-English clinic and a niche legal-research firm can adjust the
    deflection vocabulary. Matched case-insensitively against the agent's
    spoken reply."""


class VoiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voice_id: str = "marin"
    model: str = "gpt-realtime-1.5"
    auth: VoiceAuth | None = None
    idle: VoiceIdleConfig = Field(default_factory=VoiceIdleConfig)


class DayHours(BaseModel):
    model_config = ConfigDict(extra="forbid")

    open: str
    close: str

    @field_validator("open", "close")
    @classmethod
    def validate_time_format(cls, v: str) -> str:
        if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", v):
            raise ValueError(f"Time must be in HH:MM 24-hour format, got: {v!r}")
        return v


class WeeklyHours(BaseModel):
    model_config = ConfigDict(extra="forbid")

    monday: DayHours | None = None
    tuesday: DayHours | None = None
    wednesday: DayHours | None = None
    thursday: DayHours | None = None
    friday: DayHours | None = None
    saturday: DayHours | None = None
    sunday: DayHours | None = None

    @field_validator("*", mode="before")
    @classmethod
    def parse_closed(cls, v):
        if v == "closed":
            return None
        return v


class CommunicationsConfig(BaseModel):
    """Operator-editable defaults for outward-facing communication identity.

    Put common values here so a demo/prod switch or phone-number change does
    not require editing routing entries, email sender blocks, and Twilio SMS
    blocks in three different places.
    """

    model_config = ConfigDict(extra="forbid")

    default_transfer_number: str | None = None
    email_from: str | None = None
    sms_from_number: str | None = None


class RoutingEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    number: str | None = None
    description: str


class FAQEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str
    answer: str


class ReceptionistSettings(BaseModel):
    """Approved facts and boundaries used by the voice receptionist."""

    model_config = ConfigDict(extra="forbid")

    description: str = ""
    services: list[str] = Field(default_factory=list)
    escalation_rules: list[str] = Field(default_factory=list)
    prohibited_claims: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Languages
# ---------------------------------------------------------------------------

class LanguagesConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    primary: str = "en"
    allowed: list[str] = Field(default_factory=lambda: ["en"])

    @field_validator("primary", "allowed")
    @classmethod
    def lowercase_codes(cls, v):
        if isinstance(v, str):
            return v.lower()
        return [s.lower() for s in v]

    @model_validator(mode="after")
    def primary_in_allowed(self) -> LanguagesConfig:
        if self.primary not in self.allowed:
            raise ValueError(
                f"languages.primary {self.primary!r} must appear in languages.allowed {self.allowed!r}"
            )
        return self


# ---------------------------------------------------------------------------
# Message channels (discriminated union on "type")
# ---------------------------------------------------------------------------

class FileChannel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["file"]
    file_path: str


class EmailChannel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["email"]
    to: list[str]
    include_transcript: bool = True
    include_recording_link: bool = True


class WebhookChannel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["webhook"]
    url: str
    headers: dict[str, str] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def _validate_url_safe(cls, v: str) -> str:
        """Reject non-http(s) schemes and warn (not reject) on private/loopback hosts.

        - Hard reject: file://, data:, javascript:, gopher:, etc. We only ever
          want webhooks to leave via HTTP(S).
        - Soft warn: loopback (127.0.0.0/8, ::1), private (10/8, 172.16/12,
          192.168/16, fc00::/7), link-local (169.254/16, fe80::/10). These are
          legitimate in dev (ngrok forwards, internal Slack relays) but a
          common foot-gun in prod (e.g. AWS metadata at 169.254.169.254).
        """
        parsed = urlparse(v)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(
                f"Webhook URL scheme must be http or https; got {parsed.scheme!r} in {v!r}. "
                f"file://, data:, javascript: and other schemes are rejected."
            )
        if not parsed.hostname:
            raise ValueError(f"Webhook URL has no host: {v!r}")

        # IP-literal check (don't try to resolve DNS at config-load time)
        try:
            ip = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            # Hostname is a domain â€” can't classify without DNS. Catch the
            # most common literal foot-guns by name.
            host = parsed.hostname.lower()
            if host in ("localhost",) or host.endswith(".localhost"):
                raise ValueError("Webhook URL must not target localhost")
        else:
            if ip.is_loopback or ip.is_private or ip.is_link_local:
                raise ValueError(
                    "Webhook URL must not target private, loopback, or link-local "
                    f"addresses; got {ip}"
                )
        return v


MessageChannel = Annotated[
    Union[FileChannel, EmailChannel, WebhookChannel],
    Field(discriminator="type"),
]


class MessagesConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channels: list[MessageChannel]

    @model_validator(mode="before")
    @classmethod
    def convert_legacy_delivery(cls, data):
        """Accept legacy `delivery: file, file_path: ...` form and convert to channels list."""
        if not isinstance(data, dict):
            return data
        if "delivery" in data and "channels" not in data:
            delivery = data.pop("delivery")
            if delivery == "file":
                data["channels"] = [{"type": "file", "file_path": data.pop("file_path", "./messages/")}]
            elif delivery == "webhook":
                data["channels"] = [{"type": "webhook", "url": data.pop("webhook_url", "")}]
            else:
                raise ValueError(f"Unknown legacy delivery: {delivery!r}")
        return data


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

class LocalStorageConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str


class S3StorageConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bucket: str
    region: str
    prefix: str = ""
    endpoint_url: str | None = None


class RecordingStorageConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["local", "s3"]
    local: LocalStorageConfig | None = None
    s3: S3StorageConfig | None = None

    @model_validator(mode="after")
    def validate_matching_subconfig(self) -> RecordingStorageConfig:
        if self.type == "local" and self.local is None:
            raise ValueError("recording.storage.local required when type is 'local'")
        if self.type == "s3" and self.s3 is None:
            raise ValueError("recording.storage.s3 required when type is 's3'")
        return self


class ConsentPreambleConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    text: str = "This call may be recorded for quality purposes."


class RecordingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    storage: RecordingStorageConfig
    consent_preamble: ConsentPreambleConfig = Field(default_factory=ConsentPreambleConfig)


# ---------------------------------------------------------------------------
# Transcripts
# ---------------------------------------------------------------------------

class TranscriptStorageConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["local"]
    path: str


class TranscriptsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    storage: TranscriptStorageConfig
    formats: list[Literal["json", "markdown"]] = Field(default_factory=lambda: ["json", "markdown"])


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

class SMTPConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host: str
    port: int = 587
    username: str
    password: str
    use_tls: bool = True


class ResendConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    api_key: str


class GmailOAuthConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    oauth_token_file: str


class EmailSenderConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["smtp", "resend", "gmail_oauth"]
    smtp: SMTPConfig | None = None
    resend: ResendConfig | None = None
    gmail_oauth: GmailOAuthConfig | None = None

    @model_validator(mode="after")
    def validate_matching_subconfig(self) -> EmailSenderConfig:
        if self.type == "smtp" and self.smtp is None:
            raise ValueError("email.sender.smtp required when type is 'smtp'")
        if self.type == "resend" and self.resend is None:
            raise ValueError("email.sender.resend required when type is 'resend'")
        if self.type == "gmail_oauth":
            if self.gmail_oauth is None:
                raise ValueError("email.sender.gmail_oauth required when type is 'gmail_oauth'")
        return self


class EmailTriggers(BaseModel):
    model_config = ConfigDict(extra="forbid")

    on_message: bool = True
    on_call_end: bool = False
    on_booking: bool = False


class EmailConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    from_: str | None = Field(default=None, alias="from")
    sender: EmailSenderConfig
    triggers: EmailTriggers = Field(default_factory=EmailTriggers)


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

class RetentionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recordings_days: int = 90
    transcripts_days: int = 90
    messages_days: int = 0  # 0 = keep forever


# ---------------------------------------------------------------------------
# SIP transfer config
# ---------------------------------------------------------------------------

class SipConfig(BaseModel):
    """Per-business SIP behavior. Today only the transfer URI scheme is configurable.

    `transfer_uri_template` is the format string the agent uses when telling
    LiveKit how to dial the routing target during a transfer. It must contain
    the literal `{number}` placeholder, which is substituted with the routing
    target's `{number}` field.

    Defaults to `tel:{number}` which works for Twilio, Telnyx, and most BYOC
    providers that translate tel-URIs to SIP. For Asterisk classic sip.conf
    (which rejects tel-URIs), use `sip:{number}` for local DID transfers, or
    `sip:{number}@your-pbx.example.com` for transfers to a remote SIP PBX.
    """
    model_config = ConfigDict(extra="forbid")

    transfer_uri_template: str = "tel:{number}"

    @field_validator("transfer_uri_template")
    @classmethod
    def _has_number_placeholder(cls, v: str) -> str:
        if "{number}" not in v:
            raise ValueError(
                f"transfer_uri_template must contain '{{number}}' placeholder; got: {v!r}"
            )
        return v


# ---------------------------------------------------------------------------
# Calendar â€” Google Calendar integration
# ---------------------------------------------------------------------------

class ServiceAccountAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["service_account"]
    service_account_file: str


class OAuthAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["oauth"]
    oauth_token_file: str


CalendarAuth = Annotated[
    Union[ServiceAccountAuth, OAuthAuth],
    Field(discriminator="type"),
]


class CalendarConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    calendar_id: str = "primary"
    auth: CalendarAuth
    appointment_duration_minutes: int = Field(default=30, gt=0)
    buffer_minutes: int = Field(default=15, ge=0)
    buffer_placement: Literal["before", "after", "both"] = "after"
    booking_window_days: int = Field(default=30, gt=0, le=90)
    earliest_booking_hours_ahead: int = Field(default=2, ge=0)

    @model_validator(mode="after")
    def validate_auth_file_exists(self) -> CalendarConfig:
        """If enabled, require the configured auth file to exist on disk.

        Fail fast at agent startup, not at first call.
        """
        if not self.enabled:
            return self
        path_str = (
            self.auth.service_account_file
            if isinstance(self.auth, ServiceAccountAuth)
            else self.auth.oauth_token_file
        )
        return self


class AppointmentChangesConfig(BaseModel):
    """Safety controls for automated changes to existing appointments."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    admin_email_to: list[str] = Field(default_factory=lambda: ["contact@hirarw.com"])
    lookup_window_minutes: int = Field(default=45, ge=5, le=180)
    token_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    operation_retry_limit: int = Field(default=3, ge=1, le=20)
    notification_retry_limit: int = Field(default=5, ge=1, le=50)

    @field_validator("admin_email_to")
    @classmethod
    def validate_admin_email_to(cls, values: list[str]) -> list[str]:
        normalized = [str(value).strip().lower() for value in values if str(value).strip()]
        if not normalized:
            raise ValueError("appointment_changes.admin_email_to must contain at least one address")
        if any(not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) for value in normalized):
            raise ValueError("appointment_changes.admin_email_to contains an invalid email address")
        return list(dict.fromkeys(normalized))


# ---------------------------------------------------------------------------
# SMS + appointment reminders
# ---------------------------------------------------------------------------

class FakeSMSProviderConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["fake"] = "fake"
    log_path: str = "./messages/reminders-sms.log"


class TwilioSMSProviderConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["twilio"] = "twilio"
    account_sid_env: str = "TWILIO_ACCOUNT_SID"
    auth_token_env: str = "TWILIO_AUTH_TOKEN"
    from_number: str | None = None
    messaging_service_sid: str | None = None
    messaging_service_sid_env: str | None = None

    @model_validator(mode="after")
    def validate_sender(self) -> TwilioSMSProviderConfig:
        sender_values = (
            self.from_number,
            self.messaging_service_sid,
            self.messaging_service_sid_env,
        )
        if sum(bool(value) for value in sender_values) > 1:
            raise ValueError(
                "sms.provider twilio requires exactly one sender: from_number, "
                "messaging_service_sid, or messaging_service_sid_env"
            )
        return self


SMSProviderConfig = Annotated[
    Union[FakeSMSProviderConfig, TwilioSMSProviderConfig],
    Field(discriminator="type"),
]


class SMSConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: SMSProviderConfig = Field(default_factory=FakeSMSProviderConfig)


class MessageTemplatesConfig(BaseModel):
    """Operator-editable email/SMS copy for appointment messages.

    Templates use Python-style placeholders:
    {business_name}, {recipient_name}, {appointment_time}, {offset_days},
    and {default_transfer_number}. Post follow-ups use the same placeholders.
    Fields left blank use the built-in copy.
    """

    model_config = ConfigDict(extra="forbid")

    confirmation_email_subject: str | None = None
    confirmation_email_text: str | None = None
    confirmation_email_html: str | None = None
    confirmation_sms: str | None = None
    reminder_email_subject: str | None = None
    reminder_email_text: str | None = None
    reminder_email_html: str | None = None
    reminder_sms: str | None = None
    post_reminder_email_subject: str | None = None
    post_reminder_email_text: str | None = None
    post_reminder_email_html: str | None = None
    post_reminder_sms: str | None = None
    post_followups: dict[str, dict[str, str | None]] = Field(default_factory=dict)
    quick_sms: str | None = None
    quick_email: str | None = None
    quick_call_script: str | None = None
    message_email_subject: str | None = None
    message_email_text: str | None = None
    message_email_html: str | None = None
    call_end_email_subject: str | None = None
    call_end_email_text: str | None = None
    call_end_email_html: str | None = None
    booking_email_subject: str | None = None
    booking_email_text: str | None = None
    booking_email_html: str | None = None

    @field_validator("*")
    @classmethod
    def validate_placeholders(cls, v: str | None) -> str | None:
        if not isinstance(v, str) or not v:
            return v
        allowed = {
            "business_name",
            "recipient_name",
            "appointment_time",
            "offset_days",
            "default_transfer_number",
            "caller_name",
            "callback_number",
            "received_at",
            "message_text",
            "recording_url",
            "transcript_path",
            "caller_phone",
            "start_ts",
            "end_ts",
            "duration",
            "outcomes",
            "transfer_target",
            "agent_end_reason",
            "appointment_start",
            "appointment_end",
            "appointment_link",
            "faqs_answered",
            "languages",
            "call_id",
        }
        fields = {
            field_name.split(".", 1)[0].split("[", 1)[0]
            for _, field_name, _, _ in Formatter().parse(v)
            if field_name
        }
        unknown = sorted(fields - allowed)
        if unknown:
            raise ValueError(
                "unknown message template placeholder(s): "
                + ", ".join(f"{{{name}}}" for name in unknown)
            )
        return v

    @field_validator("post_followups")
    @classmethod
    def validate_post_followups(cls, value: dict[str, dict[str, str | None]]) -> dict[str, dict[str, str | None]]:
        allowed_presets = {"thank_you_review", "thank_you_only", "book_next_appointment"}
        unknown = set(value) - allowed_presets
        if unknown:
            raise ValueError("unknown post follow-up preset(s): " + ", ".join(sorted(unknown)))
        allowed_fields = {"email_subject", "email_text", "email_html", "sms"}
        for preset, fields in value.items():
            if not isinstance(fields, dict):
                raise ValueError(f"message_templates.post_followups.{preset} must be a mapping")
            unknown_fields = set(fields) - allowed_fields
            if unknown_fields:
                raise ValueError(
                    f"unknown fields in message_templates.post_followups.{preset}: "
                    + ", ".join(sorted(unknown_fields))
                )
            for field_name, template in fields.items():
                if not isinstance(template, str) or not template:
                    continue
                parsed_fields = {
                    field.split(".", 1)[0].split("[", 1)[0]
                    for _, field, _, _ in Formatter().parse(template)
                    if field
                }
                allowed_placeholders = {
                    "business_name", "recipient_name", "appointment_time", "offset_days",
                    "default_transfer_number", "appointment_start", "appointment_end",
                }
                unknown_placeholders = sorted(parsed_fields - allowed_placeholders)
                if unknown_placeholders:
                    raise ValueError(
                        f"unknown message template placeholder(s) in {preset}.{field_name}: "
                        + ", ".join(f"{{{name}}}" for name in unknown_placeholders)
                    )
        return value


class ReminderCalendarSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["google", "apple_ics"]
    calendar_id: str = "primary"
    path: str | None = None

    @model_validator(mode="after")
    def validate_source(self) -> ReminderCalendarSource:
        if self.type == "apple_ics" and not self.path:
            raise ValueError("apple_ics reminder calendar source requires path")
        return self


class PostFollowupConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preset: Literal["thank_you_review", "thank_you_only", "book_next_appointment"]
    enabled: bool = True
    offset_days_after: int = Field(default=1, ge=1, le=365)
    channels: list[Literal["email", "sms"]] = Field(default_factory=lambda: ["email", "sms"])

    @field_validator("channels")
    @classmethod
    def validate_channels(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("post follow-up channels must contain at least one channel")
        if len(set(value)) != len(value):
            raise ValueError("post follow-up channels must not contain duplicates")
        return value


class PostAppointmentConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    offset_days_after: int = Field(default=1, ge=1, le=30)
    follow_ups: list[PostFollowupConfig] | None = None

    @model_validator(mode="after")
    def normalize_follow_ups(self) -> PostAppointmentConfig:
        if self.follow_ups is None:
            self.follow_ups = [
                PostFollowupConfig(
                    preset="thank_you_review",
                    enabled=self.enabled,
                    offset_days_after=self.offset_days_after,
                ),
                PostFollowupConfig(
                    preset="thank_you_only",
                    enabled=False,
                    offset_days_after=1,
                ),
                PostFollowupConfig(
                    preset="book_next_appointment",
                    enabled=False,
                    offset_days_after=30,
                ),
            ]
        presets = [item.preset for item in self.follow_ups]
        if len(set(presets)) != len(presets):
            raise ValueError("post_appointment.follow_ups cannot contain duplicate presets")
        return self


class RemindersConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    offset_days: list[int] = Field(default_factory=lambda: [4, 1])
    channels: list[Literal["email", "sms"]] = Field(default_factory=lambda: ["email", "sms"])
    post_appointment: PostAppointmentConfig = Field(default_factory=PostAppointmentConfig)
    store_path: str = "./reminders.sqlite3"
    contacts_path: str = "./contacts.yaml"
    lookback_days: int = Field(default=90, ge=0, le=366)
    lookahead_days: int = Field(default=60, gt=0, le=366)
    allow_retroactive_send: bool = False
    calendar_sources: list[ReminderCalendarSource] = Field(default_factory=list)
    email_provider: Literal["fake", "configured"] = "fake"
    fake_email_log_path: str = "./messages/reminders-email.log"

    @field_validator("offset_days")
    @classmethod
    def validate_offsets(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("reminders.offset_days must contain at least one offset")
        if any(offset <= 0 for offset in v):
            raise ValueError("reminders.offset_days values must be positive")
        return sorted(set(v), reverse=True)

    @field_validator("channels")
    @classmethod
    def validate_channels(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("reminders.channels must contain at least one channel")
        return list(dict.fromkeys(v))


class TelephonyReadinessConfig(BaseModel):
    """Read-only routing facts used by the desktop readiness checker."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    inbound_number: str = ""
    livekit_sip_uri: str = ""
    livekit_inbound_trunk_id: str = ""
    livekit_dispatch_rule_id: str = ""

    @model_validator(mode="after")
    def validate_enabled_configuration(self) -> TelephonyReadinessConfig:
        if not self.enabled:
            return self
        missing = [
            name for name, value in (
                ("inbound_number", self.inbound_number),
                ("livekit_sip_uri", self.livekit_sip_uri),
                ("livekit_inbound_trunk_id", self.livekit_inbound_trunk_id),
                ("livekit_dispatch_rule_id", self.livekit_dispatch_rule_id),
            ) if not value.strip()
        ]
        if missing:
            raise ValueError("telephony.enabled requires " + ", ".join(missing))
        if not re.fullmatch(r"\+\d{7,15}", self.inbound_number):
            raise ValueError("telephony.inbound_number must be an E.164 number")
        if not self.livekit_sip_uri.lower().startswith("sip:"):
            raise ValueError("telephony.livekit_sip_uri must start with sip:")
        return self



# ---------------------------------------------------------------------------
# Top-level
# ---------------------------------------------------------------------------

class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["demo", "production"] = "demo"
    name: str
    type: str
    timezone: str
    communications: CommunicationsConfig = Field(default_factory=CommunicationsConfig)
    message_templates: MessageTemplatesConfig = Field(default_factory=MessageTemplatesConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    languages: LanguagesConfig = Field(default_factory=LanguagesConfig)
    greeting: str
    personality: str
    hours: WeeklyHours
    after_hours_message: str
    routing: list[RoutingEntry]
    faqs: list[FAQEntry]
    receptionist: ReceptionistSettings = Field(default_factory=ReceptionistSettings)
    messages: MessagesConfig
    recording: RecordingConfig | None = None
    transcripts: TranscriptsConfig | None = None
    email: EmailConfig | None = None
    calendar: CalendarConfig | None = None
    appointment_changes: AppointmentChangesConfig = Field(default_factory=AppointmentChangesConfig)
    sms: SMSConfig = Field(default_factory=SMSConfig)
    reminders: RemindersConfig = Field(default_factory=RemindersConfig)
    sip: SipConfig = Field(default_factory=SipConfig)
    telephony: TelephonyReadinessConfig = Field(default_factory=TelephonyReadinessConfig)
    retention: RetentionConfig = Field(default_factory=RetentionConfig)

    @field_validator("timezone")
    @classmethod
    def validate_app_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"Invalid IANA timezone: {value!r}") from exc
        return value

    @model_validator(mode="after")
    def validate_cross_section(self) -> AppConfig:
        for route in self.routing:
            if route.number is None and self.communications.default_transfer_number:
                route.number = self.communications.default_transfer_number
            if route.number is None:
                raise ValueError(
                    f"routing entry {route.name!r} needs \nnumber` or "
                    "communications.default_transfer_number"
                )

        if self.email:
            if self.email.from_ is None and self.communications.email_from:
                self.email.from_ = self.communications.email_from
            if self.email.from_ is None:
                raise ValueError("email.from or communications.email_from is required")

        provider = self.sms.provider
        if isinstance(provider, TwilioSMSProviderConfig):
            if (
                provider.from_number is None
                and provider.messaging_service_sid is None
                and provider.messaging_service_sid_env is None
            ):
                provider.from_number = self.communications.sms_from_number
            if sum(
                bool(value)
                for value in (
                    provider.from_number,
                    provider.messaging_service_sid,
                    provider.messaging_service_sid_env,
                )
            ) != 1:
                raise ValueError(
                    "sms.provider twilio requires exactly one of from_number, "
                    "communications.sms_from_number, messaging_service_sid, or "
                    "messaging_service_sid_env"
                )

        needs_email = any(c.type == "email" for c in self.messages.channels)
        if self.email:
            if self.email.triggers.on_call_end:
                needs_email = True
            if self.email.triggers.on_booking:
                needs_email = True
        if needs_email and self.email is None:
            raise ValueError(
                "email channel or on_call_end/on_booking trigger is configured but "
                "no top-level `email` section is present"
            )
        # NEW: on_booking trigger requires calendar enabled
        if self.email and self.email.triggers.on_booking and (
            self.calendar is None or not self.calendar.enabled
        ):
            raise ValueError(
                "email.triggers.on_booking is true but calendar is not enabled. "
                "Enable calendar or disable the on_booking trigger."
            )
        if self.reminders.enabled:
            if (
                "email" in self.reminders.channels
                and self.reminders.email_provider == "configured"
                and self.email is None
            ):
                raise ValueError(
                    "reminders email_provider is configured but no top-level `email` section is present"
                )
            if "sms" in self.reminders.channels and self.sms is None:
                raise ValueError(
                    "reminders.channels includes sms but no top-level `sms` section is present"
                )
            if any(s.type == "google" for s in self.reminders.calendar_sources):
                if self.calendar is None or not self.calendar.enabled:
                    raise ValueError(
                        "reminders calendar source google requires calendar.enabled"
                    )
            if self.mode == "production":
                if (
                    "email" in self.reminders.channels
                    and self.reminders.email_provider == "fake"
                ):
                    raise ValueError(
                        "production mode cannot use reminders.email_provider=fake"
                    )
                if (
                    "sms" in self.reminders.channels
                    and isinstance(self.sms.provider, FakeSMSProviderConfig)
                ):
                    raise ValueError(
                        "production mode cannot use sms.provider.type=fake"
                    )
        review_followup = next(
            (item for item in self.reminders.post_appointment.follow_ups or [] if item.preset == "thank_you_review"),
            None,
        )
        review_templates = self.message_templates.post_followups.get("thank_you_review", {})
        if review_followup and review_followup.enabled:
            if "email" in review_followup.channels:
                email_text = review_templates.get("email_text") or self.message_templates.post_reminder_email_text
                if email_text and not _has_https_url(email_text):
                    raise ValueError(
                        "thank_you_review email template must include a valid HTTPS review link"
                    )
            if "sms" in review_followup.channels:
                sms_text = review_templates.get("sms") or self.message_templates.post_reminder_sms
                if sms_text and not _has_https_url(sms_text):
                    raise ValueError(
                        "thank_you_review SMS template must include a valid HTTPS review link"
                    )
        return self

    @classmethod
    def from_yaml_string(cls, yaml_string: str, *, base_dir: Path | None = None) -> AppConfig:
        try:
            data = yaml.safe_load(yaml_string)
        except yaml.YAMLError as e:
            raise ConfigError(_friendly_yaml_error(e, yaml_string)) from e
        data = _normalize_app_data(data)
        if base_dir is not None:
            data = _resolve_relative_paths(data, base_dir)
        data = _interpolate_env_vars(data)
        return cls.model_validate(data)

    @property
    def business(self) -> BusinessInfo:
        return BusinessInfo(name=self.name, type=self.type, timezone=self.timezone)


_RELATIVE_PATH_KEYS = {
    "contacts_path", "file_path", "log_path", "oauth_token_file",
    "service_account_file", "store_path",
}


def _normalize_app_data(data: object) -> object:
    if not isinstance(data, dict):
        return data
    normalized = dict(data)
    legacy = normalized.pop("business", None)
    if isinstance(legacy, dict):
        for key in ("name", "type", "timezone"):
            if key not in normalized and key in legacy:
                normalized[key] = legacy[key]
    return normalized


def _resolve_relative_paths(node: object, base_dir: Path, *, key: str | None = None) -> object:
    if isinstance(node, dict):
        return {
            child_key: _resolve_relative_paths(child, base_dir, key=child_key)
            for child_key, child in node.items()
        }
    if isinstance(node, list):
        return [_resolve_relative_paths(child, base_dir) for child in node]
    if key in _RELATIVE_PATH_KEYS and isinstance(node, str) and node:
        path = Path(node).expanduser()
        return str(path if path.is_absolute() else (base_dir / path).resolve())
    return node


def load_config(path: Path | str) -> AppConfig:
    config_path = Path(path).expanduser().resolve()
    text = config_path.read_text(encoding="utf-8")
    return AppConfig.from_yaml_string(text, base_dir=config_path.parent)


def canonical_config_path() -> Path:
    configured = os.environ.get("RECEPTIONIST_APP_CONFIG")
    if configured:
        return Path(configured).expanduser().resolve()
    runtime = os.environ.get("RECEPTIONIST_RUNTIME_ROOT")
    if runtime:
        return (Path(runtime).expanduser() / "config.yaml").resolve()
    root = os.environ.get("RECEPTIONIST_DESKTOP_ROOT")
    if root:
        return (Path(root).expanduser() / "config" / "app.yaml").resolve()
    return (Path(__file__).resolve().parents[1] / "config" / "app.yaml").resolve()

def load_app_config(path: Path | str | None = None) -> AppConfig:
    """Load the one canonical application config; never discover profiles."""
    config_path = Path(path).expanduser().resolve() if path else canonical_config_path()
    if not config_path.exists():
        raise FileNotFoundError(f"Application config not found: {config_path}")
    return load_config(config_path)


# Temporary import compatibility for external callers; runtime selection is
# handled only by load_app_config.
BusinessConfig = AppConfig

# ---------------------------------------------------------------------------
# YAML error helpers
# ---------------------------------------------------------------------------

# Matches a key like " sip:" or "  recording:" â€” leading whitespace + plain
# identifier + colon at end-of-line. Used to detect the most common config
# pitfall: uncommenting a "# section:" block by removing only "#", leaving
# the line indented by one space. YAML then sees the section as nested under
# the previous block and the parser error points at the "wrong" line.
_LEADING_WS_KEY_RE = re.compile(r"^\s+([a-z_][a-z0-9_]*)\s*:\s*(?:#.*)?$", re.IGNORECASE)


def _friendly_yaml_error(e: yaml.YAMLError, source: str) -> str:
    """Translate a yaml parse error into something an operator can act on.

    Catches the indentation trap from uncommenting "# section:" blocks where
    the user left a leading space. Falls back to a clear-but-generic message
    that still includes the underlying yaml position.
    """
    base = str(e)
    mark = getattr(e, "problem_mark", None)
    if mark is None:
        return f"Config YAML failed to parse:\n{base}"

    lineno = mark.line + 1  # mark uses 0-based; humans want 1-based
    col = mark.column + 1
    lines = source.splitlines()
    offending_line = lines[mark.line] if 0 <= mark.line < len(lines) else ""

    # Detect the specific "I uncommented and left a leading space" trap so we
    # can give an actionable hint rather than the cryptic raw yaml message.
    m = _LEADING_WS_KEY_RE.match(offending_line)
    if (
        m is not None
        and "block end" in (getattr(e, "problem", "") or "")
    ):
        key = m.group(1)
        return (
            f"Config YAML indentation error at line {lineno}: '{offending_line.strip()}' "
            f"is indented with {col - 1} space(s) but appears to be a top-level "
            f"section. If you just uncommented a '# {key}:' example block, "
            f"remove BOTH the leading '#' AND the space after it so '{key}:' "
            f"starts at column 0.\n\n"
            f"Original yaml error:\n{base}"
        )
    return f"Config YAML failed to parse at line {lineno}, column {col}:\n{base}"


# ---------------------------------------------------------------------------
# Env var interpolation
# ---------------------------------------------------------------------------

_ENV_PATTERN = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")
# Matches the *shape* of an env-var placeholder (`${...}`) so we can detect
# lowercase or invalid placeholders that look like an interpolation attempt
# but won't be expanded by _ENV_PATTERN. Anything else (e.g. plain "${" in a
# greeting because it really is the literal characters "$" + "{") is left
# alone because it does not look like a placeholder.
_ENV_PLACEHOLDER_SHAPE = re.compile(r"\$\{[^}\s]*\}")


def _interpolate_env_vars(node):
    if isinstance(node, str):
        def _replace(match: re.Match) -> str:
            var = match.group(1)
            if var not in os.environ:
                raise ValueError(f"Environment variable {var} referenced in config but not set")
            return os.environ[var]
        interpolated = _ENV_PATTERN.sub(_replace, node)
        remaining = _ENV_PLACEHOLDER_SHAPE.search(interpolated)
        if remaining is not None:
            raise ValueError(
                f"Invalid environment variable placeholder {remaining.group(0)!r}. "
                "Use ${UPPERCASE_NAME} with uppercase ASCII letters, digits, and underscores."
            )
        return interpolated
    if isinstance(node, dict):
        return {k: _interpolate_env_vars(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_interpolate_env_vars(v) for v in node]
    return node
