#!/usr/bin/env python3
"""Launches the TF2 Trader browser: Firefox with a dedicated profile, both
bot add-ons preinstalled, the trade analyzer in the sidebar, the STN hats page
and the scrap.tf hats page as the start tabs, and the confirmation server running
beside it.

  python3 browserShell/launch.py                 # normal start
  python3 browserShell/launch.py --dry-run       # prepare the profile, print what would run
  python3 browserShell/launch.py --server-dry-run  # the server accepts requests but clicks nothing
  python3 browserShell/launch.py --quiet         # print nothing; everything goes to the log files

Firefox's own console chatter (for example the macOS "sandbox_extension_issue_file_to_process
failed ... Operation not permitted" lines) is always written to firefox.log instead of the
window. With --quiet the confirm server's output goes to server.log too.

On a Mac Firefox is opened through macOS (open -W -n -a), not run as a child of this
terminal; that is what stops the "Operation not permitted" sandbox lines at the source.
Pass --direct to run the binary itself like before.

What it does, in order:
  1. Packs tf2_trade_arbitrage_prototype/ and automaticMetal/ into .xpi files and
     puts them, with user.js and userChrome.css, into the profile.
  2. Starts macConfirmer/confirm_server.py (local only) unless one is already
     listening, and keeps the Mac awake with caffeinate while it runs.
  3. Starts Firefox on the profile and waits. When Firefox closes, the server stops.

The profile (logins, add-on settings) is kept between runs.
"""

import argparse
import json
import os
import platform
import secrets
import shutil
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path

SHELL_DIR = Path(__file__).resolve().parent
ROOT = SHELL_DIR.parent
EXTENSION_DIRS = ["tf2_trade_arbitrage_prototype", "automaticMetal"]
SERVER_SCRIPT = ROOT / "macConfirmer" / "confirm_server.py"
SERVER_HOST, SERVER_PORT = "127.0.0.1", 8765
SERVER_CONFIG = ROOT / "macConfirmer" / "server_config.json"

# The analyzer add-on reads this file from its own package on start-up and
# fills in its "Mac confirmer" settings, so nothing has to be typed in.
ANALYZER_FOLDER = "tf2_trade_arbitrage_prototype"
BUNDLED_CONFIG_NAME = "mac-confirmer.json"

STN_HATS_URL = (
    "https://stntrading.eu/tf2/hats"
    "?products_price_desc%5BsortBy%5D=products_time_desc&products_price_desc%5Bpage%5D=1"
)
# scrap.tf's Buy Hats page (it needs a Steam login). Both pages are opened as
# tabs on start (and are the home page, separated by "|"); "Scan current page"
# works on whichever tab is in front.
SCRAP_HATS_URL = "https://scrap.tf/buy/hats"
HOME_URL = f"{STN_HATS_URL}|{SCRAP_HATS_URL}"

# Release Firefox refuses unsigned add-ons; these builds can run them.
MAC_FIREFOX_CANDIDATES = [
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
]
UNSIGNED_OK = ("Developer Edition", "Nightly")

SKIP_NAMES = {"__pycache__", ".DS_Store"}
SKIP_PREFIXES = ("README",)


def default_profile_dir():
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support" / "TF2Trader" / "profile"
    return Path.home() / ".tf2trader" / "profile"


def default_log_dir():
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Logs" / "TF2Trader"
    return Path.home() / ".tf2trader" / "logs"


def open_log(log_dir, name):
    """Opens <log_dir>/<name> for appending, with a dated header line."""
    log_dir.mkdir(parents=True, exist_ok=True)
    handle = open(log_dir / name, "a", encoding="utf-8", errors="replace", buffering=1)
    handle.write("\n===== " + time.strftime("%Y-%m-%d %H:%M:%S") + " =====\n")
    return handle


def app_bundle(firefox):
    """The .app folder of a macOS Firefox binary path, else None."""
    marker = ".app/Contents/MacOS/"
    if platform.system() != "Darwin" or marker not in firefox:
        return None
    return firefox[: firefox.index(marker) + len(".app")]


