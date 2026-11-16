#!/usr/bin/env python3
"""Accepts Steam mobile trade confirmations through iPhone Mirroring.

Flow (all done with `cliclick` clicks inside the mirrored Steam app, which must
already be open on its Confirmations screen):

  1. Pull down to refresh the confirmations list (once, at the start).
  2. Click the trade offer at the top of the list.
  3. Click the confirm button.
  4. Steam returns to the list and refreshes it by itself, pushing the next
     trade to the top, so steps 2-3 simply repeat for the requested count.

Usage:
  python3 confirm_trades.py 3             # accept 3 trades
  python3 confirm_trades.py 3 --dry-run   # print what would happen, click nothing

Requirements: macOS, `brew install cliclick`, Accessibility permission for the
terminal, iPhone Mirroring open and not moved or resized since the coordinates
were measured (`cliclick p` prints the pointer position).
"""

import argparse
import os
import random
import re
import shutil
import subprocess
import sys
import time

# How far (in screen points) the pointer may be from where the script put it before the run
# stops because "the user grabbed the mouse". A small nudge of the mouse is allowed: a stray
# bump, or macOS / iPhone Mirroring shifting the pointer a little, no longer stops it.
# `--pointer-tolerance` changes it.
POINTER_TOLERANCE = 60
# When the pointer is further away than that, the script puts it back and looks again this
# many times (a short disturbance fixes itself); it only stops if it is still away every time.
POINTER_RECHECKS = 3

# Pointer positions measured with `cliclick p`.
TRADE_OFFER = (1308, 578)
CONFIRM_BUTTON = (1315, 911)

# When the connection has timed out, the Steam app shows a retry button here.
# It is clicked once at the start of every run, before anything else, and is
# harmless when the button is not showing. Set to None to turn this off.
TIMEOUT_RETRY_BUTTON = (1321, 849)
# A second retry button, clicked after the first one. Set to None to turn it off.
SECOND_RETRY_BUTTON = (1318, 875)
# A third retry click, after the second one. Set to None to turn it off.
THIRD_RETRY_BUTTON = (1321, 843)
# A small pause (seconds, random in this range) between the retry clicks.
RETRY_CLICK_GAP_SECONDS = (0.5, 1.0)
# How long to wait after that click: the iPhone takes a while to initialize.
RETRY_WAIT_SECONDS = (9.0, 11.0)
# When the phone can be checked (a spot was saved), the three retry clicks are repeated until the
# check says the phone is on the confirmations page. This many rounds at most; then the run fails
# (and the server pauses) instead of clicking for ever.
MAX_RETRY_ROUNDS = 10

# Taps that reload the confirmations list instead of a swipe, clicked in order.
# For example: open another tab in the Steam app, then come back to Confirmations.
# Fill in with pointer positions from `cliclick p`:
#   REFRESH_TAPS = [("another tab", 1100, 960), ("Confirmations tab", 1274, 960)]
REFRESH_TAPS = []

# Where the refresh gesture happens, relative to the trade offer's click point.
# Positive moves it lower on the screen, negative higher (it used to be -40).
REFRESH_Y_OFFSET = 0

# Mouse-wheel refresh: this many wheel events of this many lines each.
WHEEL_EVENTS = 50
WHEEL_LINES = 7

# iPhone Mirroring lags, so a single click is sometimes not registered. Every
# click is sent twice, this many milliseconds apart (0 = a single click).
CLICK_REPEAT_MS = 120

MIRRORING_APP = "iPhone Mirroring"
MAX_TRADES_PER_RUN = 20

# Pull-to-refresh swipe: starts at the trade offer's x, a little above the first
# trade, and drags down by this many pixels.
REFRESH_DRAG_PIXELS = 350
REFRESH_DRAG_STEPS = 14


# Homebrew installs cliclick here. A server started from a double-clicked app
# gets a bare PATH without these folders, so look in them explicitly.
CLICLICK_FOLDERS = ["/opt/homebrew/bin", "/usr/local/bin"]


def find_cliclick():
    """Full path to cliclick, or None if it is not installed."""
    found = shutil.which("cliclick")
    if found:
        return found
    for folder in CLICLICK_FOLDERS:
        candidate = os.path.join(folder, "cliclick")
        if os.access(candidate, os.X_OK):
            return candidate
    return None


