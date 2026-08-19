from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import date


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
# Google Calendar descriptions are commonly entered on a phone. Accept the
# standard US slash or dot separator, but keep the date components bounded so
# malformed values cannot silently become an identity match.
_US_DOB_RE = re.compile(r"^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$")
_PATIENT_BLOCK_START = "[OpenWhispr Patient]"
_PATIENT_BLOCK_END = "[/OpenWhispr Patient]"
_MAX_PATIENT_DESCRIPTION_LENGTH = 4096
_MAX_PATIENT_BLOCK_LENGTH = 512
_MAX_PATIENT_NAME_LENGTH = 120
_MAX_PATIENT_EMAIL_LENGTH = 254
_MAX_PATIENT_PHONE_LENGTH = 32
_MAX_PATIENT_DOB_LENGTH = 10


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
    has_patient_markers = _PATIENT_BLOCK_START in raw or _PATIENT_BLOCK_END in raw
    if has_patient_markers:
        if raw.count(_PATIENT_BLOCK_START) != 1 or raw.count(_PATIENT_BLOCK_END) != 1:
            return None
        matches = list(_PATIENT_BLOCK_RE.finditer(raw))
        if len(matches) != 1:
            return None
        block = matches[0].group(1)
    else:
        # Manual Google Calendar events use the title for the patient name and
        # keep the description to a few quick labeled lines. The desktop
        # projection supplies the title as ``name`` after this parse.
        block = raw.strip()
    if len(block) > _MAX_PATIENT_BLOCK_LENGTH:
        return None
    fields: dict[str, str] = {}
    for line in block.splitlines():
        field = _PATIENT_FIELD_RE.fullmatch(line)
        if not field:
            return None
        key = field.group(1).lower()
        text = field.group(2).strip()
        if key not in {"name", "dob", "email", "phone"} or not text or key in fields:
            return None
        fields[key] = text
    raw_email = fields.get("email", "")
    if len(raw_email) > _MAX_PATIENT_EMAIL_LENGTH:
        return None
    email = normalize_email(raw_email) if raw_email else None
    if raw_email and not email:
        return None
    name = fields.get("name", "").strip() or None
    if name and len(name) > _MAX_PATIENT_NAME_LENGTH:
        return None
    raw_dob = fields.get("dob", "").strip()
    dob = None
    if raw_dob:
        if len(raw_dob) > _MAX_PATIENT_DOB_LENGTH:
            return None
        try:
            us_dob = _US_DOB_RE.fullmatch(raw_dob)
            if us_dob:
                month, day, year = (int(value) for value in us_dob.groups())
                dob = date(year, month, day).isoformat()
            else:
                dob = date.fromisoformat(raw_dob).isoformat()
        except ValueError:
            return None
        if not us_dob and dob != raw_dob:
            return None
        if date.fromisoformat(dob) > date.today():
            return None
    if not has_patient_markers and not dob:
        return None
    phone = fields.get("phone", "").strip() or None
    if phone:
        if len(phone) > _MAX_PATIENT_PHONE_LENGTH:
            return None
        digits = "".join(character for character in phone if character.isdigit())
        if not 7 <= len(digits) <= 15:
            return None
        phone = f"+{digits}" if phone.startswith("+") else digits
    result = {
        "name": name,
        "email": email,
        "phone": phone,
        "source": RECOVERED_CONTACT_SOURCE,
    }
    if dob:
        result["dob"] = dob
    return result
