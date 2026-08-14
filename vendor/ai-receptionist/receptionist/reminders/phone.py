from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal


PhoneExtractionSource = Literal["labeled", "unlabeled", "ambiguous", "missing"]


@dataclass(frozen=True)
class PhoneExtraction:
    phone: str | None
    source: PhoneExtractionSource
    candidates: tuple[str, ...] = ()
    label_present: bool = False

    @property
    def ambiguous(self) -> bool:
        return self.source == "ambiguous"


_PHONE_CANDIDATE_RE = re.compile(
    r"(?<!\d)(?:\+?1[\s().-]*)?(?:\([2-9]\d{2}\)|[2-9]\d{2})"
    r"[\s.-]*[2-9]\d{2}[\s.-]*\d{4}(?!\d)"
)
_PHONE_LABEL_RE = re.compile(
    r"(?im)^[ \t]*(?:patient[ \t_-]*)?"
    r"(?:phone|sms|mobile|callback|tel|telephone|telefono|teléfono|celular|cell)"
    r"(?:[ \t_-]+(?:number|no\.?))?[ \t]*:[ \t]*(?P<value>.+?)\s*$"
)


def normalize_us_phone(value: object) -> str | None:
    """Normalize a US phone value to E.164, or return None when invalid."""
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 10 and digits[0] in "23456789" and digits[3] in "23456789":
        return f"+1{digits}"
    if (
        len(digits) == 11
        and digits.startswith("1")
        and digits[1] in "23456789"
        and digits[4] in "23456789"
    ):
        return f"+{digits}"
    return None


def _normalized_candidates(value: object) -> tuple[str, ...]:
    found: list[str] = []
    for match in _PHONE_CANDIDATE_RE.finditer(str(value or "")):
        phone = normalize_us_phone(match.group(0))
        if phone and phone not in found:
            found.append(phone)
    return tuple(found)


def extract_phone(value: object) -> PhoneExtraction:
    """Extract one phone from calendar text using labels, then safe fallback.

    A labeled number wins over unrelated numbers elsewhere in the description.
    When no label is present, exactly one phone-like number is required.
    """
    raw = str(value or "")
    all_candidates = _normalized_candidates(raw)
    label_present = bool(_PHONE_LABEL_RE.search(raw))
    labeled_candidates: list[str] = []
    for match in _PHONE_LABEL_RE.finditer(raw):
        for phone in _normalized_candidates(match.group("value")):
            if phone not in labeled_candidates:
                labeled_candidates.append(phone)

    if len(labeled_candidates) == 1:
        return PhoneExtraction(
            labeled_candidates[0], "labeled", tuple(all_candidates), label_present=True
        )
    if len(labeled_candidates) > 1:
        return PhoneExtraction(
            None, "ambiguous", tuple(labeled_candidates), label_present=True
        )
    if len(all_candidates) == 1:
        return PhoneExtraction(
            all_candidates[0], "unlabeled", all_candidates, label_present=label_present
        )
    if len(all_candidates) > 1:
        return PhoneExtraction(None, "ambiguous", all_candidates, label_present=label_present)
    return PhoneExtraction(None, "missing", label_present=label_present)
