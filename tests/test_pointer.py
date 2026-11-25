"""Mac confirmer: how far the mouse may be moved before a run stops.

confirm_trades.click_checked puts the pointer on a target, reads where it really is, and
stops only when it is still more than POINTER_TOLERANCE points away after POINTER_RECHECKS
tries. A stub stands in for cliclick, so this runs on any machine.

Run: python tests/test_pointer.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "macConfirmer"))
import confirm_trades as ct  # noqa: E402

ct.time.sleep = lambda seconds: None
ct.random.randint = lambda a, b: 0
ct.random.uniform = lambda a, b: a


class StubClicker:
    dry_run = False

    def __init__(self, positions):
        self.positions = list(positions)
        self.clicks = 0
        self.moves = 0

    def move(self, x, y):
        self.moves += 1

    def pointer(self):
        return self.positions.pop(0) if self.positions else (0, 0)

    def click(self, x, y, repeat=True):
        self.clicks += 1


TARGET = (1000, 500)


def run(positions):
    clicker = StubClicker(positions)
    try:
        ct.click_checked(clicker, TARGET, "x", False, 5)
        return "clicked", clicker.moves
    except RuntimeError:
        return "stopped", clicker.moves


def main():
    failures = 0

    def expect(label, got, want):
        nonlocal failures
        good = got == want
        failures += 0 if good else 1
        print(("ok   " if good else "FAIL ") + label, got)

    expect("exact position clicks", run([(1000, 500)]), ("clicked", 1))
    expect("20 point nudge still clicks", run([(1020, 485)]), ("clicked", 1))
    expect("off once, then back, clicks after a re-move", run([(300, 300), (1001, 500)]), ("clicked", 2))
    expect("always far stops after the re-checks", run([(300, 300)] * 5), ("stopped", ct.POINTER_RECHECKS))
    expect("unreadable pointer clicks", run([None]), ("clicked", 1))
    print("ALL PASS" if not failures else f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
