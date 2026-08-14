from __future__ import annotations

import html
from string import Formatter

from receptionist.config import BusinessConfig, DEFAULT_GOOGLE_REVIEW_URL
from receptionist.reminders.models import AppointmentEvent, ReminderRecipient


def format_when(event: AppointmentEvent) -> str:
    # Windows' strftime does not support %-d / %-I.
    return event.start.strftime("%A, %B %d at %I:%M %p").replace(" 0", " ").replace(" at 0", " at ")


def _context(
    config: BusinessConfig,
    event: AppointmentEvent,
    recipient: ReminderRecipient | None = None,
    offset_days: int | None = None,
) -> dict[str, str | int]:
    return {
        "business_name": config.business.name,
        "recipient_name": recipient_name_for_message(event, recipient),
        "appointment_time": format_when(event),
        "offset_days": offset_days or 0,
        "default_transfer_number": config.communications.default_transfer_number or "",
    }


def recipient_name_for_message(
    event: AppointmentEvent,
    recipient: ReminderRecipient | None = None,
) -> str:
    title = event.summary.strip()
    if title and title.lower() != "appointment":
        return title
    return recipient.display_name if recipient else ""


def _render(template: str | None, context: dict[str, str | int]) -> str | None:
    if not template:
        return None
    allowed = set(context)
    fields = {
        field_name.split(".", 1)[0].split("[", 1)[0]
        for _, field_name, _, _ in Formatter().parse(template)
        if field_name
    }
    unknown = sorted(fields - allowed)
    if unknown:
        raise ValueError(
            "Unknown message template placeholder(s): "
            + ", ".join(f"{{{name}}}" for name in unknown)
        )
    return template.format(**context)


def _html_from_text(text: str) -> str:
    return "".join(f"<p>{html.escape(part, quote=True)}</p>" for part in text.split("\n\n"))


def build_reminder_email(
    config: BusinessConfig, event: AppointmentEvent, recipient: ReminderRecipient, offset_days: int
) -> tuple[str, str, str]:
    ctx = _context(config, event, recipient, offset_days)
    templates = config.message_templates
    subject = _render(templates.reminder_email_subject, ctx) or f"Appointment reminder: {format_when(event)}"
    name = recipient_name_for_message(event, recipient)
    body_text = _render(templates.reminder_email_text, ctx) or (
        f"Hi {name},\n\n"
        f"This is a reminder from {config.business.name} about your appointment "
        f"on {format_when(event)}.\n\n"
        f"If you need to make changes, please call us.\n"
    )
    configured_html = _render(templates.reminder_email_html, ctx)
    if configured_html:
        return subject, body_text, configured_html
    e = lambda s: html.escape(str(s), quote=True)
    body_html = (
        f"<p>Hi {e(name)},</p>"
        f"<p>This is a reminder from <strong>{e(config.business.name)}</strong> "
        f"about your appointment on <strong>{e(format_when(event))}</strong>.</p>"
        f"<p>If you need to make changes, please call us.</p>"
    )
    return subject, body_text, body_html


def build_reminder_sms(
    config: BusinessConfig,
    event: AppointmentEvent,
    offset_days: int,
    recipient: ReminderRecipient | None = None,
) -> str:
    ctx = _context(config, event, recipient, offset_days=offset_days)
    return _render(config.message_templates.reminder_sms, ctx) or (
        f"{config.business.name}: reminder for your appointment on {format_when(event)}. "
        f"Reply STOP to opt out. Reply HELP for help."
    )


def build_confirmation_email(
    config: BusinessConfig, event: AppointmentEvent, recipient: ReminderRecipient
) -> tuple[str, str, str]:
    ctx = _context(config, event, recipient)
    templates = config.message_templates
    subject = _render(templates.confirmation_email_subject, ctx) or f"Appointment confirmed: {format_when(event)}"
    name = recipient_name_for_message(event, recipient)
    body_text = _render(templates.confirmation_email_text, ctx) or (
        f"Hi {name},\n\n"
        f"Your appointment with {config.business.name} is confirmed for "
        f"{format_when(event)}.\n\n"
        f"If you need to make changes, please call us.\n"
    )
    configured_html = _render(templates.confirmation_email_html, ctx)
    if configured_html:
        return subject, body_text, configured_html
    e = lambda s: html.escape(str(s), quote=True)
    body_html = (
        f"<p>Hi {e(name)},</p>"
        f"<p>Your appointment with <strong>{e(config.business.name)}</strong> "
        f"is confirmed for <strong>{e(format_when(event))}</strong>.</p>"
        f"<p>If you need to make changes, please call us.</p>"
    )
    return subject, body_text, body_html


def build_confirmation_sms(
    config: BusinessConfig,
    event: AppointmentEvent,
    recipient: ReminderRecipient | None = None,
) -> str:
    ctx = _context(config, event, recipient)
    return _render(config.message_templates.confirmation_sms, ctx) or (
        f"{config.business.name}: your appointment is confirmed for {format_when(event)}. "
        f"Reply STOP to opt out. Reply HELP for help."
    )

