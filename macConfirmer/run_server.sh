#!/bin/bash
# Starts the confirmation server on this Mac and keeps the Mac (and its display)
# awake while it runs: iPhone Mirroring and the clicks stop working if the Mac
# sleeps or the screen locks.
#
#   ./run_server.sh --dry-run      # test without clicking
#   ./run_server.sh                # real run
#
# First time only: chmod +x run_server.sh
cd "$(dirname "$0")" || exit 1
exec caffeinate -dimsu python3 confirm_server.py "$@"
