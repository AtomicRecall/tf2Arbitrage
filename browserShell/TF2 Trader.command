#!/bin/bash
# Double-click to start the TF2 Trader browser, the sidebar and the confirm server.
# It runs in a Terminal window (which already has the Accessibility / Input
# Monitoring permissions your clicks need) and shows the server's output.
# Close Firefox to stop everything.
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
python3 browserShell/launch.py "$@"
status=$?
echo
echo "TF2 Trader stopped (exit code $status). You can close this window."
