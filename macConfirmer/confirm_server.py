#!/usr/bin/env python3
"""Small HTTP server that lets the PC add-on ask this Mac to accept trade
confirmations in the Steam app (through iPhone Mirroring).

  python3 confirm_server.py                  # listens on 127.0.0.1:8765 (this Mac only)
  python3 confirm_server.py --host 0.0.0.0   # also reachable from other devices on the network
  python3 confirm_server.py --dry-run        # accepts requests but clicks nothing

Endpoints (all but /ping need the header `X-Confirm-Token: <token>`):
  GET  /ping      -> {"ok": true}                      connectivity check, no token
  GET  /status    -> queue, busy/paused state, recent results
  POST /confirm   -> {"offerIds": ["123", "456"]}      accept that many trades
                     or {"count": 2}; add "retry": true to ask again for offers
                     that were already marked done but are still unconfirmed
  POST /resume    -> clears a pause caused by a failure
  POST /cancel    -> drops everything still waiting in the queue
  POST /shutdown  -> stops this server (sent by the add-on when the browser is closed)
  POST /focus     -> brings iPhone Mirroring to the front (sent by the add-on after it opens the
                     scanner window, which comes up on top of it)

Safety rules:
  * only private-network clients are served (and only --allow addresses if given)
  * the token is created on first start and stored in server_config.json
  * one confirmation run at a time, with a random delay before each run
  * a per-request, per-hour limit; offer ids already queued or done are ignored
  * any failure pauses the server until /resume, so a wrong click never repeats

The bot offers are matched by count, not by identity: the Steam app lists
pending confirmations and this clicks the top one. Do not leave unrelated
confirmations pending while it runs.
"""

import argparse
import collections
import ipaddress
import json
import random
import secrets
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import confirm_trades
import phone_state

CONFIG_FILE = Path(__file__).with_name("server_config.json")
MAX_BODY_BYTES = 4096
MAX_PER_REQUEST = 5
HISTORY_LENGTH = 20


def load_token():
    config = phone_state.load_config()
    if config.get("token"):
        return config["token"]
    token = secrets.token_urlsafe(24)
    config["token"] = token  # keeps the other settings (ntfy topic, phone check)
    CONFIG_FILE.write_text(json.dumps(config))
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass
    print(f"Created a new token in {CONFIG_FILE.name}.")
    return token


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


# ---- phone notification (ntfy) ---------------------------------------------------
# The Mac drives the iPhone through iPhone Mirroring, which only works while the
# phone is locked and not in use. Before a run the server looks at the colour of one
# spot of the mirroring window (see phone_state.py): when it shows the Steam
# confirmations page (the phone is ready) it just goes on, otherwise it sends a push notification (through ntfy, https://ntfy.sh) so you can
# put the phone down, and when the run is over it sends another one saying the
# phone is free again. Without a calibration it always sends the first one. The
# message is generic: no item, offer or account information is sent. The topic is a
# random name created on first start and kept in server_config.json (it is the only
# "password" of the channel, so keep it private); subscribe to it in the ntfy app.
DEFAULT_NTFY_SERVER = "https://ntfy.sh"


def load_ntfy_topic():
    config = {}
    if CONFIG_FILE.exists():
        config = json.loads(CONFIG_FILE.read_text())
    topic = config.get("ntfy_topic")
    if not topic:
        topic = "tf2-confirm-" + secrets.token_urlsafe(12).replace("_", "x").replace("-", "y")
        config["ntfy_topic"] = topic
        CONFIG_FILE.write_text(json.dumps(config))
        try:
            CONFIG_FILE.chmod(0o600)
        except OSError:
            pass
    return topic


class Notifier:
    """Sends a short push message to the phone. Never raises; it never blocks a run
    for longer than the request timeout."""

    def __init__(self, server, topic):
        self.server = (server or DEFAULT_NTFY_SERVER).rstrip("/")
        self.topic = topic

    @property
    def enabled(self):
        return bool(self.topic)

    def send(self, title, message, priority="high", tags="lock"):
        if not self.enabled:
            return False
        request = urllib.request.Request(
            f"{self.server}/{self.topic}",
            data=message.encode("utf-8"),
            method="POST",
            headers={"Title": title, "Priority": priority, "Tags": tags},
        )
        try:
            with urllib.request.urlopen(request, timeout=8):
                pass
            return True
        except Exception as error:  # offline, DNS, HTTP error ...
            log(f"Could not send the phone notification: {error}")
            return False


