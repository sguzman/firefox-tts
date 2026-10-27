#!/usr/bin/env python3
"""Explicit, reversible, read-only migration from Edge to Firefox pronunciation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
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
    parser.add_argument("--restore", metavar="BACKUP_FILE",
                        help="restore a previously archived Firefox pronunciation revision")
    args = parser.parse_args(argv)
    if args.replace and not args.apply:
        parser.error("--replace requires --apply")
    if args.replace and args.restore:
        parser.error("--restore and --replace cannot be combined")

    data = app_data()
    source = data / "edge-natural-tts" / "pronunciation-config.json"
    target = data / "firefox-tts" / "pronunciation-config.json"
    history = target.parent / "pronunciation-history"

    if args.restore:
        # A single basename from our own private backup directory; forbid
        # traversals, symlinks and foreign destinations.
        basename = args.restore
        if not re.fullmatch(
            r"before-(?:edge-import|restore)-[0-9]+-[0-9a-f]{12}\\.json",
            basename,
        ):
            print("Unrecognized backup filename", file=sys.stderr)
            return 2
        backup = history / basename
        if (history.is_symlink() or backup.is_symlink() or not backup.is_file():
            print("Backup missing or unsafe", file=sys.stderr)
            return 2
        if target.is_symlink() or target.parent.is_symlink():
            print("Unsafe Firefox destination", file=sys.stderr)
            return 2
        archived = backup.read_bytes()
        try:
            validate_config(archived)
        except ValueError as error:
            print(error, file=sys.stderr)
            return 2
        print(f"Restore backup: {basename}")
        print(f"SHA256: {hashlib.sha256(archived).hexdigest()}")
        if not args.apply:
            print("Dry run: no files were changed. Use --apply --restore BACKUP_FILE.")
            return 0
        if target.exists():
            previous = target.read_bytes()
            try:
                validate_config(previous)
            except ValueError as error:
                print(f"Current Firefox config invalid: {error}", file=sys.stderr)
                return 2
            name = (f"before-restore-{int(time.time() * 1000)}-"
                    f"{hashlib.sha256(previous).hexdigest()[:12]}.json")
            new_backup = history / name
            if new_backup.exists():
                print("Restore backup collision; no files changed", file=sys.stderr)
                return 2
            atomic_write(new_backup, previous)
            if new_backup.read_bytes() != previous:
                raise RuntimeError("Failed to verify pre-restore backup")
        atomic_write(target, archived)
        if target.read_bytes() != archived:
            raise RuntimeError("Restore verification failed")
        print("Firefox pronunciation restored. Edge source untouched.")
        return 0

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