class Clicker:
    def __init__(self, dry_run):
        self.dry_run = dry_run

    def _cliclick(self, *commands, wait_ms=0):
        args = ["cliclick"]
        if not self.dry_run:
            program = find_cliclick()
            if not program:
                raise RuntimeError("cliclick was not found (install it with: brew install cliclick). Nothing was clicked.")
            args = [program]
        if wait_ms:
            args += ["-w", str(wait_ms)]
        args += list(commands)
        if self.dry_run:
            print("  [dry-run] " + " ".join(args))
            return ""
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"cliclick failed: {result.stderr.strip() or result.stdout.strip()}")
        return result.stdout

    def pointer(self):
        """Returns the current pointer (x, y), or None if it cannot be read."""
        if self.dry_run:
            return None
        match = re.search(r"(-?\d+)\s*,\s*(-?\d+)", self._cliclick("p"))
        return (int(match.group(1)), int(match.group(2))) if match else None

    def move(self, x, y):
        self._cliclick(f"m:{x},{y}")

    def click(self, x, y, repeat=True):
        if repeat and CLICK_REPEAT_MS > 0:
            # One cliclick call, so the gap between the two clicks is exact.
            gap = max(20, CLICK_REPEAT_MS + random.randint(-30, 30))
            self._cliclick(f"c:{x},{y}", f"w:{gap}", f"c:{x},{y}")
        else:
            self._cliclick(f"c:{x},{y}")

    def drag_down(self, x, y, pixels, steps):
        """A slow vertical drag, which iPhone Mirroring treats as a swipe."""
        # `m:` sends plain mouse-moved events, which only push the cursor. A
        # swipe needs mouse-dragged events (`dm:`) between the press and release.
        commands = [f"dd:{x},{y}", "w:120"]
        for step in range(1, steps + 1):
            commands.append(f"dm:{x},{y + round(pixels * step / steps)}")
        commands.append(f"du:{x},{y + pixels}")
        self._cliclick(*commands, wait_ms=random.randint(18, 32))


def jittered(point, spread):
    return point[0] + random.randint(-spread, spread), point[1] + random.randint(-spread, spread)


def pause(low, high, label=""):
    seconds = random.uniform(low, high)
    print(f"  waiting {seconds:.1f}s{' ' + label if label else ''}")
    time.sleep(seconds)


def mirroring_is_frontmost():
    script = 'tell application "System Events" to get name of first process whose frontmost is true'
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return result.returncode == 0 and result.stdout.strip() == MIRRORING_APP


def focus_mirroring():
    subprocess.run(["osascript", "-e", f'tell application "{MIRRORING_APP}" to activate'], capture_output=True)
    time.sleep(1.0)


def click_checked(clicker, target, what, check_focus, spread, repeat=True):
    """Moves to the target, verifies it is safe, then clicks it."""
    x, y = jittered(target, spread)
    if check_focus and not clicker.dry_run and not mirroring_is_frontmost():
        # Another app (for example the browser running the bot on this same Mac)
        # may have taken focus. Take it back once before giving up.
        focus_mirroring()
        if not mirroring_is_frontmost():
            raise RuntimeError(f"{MIRRORING_APP} is no longer the front app; stopping before clicking {what}.")
    # If the pointer stays far from where we put it, the user grabbed the mouse. A small
    # difference is ignored, and a bigger one gets a few chances to fix itself first.
    for attempt in range(1, POINTER_RECHECKS + 1):
        clicker.move(x, y)
        time.sleep(random.uniform(0.15, 0.4))
        position = clicker.pointer()
        if not position or (abs(position[0] - x) <= POINTER_TOLERANCE and abs(position[1] - y) <= POINTER_TOLERANCE):
            break
        if attempt == POINTER_RECHECKS:
            raise RuntimeError(f"Pointer moved away from {what} ({position} instead of {(x, y)}, "
                               f"more than {POINTER_TOLERANCE} points off {POINTER_RECHECKS} times in a row); stopping.")
        print(f"  pointer is at {position}, not near {x},{y}; putting it back ({attempt}/{POINTER_RECHECKS - 1})")
        time.sleep(0.4)
    print(f"  clicking {what} at {x},{y}")
    clicker.click(x, y, repeat)