_DEFAULT_POST_FOLLOWUP_TEMPLATES = {
    "thank_you_review": {
        "email_subject": "Thank you for visiting {business_name}",
        "email_text": (
            "Hi {recipient_name},\n\n"
            "Thank you for visiting {business_name}. We hope you’re feeling well after your appointment.\n\n"
            "If you have a moment, we’d appreciate a quick review:\n"
            f"{DEFAULT_GOOGLE_REVIEW_URL}\n\n"
            "If you have any questions or would like help planning your next visit, just reply to this email "
            "or call {default_transfer_number}.\n\n"
            "Warmly,\n{business_name}"
        ),
        "email_html": None,
        "sms": (
            f"{{business_name}}: Thanks for visiting us. We hope you’re feeling well. "
            f"If you have a moment, we’d appreciate a quick review: {DEFAULT_GOOGLE_REVIEW_URL} "
            "Reply STOP to opt out."
        ),
    },
    "thank_you_only": {
        "email_subject": "Thank you for visiting {business_name}",
        "email_text": (
            "Hi {recipient_name},\n\n"
            "Thank you for visiting {business_name}. We hope you're feeling well after your appointment.\n\n"
            "Warmly,\n{business_name}"
        ),
        "email_html": None,
        "sms": (
            "{business_name}: Thank you for visiting us. We hope you're feeling well after your appointment. "
            "Reply STOP to opt out."
        ),
    },
    "book_next_appointment": {
        "email_subject": "Ready to plan your next visit?",
        "email_text": (
            "Hi {recipient_name},\n\n"
            "When you’re ready, we’d be happy to help plan your next visit. Reply to this email or call "
            "{default_transfer_number}.\n\n"
            "Warmly,\n{business_name}"
        ),
        "email_html": None,
        "sms": (
            "{business_name}: Ready to plan your next visit? Reply here or call {default_transfer_number}. "
            "Reply STOP to opt out."
        ),
    },
}


def post_followup_template(config: BusinessConfig, preset: str) -> dict[str, str | None]:
    defaults = dict(_DEFAULT_POST_FOLLOWUP_TEMPLATES.get(preset, {}))
    nested = config.message_templates.post_followups.get(preset, {})
    # The old flat fields remain a compatibility fallback for the first preset.
    if preset == "thank_you_review" and not nested:
        nested = {
            "email_subject": config.message_templates.post_reminder_email_subject,
            "email_text": config.message_templates.post_reminder_email_text,
            "email_html": config.message_templates.post_reminder_email_html,
            "sms": config.message_templates.post_reminder_sms,
        }
    for key, value in nested.items():
        if value:
            defaults[key] = value
    return defaults


def build_post_followup_email(
    config: BusinessConfig,
    event: AppointmentEvent,
    recipient: ReminderRecipient,
    offset_days: int,
    preset: str = "thank_you_review",
) -> tuple[str, str, str]:
    ctx = _context(config, event, recipient, offset_days)
    templates = post_followup_template(config, preset)
    subject = _render(templates.get("email_subject"), ctx) or "Thank you for visiting {business_name}".format(**ctx)
    name = recipient_name_for_message(event, recipient)
    body_text = _render(templates.get("email_text"), ctx) or f"Hi {name},\n\nWe hope your appointment went well.\n"
    configured_html = _render(templates.get("email_html"), ctx)
    if configured_html:
        return subject, body_text, configured_html
    e = lambda value: html.escape(str(value), quote=True)
    body_html = (
        f"<p>Hi {e(name)},</p>"
        f"<p>{e(body_text).replace(chr(10), '<br>')}</p>"
    )
    return subject, body_text, body_html


def build_post_followup_sms(
    config: BusinessConfig,
    event: AppointmentEvent,
    offset_days: int,
    recipient: ReminderRecipient | None = None,
    preset: str = "thank_you_review",
) -> str:
    ctx = _context(config, event, recipient, offset_days=offset_days)
    templates = post_followup_template(config, preset)
    return _render(templates.get("sms"), ctx) or f"{config.business.name}: We hope your appointment went well. Reply STOP to opt out."


def build_post_reminder_email(
    config: BusinessConfig, event: AppointmentEvent, recipient: ReminderRecipient, offset_days: int
) -> tuple[str, str, str]:
    """Compatibility wrapper for callers that used the original post phase."""
    return build_post_followup_email(config, event, recipient, offset_days, "thank_you_review")


def build_post_reminder_sms(
    config: BusinessConfig,
    event: AppointmentEvent,
    offset_days: int,
    recipient: ReminderRecipient | None = None,
) -> str:
    return build_post_followup_sms(config, event, offset_days, recipient, "thank_you_review")
