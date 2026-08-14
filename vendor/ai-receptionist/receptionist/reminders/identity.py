from __future__ import annotations

import re
from collections.abc import Iterable


_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def normalize_email(value: object) -> str | None:
    """Return a normalized deliverable email address, or ``None``."""
    email = str(value or "").strip().lower()
    return email if _EMAIL_RE.fullmatch(email) else None


def normalize_emails(values: Iterable[object]) -> tuple[str, ...]:
    """Normalize and deterministically de-duplicate email values."""
    return tuple(sorted({email for value in values if (email := normalize_email(value))}))


def normalize_contact_keys(values: Iterable[object]) -> tuple[str, ...]:
    """Normalize opaque lookup keys without treating them as email addresses."""
    normalized = {str(value).strip().lower() for value in values if str(value or "").strip()}
    return tuple(sorted(normalized))


def split_stored_values(value: object) -> tuple[str, ...]:
    return tuple(part.strip() for part in str(value or "").split(",") if part.strip())

_STRUCTURED_EMAIL_RE = re.compile(r"(?im)^[ \t]*email:[ \t]*(\S+)[ \t]*$")
RECOVERED_CONTACT_SOURCE = "structured_description"
_PATIENT_BLOCK_RE = re.compile(
    r"(?:^|\r?\n)\[OpenWhispr Patient\]\r?\n(.*?)\r?\n\[/OpenWhispr Patient\](?=\r?\n|$)",
    re.DOTALL,
)
_PATIENT_FIELD_RE = re.compile(r"^([A-Za-z]+):[ \t]*(.*)$")
_PATIENT_BLOCK_START = "[OpenWhispr Patient]"
_PATIENT_BLOCK_END = "[/OpenWhispr Patient]"
_MAX_PATIENT_DESCRIPTION_LENGTH = 4096
_MAX_PATIENT_BLOCK_LENGTH = 512
_MAX_PATIENT_NAME_LENGTH = 120
_MAX_PATIENT_EMAIL_LENGTH = 254
_MAX_PATIENT_PHONE_LENGTH = 32


def extract_structured_email(value: object) -> str | None:
    """Recover one explicit Email line or an exact legacy email note."""
    raw = str(value or "")
    matches = [normalize_email(match) for match in _STRUCTURED_EMAIL_RE.findall(raw)]
    emails = tuple(dict.fromkeys(email for email in matches if email))
    if len(emails) == 1:
        return emails[0]
    compact = raw.strip()
    if compact and "\n" not in compact and "\r" not in compact:
        return normalize_email(compact)
    return None


def extract_patient_metadata(value: object) -> dict[str, str | None] | None:
    """Return a fixed, sanitized patient shape from one exact bounded block.

    Descriptions are intentionally treated as untrusted. Any malformed or
    duplicate marker, unknown field, duplicate field, or overlong value
    invalidates the entire block rather than attempting a best-effort parse.
    """
    raw = str(value or "")
    if not raw.strip() or len(raw) > _MAX_PATIENT_DESCRIPTION_LENGTH:
        return None
    if raw.count(_PATIENT_BLOCK_START) != 1 or raw.count(_PATIENT_BLOCK_END) != 1:
        return None
    matches = list(_PATIENT_BLOCK_RE.finditer(raw))
    if len(matches) != 1:
        return None
    block = matches[0].group(1)
    if len(block) > _MAX_PATIENT_BLOCK_LENGTH:
        return None
    fields: dict[str, str] = {}
    for line in block.splitlines():
        field = _PATIENT_FIELD_RE.fullmatch(line)
        if not field:
            return None
        key = field.group(1).lower()
        text = field.group(2).strip()
        if key not in {"name", "email", "phone"} or not text or key in fields:
            return None
        fields[key] = text
    raw_email = fields.get("email", "")
    if len(raw_email) > _MAX_PATIENT_EMAIL_LENGTH:
        return None
    email = normalize_email(raw_email)
    if not email:
        return None
    name = fields.get("name", "").strip() or None
    if name and len(name) > _MAX_PATIENT_NAME_LENGTH:
        return None
    phone = fields.get("phone", "").strip() or None
    if phone:
        if len(phone) > _MAX_PATIENT_PHONE_LENGTH:
            return None
        digits = "".join(character for character in phone if character.isdigit())
        if not 7 <= len(digits) <= 15:
            return None
        phone = f"+{digits}" if phone.startswith("+") else digits
    return {
        "name": name,
        "email": email,
        "phone": phone,
        "source": RECOVERED_CONTACT_SOURCE,
    }
