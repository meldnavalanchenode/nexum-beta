#!/bin/bash
# PHYSYNC pit runner — one team, ~3 minutes, read-only.
#   ./pull-and-check.sh <team-number>        pull configs off a connected RC via adb, then check
#   ./pull-and-check.sh <team-number> <dir>  skip adb; use a TeamCode folder they hand you
#   ./pull-and-check.sh --demo               dry-run against the bundled sample (pre-event test)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../app"
NODE="${PHYSYNC_NODE:-$HOME/.local/node22/bin/node}"
[ -x "$NODE" ] || NODE=node

# adb is installed with Android Studio but is NOT on PATH on this machine, and
# a bare `adb` here fails in a pit with a team standing there waiting. Look in
# the places it actually lives, in order, and say so plainly when it is absent.
find_adb() {
  if command -v adb >/dev/null 2>&1; then command -v adb; return 0; fi
  for c in "$HOME/Library/Android/sdk/platform-tools/adb" \
           "$HOME/Android/Sdk/platform-tools/adb" \
           "/usr/local/bin/adb" "/opt/homebrew/bin/adb"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
ADB="$(find_adb || true)"

if [ "${1:-}" = "--demo" ]; then
  echo "── demo: seeded sample (expect FAIL with a did-you-mean) ──"
  "$NODE" "$APP/bin/physync.js" check --config "$APP/samples/config.xml" --code "$APP/samples/TeamCode"
  DEMO_STATUS=$?
  echo ""
  if [ -n "$ADB" ]; then
    echo "adb: $ADB  ($("$ADB" version 2>/dev/null | sed -n 1p))"
    echo "devices attached right now:"
    "$ADB" devices | sed -n '2,$p' | grep -v '^$' || echo "  (none — normal unless an RC is plugged in)"
  else
    echo "⚠ adb NOT FOUND. The pit protocol's pull step will fail without it."
    echo "  Install Android platform-tools, or pass a team's TeamCode folder as arg 2"
    echo "  and copy their config XML in by hand — the check itself does not need adb."
  fi
  exit $DEMO_STATUS
fi

TEAM="${1:?usage: pull-and-check.sh <team-number> [teamcode-dir]}"
OUT="$HERE/pit-data/$TEAM"
mkdir -p "$OUT"

CODE_DIR="${2:-}"
if [ -z "$CODE_DIR" ]; then
  echo "── pulling /sdcard/FIRST from connected device (read-only) ──"
  [ -n "$ADB" ] || { echo "adb not found. Install Android platform-tools, or skip the pull: copy their config XML into $OUT/FIRST/ and re-run with their TeamCode dir as arg 2."; exit 1; }
  "$ADB" devices | sed -n 2p
  "$ADB" pull /sdcard/FIRST "$OUT/FIRST" >/dev/null 2>&1 || { echo "adb pull failed — is the RC connected + USB debugging on? Or pass their TeamCode dir as arg 2."; exit 1; }
  echo "pulled → $OUT/FIRST"
  echo "Now ask for their TeamCode folder (USB stick / their laptop) and re-run:"
  echo "  ./pull-and-check.sh $TEAM <path-to-TeamCode>"
  ls "$OUT/FIRST/"*.xml 2>/dev/null | head -5
  exit 0
fi

# find the active-looking config: newest XML with a <Robot root
CONFIG=""
for x in "$OUT/FIRST/"*.xml; do
  [ -f "$x" ] && grep -q '<Robot type="FirstInspires-FTC"' "$x" && CONFIG="$x"
done
[ -n "$CONFIG" ] || { echo "No FTC config XML in $OUT/FIRST — pull first (run without arg 2), or copy their XML into $OUT/FIRST/."; exit 1; }

echo "── PHYSYNC check: team $TEAM ──"
echo "config: $(basename "$CONFIG")   code: $CODE_DIR"
"$NODE" "$APP/bin/physync.js" check --config "$CONFIG" --code "$CODE_DIR" --report "$OUT/report.md"
STATUS=$?
"$NODE" "$APP/bin/physync.js" check --config "$CONFIG" --code "$CODE_DIR" --json > "$OUT/report.json" 2>/dev/null
echo ""
echo "saved: $OUT/report.md + report.json  (exit $STATUS: 0=PASS 2=FAIL)"
echo "→ Fill the tally row NOW. Ask: 'did you already know about these?'"
exit $STATUS
