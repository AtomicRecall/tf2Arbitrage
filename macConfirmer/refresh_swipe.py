#!/usr/bin/env python3
"""Pull-to-refresh for the Steam app in iPhone Mirroring, done with mouse-wheel
events posted through CoreGraphics (macOS only; no extra packages).

iPhone Mirroring ignores drags and synthetic trackpad gestures, but it accepts
plain line-unit wheel events posted at the session event tap, so that is what
`pull_with_wheel` sends: a run of small downward-pulling scroll steps with the
pointer resting on the list.

  python3 refresh_swipe.py 1270 495              # wheel pull at that point
  python3 refresh_swipe.py 1270 495 --invert     # the other direction

confirm_trades.py calls pull_with_wheel() itself.
"""

import argparse
import ctypes
import ctypes.util
import time

SCROLL_UNIT_PIXEL = 0
SCROLL_UNIT_LINE = 1
SESSION_EVENT_TAP = 1  # kCGSessionEventTap
HID_EVENT_TAP = 0  # kCGHIDEventTap


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


_quartz = None


def _load():
    global _quartz
    if _quartz is not None:
        return _quartz
    path = ctypes.util.find_library("ApplicationServices") or "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    try:
        library = ctypes.CDLL(path)
    except OSError as error:
        raise RuntimeError(f"CoreGraphics is not available ({error}); wheel scrolling only works on macOS.")
    library.CGEventCreateScrollWheelEvent2.restype = ctypes.c_void_p
    library.CGEventCreateScrollWheelEvent2.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32, ctypes.c_int32, ctypes.c_int32,
    ]
    library.CGEventSetLocation.argtypes = [ctypes.c_void_p, CGPoint]
    library.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    library.CFRelease.argtypes = [ctypes.c_void_p]
    _quartz = library
    return library


def _post_wheel(x, y, delta, line_units, session_tap):
    library = _load()
    unit = SCROLL_UNIT_LINE if line_units else SCROLL_UNIT_PIXEL
    event = library.CGEventCreateScrollWheelEvent2(None, unit, 1, int(delta), 0, 0)
    if not event:
        raise RuntimeError("Could not create a scroll event (is this macOS with a logged-in session?).")
    try:
        library.CGEventSetLocation(event, CGPoint(float(x), float(y)))
        library.CGEventPost(SESSION_EVENT_TAP if session_tap else HID_EVENT_TAP, event)
    finally:
        library.CFRelease(event)


def pull_with_wheel(x, y, events=14, amount=None, step_delay=0.03, invert=False, line_units=True, session_tap=False):
    """Pulls the list down at (x, y): `events` wheel events of `amount` units each.

    The default direction pulls the content down (the pull-to-refresh motion);
    `invert` reverses it for systems with the opposite scroll setting."""
    if amount is None:
        amount = 6 if line_units else 40
    delta = -abs(amount) if invert else abs(amount)
    for _ in range(max(1, int(events))):
        _post_wheel(x, y, delta, line_units, session_tap)
        time.sleep(step_delay)


def pull_down_to_refresh(x, y, invert=False):
    """Trackpad-like variant: pixel-unit wheel events that ease in and out."""
    steps = [8, 14, 22, 30, 36, 40, 40, 36, 30, 22, 14, 8]
    for amount in steps:
        _post_wheel(x, y, -amount if invert else amount, False, True)
        time.sleep(0.02)


def main():
    parser = argparse.ArgumentParser(description="Wheel-based pull-to-refresh test.")
    parser.add_argument("x", type=int)
    parser.add_argument("y", type=int)
    parser.add_argument("--events", type=int, default=28)
    parser.add_argument("--amount", type=int, default=6)
    parser.add_argument("--invert", action="store_true")
    args = parser.parse_args()
    pull_with_wheel(args.x, args.y, events=args.events, amount=args.amount, invert=args.invert,
                    line_units=True, session_tap=True)


if __name__ == "__main__":
    main()
