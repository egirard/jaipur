#!/usr/bin/env bash
# Start the local jaipur-AR test stack: Firebase emulators (auth+firestore)
# and the vite dev server. Needs Java 21+ on PATH for the Firestore emulator
# (JAVA_HOME=~/jdk21 works on this machine) and `bun install` done once.
#
# Then open (on this machine):
#   http://127.0.0.1:5185/tt/?bot=1&diag=27     <- tabletop, solitaire mode
# Take seat 1 in another tab via the Player 1 QR link (the phone can't reach
# 127.0.0.1 — it is dedicated to AR: scan the seat's AR QR instead).
set -euo pipefail
cd "$(dirname "$0")/.."

export JAVA_HOME="${JAVA_HOME:-$HOME/jdk21}"
export PATH="$JAVA_HOME/bin:$PATH"

# Vite binds all interfaces: WSL2's localhost forwarding to Windows has
# gone stale for a single port more than once, and http://<WSL-IP>:5185
# keeps working when 127.0.0.1 does not. The emulators stay on 127.0.0.1
# (the page reaches them through Windows' localhost forwarding).
node_modules/.bin/firebase emulators:start --project demo-jaipur --only auth,firestore &
EMU=$!
trap 'kill $EMU 2>/dev/null' EXIT
sleep 6
node_modules/.bin/vite dev --host 0.0.0.0 --port 5185 --strictPort