def launch_command(firefox, profile, log_dir, direct):
    """The command that starts Firefox.

    On a Mac Firefox is started through LaunchServices (`open -W -n -a`), like
    double-clicking it, and not as a child process of Terminal and this script.
    Started as a child it logs "sandbox_extension_issue_file_to_process failed ...
    Operation not permitted" for its helper app. `open -W` waits until Firefox
    quits, and --stdout/--stderr send its console output to the log file."""
    arguments = ["-profile", str(profile), "--no-remote", STN_HATS_URL, SCRAP_HATS_URL]
    bundle = None if direct else app_bundle(firefox)
    if not bundle:
        return [firefox or "firefox", *arguments], False
    log = str(log_dir / "firefox.log")
    return ["open", "-W", "-n", "--stdout", log, "--stderr", log, "-a", bundle, "--args", *arguments], True


def find_firefox(explicit):
    if explicit:
        return explicit
    if os.environ.get("FIREFOX_BIN"):
        return os.environ["FIREFOX_BIN"]
    for candidate in MAC_FIREFOX_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    return shutil.which("firefox") or ""


def read_manifest(folder):
    # The manifests are saved with a byte-order mark.
    return json.loads((ROOT / folder / "manifest.json").read_text(encoding="utf-8-sig"))


def ensure_server_token():
    """The confirm server's token, created the same way the server does if needed."""
    if SERVER_CONFIG.exists():
        token = json.loads(SERVER_CONFIG.read_text()).get("token")
        if token:
            return token
    token = secrets.token_urlsafe(24)
    SERVER_CONFIG.write_text(json.dumps({"token": token}))
    try:
        SERVER_CONFIG.chmod(0o600)
    except OSError:
        pass
    return token


def build_xpi(folder, destination_dir, extra_files=None):
    """Zips an extension folder to <extension id>.xpi. Returns (path, id, version).

    `extra_files` maps a name to text that is added to the package."""
    manifest = read_manifest(folder)
    extension_id = manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
    if not extension_id:
        raise SystemExit(f"{folder}/manifest.json has no browser_specific_settings.gecko.id; Firefox needs one to preinstall it.")
    destination = destination_dir / f"{extension_id}.xpi"
    source = ROOT / folder
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            relative = path.relative_to(source)
            if not path.is_file() or any(part in SKIP_NAMES for part in relative.parts):
                continue
            if relative.parts[0].startswith(SKIP_PREFIXES):
                continue
            archive.write(path, relative.as_posix())
        for name, text in (extra_files or {}).items():
            archive.writestr(name, text)
    return destination, extension_id, manifest.get("version", "?")


def prepare_profile(profile_dir):
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "chrome").mkdir(exist_ok=True)
    extensions_dir = profile_dir / "extensions"
    extensions_dir.mkdir(exist_ok=True)

    user_js = (SHELL_DIR / "profile" / "user.js").read_text(encoding="utf-8").replace("__HOME_URL__", HOME_URL)
    (profile_dir / "user.js").write_text(user_js, encoding="utf-8")
    shutil.copyfile(SHELL_DIR / "profile" / "chrome" / "userChrome.css", profile_dir / "chrome" / "userChrome.css")

    # The token lives only in the profile's package, never in the project files.
    mac_confirmer = json.dumps({
        "url": f"http://{SERVER_HOST}:{SERVER_PORT}",
        "token": ensure_server_token(),
        "enabled": True,
    })
    built = [
        build_xpi(folder, extensions_dir, {BUNDLED_CONFIG_NAME: mac_confirmer} if folder == ANALYZER_FOLDER else None)
        for folder in EXTENSION_DIRS
    ]
    for path, extension_id, version in built:
        print(f"  add-on {extension_id} v{version} -> {path.name}")


def server_listening():
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((SERVER_HOST, SERVER_PORT)) == 0


