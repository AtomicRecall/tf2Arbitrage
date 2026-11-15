#!/usr/bin/env python3
"""Tells whether the iPhone is ready for the Mac, by the colour of one spot on the screen.

iPhone Mirroring only works while the phone is locked. When it is, the mirroring
window shows the Steam app's confirmations page; while you use the phone it shows
something else (an "iPhone In Use" screen). You record one spot of the confirmations
page once; later the server takes a tiny screenshot of that spot and compares its
colour with the saved one:

  * same colour  -> the phone is ready: no "lock your iPhone" notification is needed
  * other colour -> the phone is in use (or on another screen): notify, wait, then click

  python3 confirm_server.py --pick-phone-spot     # hover the mouse over the spot, wait 5 s
  python3 confirm_server.py --phone-spot 1308,578 # or give the position yourself
  python3 confirm_server.py --check-phone         # prints what the spot looks like now

Positions are screen points, the same numbers `cliclick p` prints and the click
positions in confirm_trades.py use. Only that spot's colour is read and saved, in
server_config.json (git-ignored). Needs the macOS tool `screencapture` (Terminal
needs Screen Recording permission); the PNG is decoded here.
"""

import json
import os
import re
import struct
import subprocess
import tempfile
import time
import zlib
from pathlib import Path

CONFIG_FILE = Path(__file__).with_name("server_config.json")
MIRRORING_APP = "iPhone Mirroring"

TOLERANCE = 24  # largest red/green/blue difference that still counts as "the same colour"
SPOT_SIZE = 5  # the spot is a square this many screen points wide; its pixels are averaged


# ---- config (shared with confirm_server.py) ---------------------------------------
def load_config():
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except ValueError:
            return {}
    return {}


def save_config(config):
    CONFIG_FILE.write_text(json.dumps(config))
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass


# ---- reading pixels ---------------------------------------------------------------
def decode_png(data):
    """Returns (width, height, rows); each row is bytes of RGB triples (alpha dropped).
    Supports 8-bit RGB and RGBA, not interlaced: what macOS makes."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file")
    pos, idat = 8, []
    width = height = depth = color = interlace = None
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if width is None or not idat:
        raise ValueError("incomplete PNG file")
    if depth != 8 or color not in (2, 6) or interlace != 0:
        raise ValueError(f"unsupported PNG (depth {depth}, colour type {color}, interlace {interlace})")
    channels = 3 if color == 2 else 4
    stride = width * channels
    raw = zlib.decompress(b"".join(idat))
    if len(raw) < height * (stride + 1):
        raise ValueError("truncated PNG data")
    rows, previous = [], bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1:start + 1 + stride])
        if kind == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 255
        elif kind == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 255
        elif kind == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 255
        elif kind == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = previous[i]
                c = previous[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + predictor) & 255
        elif kind != 0:
            raise ValueError(f"unknown PNG filter {kind}")
        previous = line
        if channels == 4:
            rows.append(bytes(line[i] for i in range(stride) if i % 4 != 3))
        else:
            rows.append(bytes(line))
    return width, height, rows


def average_color(width, height, rows):
    """The average colour (r, g, b) of every pixel of a decoded picture."""
    total = [0, 0, 0]
    for row in rows:
        for i in range(0, width * 3, 3):
            total[0] += row[i]
            total[1] += row[i + 1]
            total[2] += row[i + 2]
    count = max(1, width * height)
    return [round(value / count) for value in total]


def colors_match(current, reference, tolerance=TOLERANCE):
    """True when every channel is within `tolerance`."""
    return max(abs(a - b) for a, b in zip(current, reference)) <= tolerance


# ---- the screen -------------------------------------------------------------------
def read_spot_color(spot):
    """The colour at screen point `spot` (x, y): a tiny screenshot, averaged."""
    x, y = spot
    half = SPOT_SIZE // 2
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "spot.png")
        result = subprocess.run(["screencapture", "-x", "-t", "png", "-R", f"{x - half},{y - half},{SPOT_SIZE},{SPOT_SIZE}", path],
                                capture_output=True, text=True)
        if result.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) == 0:
            raise RuntimeError("screencapture failed (give Terminal Screen Recording permission in "
                               f"System Settings > Privacy & Security): {result.stderr.strip()}")
        with open(path, "rb") as handle:
            return average_color(*decode_png(handle.read()))


def pointer_position():
    """The mouse position in screen points, read with cliclick."""
    import confirm_trades
    program = confirm_trades.find_cliclick()
    if not program:
        raise RuntimeError("cliclick was not found (brew install cliclick).")
    result = subprocess.run([program, "p"], capture_output=True, text=True)
    match = re.search(r"(-?\d+)\s*,\s*(-?\d+)", result.stdout)
    if result.returncode != 0 or not match:
        raise RuntimeError("cliclick could not read the mouse position.")
    return int(match.group(1)), int(match.group(2))


def bring_mirroring_to_front():
    subprocess.run(["osascript", "-e", f'tell application "{MIRRORING_APP}" to activate'], capture_output=True)
    time.sleep(1.0)


# ---- the check --------------------------------------------------------------------
class PhoneCheck:
    """Compares the saved spot's colour with what the screen shows now."""

    def __init__(self, config):
        self.spot = tuple(config["spot"])
        self.color = list(config["color"])
        self.tolerance = int(config.get("tolerance") or TOLERANCE)

    @classmethod
    def from_config(cls, config=None):
        saved = (config if config is not None else load_config()).get("phone_check")
        if not saved or not saved.get("spot") or not saved.get("color"):
            return None
        return cls(saved)

    def look(self, bring_to_front=True):
        """Returns ("free", details) when the spot shows the saved colour (the phone is ready),
        otherwise ("busy", details). Raises when the screen cannot be read."""
        if bring_to_front:
            bring_mirroring_to_front()
        current = read_spot_color(self.spot)
        same = colors_match(current, self.color, self.tolerance)
        details = f"spot {self.spot[0]},{self.spot[1]} is rgb{tuple(current)}, saved rgb{tuple(self.color)}"
        return ("free" if same else "busy"), details


def save_spot(spot, color=None, tolerance=None):
    """Saves the spot and its colour (read from the screen now when not given)."""
    if color is None:
        color = read_spot_color(spot)
    config = load_config()
    saved = {"spot": list(spot), "color": list(color)}
    if tolerance:
        saved["tolerance"] = int(tolerance)
    config["phone_check"] = saved
    save_config(config)
    return saved
