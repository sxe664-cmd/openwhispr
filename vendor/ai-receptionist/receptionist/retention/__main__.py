from __future__ import annotations

import argparse
import logging
import sys

from receptionist.config import load_app_config
from receptionist.retention.sweeper import sweep_business
from receptionist.runtime import ensure_app_runtime

logger = logging.getLogger("receptionist")


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m receptionist.retention", description="Retention utilities for application artifacts.")
    sub = parser.add_subparsers(dest="command", required=True)
    sweep = sub.add_parser("sweep", help="Delete artifacts older than configured TTL.")
    sweep.add_argument("--dry-run", action="store_true")
    sweep.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)
    if args.command != "sweep":
        parser.error(f"Unknown command: {args.command}")
    ensure_app_runtime()
    config = load_app_config()
    results = sweep_business(config, dry_run=args.dry_run)
    total_deleted = 0
    total_errors = 0
    for label, result in results.items():
        if args.dry_run:
            print(f"[{label}] would delete {len(result.would_delete)}, keep {len(result.kept)}")
        else:
            print(f"[{label}] deleted {len(result.deleted)}, kept {len(result.kept)}, errors {len(result.errors)}")
            total_deleted += len(result.deleted)
            total_errors += len(result.errors)
            for path, exc in result.errors:
                print(f"error on {path}: {exc}", file=sys.stderr)
    if not args.dry_run:
        print(f"Total deleted: {total_deleted}, total errors: {total_errors}")
    return 1 if total_errors else 0


if __name__ == "__main__":
    sys.exit(main())