def preflight(dry_run):
    """Checks, at start-up, the things that make clicks silently do nothing."""
    if dry_run:
        return
    program = confirm_trades.find_cliclick()
    if not program:
        log("WARNING: cliclick was not found, so nothing can be clicked. Install it: brew install cliclick")
        return
    result = subprocess.run([program, "p"], capture_output=True, text=True)
    if result.returncode != 0:
        log(f"WARNING: cliclick could not read the pointer ({result.stderr.strip() or result.stdout.strip()}).")
        return
    log(f"cliclick found at {program}. If clicks or scrolling do nothing, give the app that started this "
        f"server (Terminal, or TF2 Trader) Accessibility and Input Monitoring in System Settings > Privacy & Security.")


class Confirmer:
    """Owns the queue and the single worker that performs the clicks."""

    def __init__(self, dry_run, min_delay, max_delay, max_per_hour, notifier=None, notify_lead=0.0,
                 phone=None, phone_wait=120.0):
        self.notifier = notifier or Notifier(None, "")
        self.notify_lead = max(0.0, notify_lead)
        self.phone = phone  # phone_state.PhoneCheck, or None when no spot was saved
        self.phone_wait = max(0.0, phone_wait)
        self.phone_taken = False  # the phone was asked for and has not been given back yet
        self.dry_run = dry_run
        self.min_delay, self.max_delay = min_delay, max_delay
        self.max_per_hour = max_per_hour
        self.cond = threading.Condition()
        self.queue = collections.deque()  # (count, [offer ids])
        self.active_ids = set()  # offer ids queued or being confirmed right now
        self.done_ids = set()  # offer ids already confirmed
        self.confirmed_times = collections.deque()  # one entry per trade accepted
        self.history = collections.deque(maxlen=HISTORY_LENGTH)
        self.busy = False
        self.paused_reason = ""
        threading.Thread(target=self._worker, daemon=True).start()

    # -- requests -------------------------------------------------------------
    def _confirmed_last_hour(self):
        cutoff = time.time() - 3600
        while self.confirmed_times and self.confirmed_times[0] < cutoff:
            self.confirmed_times.popleft()
        return len(self.confirmed_times)

    def enqueue(self, count, offer_ids, retry=False):
        with self.cond:
            if self.paused_reason:
                return 503, {"ok": False, "error": f"Paused: {self.paused_reason}. POST /resume once it is fixed."}
            if offer_ids:
                # A retry asks again for offers already marked done (the click
                # did not take effect); anything still queued or running is skipped.
                skip = self.active_ids if retry else self.active_ids | self.done_ids
                fresh = [offer_id for offer_id in offer_ids if offer_id not in skip]
                count = len(fresh)
                if not count:
                    return 200, {"ok": True, "queued": 0, "duplicate": True}
            else:
                fresh = []
            if not 1 <= count <= MAX_PER_REQUEST:
                return 400, {"ok": False, "error": f"count must be between 1 and {MAX_PER_REQUEST}"}
            waiting = sum(job[0] for job in self.queue)
            if self._confirmed_last_hour() + waiting + count > self.max_per_hour:
                return 429, {"ok": False, "error": f"Hourly limit of {self.max_per_hour} confirmations reached."}
            self.active_ids.update(fresh)
            self.done_ids.difference_update(fresh)
            self.queue.append((count, fresh))
            self.cond.notify()
            log(f"Queued {count} confirmation{'s' if count != 1 else ''} {fresh or ''}".rstrip())
            return 202, {"ok": True, "queued": count, "queueLength": len(self.queue), "dryRun": self.dry_run}

    def resume(self):
        with self.cond:
            self.paused_reason = ""
            self.cond.notify()
        log("Resumed.")
        return 200, {"ok": True}

    def cancel(self):
        with self.cond:
            dropped = sum(job[0] for job in self.queue)
            for _, ids in self.queue:
                self.active_ids.difference_update(ids)
            self.queue.clear()
        log(f"Cancelled {dropped} waiting confirmations.")
        return 200, {"ok": True, "dropped": dropped}

    def status(self):
        with self.cond:
            return 200, {
                "ok": True,
                "dryRun": self.dry_run,
                "busy": self.busy,
                "paused": self.paused_reason or None,
                "waiting": sum(job[0] for job in self.queue),
                "confirmedLastHour": self._confirmed_last_hour(),
                "hourlyLimit": self.max_per_hour,
                "recent": list(self.history),
            }

    # -- worker ---------------------------------------------------------------
    def _next_batch(self):
        """Waits for work, then merges every waiting job into one run."""
        with self.cond:
            while not self.queue or self.paused_reason:
                self.cond.wait()
            total, ids = 0, []
            while self.queue and total + self.queue[0][0] <= confirm_trades.MAX_TRADES_PER_RUN:
                count, job_ids = self.queue.popleft()
                total += count
                ids += job_ids
            self.busy = True
            return total, ids

    def _phone_state(self):
        """"free" (the spot shows the saved colour: ready), "busy" (it does not) or "unknown" (no spot saved, or the screen could not be read)."""
        if not self.phone:
            return "unknown"
        try:
            state, details = self.phone.look()
        except Exception as error:  # a failed look must never block a run
            log(f"Could not read the spot on the screen ({error}); treating the phone as in use.")
            return "unknown"
        log(f"Phone check: {'ready (on the confirmations page)' if state == 'free' else 'NOT ready'} ({details}).")
        return state

    def _ask_for_phone(self, count):
        """Makes sure the phone is not in use before the Mac takes it over.
        Returns True only when the very first look found the phone on the confirmations page
        (the connection retry clicks are then not needed). Any "not ready" first look, even one
        that turns ready while waiting, returns False: the retry clicks are done."""
        state = self._phone_state()
        if state == "free":
            log("The phone is already on the confirmations page: no notification needed.")
            return True
        sent = self.notifier.send(
            "Lock your iPhone",
            f"{count} trade{'s' if count != 1 else ''} to confirm. Put your phone down and lock it now: "
            f"the Mac takes it over in {int(self.notify_lead)} seconds.",
        )
        if not sent:
            return False
        self.phone_taken = True
        if state != "busy":
            log(f"Sent the phone notification; waiting {self.notify_lead:.0f}s before clicking.")
            time.sleep(self.notify_lead)
            return False
        # The spot does not show the confirmations page: go on as soon as it does.
        log(f"Sent the phone notification; waiting up to {self.phone_wait:.0f}s for the confirmations page to show.")
        deadline = time.time() + self.phone_wait
        while time.time() < deadline:
            time.sleep(2.0)
            if self._phone_state() == "free":
                time.sleep(1.5)
                # The first look said "not ready", so the connection retry clicks are still done.
                return False
        log("The confirmations page did not show up in time; trying anyway.")
        return False

    def _give_phone_back(self, text):
        """Tells you the phone is free again, once nothing more is waiting for it."""
        with self.cond:
            if not self.phone_taken or self.queue:
                return
            self.phone_taken = False
        if not self.dry_run:
            self.notifier.send("You can use your phone", text, priority="default", tags="iphone")

    def _worker(self):
        while True:
            count, ids = self._next_batch()
            try:
                # The phone has to be locked and unused while the Mac clicks on it.
                on_page = False
                if not self.dry_run and (self.notifier.enabled or self.phone):
                    on_page = self._ask_for_phone(count)
                delay = random.uniform(self.min_delay, self.max_delay)
                log(f"Accepting {count} trade{'s' if count != 1 else ''} in {delay:.1f}s…")
                time.sleep(delay)
                confirm_trades.run(count, self.dry_run, True, 0, 5, "wheel", False, skip_retry=on_page)
                with self.cond:
                    self.active_ids.difference_update(ids)
                    self.done_ids.update(ids)
                    self.confirmed_times.extend([time.time()] * count)
                    self.history.append({"at": time.strftime("%H:%M:%S"), "count": count, "ids": ids, "ok": True})
                log(f"Done: {count} accepted." if not self.dry_run else f"Done (DRY RUN: nothing was actually clicked) for {count}.")
                self._give_phone_back(f"{count} trade{'s' if count != 1 else ''} confirmed. The Mac is done with your phone.")
            except BaseException as error:  # a failed run must never be repeated blindly
                reason = str(error) or error.__class__.__name__
                with self.cond:
                    self.active_ids.difference_update(ids)  # let the add-on ask again after /resume
                    self.paused_reason = reason
                    self.history.append({"at": time.strftime("%H:%M:%S"), "count": count, "ids": ids, "ok": False, "error": reason})
                log(f"FAILED: {reason}. Paused until POST /resume.")
                if not self.dry_run:
                    self.phone_taken = False  # this message says it too
                    self.notifier.send(
                        "Confirming trades failed",
                        f"The Mac could not accept the trade confirmation and paused: {reason[:150]}. "
                        f"The Mac is not using your phone now.",
                        priority="high", tags="warning",
                    )
            finally:
                with self.cond:
                    self.busy = False


