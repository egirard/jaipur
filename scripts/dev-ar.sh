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

node_modules/.bin/firebase emulators:start --project demo-jaipur --only auth,firestore &
EMU=$!
trap 'kill $EMU 2>/dev/null' EXIT
sleep 6
bun run dev
