#!/bin/bash
# macOS launcher for the Citrix Work Login Automation.
# Double-click this file (or run: open run.command) to start the automation.
# A Terminal window opens, runs the script, and waits at the 2FA step for you.
cd "$(dirname "$0")" || exit 1
echo "=== Citrix Work Login Automation ==="
echo "Open the browser window that appears, then complete your 2FA when prompted."
echo "Press Ctrl+C here to cancel."
echo ""
node login.js
echo ""
echo "Automation finished. Close this window."
read -n 1 -s -r -p "Press any key to exit..."