def make_handler(confirmer, token, allowed):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ConfirmServer/1.0"

        def log_message(self, fmt, *args):  # quieter than the default
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _client_allowed(self):
            address = ipaddress.ip_address(self.client_address[0])
            if allowed:
                return address in allowed
            return address.is_private or address.is_loopback

        def _authorized(self):
            supplied = self.headers.get("X-Confirm-Token", "")
            return secrets.compare_digest(supplied.encode(), token.encode())

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                raise ValueError("body too large")
            return json.loads(self.rfile.read(length) or b"{}")

        def _dispatch(self, method):
            if not self._client_allowed():
                return self._send(403, {"ok": False, "error": "client not allowed"})
            path = self.path.split("?")[0]
            if method == "GET" and path == "/ping":
                return self._send(200, {"ok": True})
            if not self._authorized():
                log(f"Rejected {method} {path} from {self.client_address[0]}: bad token")
                return self._send(401, {"ok": False, "error": "bad token"})
            try:
                if method == "GET" and path == "/status":
                    return self._send(*confirmer.status())
                if method == "POST" and path == "/confirm":
                    body = self._read_json()
                    ids = [str(item) for item in body.get("offerIds", [])]
                    if any(not item.isdigit() for item in ids):
                        return self._send(400, {"ok": False, "error": "offerIds must be numeric"})
                    count = int(body.get("count", 0)) if not ids else len(ids)
                    return self._send(*confirmer.enqueue(count, ids, retry=body.get("retry") is True))
                if method == "POST" and path == "/resume":
                    return self._send(*confirmer.resume())
                if method == "POST" and path == "/cancel":
                    return self._send(*confirmer.cancel())
                if method == "POST" and path == "/focus":
                    # Only brings the app forward; it never clicks anything.
                    if not confirmer.dry_run:
                        threading.Thread(target=confirm_trades.focus_mirroring, daemon=True).start()
                    log("Focusing iPhone Mirroring (the scanner window opened).")
                    return self._send(200, {"ok": True})
                if method == "POST" and path == "/shutdown":
                    # The add-on sends this when the browser window was closed;
                    # browserShell/launch.py then quits Firefox and exits too.
                    log("Shutdown requested by the add-on (the browser was closed).")
                    self._send(200, {"ok": True})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                return self._send(400, {"ok": False, "error": f"bad request: {error}"})
            return self._send(404, {"ok": False, "error": "not found"})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

    return Handler


