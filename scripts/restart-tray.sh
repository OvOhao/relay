#!/usr/bin/env bash
# Restart Relay's tray app (macOS LaunchAgent dev.relay.app) so it runs the code now in the live tree.
#
# Safe order: ask the running app to quit (SIGTERM), wait until it has really exited (at most 20 s), then let
# launchd start it again, and check that the new process serves the port in ~/.relay/connect.json.
# If the old process does not exit in time, nothing is started and the script stops with an error.
set -euo pipefail

LABEL="dev.relay.app"
TARGET="gui/$(id -u)/$LABEL"
CONNECT="${RELAY_HOME:-$HOME/.relay}/connect.json"
die() { echo "restart-tray: $*" >&2; exit 1; }

launchd_pid() { launchctl print "$TARGET" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'; }
alive() { kill -0 "$1" 2>/dev/null; }

launchctl print "$TARGET" >/dev/null 2>&1 || die "launchd does not know $TARGET (is the LaunchAgent loaded?)."

old="$(launchd_pid || true)"
if [ -n "$old" ]; then
  echo "Stopping the tray app (pid $old) ..."
  kill -TERM "$old" 2>/dev/null || true
  for _ in $(seq 1 40); do alive "$old" || break; sleep 0.5; done
  alive "$old" && die "pid $old has not exited after 20 s. Nothing was started; check it (ps -p $old) and quit it from the tray menu."
  echo "Stopped."
else
  echo "The tray app is not running."
fi

echo "Starting it: launchctl kickstart $TARGET"
launchctl kickstart "$TARGET"

new=""
port=""
for _ in $(seq 1 40); do
  new="$(launchd_pid || true)"
  if [ -n "$new" ] && [ "$new" != "$old" ] && [ -f "$CONNECT" ]; then
    port="$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port || "") } catch { console.log("") }' "$CONNECT")"
    if [ -n "$port" ] && lsof -nP -a -p "$new" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "OK: the tray app runs again as pid $new and listens on 127.0.0.1:$port."
      exit 0
    fi
  fi
  sleep 0.5
done
die "the tray app did not come back listening within 20 s (pid: ${new:-none}, port in $CONNECT: ${port:-none}). See: launchctl print $TARGET"