def start_server(server_dry_run, log=None):
    if server_listening():
        print(f"A server is already listening on {SERVER_HOST}:{SERVER_PORT}; using it.")
        return None
    if not SERVER_SCRIPT.exists():
        print(f"Confirm server not found at {SERVER_SCRIPT}; continuing without it.")
        return None
    command = [sys.executable, str(SERVER_SCRIPT), "--host", SERVER_HOST, "--port", str(SERVER_PORT)]
    # An app started from Finder has a bare PATH; give the server Homebrew's folders.
    server_env = dict(os.environ)
    server_env["PATH"] = os.pathsep.join([server_env.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin"])
    if server_dry_run:
        command.append("--dry-run")
    if not server_dry_run and platform.system() == "Darwin" and not (
        shutil.which("cliclick", path=server_env["PATH"])
    ):
        print("WARNING: cliclick is not installed (brew install cliclick); the server will start but cannot click.")
    print("Starting the confirm server" + (" (dry run: no clicks)" if server_dry_run else "") + "…")
    output = {"stdout": log, "stderr": subprocess.STDOUT} if log else {}
    process = subprocess.Popen(command, cwd=SERVER_SCRIPT.parent, env=server_env, **output)
    # Make sure it really came up before the browser relies on it.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if process.poll() is not None:
            print(f"WARNING: the confirm server exited immediately (code {process.returncode}); check its output above.")
            return None
        if server_listening():
            print(f"Confirm server ready on {SERVER_HOST}:{SERVER_PORT}; the add-on is configured to use it.")
            return process
        time.sleep(0.2)
    print("WARNING: the confirm server did not start listening within 5 seconds.")
    return process


def open_iphone_mirroring():
    """Opens iPhone Mirroring so it is ready for the confirmation clicks."""
    if platform.system() != "Darwin":
        return
    result = subprocess.run(["open", "-a", "iPhone Mirroring"], capture_output=True)
    if result.returncode != 0:
        print("Could not open iPhone Mirroring; open it yourself before trades need confirming.")
    else:
        print("Opened iPhone Mirroring. Keep the iPhone locked, and the Steam app on its Confirmations screen.")


def start_caffeinate():
    if platform.system() != "Darwin" or not shutil.which("caffeinate"):
        return None
    # -w ties it to this launcher: it exits when the launcher does.
    return subprocess.Popen(["caffeinate", "-dimsu", "-w", str(os.getpid())])


def main():
    parser = argparse.ArgumentParser(description="Launch the TF2 Trader browser.")
    parser.add_argument("--profile", type=Path, default=default_profile_dir(), help="profile folder (default: app support folder)")
    parser.add_argument("--firefox", help="path to the Firefox binary (default: Developer Edition, Nightly, then Firefox)")
    parser.add_argument("--no-server", action="store_true", help="do not start the confirm server")
    parser.add_argument("--server-dry-run", action="store_true", help="the server accepts requests but clicks nothing")
    parser.add_argument("--no-mirroring", action="store_true", help="do not open iPhone Mirroring")
    parser.add_argument("--quiet", action="store_true", help="print nothing; write the launcher, server and Firefox output to the log files")
    parser.add_argument("--log-dir", type=Path, default=default_log_dir(), help="folder for the log files (default: ~/Library/Logs/TF2Trader)")
    parser.add_argument("--direct", action="store_true", help="run the Firefox binary itself (a child of this terminal) instead of opening the app through macOS")
    parser.add_argument("--dry-run", action="store_true", help="prepare the profile and print the commands without starting anything")
    args = parser.parse_args()

    firefox_log = None if args.dry_run else open_log(args.log_dir, "firefox.log")
    server_log = open_log(args.log_dir, "server.log") if args.quiet and not args.dry_run else None
    if args.quiet and not args.dry_run:
        # Everything the launcher itself prints goes to launcher.log as well.
        sys.stdout = sys.stderr = open_log(args.log_dir, "launcher.log")

    print(f"Preparing profile in {args.profile}")
    prepare_profile(args.profile)

    firefox = find_firefox(args.firefox)
    command, opened_by_system = launch_command(firefox, args.profile, args.log_dir, args.direct)
    if args.dry_run:
        print("Would run:", " ".join(f'"{part}"' if " " in part else part for part in command))
        print("Would start:", SERVER_SCRIPT, "(skipped)" if args.no_server else "")
        return
    if not firefox:
        raise SystemExit("Firefox was not found. Install Firefox Developer Edition, or pass --firefox PATH or set FIREFOX_BIN.")
    if not any(name in firefox for name in UNSIGNED_OK):
        print("WARNING: this Firefox build may refuse the unsigned add-ons. Firefox Developer Edition is recommended.")

    server = None if args.no_server else start_server(args.server_dry_run, server_log)
    if not args.no_server and not args.no_mirroring:
        open_iphone_mirroring()
    caffeinate = start_caffeinate()
    try:
        print("Starting Firefox. Close its window to stop everything.")
        print(f"Firefox's console output goes to {args.log_dir / 'firefox.log'}")
        if opened_by_system:
            subprocess.run(command)
        else:
            subprocess.run(command, stdout=firefox_log, stderr=subprocess.STDOUT)
    finally:
        for process in (server, caffeinate):
            if process and process.poll() is None:
                process.terminate()


if __name__ == "__main__":
    main()