def main():
    parser = argparse.ArgumentParser(description="HTTP server for Steam mobile confirmations via iPhone Mirroring.")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to listen on (default 127.0.0.1: this Mac only; use 0.0.0.0 for other devices on your network)")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on (default 8765)")
    parser.add_argument("--allow", action="append", default=[], metavar="IP",
                        help="only serve this client IP (repeatable); default: any private-network address")
    parser.add_argument("--dry-run", action="store_true", help="accept requests but click nothing")
    parser.add_argument("--min-delay", type=float, default=3.0, help="minimum seconds before each run (default 3)")
    parser.add_argument("--max-delay", type=float, default=10.0, help="maximum seconds before each run (default 10)")
    parser.add_argument("--max-per-hour", type=int, default=30, help="confirmations allowed per hour (default 30)")
    parser.add_argument("--no-notify", action="store_true", help="do not send phone notifications")
    parser.add_argument("--ntfy-topic", help="ntfy topic to notify (default: a random one kept in server_config.json)")
    parser.add_argument("--ntfy-server", default=DEFAULT_NTFY_SERVER, help="ntfy server (default %(default)s)")
    parser.add_argument("--notify-lead", type=float, default=20.0,
                        help="seconds to wait after the notification before clicking, so you can lock the phone (default %(default)s)")
    parser.add_argument("--test-notification", action="store_true", help="send one test notification and exit")
    parser.add_argument("--pick-phone-spot", action="store_true",
                        help="save the colour of the spot under the mouse pointer (the iPhone must be on the Steam "
                             "confirmations page), then exit; see phone_state.py")
    parser.add_argument("--pick-delay", type=int, default=5, help="seconds to wait before --pick-phone-spot reads the pointer (default %(default)s)")
    parser.add_argument("--phone-spot", metavar="X,Y",
                        help="the spot to check, in screen points; its colour is read now (or given with --phone-color)")
    parser.add_argument("--phone-color", metavar="R,G,B", help="with --phone-spot: the colour the spot has on the confirmations page")
    parser.add_argument("--phone-tolerance", type=int, default=0,
                        help=f"with --pick-phone-spot / --phone-spot: how far each of R, G and B may differ (default {phone_state.TOLERANCE})")
    parser.add_argument("--check-phone", action="store_true", help="look at the saved spot now, print what it shows and exit")
    parser.add_argument("--no-phone-check", action="store_true", help="always send the 'lock your iPhone' notification, without looking at the spot")
    parser.add_argument("--phone-wait", type=float, default=120.0,
                        help="when the spot does not show the confirmations page, wait at most this many seconds for it to (default %(default)s)")
    parser.add_argument("--wheel-events", type=int, default=confirm_trades.WHEEL_EVENTS)
    parser.add_argument("--wheel-lines", type=int, default=confirm_trades.WHEEL_LINES)
    parser.add_argument("--refresh-y-offset", type=int, default=confirm_trades.REFRESH_Y_OFFSET)
    parser.add_argument("--click-repeat-ms", type=int, default=confirm_trades.CLICK_REPEAT_MS,
                        help="send every click twice, this many ms apart; 0 = single click (default %(default)s)")
    args = parser.parse_args()
    if args.min_delay > args.max_delay:
        parser.error("--min-delay cannot be larger than --max-delay")

    confirm_trades.WHEEL_EVENTS = args.wheel_events
    confirm_trades.WHEEL_LINES = args.wheel_lines
    confirm_trades.REFRESH_Y_OFFSET = args.refresh_y_offset
    confirm_trades.CLICK_REPEAT_MS = max(0, args.click_repeat_ms)

    if args.pick_phone_spot or args.phone_spot or args.check_phone:
        try:
            if args.pick_phone_spot or args.phone_spot:
                if args.phone_spot:
                    spot = tuple(int(value) for value in args.phone_spot.split(","))
                    if len(spot) != 2:
                        parser.error("--phone-spot needs two numbers: X,Y")
                else:
                    print(f"Put the mouse pointer on the spot (iPhone Mirroring must show the Steam confirmations page). "
                          f"Reading it in {args.pick_delay} seconds…", flush=True)
                    time.sleep(args.pick_delay)
                    spot = phone_state.pointer_position()
                color = None
                if args.phone_color:
                    color = [int(value) for value in args.phone_color.split(",")]
                    if len(color) != 3 or not all(0 <= value <= 255 for value in color):
                        parser.error("--phone-color needs three numbers from 0 to 255: R,G,B")
                saved = phone_state.save_spot(spot, color, args.phone_tolerance)
                print(f"Saved: spot {saved['spot'][0]},{saved['spot'][1]} with colour rgb{tuple(saved['color'])} in {CONFIG_FILE.name}.")
            else:
                check = phone_state.PhoneCheck.from_config()
                if not check:
                    sys.exit("No spot saved yet: run --pick-phone-spot while the phone shows the confirmations page.")
                state, details = check.look()
                print(f"{'READY: the spot shows the confirmations page' if state == 'free' else 'NOT ready: the spot has another colour'} ({details}).")
        except (RuntimeError, ValueError) as error:
            sys.exit(f"Phone check failed: {error}")
        sys.exit(0)

    notifier = Notifier(args.ntfy_server, "" if args.no_notify else (args.ntfy_topic or load_ntfy_topic()))
    if args.test_notification:
        if not notifier.enabled:
            sys.exit("Notifications are switched off (--no-notify).")
        ok = notifier.send("Test notification", "The TF2 confirmer can reach your phone.", priority="default", tags="white_check_mark")
        print("Sent." if ok else "Not sent (see the message above).")
        sys.exit(0 if ok else 1)
    preflight(args.dry_run)
    token = load_token()
    allowed = {ipaddress.ip_address(item) for item in args.allow}
    phone = None if args.no_phone_check else phone_state.PhoneCheck.from_config()
    confirmer = Confirmer(args.dry_run, args.min_delay, args.max_delay, args.max_per_hour, notifier, args.notify_lead,
                          phone, args.phone_wait)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(confirmer, token, allowed))
    log(f"Listening on {args.host}:{args.port}{' (DRY RUN: no clicks)' if args.dry_run else ''}")
    log(f"Token: {token}")
    if notifier.enabled:
        log(f"Phone notifications: install the ntfy app and subscribe to the topic \"{notifier.topic}\" "
            f"on {notifier.server} (lock-screen alerts before each confirmation run, {args.notify_lead:.0f}s ahead).")
        if phone:
            log("Phone check: the saved spot is looked at first; the 'lock your iPhone' alert is only sent when it does not show the confirmations page.")
        else:
            log("Phone check: no spot saved, so the alert is sent before every run (python3 confirm_server.py --pick-phone-spot).")
    else:
        log("Phone notifications are off.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped.")
        sys.exit(0)
    server.server_close()
    log("Stopped on request.")


if __name__ == "__main__":
    main()
