#!/bin/bash
# Creates "TF2 Trader.app" in the project folder: double-click it to start the
# browser, the sidebar and the confirm server together.
#
#   chmod +x browserShell/make_app.sh
#   browserShell/make_app.sh
#
# The app opens a Terminal window that runs browserShell/TF2 Trader.command (which
# runs browserShell/launch.py and closes the window when it has finished), so the
# clicks use Terminal's Accessibility / Input Monitoring permissions (the ones
# you already granted) and the server's output stays visible. It points at this
# project folder, so re-run this script if you move the folder.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/TF2 Trader.app"

rm -rf "$APP"
osacompile -o "$APP" \
  -e 'tell application "Terminal"' \
  -e 'activate' \
  -e "do script \"bash '$ROOT/browserShell/TF2 Trader.command'\"" \
  -e 'end tell'
echo "Created: $APP"
echo "The first time you open it, macOS asks whether it may control Terminal: allow it."
echo "Tip: drag it to the Dock. Close Firefox to stop everything."
