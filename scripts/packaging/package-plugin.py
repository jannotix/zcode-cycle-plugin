#!/usr/bin/env python3
"""Build the deterministic ZCode plugin ZIP used by the official marketplace."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ZIP_DATE = (2026, 1, 1, 0, 0, 0)
MAX_FILES = 5_000
MAX_BYTES = 256 * 1024 * 1024


def regular_files(root: Path) -> list[Path]:
    if root.is_symlink():
        raise ValueError("plugin directory is a symlink")
    files: list[Path] = []
    total = 0
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"plugin contains symlink: {path.relative_to(root)}")
        if path.is_file():
            files.append(path)
            total += path.stat().st_size
    if len(files) > MAX_FILES:
        raise ValueError(f"plugin contains {len(files)} files; maximum is {MAX_FILES}")
    if total > MAX_BYTES:
        raise ValueError(f"plugin contains {total} bytes; maximum is {MAX_BYTES}")
    return files


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    plugin = args.plugin.resolve(strict=True)
    output = args.output.resolve()
    manifest = json.loads((plugin / ".zcode-plugin" / "plugin.json").read_text(encoding="utf-8"))
    if manifest.get("name") != "zcode-cycle":
        raise ValueError("plugin manifest identity is not zcode-cycle")

    files = regular_files(plugin)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            relative = path.relative_to(plugin).as_posix()
            info = zipfile.ZipInfo(f"zcode-cycle/{relative}", date_time=ZIP_DATE)
            # Match the official ZCode builder byte for byte.
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())

    digest = sha256(output)
    output.with_suffix(f"{output.suffix}.sha256").write_text(
        f"{digest}  {output.name}\n", encoding="utf-8"
    )
    print(json.dumps({"archive": str(output), "files": len(files), "sha256": digest}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
