# receptionist/messaging/channels/email.py
from __future__ import annotations

import logging

from receptionist.config import EmailChannel as EmailChannelConfig, EmailConfig, MessageTemplatesConfig
from receptionist.email.sender import EmailSendError, EmailSender
from receptionist.email.gmail_oauth import GmailOAuthSender
from receptionist.email.resend import ResendSender
from receptionist.email.smtp import SMTPSender
from receptionist.email.templates import (
    build_booking_email,
    build_call_end_email,
    build_message_email,
)
from receptionist.messaging.models import Message, DispatchContext
from receptionist.messaging.retry import retry_with_backoff, RetryPolicy
from receptionist.transcript.metadata import CallMetadata

logger = logging.getLogger("receptionist")


def _build_sender(email_config: EmailConfig) -> EmailSender:
    if email_config.sender.type == "smtp":
        assert email_config.sender.smtp is not None
        return SMTPSender(email_config.sender.smtp)
    if email_config.sender.type == "resend":
        assert email_config.sender.resend is not None
        return ResendSender(email_config.sender.resend)
    if email_config.sender.type == "gmail_oauth":
        assert email_config.sender.gmail_oauth is not None
        return GmailOAuthSender(email_config.sender.gmail_oauth)
    raise ValueError(f"Unknown email sender type: {email_config.sender.type}")


class EmailChannel:
    def __init__(
        self,
        channel_config: EmailChannelConfig,
        email_config: EmailConfig,
        message_templates: MessageTemplatesConfig | None = None,
        default_transfer_number: str = "",
        initial_delay: float = 1.0,
    ) -> None:
        self.channel_config = channel_config
        self.email_config = email_config
        self.sender: EmailSender = _build_sender(email_config)
        self.message_templates = message_templates
        self.default_transfer_number = default_transfer_number
        self.policy = RetryPolicy(max_attempts=3, initial_delay=initial_delay, factor=2.0)

    async def deliver(self, message: Message, context: DispatchContext) -> None:
        subject, body_text, body_html = build_message_email(
            message,
            context,
            include_transcript=self.channel_config.include_transcript,
            include_recording_link=self.channel_config.include_recording_link,
            templates=self.message_templates,
            default_transfer_number=self.default_transfer_number,
        )
        await self._send_with_retry(subject, body_text, body_html, recipients=self.channel_config.to)

    async def deliver_call_end(
        self, metadata: CallMetadata, context: DispatchContext
    ) -> None:
        subject, body_text, body_html = build_call_end_email(
            metadata,
            context,
            include_transcript=self.channel_config.include_transcript,
            include_recording_link=self.channel_config.include_recording_link,
            templates=self.message_templates,
            default_transfer_number=self.default_transfer_number,
        )
        await self._send_with_retry(subject, body_text, body_html, recipients=self.channel_config.to)

    async def deliver_booking(
        self, metadata: CallMetadata, context: DispatchContext
    ) -> None:
        subject, body_text, body_html = build_booking_email(
            metadata,
            context,
            templates=self.message_templates,
            default_transfer_number=self.default_transfer_number,
        )
        recipients = self._booking_recipients(metadata)
        if not recipients:
            logger.info(
                "Skipping booking email: no attendee email on appointment",
                extra={"call_id": metadata.call_id, "component": "email.booking"},
            )
            return
        await self._send_with_retry(subject, body_text, body_html, recipients=recipients)

    def _booking_recipients(self, metadata: CallMetadata) -> list[str]:
        details = metadata.appointment_details or {}
        attendee_email = (details.get("attendee_email") or "").strip()
        if attendee_email:
            return [attendee_email]
        return []

    async def _send_with_retry(
        self, subject: str, body_text: str, body_html: str, *, recipients: list[str]
    ) -> None:
        async def _send() -> None:
            if self.email_config.from_ is None:
                raise ValueError("email.from is required")
            await self.sender.send(
                from_=self.email_config.from_,
                to=recipients,
                subject=subject,
                body_text=body_text,
                body_html=body_html,
            )

        await retry_with_backoff(
            _send,
            self.policy,
            is_transient=lambda e: isinstance(e, EmailSendError) and e.transient,
        )
