from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path
from typing import Any

import yaml


MIGRATION_MARKER = ".single-app-migrated"

# Packaged Dad Edition builds use a private seed layout rooted at the value of
# RECEPTIONIST_SEED_ROOT:
#   .env.local
#   config/app.yaml
#   config/contacts.yaml
#   secrets/google-oauth.json
#
# These files are copied only when the corresponding runtime file is missing.
# They are never used as an update mechanism, so an installed user's changes
# and generated data survive app upgrades.


def runtime_root() -> Path:
    configured = os.environ.get("RECEPTIONIST_RUNTIME_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    # Development config resolves relative paths from config/, so setup CLIs
    # must use the same root as the canonical seed config.
    return _seed_root() / "config"


def app_config_path() -> Path:
    configured = os.environ.get("RECEPTIONIST_APP_CONFIG")
    if configured:
        return Path(configured).expanduser().resolve()
    if os.environ.get("RECEPTIONIST_RUNTIME_ROOT"):
        return runtime_root() / "config.yaml"
    return _seed_root() / "config" / "app.yaml"


def _seed_root() -> Path:
    configured = os.environ.get("RECEPTIONIST_SEED_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def _legacy_root() -> Path:
    configured = os.environ.get("RECEPTIONIST_LEGACY_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return _seed_root()


def _copy_if_missing(source: Path, target: Path) -> None:
    if source.exists() and not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def _secure_oauth_token(path: Path) -> None:
    """Keep the managed OAuth token private on Unix-like platforms.

    Git-tracked seed files normally arrive with mode 0644. ``shutil.copy2``
    preserves that mode, but Google auth rejects token files readable by
    group/other users. Normalize both newly copied and already existing
    runtime tokens so a first launch cannot fail on macOS before refresh.
    """
    if os.name == "nt" or not path.exists():
        return
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        # The auth layer will report a precise permissions error if the mode
        # cannot be tightened, without exposing token contents.
        pass


def _rewrite_paths(node: Any, root: Path) -> Any:
    if isinstance(node, dict):
        return {key: _rewrite_paths(value, root) for key, value in node.items()}
    if isinstance(node, list):
        return [_rewrite_paths(value, root) for value in node]
    return node


def _rewrite_config_paths(data: dict[str, Any], root: Path) -> dict[str, Any]:
    result = _rewrite_paths(data, root)
    result.pop("business", None)
    legacy_business = data.get("business") or {}
    for key in ("name", "type", "timezone"):
        if key not in result and key in legacy_business:
            result[key] = legacy_business[key]

    reminders = result.setdefault("reminders", {})
    if isinstance(reminders, dict):
        reminders["contacts_path"] = "contacts.yaml"
        reminders["store_path"] = "reminders.sqlite3"

    email = result.get("email")
    if isinstance(email, dict):
        sender = email.get("sender")
        if isinstance(sender, dict):
            oauth = sender.get("gmail_oauth")
            if isinstance(oauth, dict):
                oauth["oauth_token_file"] = "secrets/google-oauth.json"

    voice = result.get("voice")
    if isinstance(voice, dict):
        auth = voice.get("auth")
        if isinstance(auth, dict) and auth.get("type") == "oauth_codex":
            auth["path"] = "secrets/openai_auth.json"

    calendar = result.get("calendar")
    if isinstance(calendar, dict):
        auth = calendar.get("auth")
        if isinstance(auth, dict):
            if auth.get("type") == "oauth":
                auth["oauth_token_file"] = "secrets/google-oauth.json"
            elif auth.get("type") == "service_account":
                auth["service_account_file"] = "secrets/service-account.json"

    messages = result.get("messages")
    if isinstance(messages, dict):
        for channel in messages.get("channels", []):
            if isinstance(channel, dict) and channel.get("type") == "file":
                channel["file_path"] = "messages"

    sms = result.get("sms")
    if isinstance(sms, dict):
        provider = sms.get("provider")
        if isinstance(provider, dict) and provider.get("type") == "fake":
            provider["log_path"] = "messages/reminders-sms.log"

    return result


def ensure_app_runtime() -> Path:
    target_root = runtime_root()
    target_root.mkdir(parents=True, exist_ok=True)
    config_path = app_config_path()
    if not os.environ.get("RECEPTIONIST_RUNTIME_ROOT"):
        _copy_if_missing(
            Path.home() / ".aireceptionist" / "secrets" / "santiago" / "google-calendar-oauth.json",
            target_root / "secrets" / "google-oauth.json",
        )
        _secure_oauth_token(target_root / "secrets" / "google-oauth.json")
        return config_path

    config_path.parent.mkdir(parents=True, exist_ok=True)
    marker = target_root / MIGRATION_MARKER
    seed_root = _seed_root()
    legacy_root = _legacy_root()

    if not config_path.exists():
        seed_config = seed_root / "config" / "app.yaml"
        if not seed_config.exists():
            seed_config = seed_root / "config" / "businesses" / "santiago.yaml"
        if not seed_config.exists():
            raise FileNotFoundError(f"Canonical config seed not found under {seed_root}")

        raw = yaml.safe_load(seed_config.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise ValueError("Application config seed must be a YAML mapping")
        migrated = _rewrite_config_paths(raw, target_root)
        config_path.write_text(
            yaml.safe_dump(migrated, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    contacts = target_root / "contacts.yaml"
    _copy_if_missing(seed_root / "config" / "contacts.yaml", contacts)
    _copy_if_missing(seed_root / "config" / "businesses" / "santiago-contacts.yaml", contacts)
    _copy_if_missing(seed_root / ".env.local", target_root / ".env.local")
    _copy_if_missing(seed_root / "secrets" / "google-oauth.json", target_root / "secrets" / "google-oauth.json")
    _copy_if_missing(
        seed_root / "config" / "secrets" / "google-oauth.json",
        target_root / "secrets" / "google-oauth.json",
    )
    _copy_if_missing(legacy_root / "messages" / "santiago-reminders.sqlite3", target_root / "reminders.sqlite3")
    _copy_if_missing(
        Path.home() / ".aireceptionist" / "secrets" / "santiago" / "google-calendar-oauth.json",
        target_root / "secrets" / "google-oauth.json",
    )
    _secure_oauth_token(target_root / "secrets" / "google-oauth.json")
    marker.write_text("single-app migration complete\n", encoding="utf-8")
    return config_path
