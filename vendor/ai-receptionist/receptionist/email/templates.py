# receptionist/email/templates.py
from __future__ import annotations

import html
from string import Formatter

from receptionist.config import MessageTemplatesConfig
from receptionist.messaging.models import DispatchContext, Message
from receptionist.transcript.metadata import CallMetadata


# Human-readable display labels for outcome values. Keep in sync with
# VALID_OUTCOMES in receptionist/transcript/metadata.py.
_OUTCOME_LABELS = {
    "hung_up": "Hung up",
    "message_taken": "Message taken",
    "transferred": "Transferred",
    "appointment_booked": "Appointment booked",
    "agent_ended": "Agent ended",
}


def _subject_safe(value: str | None) -> str:
    return " ".join((value or "").replace("\r", " ").replace("\n", " ").replace("\x00", " ").split())


def _outcomes_display(
    outcomes: set[str] | list[str], *, transfer_target: str | None = None,
) -> str:
    if not outcomes:
        return "Unknown"
    labels = []
    for outcome in sorted(outcomes):
        if outcome == "transferred" and transfer_target:
            labels.append(f"Transferred to {transfer_target}")
        else:
            labels.append(_OUTCOME_LABELS.get(outcome, outcome))
    return " + ".join(labels)


def _render_template(template: str | None, context: dict[str, str]) -> str | None:
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


def build_message_email(
    message: Message,
    context: DispatchContext,
    *,
    include_transcript: bool = True,
    include_recording_link: bool = True,
    templates: MessageTemplatesConfig | None = None,
    default_transfer_number: str = "",
) -> tuple[str, str, str]:
    template_ctx = {
        "business_name": message.business_name,
        "caller_name": message.caller_name,
        "callback_number": message.callback_number,
        "received_at": message.timestamp,
        "message_text": message.message,
        "recording_url": context.recording_url or "",
        "transcript_path": context.transcript_markdown_path or "",
        "default_transfer_number": default_transfer_number or "",
    }

    subject = _render_template(
        templates.message_email_subject if templates else None,
        template_ctx,
    ) or f"New message from {_subject_safe(message.caller_name)} - {_subject_safe(message.business_name)}"

    body_text_default = (
        f"A caller left a message for {message.business_name}.\n"
        f"\n"
        f"Caller: {message.caller_name}\n"
        f"Callback: {message.callback_number}\n"
        f"Received: {message.timestamp}\n"
        f"\n"
        f"Message:\n"
        f"{message.message}\n"
    )
    if include_recording_link and context.recording_url:
        body_text_default += f"\nRecording: {context.recording_url}\n"
    if include_transcript and context.transcript_markdown_path:
        body_text_default += f"Transcript: {context.transcript_markdown_path}\n"
        content, err = _read_transcript(context.transcript_markdown_path)
        if content is not None:
            body_text_default += "\n--- Transcript ---\n"
            body_text_default += content
            if not content.endswith("\n"):
                body_text_default += "\n"
            body_text_default += "--- End transcript ---\n"
        else:
            body_text_default += f"({err})\n"
    body_text = _render_template(
        templates.message_email_text if templates else None,
        template_ctx,
    ) or body_text_default

    def e(s: str | None) -> str:
        return html.escape(s or "", quote=True)

    body_html_default = (
        f"<p>A caller left a message for <strong>{e(message.business_name)}</strong>.</p>"
        f"<table cellpadding='4'>"
        f"<tr><td><strong>Caller</strong></td><td>{e(message.caller_name)}</td></tr>"
        f"<tr><td><strong>Callback</strong></td><td>{e(message.callback_number)}</td></tr>"
        f"<tr><td><strong>Received</strong></td><td>{e(message.timestamp)}</td></tr>"
        f"</table>"
        f"<h3>Message</h3>"
        f"<blockquote>{e(message.message)}</blockquote>"
    )
    if include_recording_link and context.recording_url:
        body_html_default += f"<p><strong>Recording:</strong> <a href='{e(context.recording_url)}'>{e(context.recording_url)}</a></p>"
    if include_transcript and context.transcript_markdown_path:
        body_html_default += f"<p><strong>Transcript:</strong> {e(context.transcript_markdown_path)}</p>"
        content, err = _read_transcript(context.transcript_markdown_path)
        if content is not None:
            body_html_default += (
                "<hr><h3>Transcript</h3>"
                f"<pre style='white-space:pre-wrap;font-family:monospace'>{e(content)}</pre>"
            )
        else:
            body_html_default += f"<p><em>({e(err)})</em></p>"

    body_html = _render_template(
        templates.message_email_html if templates else None,
        template_ctx,
    ) or body_html_default

    return subject, body_text, body_html


def _read_transcript(path: str) -> tuple[str | None, str | None]:
    try:
        from pathlib import Path

        return Path(path).read_text(encoding="utf-8"), None
    except (OSError, UnicodeDecodeError):
        return None, "transcript_unavailable"


