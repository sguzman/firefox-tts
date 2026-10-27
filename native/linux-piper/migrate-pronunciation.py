#!/usr/bin/env python3
"""Explicit, reversible, read-only migration from Edge to Firefox pronunciation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path


def app_data() -> Path:
    return Path(os.environ.get(
        "XDG_DATA_HOME", Path.home() / ".local" / "share"
    )).expanduser()


def validate_config(data: bytes) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid source JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("Pronunciation configuration must be a JSON object")
    if not isinstance(value.get("revision"), (int, float)) or value["revision"] < 0:
        raise ValueError("Pronunciation configuration has no valid revision")
    return value


def atomic_write(path: Path, contents: bytes) -> None:
    # No writes to the existing Edge voice/config/runtime tree.
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        try:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
            os.chmod(handle.name, 0o600)
            staged = Path(handle.name)
        except Exception:
            Path(handle.name).unlink(missing_ok=True)
            raise
    try:
        staged.replace(path)
    finally:
        staged.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="actually copy; otherwise only validate and display a plan")
    parser.add_argument("--replace", action="store_true",
                        help="on --apply, archive existing Firefox settings before replacing")
    args = parser.parse_args(argv)
    if args.replace and not args.apply:
        parser.error("--replace requires --apply")

    data = app_data()
    source = data / "edge-natural-tts" / "pronunciation-config.json"
    target = data / "firefox-tts" / "pronunciation-config.json"
    history = target.parent / "pronunciation-history"

    if not source.is_file():
        print(f"Source Edge pronunciation configuration not found: {source}", file=sys.stderr)
        return 2
    if target.is_symlink() or target.parent.is_symlink():
        print("Refusing Firefox symlink destination; use a normal directory", file=sys.stderr)
        return 2
    if source.resolve() == target.resolve():
        print("Refusing to copy source over itself", file=sys.stderr)
        return 2

    raw = source.read_bytes()
    try:
        incoming = validate_config(raw)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    print(f"Source revision: {incoming['revision']}")
    print(f"Source SHA256: {hashlib.sha256(raw).hexdigest()}")
    print(f"Destination: {target}")

    if target.exists() and not args.replace:
        print("Firefox configuration already exists. Nothing modified. "
              "Use --apply --replace only if you intend to archive and replace it.",
              file=sys.stderr)
        return 2

    if not args.apply:
        print("Dry run: no files were changed. Repeat with --apply to migrate.")
        return 0

    if target.exists():
        previous = target.read_bytes()
        # Check the old Firefox config before archiving; never silently discard.
        validate_config(previous)
        history.mkdir(parents=True, exist_ok=True)
        name = (f"before-edge-import-{int(time.time() * 1000)}-"
                f"{hashlib.sha256(previous).hexdigest()[:12]}.json")
        backup = history / name
        if backup.exists():
            print("Backup collision; no files changed", file=sys.stderr)
            return 2
        atomic_write(backup, previous)
        if backup.read_bytes() != previous:
            raise RuntimeError("Backup verification failed; refusing replacement")

    atomic_write(target, raw)
    if target.read_bytes() != raw:
        raise RuntimeError("Post-write verification failed")
    print("Firefox pronunciation config imported. Edge source was read only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
