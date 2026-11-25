#!/usr/bin/env python
"""Runs every test in this folder (and the static checks), prints one line per file.

    python tests/run_all.py

Needs `node` on the PATH for the .js tests. Nothing here touches Steam, STN, scrap.tf or
Backpack.tf; see AGENT.md (section 11) for what still needs a manual check in Firefox.
"""
import glob
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))


def main():
    node = shutil.which("node")
    jobs = []
    for path in sorted(glob.glob(os.path.join(HERE, "test_*.js"))):
        if node:
            jobs.append((os.path.basename(path), [node, path]))
        else:
            print("SKIP", os.path.basename(path), "(node not found)")
    for path in sorted(glob.glob(os.path.join(HERE, "test_*.py"))):
        jobs.append((os.path.basename(path), [sys.executable, "-I", path]))
    jobs.append(("tools/check.py", [sys.executable, os.path.join(ROOT, "tools", "check.py")]))

    failed = []
    for name, command in jobs:
        result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
        status = "ok  " if result.returncode == 0 else "FAIL"
        print(status, name)
        if result.returncode:
            failed.append(name)
            print((result.stdout + result.stderr).rstrip())
    print()
    print("all passed" if not failed else f"{len(failed)} failed: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
