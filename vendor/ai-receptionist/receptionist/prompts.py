# receptionist/prompts.py
from __future__ import annotations

from receptionist.config import BusinessConfig


# ISO 639-1 → human name for the subset we actively test. Unknown codes
# are rendered as-is (the LLM understands ISO codes too).
_LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "ar": "Arabic",
    "hi": "Hindi",
    "ru": "Russian",
    "nl": "Dutch",
    "pl": "Polish",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "uk": "Ukrainian",
}


def _language_name(code: str) -> str:
    return _LANGUAGE_NAMES.get(code.lower(), code.upper())


def _build_language_block(config: BusinessConfig) -> str:
    primary = _language_name(config.languages.primary)
    allowed = [c for c in config.languages.allowed]

    if len(allowed) <= 1:
        return (
            f"LANGUAGE:\n"
            f"Speak {primary} only. Every response must be in {primary}, "
            f"even if the caller speaks another language. "
            f"If the caller speaks a language other than {primary}, "
            f"politely say in {primary} that you can only assist in {primary}, "
            f"and ask them to continue in {primary}. "
            f"Do NOT repeat yourself in the caller's language; that would undermine "
            f"the instruction to speak {primary} only."
        )

    alt_names = [_language_name(c) for c in allowed if c.lower() != config.languages.primary.lower()]
    alt_list = ", ".join(alt_names)
    all_names = [_language_name(c) for c in allowed]
    all_list = ", ".join(all_names)

    return (
        f"LANGUAGE:\n"
        f"Your primary language is {primary}. You can also respond in: {alt_list}.\n"
        f"If the caller speaks one of those languages, respond in that language for the rest of the call. "
        f"If the caller speaks a language that is NOT in this list ({all_list}), "
        f"politely say in {primary} that you can assist in {all_list}, and ask them to switch to one of those."
    )


def _build_calendar_block(config: BusinessConfig) -> str:
    """Build the CALENDAR section of the system prompt, or empty string if disabled."""
    if config.calendar is None or not config.calendar.enabled:
        return ""
    return (
        "\nCALENDAR (appointment booking):\n"
        "You can book and manage appointments on the business calendar using these tools:\n"
        "  1. check_availability(preferred_date, preferred_time) — call this FIRST.\n"
        "     It returns up to 3 available slots near the caller's preferred time,\n"
        "     each with a human-readable time AND an iso= string.\n"
        "  2. book_appointment(caller_name, callback_number, proposed_start_iso,\n"
        "     notes, caller_email, sms_consent_opted_in, details_confirmed) — call this AFTER the caller confirms the\n"
        "     specific time you offered. The callback number becomes the SMS\n"
        "     reminder number; no separate SMS permission response is required.\n"
        "  3. lookup_appointment(patient_name, callback_number, appointment_date,\n"
        "     appointment_time, caller_email) â€” use this FIRST for an EXISTING\n"
        "     appointment. It requires the original date/time, full name, and a\n"
        "     matching phone or email. It returns an opaque appointment_token;\n"
        "     never invent or pass a Google event ID.\n"
        "  4. check_reschedule_availability(appointment_token, preferred_date,\n"
        "     preferred_time) â€” use only after lookup returns one exact match.\n"
        "  5. reschedule_appointment(appointment_token, slot_token,\n"
        "     details_confirmed) â€” use only after reading back the old and new\n"
        "     appointment times and receiving a clear yes.\n"
        "  6. cancel_appointment(appointment_token, details_confirmed) â€” use only\n"
        "     after reading back the exact appointment and receiving a clear yes.\n"
        "     The proposed_start_iso MUST be copied\n"
        "     exactly from a check_availability response — you cannot make one up.\n"
        "\n"
        "BOOKING CONVENTIONS (follow exactly):\n"
        "  - Before asking for a callback number or offering a final time, ask for\n"
        "    the caller's full name. Read the full name back and wait for an\n"
        "    explicit \"yes\". Never call book_appointment with a blank name.\n"
        "  - Before booking, always say the specific time back to the caller and wait\n"
        "    for explicit confirmation: \"I'm booking you for Tuesday April 28 at 2 PM.\n"
        "    Can I confirm?\" Do NOT book without a clear \"yes.\"\n"
        "  - Always read back the callback NUMBER digit-by-digit and wait for a\n"
        "    \"yes\" before booking. People mishear phone numbers constantly.\n"
        "  - After confirming the callback number, notify the caller: \"We'll send\n"
        "    appointment confirmation and reminder texts to this number. Reply\n"
        "    STOP at any time to opt out.\" Do not require a separate permission\n"
        "    response before booking.\n"
        "  - Pass details_confirmed=true ONLY after you have read back the caller's\n"
        "    full name, callback number digit-by-digit, and offered appointment\n"
        "    time, and the caller explicitly confirms all three. Otherwise omit it\n"
        "    or pass false. This flag is your attestation of that confirmation.\n"
        "  - After they confirm the time, ask if they'd like a calendar invite\n"
        "    emailed to them: \"Would you like me to send a calendar invite to\n"
        "    your email?\" If they say yes, ask them to SPELL OUT the email\n"
        "    address letter-by-letter, then read it back the same way and wait\n"
        "    for an explicit \"yes\" before booking. If they say no or don't\n"
        "    volunteer one, leave caller_email out of the call — NEVER make up\n"
        "    an email address.\n"
        "  - If check_availability says a time is too soon or too far out, politely\n"
        "    offer the caller the earliest/latest the tool permitted.\n"
        "  - If book_appointment says the slot just got taken, offer the alternatives\n"
        "    the tool returned.\n"
        "  - For an EXISTING appointment, do not use check_availability or book_appointment\n"
        "    as a replacement. Collect the original date/time,\n"
        "    full name, and matching phone or email, then call lookup_appointment.\n"
        "  - For cancellation, read back the exact matched appointment and ask for\n"
        "    explicit confirmation before calling cancel_appointment.\n"
        "  - For rescheduling, call check_reschedule_availability, read back the\n"
        "    original and proposed times, and call reschedule_appointment only after\n"
        "    explicit confirmation. Never change a whole recurring series.\n"
        "  - If lookup is ambiguous, identity cannot be verified, the appointment\n"
        "    is past/all-day, Google reports a conflict, or any change tool fails,\n"
        "    transfer to the configured Front Desk. Transfer them to the configured scheduling/front-desk\n"
        "    department. If transfer is unavailable or\n"
        "    fails, take a message with the name, callback number, and requested\n"
        "    change.\n"
        "  - If the calendar can't be reached, pivot to take_message: \"I'm having\n"
        "    trouble with the calendar — can I take your info and have someone call\n"
        "    back to confirm the time?\"\n"
        "  - NEVER fabricate a time, confirmation code, or event ID.\n"
    )


