#!/bin/bash
set -euo pipefail
umask 077

SERVER_ROOT="${COMPANION_MC_SERVER_ROOT:-$HOME/工作/会话/coopcraft/server}"
CONTROL_DIR="${COMPANION_MC_CONTROL_DIR:-$HOME/.local/share/companion/minecraft}"
FIFO="$CONTROL_DIR/console.in"

mkdir -p "$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"
if [[ -e "$FIFO" && ! -p "$FIFO" ]]; then
  echo "Companion console input is not a FIFO" >&2
  exit 1
fi
if [[ ! -p "$FIFO" ]]; then
  mkfifo "$FIFO"
fi
chmod 600 "$FIFO"
cd "$SERVER_ROOT"

# Keep a read/write descriptor open so a quiet server never sees EOF.
exec 3<>"$FIFO"
exec /usr/bin/caffeinate -s /bin/bash "$SERVER_ROOT/start.sh" <&3
