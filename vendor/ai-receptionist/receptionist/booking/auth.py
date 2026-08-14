# receptionist/booking/auth.py
from __future__ import annotations

import logging
import os
import stat
import sys
import tempfile
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials

from receptionist.config import CalendarAuth, OAuthAuth, ServiceAccountAuth

logger = logging.getLogger("receptionist")

# Least-privilege: we read free/busy and create events. Not full calendar.
# - calendar.events: create/edit events on calendars we have access to
# - calendar.freebusy: query free/busy on calendars (events scope alone is
#   not sufficient Ã¢â‚¬â€ Google treats freeBusy as a calendar-level op).
SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/gmail.send",
]


class CalendarAuthError(Exception):
    """Raised when calendar credentials can't be loaded or refreshed."""


def _expand_path(path_str: str) -> Path:
    return Path(path_str).expanduser()


def build_credentials(auth: CalendarAuth):
    """Build a google-auth Credentials object from a CalendarAuth config.

    Raises CalendarAuthError with a clear message on any failure.
    """
    if isinstance(auth, ServiceAccountAuth):
        return _build_service_account(auth)
    if isinstance(auth, OAuthAuth):
        return _build_oauth(auth)
    raise CalendarAuthError(f"Unknown calendar auth type: {type(auth).__name__}")


def _build_service_account(auth: ServiceAccountAuth):
    path = _expand_path(auth.service_account_file)
    if not path.exists():
        raise CalendarAuthError(
            f"Service account key not found: {auth.service_account_file}"
        )
    try:
        return service_account.Credentials.from_service_account_file(
            str(path), scopes=SCOPES,
        )
    except Exception as e:
        raise CalendarAuthError(f"Failed to load service account key: {e}") from e


def _build_oauth(auth: OAuthAuth):
    path = _expand_path(auth.oauth_token_file)
    if not path.exists():
        raise CalendarAuthError(
            f"OAuth token file not found: {auth.oauth_token_file}. "
            f"Run `python -m receptionist.booking setup` first."
        )
    _check_token_permissions(path)
    try:
        creds = Credentials.from_authorized_user_file(str(path), SCOPES)
    except Exception as e:
        raise CalendarAuthError(f"Failed to load OAuth token: {e}") from e

    # Refresh if expired and we have a refresh token
    if not creds.valid and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _persist_credentials(path, creds)
        except Exception as e:
            raise CalendarAuthError(f"Failed to refresh OAuth token: {e}") from e

    return creds

def _persist_credentials(path: Path, creds: Credentials) -> None:
    """Persist refreshed credentials without leaving a partially written token."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        serialized = creds.to_json()
        if not isinstance(serialized, str):
            os.close(fd)
            logger.warning("Refreshed Calendar credentials did not provide JSON; leaving existing token unchanged")
            return
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
        Path(temp_name).replace(path)
    finally:
        temp_path = Path(temp_name)
        if temp_path.exists():
            temp_path.unlink()


_WINDOWS_ACL_WARNED: set[str] = set()


def _is_within_directory(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _check_token_permissions(path: Path) -> None:
    """Reject OAuth token files with world/group-readable permissions on Unix.

    On Windows, POSIX mode bits don't apply and stdlib has no NTFS-ACL
    inspection without an external lib (pywin32). Instead of silently
    no-op'ing, warn only when the file sits outside the current user's
    profile directory. Token files under %USERPROFILE%\\... are treated as
    sufficiently private for this desktop workflow.
    """
    if sys.platform == "win32":
        resolved = path.resolve()
        home = Path.home().resolve()
        if _is_within_directory(resolved, home):
            return
        key = str(resolved)
        if key not in _WINDOWS_ACL_WARNED:
            _WINDOWS_ACL_WARNED.add(key)
            logger.warning(
                "Windows: OAuth token ACL not enforced for %s. "
                "stdlib can't inspect NTFS ACLs; ensure the token file lives "
                "in a user-only directory (e.g. under %%USERPROFILE%%) and "
                "is not on a shared drive.",
                resolved,
            )
        return
    mode = path.stat().st_mode
    # Bits we care about: group + other read/write/exec. Owner bits are fine.
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise CalendarAuthError(
            f"OAuth token file has overly permissive permissions: {oct(mode & 0o777)}. "
            f"Run `chmod 0600 {path}` and try again."
        )