def build_call_end_email(
    metadata: CallMetadata,
    context: DispatchContext,
    *,
    include_transcript: bool = True,
    include_recording_link: bool = True,
    templates: MessageTemplatesConfig | None = None,
    default_transfer_number: str = "",
) -> tuple[str, str, str]:
    outcomes_str = _outcomes_display(metadata.outcomes)
    subject_outcomes = _outcomes_display(
        metadata.outcomes, transfer_target=metadata.transfer_target,
    )

    template_ctx = {
        "business_name": metadata.business_name,
        "caller_phone": metadata.caller_phone or "Unknown",
        "start_ts": metadata.start_ts,
        "end_ts": metadata.end_ts or "(in progress)",
        "duration": _format_duration(metadata.duration_seconds),
        "outcomes": outcomes_str,
        "transfer_target": metadata.transfer_target or "",
        "agent_end_reason": metadata.agent_end_reason or "",
        "appointment_start": (metadata.appointment_details or {}).get("start_iso", ""),
        "appointment_end": (metadata.appointment_details or {}).get("end_iso", ""),
        "appointment_link": (metadata.appointment_details or {}).get("html_link", ""),
        "faqs_answered": ", ".join(metadata.faqs_answered),
        "languages": ", ".join(sorted(metadata.languages_detected)),
        "recording_url": context.recording_url or "",
        "transcript_path": context.transcript_markdown_path or "",
        "call_id": metadata.call_id,
        "default_transfer_number": default_transfer_number or "",
    }

    subject = _render_template(
        templates.call_end_email_subject if templates else None,
        template_ctx,
    ) or (
        f"Call from {_subject_safe(metadata.caller_phone or 'Unknown')} - "
        f"{_subject_safe(subject_outcomes)} [{_subject_safe(metadata.business_name)}]"
    )

    duration_str = _format_duration(metadata.duration_seconds)

    body_text_default = (
        f"Call summary for {metadata.business_name}.\n"
        f"\n"
        f"Caller: {metadata.caller_phone or 'Unknown'}\n"
        f"Start: {metadata.start_ts}\n"
        f"End: {metadata.end_ts or '(in progress)'}\n"
        f"Duration: {duration_str}\n"
        f"Outcomes: {outcomes_str}\n"
    )
    if metadata.transfer_target:
        body_text_default += f"Transferred to: {metadata.transfer_target}\n"
    if metadata.agent_end_reason:
        body_text_default += f"Agent end reason: {metadata.agent_end_reason}\n"
    if metadata.appointment_details:
        body_text_default += (
            f"Appointment: {metadata.appointment_details.get('start_iso', '?')}\n"
            f"  {metadata.appointment_details.get('html_link', '')}\n"
        )
    if metadata.faqs_answered:
        body_text_default += f"FAQs answered: {', '.join(metadata.faqs_answered)}\n"
    if metadata.languages_detected:
        body_text_default += f"Languages: {', '.join(sorted(metadata.languages_detected))}\n"
    if include_recording_link:
        if metadata.recording_failed:
            body_text_default += "\nRecording: failed\n"
        elif context.recording_url:
            body_text_default += f"\nRecording: {context.recording_url}\n"
    if include_transcript and context.transcript_markdown_path:
        body_text_default += f"Transcript: {context.transcript_markdown_path}\n"
        content, err = _read_transcript(context.transcript_markdown_path)
        if content is not None:
            body_text_default += "\n--- Transcript ---\n"
            body_text_default += content
            if not content.endswith("\n"):
                body_text_default += "\n"
            body_text_default += "--- End transcript ---\n"
        else:
            body_text_default += f"({err})\n"

    body_text = _render_template(
        templates.call_end_email_text if templates else None,
        template_ctx,
    ) or body_text_default

    def e(s: object) -> str:
        return html.escape(str(s) if s is not None else "", quote=True)

    body_html_default = (
        f"<h2>Call summary - {e(metadata.business_name)}</h2>"
        f"<table cellpadding='4'>"
        f"<tr><td><strong>Caller</strong></td><td>{e(metadata.caller_phone or 'Unknown')}</td></tr>"
        f"<tr><td><strong>Start</strong></td><td>{e(metadata.start_ts)}</td></tr>"
        f"<tr><td><strong>End</strong></td><td>{e(metadata.end_ts or '(in progress)')}</td></tr>"
        f"<tr><td><strong>Duration</strong></td><td>{e(duration_str)}</td></tr>"
        f"<tr><td><strong>Outcomes</strong></td><td>{e(outcomes_str)}</td></tr>"
    )
    if metadata.transfer_target:
        body_html_default += f"<tr><td><strong>Transferred to</strong></td><td>{e(metadata.transfer_target)}</td></tr>"
    if metadata.agent_end_reason:
        body_html_default += f"<tr><td><strong>Agent end reason</strong></td><td>{e(metadata.agent_end_reason)}</td></tr>"
    if metadata.appointment_details:
        start_iso = metadata.appointment_details.get("start_iso", "?")
        html_link = metadata.appointment_details.get("html_link", "")
        appointment = e(start_iso)
        if html_link:
            appointment += f"<br><a href='{e(html_link)}'>{e(html_link)}</a>"
        body_html_default += f"<tr><td><strong>Appointment</strong></td><td>{appointment}</td></tr>"
    if metadata.faqs_answered:
        body_html_default += f"<tr><td><strong>FAQs answered</strong></td><td>{e(', '.join(metadata.faqs_answered))}</td></tr>"
    if metadata.languages_detected:
        body_html_default += f"<tr><td><strong>Languages</strong></td><td>{e(', '.join(sorted(metadata.languages_detected)))}</td></tr>"
    body_html_default += "</table>"
    if include_recording_link:
        if metadata.recording_failed:
            body_html_default += "<p><strong>Recording:</strong> failed</p>"
        elif context.recording_url:
            body_html_default += f"<p><strong>Recording:</strong> <a href='{e(context.recording_url)}'>{e(context.recording_url)}</a></p>"
    if include_transcript and context.transcript_markdown_path:
        body_html_default += f"<p><strong>Transcript:</strong> {e(context.transcript_markdown_path)}</p>"
        content, err = _read_transcript(context.transcript_markdown_path)
        if content is not None:
            body_html_default += (
                "<hr><h3>Transcript</h3>"
                f"<pre style='white-space:pre-wrap;font-family:monospace'>{e(content)}</pre>"
            )
        else:
            body_html_default += f"<p><em>({e(err)})</em></p>"

    body_html = _render_template(
        templates.call_end_email_html if templates else None,
        template_ctx,
    ) or body_html_default

    return subject, body_text, body_html


