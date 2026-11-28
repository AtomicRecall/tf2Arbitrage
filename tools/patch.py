#!/usr/bin/env python
"""Exact-match file patcher that keeps each file's line endings and BOM.

The repo mixes CRLF and LF files and some files start with a UTF-8 BOM, and a
whole-file rewrite would turn every line into a diff. This helper replaces exact
text instead: each `old` string must appear exactly once, otherwise nothing in
that file is written.

Use it from a throwaway script:

    import sys; sys.path.insert(0, "tools")
    from patch import edit
    edit("tf2_trade_arbitrage_prototype/background.js", [
        ("const MIN_PROFIT_REF=0.05;", "const MIN_PROFIT_REF=0.06;"),
    ])

or from the command line with a JSON spec:

    python tools/patch.py spec.json

where spec.json is  [{"file": "path", "replace": [["old", "new"], ...]}, ...].
Paths are relative to the repo root (the folder above tools/). Write `old` and
`new` with plain "\n" newlines; the file's own line endings are restored on save.
"""
import json
import os
import shutil
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def edit(path, pairs, root=ROOT):
    """Replace each (old, new) pair in `path`; every `old` must occur exactly once."""
    full = path if os.path.isabs(path) else os.path.join(root, path)
    with open(full, "r", encoding="utf-8", newline="") as handle:
        raw = handle.read()
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n")
    for index, (old, new) in enumerate(pairs, 1):
        old = old.replace("\r\n", "\n")
        new = new.replace("\r\n", "\n")
        found = text.count(old)
        if found != 1:
            raise SystemExit(
                f"{path}: replacement {index} matched {found} times (need exactly 1): {old[:80]!r}"
            )
        text = text.replace(old, new)
    # A BOM, if the file had one, is part of `text` and is written back unchanged.
    out = text.replace("\n", "\r\n") if crlf else text
    temporary = full + ".tmp"
    with open(temporary, "w", encoding="utf-8", newline="") as handle:
        handle.write(out)
    # The temporary file would otherwise drop the original's permissions (the .command launcher's executable bit).
    shutil.copymode(full, temporary)
    os.replace(temporary, full)
    return len(pairs)


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    with open(argv[1], "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    total = 0
    for entry in spec:
        total += edit(entry["file"], [tuple(pair) for pair in entry["replace"]])
        print(f"patched {entry['file']}")
    print(f"{total} replacement(s) applied")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