def refresh_list(clicker, mode, spread, invert_scroll, check_focus=True):
    start = jittered((TRADE_OFFER[0], TRADE_OFFER[1] + REFRESH_Y_OFFSET), spread)
    if mode == "none":
        print("Skipping the refresh.")
    elif mode == "taps":
        if not REFRESH_TAPS:
            raise RuntimeError("REFRESH_TAPS is empty. Add the tap positions near the top of this script, or use --refresh-mode none.")
        print("Refreshing the confirmations list (taps)…")
        for label, x, y in REFRESH_TAPS:
            click_checked(clicker, (x, y), label, check_focus, spread)
            pause(1.0, 2.0, f"after tapping {label}")
    elif mode == "wheel":
        print("Refreshing the confirmations list (mouse-wheel scroll)…")
        clicker.move(start[0], start[1])
        if clicker.dry_run:
            print(f"  [dry-run] wheel scroll ({WHEEL_EVENTS} events x {WHEEL_LINES} lines) at {start[0]},{start[1]}")
        else:
            from refresh_swipe import pull_with_wheel
            time.sleep(0.3)
            # Working variant found by testing: line units, session event tap.
            pull_with_wheel(start[0], start[1], events=WHEEL_EVENTS, amount=WHEEL_LINES,
                            invert=invert_scroll, line_units=True, session_tap=True)
    elif mode == "replay":
        print("Refreshing the confirmations list (replaying the recorded gesture)…")
        clicker.move(start[0], start[1])
        if clicker.dry_run:
            print(f"  [dry-run] replay pull_refresh.json at {start[0]},{start[1]}")
        else:
            from gesture_replay import play_gesture
            time.sleep(0.3)
            play_gesture(start[0], start[1])
    elif mode == "drag":
        print("Refreshing the confirmations list (mouse drag)…")
        clicker.drag_down(start[0], start[1], REFRESH_DRAG_PIXELS, REFRESH_DRAG_STEPS)
    else:
        print("Refreshing the confirmations list (trackpad-style scroll)…")
        clicker.move(start[0], start[1])
        if clicker.dry_run:
            print(f"  [dry-run] scroll pull-down at {start[0]},{start[1]}")
        else:
            from refresh_swipe import pull_down_to_refresh
            time.sleep(0.3)
            pull_down_to_refresh(start[0], start[1], invert=invert_scroll)


def retry_round(clicker, check_focus, spread):
    """One round of the connection retry clicks (first, second and third button, with a small pause
    between them), then the wait for the iPhone to reconnect."""
    click_checked(clicker, TIMEOUT_RETRY_BUTTON, "the connection retry button", check_focus, min(spread, 3), repeat=False)
    if SECOND_RETRY_BUTTON:
        pause(*RETRY_CLICK_GAP_SECONDS, "between the retry clicks")
        click_checked(clicker, SECOND_RETRY_BUTTON, "the second retry button", check_focus, min(spread, 3), repeat=False)
    if THIRD_RETRY_BUTTON:
        pause(*RETRY_CLICK_GAP_SECONDS, "between the retry clicks")
        click_checked(clicker, THIRD_RETRY_BUTTON, "the third retry button", check_focus, min(spread, 3), repeat=False)
    pause(*RETRY_WAIT_SECONDS, "for the iPhone to reconnect after the retry button")


def ensure_confirmations_page(clicker, check_focus, spread, page_ready, max_rounds=None):
    """Check -> (not on the confirmations page) retry clicks -> check again -> ... until the check says
    the phone is on the confirmations page. `page_ready()` returns True (on the page), False (not on
    it) or None (it cannot be told: then one round of clicks is done and the run goes on)."""
    max_rounds = MAX_RETRY_ROUNDS if max_rounds is None else max_rounds
    rounds = 0
    while True:
        state = page_ready()
        if state is True:
            print("The phone is on the confirmations page." if not rounds else
                  f"The phone is on the confirmations page after {rounds} round{'s' if rounds != 1 else ''} of retry clicks.")
            return rounds
        if not TIMEOUT_RETRY_BUTTON:
            return rounds
        if rounds >= max_rounds:
            raise RuntimeError(f"The phone is still not on the confirmations page after {rounds} rounds of retry clicks.")
        rounds += 1
        print(f"The phone is {'not on the confirmations page' if state is False else 'in an unknown state'}: retry clicks, round {rounds}.")
        retry_round(clicker, check_focus, spread)
        if state is None:
            return rounds  # nothing to check against, so one round is all that can be done


