#!/bin/bash
# Double-click to start the TF2 Trader browser, the sidebar and the confirm server.
# It runs in a Terminal window (which already has the Accessibility / Input
# Monitoring permissions your clicks need) and shows the server's output.
# Close Firefox to stop everything. When the launcher has finished cleaning up
# (Firefox and the server stopped), this Terminal window closes by itself.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# This window's id, so it can be closed at the end (only in Terminal.app).
WINDOW_ID=""
if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
  WINDOW_ID=$(osascript -e 'tell application "Terminal" to id of front window' 2>/dev/null)
fi

# Move this window to the top right corner of the main screen (keeps its size).
if [ -n "$WINDOW_ID" ]; then
  SCREEN_WIDTH=$(osascript -l JavaScript -e 'ObjC.import("AppKit"); Math.round($.NSScreen.screens.objectAtIndex(0).frame.size.width)' 2>/dev/null)
  if [ -n "$SCREEN_WIDTH" ]; then
    osascript -e "tell application \"Terminal\"
      set b to bounds of window id $WINDOW_ID
      set w to (item 3 of b) - (item 1 of b)
      set h to (item 4 of b) - (item 2 of b)
      set bounds of window id $WINDOW_ID to {$SCREEN_WIDTH - w, 30, $SCREEN_WIDTH, 30 + h}
    end tell" >/dev/null 2>&1
  fi
fi

python3 browserShell/launch.py "$@"
status=$?
echo
echo "TF2 Trader stopped (exit code $status)."

if [ -n "$WINDOW_ID" ] && [ "$status" -eq 0 ]; then
  # Close the window once this shell has exited. After an error the window stays
  # open so the message above can be read.
  ( sleep 1; osascript -e "tell application \"Terminal\" to close (window id $WINDOW_ID)" >/dev/null 2>&1 ) &
  exit 0
fi
echo "You can close this window."
exit $status
