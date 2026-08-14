from __future__ import annotations

import argparse
import sys

from receptionist.config import load_app_config
from receptionist.messaging.failures import resolve_failures_dir
from receptionist.messaging.failures_cli import list_failures
from receptionist.runtime import ensure_app_runtime


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m receptionist.messaging", description="Messaging utilities.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-failures", help="List records in the canonical application failure directory.")
    args = parser.parse_args(argv)
    if args.command != "list-failures":
        parser.error(f"Unknown command: {args.command}")
    ensure_app_runtime()
    config = load_app_config()
    failures_dir = resolve_failures_dir(config.messages.channels, config.name)
    return list_failures([str(failures_dir.parent)])


if __name__ == "__main__":
    sys.exit(main())