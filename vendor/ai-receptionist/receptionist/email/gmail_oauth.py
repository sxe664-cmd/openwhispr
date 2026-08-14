from __future__ import annotations

import asyncio
import base64
import logging
import os
import tempfile
from email.message import EmailMessage
from pathlib import Path
from typing import Sequence

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from receptionist.config import GmailOAuthConfig
from receptionist.email.sender import EmailAttachment, EmailSendError

logger = logging.getLogger("receptionist")

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


class GmailOAuthSender:
    def __init__(self, config: GmailOAuthConfig) -> None:
        self.config = config

    async def send(
        self,
        *,
        from_: str,
        to: Sequence[str],
        subject: str,
        body_text: str,
        body_html: str | None,
        attachments: Sequence[EmailAttachment] = (),
    ) -> None:
        await asyncio.to_thread(
            self._send_sync,
            from_=from_,
            to=to,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            attachments=attachments,
        )

    def _send_sync(
        self,
        *,
        from_: str,
        to: Sequence[str],
        subject: str,
        body_text: str,
        body_html: str | None,
        attachments: Sequence[EmailAttachment] = (),
    ) -> None:
        creds = self._load_credentials()
        try:
            service = build("gmail", "v1", credentials=creds, cache_discovery=False)
            message = self._build_message(
                from_=from_,
                to=to,
                subject=subject,
                body_text=body_text,
                body_html=body_html,
                attachments=attachments,
            )
            encoded_message = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
            service.users().messages().send(
                userId="me",
                body={"raw": encoded_message},
            ).execute()
        except HttpError as e:
            status = getattr(getattr(e, "resp", None), "status", None)
            transient = bool(status and (status >= 500 or status == 429))
            raise EmailSendError(f"Gmail API send failed: {e}", transient=transient) from e
        except EmailSendError:
            raise
        except Exception as e:
            raise EmailSendError(f"Gmail OAuth send failed: {e}", transient=True) from e

        logger.info("GmailOAuthSender sent to=%s subject=%r", list(to), subject)

    def _load_credentials(self) -> Credentials:
        token_path = Path(self.config.oauth_token_file).expanduser()
        if not token_path.exists():
            raise EmailSendError(
                f"Gmail OAuth token file not found: {self.config.oauth_token_file}",
                transient=False,
            )
        try:
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        except Exception as e:
            raise EmailSendError(f"Failed to load Gmail OAuth token: {e}", transient=False) from e

        granted_scopes = set(creds.scopes or [])
        missing_scopes = [scope for scope in SCOPES if scope not in granted_scopes]
        if missing_scopes:
            raise EmailSendError(
                "Gmail OAuth token is missing send permission. Click Connect Calendar "
                "again to reauthorize the Google account with Gmail access.",
                transient=False,
            )

        if not creds.valid and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                self._persist_credentials(token_path, creds)
            except Exception as e:
                raise EmailSendError(f"Failed to refresh Gmail OAuth token: {e}", transient=False) from e
        return creds

    @staticmethod
    def _persist_credentials(path: Path, creds: Credentials) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            serialized = creds.to_json()
            if not isinstance(serialized, str):
                os.close(fd)
                logger.warning("Refreshed Gmail credentials did not provide JSON; leaving existing token unchanged")
                return
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(serialized)
                handle.flush()
            Path(temp_name).replace(path)
        finally:
            temp_path = Path(temp_name)
            if temp_path.exists():
                temp_path.unlink()

    def _build_message(
        self,
        *,
        from_: str,
        to: Sequence[str],
        subject: str,
        body_text: str,
        body_html: str | None,
        attachments: Sequence[EmailAttachment] = (),
    ) -> EmailMessage:
        msg = EmailMessage()
        msg["From"] = from_
        msg["To"] = ", ".join(to)
        msg["Subject"] = subject
        msg.set_content(body_text)
        if body_html is not None:
            msg.add_alternative(body_html, subtype="html")
        for att in attachments:
            maintype, _, subtype = att.content_type.partition("/")
            subtype = subtype or "octet-stream"
            msg.add_attachment(
                att.content,
                maintype=maintype or "application",
                subtype=subtype,
                filename=att.filename,
            )
        return msg
