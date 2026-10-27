#!/usr/bin/env python3
"""Build a deterministic, unsigned Firefox TTS XPI from tracked extension inputs."""
from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
STATIC = ("LICENSE", "manifest.json")
EXTENSIONS = {".js", ".css", ".html"}


def input_files() -> list[Path]:
    files = [ROOT / name for name in STATIC]
    files += [
        file for file in (ROOT / "src").rglob("*")
        if file.is_file() and file.suffix in EXTENSIONS
    ]
    if any(not f.is_file() for f in files):
        raise FileNotFoundError("Required extension file missing")
    return sorted(files, key=lambda f: f.relative_to(ROOT).as_posix())


def build(destination: Path) -> tuple[str, list[str]]:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise ValueError("Expected Firefox manifest V3")
    if manifest.get("content_scripts"):
        raise ValueError("Unexpected automatic content scripts")
    included = input_files()
    names = [p.relative_to(ROOT).as_posix() for p in included]
    for required in manifest["background"]["scripts"] + [manifest["options_ui"]["page"]]:
        if required not in names:
            raise ValueError(f"Missing declared extension file: {required}")
    destination = destination.expanduser().resolve()
    if ROOT in destination.parents:
        raise ValueError("Package output must be outside the repository")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, mode="w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9, strict_timestamps=True) as archive:
        for file, name in zip(included, names):
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 << 16)
            archive.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED,
                             compresslevel=9)
    return hashlib.sha256(destination.read_bytes()).hexdigest(), names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    checksum, names = build(args.output)
    print(f"Firefox TTS unsigned XPI: {args.output.resolve()}")
    print(f"Files: {len(names)}")
    print(f"SHA256: {checksum}")


if __name__ == "__main__":
    main()