def build_booking_email(
    metadata: CallMetadata,
    context: DispatchContext,
    *,
    templates: MessageTemplatesConfig | None = None,
    default_transfer_number: str = "",
) -> tuple[str, str, str]:
    details = metadata.appointment_details or {}
    start_iso = details.get("start_iso", "?")
    html_link = details.get("html_link", "")
    caller = metadata.caller_phone or "Unknown"

    template_ctx = {
        "business_name": metadata.business_name,
        "caller_phone": caller,
        "appointment_start": start_iso,
        "appointment_end": details.get("end_iso", "?"),
        "appointment_link": html_link,
        "call_id": metadata.call_id,
        "transcript_path": context.transcript_markdown_path or "",
        "recording_url": context.recording_url or "",
        "default_transfer_number": default_transfer_number or "",
    }

    subject = _render_template(
        templates.booking_email_subject if templates else None,
        template_ctx,
    ) or f"New appointment booked: {_subject_safe(caller)} - {_subject_safe(start_iso)} [{_subject_safe(metadata.business_name)}]"

    body_text_default = (
        f"A new appointment has been booked for {metadata.business_name}.\n"
        f"\n"
        f"Caller: {caller}\n"
        f"Start: {start_iso}\n"
        f"End: {details.get('end_iso', '?')}\n"
        f"Event: {html_link}\n"
        f"Call ID: {metadata.call_id}\n"
        f"\n"
        f"Note: The caller's identity was NOT verified. Please confirm by calling "
        f"back at {caller} before relying on this booking.\n"
    )
    if context.transcript_markdown_path:
        body_text_default += f"\nCall transcript: {context.transcript_markdown_path}\n"
    if context.recording_url:
        body_text_default += f"Recording: {context.recording_url}\n"

    body_text = _render_template(
        templates.booking_email_text if templates else None,
        template_ctx,
    ) or body_text_default

    def e(s: object) -> str:
        return html.escape(str(s) if s is not None else "", quote=True)

    body_html_default = (
        f"<h2>New appointment booked - {e(metadata.business_name)}</h2>"
        f"<table cellpadding='4'>"
        f"<tr><td><strong>Caller</strong></td><td>{e(caller)}</td></tr>"
        f"<tr><td><strong>Start</strong></td><td>{e(start_iso)}</td></tr>"
        f"<tr><td><strong>End</strong></td><td>{e(details.get('end_iso', '?'))}</td></tr>"
        f"<tr><td><strong>Call ID</strong></td><td>{e(metadata.call_id)}</td></tr>"
        f"</table>"
    )
    if html_link:
        body_html_default += f"<p><a href='{e(html_link)}'>Open in Google Calendar</a></p>"
    body_html_default += (
        f"<p><em>The caller's identity was NOT verified. Please confirm by calling back "
        f"at {e(caller)} before relying on this booking.</em></p>"
    )
    if context.transcript_markdown_path:
        body_html_default += f"<p><strong>Transcript:</strong> {e(context.transcript_markdown_path)}</p>"
    if context.recording_url:
        body_html_default += f"<p><strong>Recording:</strong> <a href='{e(context.recording_url)}'>{e(context.recording_url)}</a></p>"

    body_html = _render_template(
        templates.booking_email_html if templates else None,
        template_ctx,
    ) or body_html_default

    return subject, body_text, body_html


def _format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    m, s = divmod(int(seconds), 60)
    return f"{m}:{s:02d}"
