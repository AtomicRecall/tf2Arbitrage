#!/bin/bash
# Creates "TF2 Trader.app" in the project folder: double-click it to start the
# browser, the sidebar and the confirm server together.
#
#   chmod +x browserShell/make_app.sh
#   browserShell/make_app.sh
#
# The app is a tiny launcher that runs browserShell/launch.py in the background
# and writes its output to ~/Library/Logs/TF2Trader.log. It points at this
# project folder, so re-run this script if you move the folder.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/TF2 Trader.app"
LOG="$HOME/Library/Logs/TF2Trader.log"

rm -rf "$APP"
osacompile -o "$APP" -e "do shell script \"export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; cd '$ROOT' && /usr/bin/python3 browserShell/launch.py >> '$LOG' 2>&1 &\""
echo "Created: $APP"
echo "Log: $LOG"
echo "Grant Accessibility and Input Monitoring to this app (and to Terminal if the"
echo "clicks do not work) in System Settings > Privacy & Security."
