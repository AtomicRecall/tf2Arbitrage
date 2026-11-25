#!/usr/bin/env python
"""Static checks to run before calling a change done.

    python tools/check.py

Checks (exit code 1 if any fails):
  - `node --check` on every extension script
  - a syntax compile of every Python helper
  - both manifests parse
  - versions agree: manifest version == default_title version == the newest
    changelog entry (scanner README.txt, Metal Trader README.md)
  - files that mix CRLF and LF line endings are listed as warnings (they usually
    mean an edit rewrote line endings; the pre-existing ones are noted too)

This does NOT test anything against live Steam, STN, scrap.tf or Backpack.tf.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCANNER = os.path.join(ROOT, "tf2_trade_arbitrage_prototype")
METAL = os.path.join(ROOT, "automaticMetal")

failures = []
warnings = []


def fail(message):
    failures.append(message)
    print("FAIL", message)


def read(path):
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


def check_js():
    node = shutil.which("node")
    if not node:
        warnings.append("node was not found; JavaScript syntax was not checked")
        print("WARN node not found, skipping JavaScript syntax checks")
        return
    files = sorted(glob.glob(os.path.join(SCANNER, "*.js")) + glob.glob(os.path.join(METAL, "*.js")))
    files += sorted(glob.glob(os.path.join(ROOT, "tests", "*.js")))
    for path in files:
        result = subprocess.run([node, "--check", path], capture_output=True, text=True)
        if result.returncode:
            fail(f"syntax error in {os.path.relpath(path, ROOT)}\n{result.stderr.strip()}")
    print(f"checked {len(files)} JavaScript files")


def check_python():
    files = sorted(
        glob.glob(os.path.join(ROOT, "macConfirmer", "*.py"))
        + glob.glob(os.path.join(ROOT, "browserShell", "*.py"))
        + glob.glob(os.path.join(ROOT, "tools", "*.py"))
        + glob.glob(os.path.join(ROOT, "tests", "*.py"))
    )
    for path in files:
        try:
            # compile() in memory: no .pyc files are written into the repo.
            compile(read(path), path, "exec")
        except SyntaxError as error:
            fail(f"syntax error in {os.path.relpath(path, ROOT)}: line {error.lineno}: {error.msg}")
    print(f"checked {len(files)} Python files")


def manifest(folder):
    path = os.path.join(folder, "manifest.json")
    try:
        return json.loads(read(path).lstrip("﻿"))
    except Exception as error:  # noqa: BLE001 - report any parse problem
        fail(f"{os.path.relpath(path, ROOT)} does not parse: {error}")
        return None


def check_versions():
    scanner = manifest(SCANNER)
    if scanner:
        version = scanner.get("version", "")
        title = (scanner.get("browser_action") or {}).get("default_title", "")
        if f"v{version}" not in title:
            fail(f"scanner default_title {title!r} does not mention v{version}")
        readme = read(os.path.join(SCANNER, "README.txt"))
        current = re.search(r"Current version\s+(\S+)", readme)
        newest = re.search(r"^V(\d+\.\d+\.\d+) changes:", readme, re.M)
        if not current or current.group(1) != version:
            fail(f"scanner README.txt 'Current version' is {current and current.group(1)}, manifest is {version}")
        if not newest or newest.group(1) != version:
            fail(f"scanner README.txt newest entry is {newest and newest.group(1)}, manifest is {version}")
        print(f"scanner version {version}")
    metal = manifest(METAL)
    if metal:
        version = metal.get("version", "")
        title = (metal.get("action") or {}).get("default_title", "")
        if title and f"v{version}" not in title:
            warnings.append(f"Metal Trader default_title {title!r} does not mention v{version}")
            print(f"WARN Metal Trader default_title {title!r} does not mention v{version}")
        readme = read(os.path.join(METAL, "README.md"))
        heading = re.search(r"^# TF2 Metal Trader v(\S+)", readme, re.M)
        newest = re.search(r"^## v(\d+\.\d+\.\d+)", readme, re.M)
        if not heading or heading.group(1) != version:
            fail(f"Metal Trader README title is {heading and heading.group(1)}, manifest is {version}")
        if not newest or newest.group(1) != version:
            fail(f"Metal Trader README newest entry is {newest and newest.group(1)}, manifest is {version}")
        print(f"Metal Trader version {version}")


def check_line_endings():
    extensions = (".js", ".py", ".json", ".html", ".css", ".md", ".txt")
    mixed = []
    for folder in (SCANNER, METAL, os.path.join(ROOT, "macConfirmer"), os.path.join(ROOT, "tools"), os.path.join(ROOT, "tests")):
        for path in glob.glob(os.path.join(folder, "*")):
            if not path.endswith(extensions) or not os.path.isfile(path):
                continue
            raw = read(path)
            crlf = raw.count("\r\n")
            lone = raw.count("\n") - crlf
            if crlf and lone:
                mixed.append(f"{os.path.relpath(path, ROOT)} ({crlf} CRLF, {lone} LF)")
    for entry in mixed:
        warnings.append(f"mixed line endings: {entry}")
        print("WARN mixed line endings:", entry)


def main():
    check_js()
    check_python()
    check_versions()
    check_line_endings()
    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED, {len(warnings)} warning(s)")
        return 1
    print(f"all checks passed, {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
