#!/bin/sh
# Update Desk from GitHub, then start the server.
# Usage in Termux: stop the server with Ctrl+C, then run:  sh update.sh
# Your data/ folder (PIN, exams, XP, data/config.json) is never touched by this.
cd "$(dirname "$0")" || exit 1
echo "Checking GitHub for updates..."
if ! git pull --ff-only; then
  echo "Update failed, so nothing was changed. Starting the version you already have."
fi
termux-wake-lock 2>/dev/null
exec python server.py