def run(count, dry_run, check_focus, countdown, spread, refresh_mode, invert_scroll, skip_retry=False,
        page_ready=None):
    """`skip_retry`: the phone is known to be on the confirmations page already, so the
    connection retry buttons are not clicked.
    `page_ready`: a function telling whether the phone is on the confirmations page (see
    ensure_confirmations_page); the retry clicks are then repeated until it says yes."""
    clicker = Clicker(dry_run)

    if not dry_run:
        focus_mirroring()
    if countdown:
        print(f"Starting in {countdown}s. A small nudge of the mouse is fine; move it well away to stop.")
        time.sleep(countdown)

    if skip_retry:
        print("The phone is already on the confirmations page: skipping the connection retry clicks.")
    elif page_ready is not None:
        ensure_confirmations_page(clicker, check_focus, spread, page_ready)
    elif TIMEOUT_RETRY_BUTTON:
        # A timed-out connection leaves a retry button on screen; press it (three buttons, a
        # single click each, not the doubled one) before refreshing or accepting.
        retry_round(clicker, check_focus, spread)

    refresh_list(clicker, refresh_mode, spread, invert_scroll, check_focus)
    if refresh_mode != "none":
        pause(4.0, 6.0, "for the list to refresh")

    for number in range(1, count + 1):
        print(f"Trade {number}/{count}")
        click_checked(clicker, TRADE_OFFER, "the trade offer", check_focus, spread)
        pause(8.0, 10.0, "for the offer to open")
        click_checked(clicker, CONFIRM_BUTTON, "the confirm button", check_focus, spread)
        if number < count:
            # Steam goes back to the list and refreshes it by itself.
            pause(6.0, 10.0, "for the list to reload with the next trade")

    print(f"Done: clicked through {count} trade{'s' if count != 1 else ''}.")


def main():
    global WHEEL_EVENTS, WHEEL_LINES, REFRESH_Y_OFFSET, CLICK_REPEAT_MS, POINTER_TOLERANCE
    parser = argparse.ArgumentParser(description="Accept Steam mobile trade confirmations via iPhone Mirroring.")
    parser.add_argument("count", type=int, help=f"how many trades to accept (1-{MAX_TRADES_PER_RUN})")
    parser.add_argument("--dry-run", action="store_true", help="print the actions without clicking anything")
    parser.add_argument("--no-focus-check", action="store_true", help="do not require iPhone Mirroring to be the front app")
    parser.add_argument("--countdown", type=int, default=3, help="seconds to wait before the first action (default 3)")
    parser.add_argument("--jitter", type=int, default=5, help="random pixel offset applied to every click (default 5)")
    parser.add_argument("--refresh-mode", choices=["wheel", "replay", "taps", "scroll", "drag", "none"], default="wheel",
                        help="how to refresh the list first: mouse-wheel scroll (default), replay a recorded "
                             "trackpad gesture, configured taps, synthetic trackpad scroll, mouse drag, or none")
    parser.add_argument("--invert-scroll", action="store_true", help="reverse the scroll direction of the refresh")
    parser.add_argument("--wheel-events", type=int, default=WHEEL_EVENTS,
                        help=f"wheel mode: number of wheel events (default {WHEEL_EVENTS})")
    parser.add_argument("--wheel-lines", type=int, default=WHEEL_LINES,
                        help=f"wheel mode: lines per wheel event (default {WHEEL_LINES})")
    parser.add_argument("--refresh-y-offset", type=int, default=REFRESH_Y_OFFSET,
                        help=f"pixels below (+) or above (-) the trade offer where the refresh happens (default {REFRESH_Y_OFFSET})")
    parser.add_argument("--click-repeat-ms", type=int, default=CLICK_REPEAT_MS,
                        help=f"send every click twice, this many ms apart; 0 = single click (default {CLICK_REPEAT_MS})")
    parser.add_argument("--pointer-tolerance", type=int, default=POINTER_TOLERANCE,
                        help=f"how far (screen points) the mouse may be moved before the run stops (default {POINTER_TOLERANCE})")
    args = parser.parse_args()
    POINTER_TOLERANCE = max(6, args.pointer_tolerance)
    WHEEL_EVENTS, WHEEL_LINES, REFRESH_Y_OFFSET = args.wheel_events, args.wheel_lines, args.refresh_y_offset
    CLICK_REPEAT_MS = max(0, args.click_repeat_ms)

    if not 1 <= args.count <= MAX_TRADES_PER_RUN:
        parser.error(f"count must be between 1 and {MAX_TRADES_PER_RUN}")

    try:
        run(args.count, args.dry_run, not args.no_focus_check, args.countdown, args.jitter,
            args.refresh_mode, args.invert_scroll)
    except (RuntimeError, KeyboardInterrupt) as error:
        print(f"\nStopped: {error or 'interrupted'}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