def build_system_prompt(config: BusinessConfig) -> str:
    hours_lines = []
    for day_name in [
        "monday", "tuesday", "wednesday", "thursday",
        "friday", "saturday", "sunday",
    ]:
        day_hours = getattr(config.hours, day_name)
        display_name = day_name.capitalize()
        if day_hours is None:
            hours_lines.append(f"  {display_name}: Closed")
        else:
            hours_lines.append(f"  {display_name}: {day_hours.open} - {day_hours.close}")
    hours_block = "\n".join(hours_lines)

    routing_lines = [f"  - {e.name}: {e.description}" for e in config.routing]
    routing_block = "\n".join(routing_lines) if routing_lines else "  No routing configured."

    faq_lines = [f"  Q: {faq.question}\n  A: {faq.answer}" for faq in config.faqs]
    faq_block = "\n\n".join(faq_lines) if faq_lines else "  No FAQs configured."
    services_block = "\n".join(f"  - {service}" for service in config.receptionist.services) or "  No services listed."
    escalation_block = "\n".join(f"  - {rule}" for rule in config.receptionist.escalation_rules) or "  Transfer or take a message when appropriate."
    prohibited_claims_block = "\n".join(f"  - {claim}" for claim in config.receptionist.prohibited_claims) or "  Do not invent prices, availability, policies, guarantees, or promises."

    language_block = _build_language_block(config)
    calendar_block = _build_calendar_block(config)

    return f"""You are the receptionist for {config.business.name}, a {config.business.type}.

{config.personality}

{language_block}

BUSINESS HOURS (timezone: {config.business.timezone}):
{hours_block}

When the business is closed, say: {config.after_hours_message}

DEPARTMENTS YOU CAN TRANSFER TO:
{routing_block}

When a caller asks to be transferred, use the transfer_call tool with the department name.
When a caller wants to leave a message, use the take_message tool to record their name, message, and callback number.
When asked about business hours, use the get_business_hours tool.
{calendar_block}
ENDING CALLS:
When the caller has clearly finished — for example they say "goodbye",
"thanks, bye", "that's all I needed", or you have already explained you
cannot help and they have nothing else to ask — call the end_call tool
to close the call cleanly. The tool will say a brief goodbye and then
hang up. Do NOT call end_call just because the caller is quiet for a
moment, mid-question, or asking for something you haven't tried yet.
NEVER call end_call as the very first reply to a caller; always greet
them and let them state their need first.

APPROVED RECEPTIONIST FACTS:
{config.receptionist.description or "Use only the approved FAQs, services, and routing information below."}

APPROVED SERVICES:
{services_block}

ESCALATION RULES:
{escalation_block}

PROHIBITED CLAIMS:
{prohibited_claims_block}

FREQUENTLY ASKED QUESTIONS:
{faq_block}

You can answer only these approved facts directly. For questions not covered here, offer to take a message or transfer the caller to the appropriate department.

IMPORTANT RULES:
- Be concise. Phone conversations should be efficient.
- Never make up information. If you don't know, say so and offer alternatives.
- Always confirm before transferring a call.
- If the caller seems upset, be empathetic and offer to connect them with a person.
"""
