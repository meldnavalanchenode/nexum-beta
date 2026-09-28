#!/bin/bash
# Pit-test rehearsal — a teammate plays "the team", you run the flow, TIMED.
# Do 3 rounds until each is under 3 minutes and the money sentence is boring.
#   ./rehearse.sh alpha     # clean robot   — practice "you're good, tool's yours anyway"
#   ./rehearse.sh bravo     # the typo      — practice "did you already know about this?"
#   ./rehearse.sh charlie   # multi-finding — practice reading a list calmly
#   ./rehearse.sh           # random team, like real life
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${PHYSYNC_NODE:-$HOME/.local/node22/bin/node}"; [ -x "$NODE" ] || NODE=node
SC="$HERE/../../app/bin/physync.js"

TEAM="${1:-$(printf '%s\n' alpha bravo charlie | sed -n "$((RANDOM%3+1))p")}"
DIR="$HERE/team_$TEAM"
[ -d "$DIR" ] || { echo "no mock team '$TEAM' (alpha|bravo|charlie)"; exit 1; }

echo "════════════════════════════════════════════════"
echo "  MOCK TEAM: $TEAM — start your timer NOW"
echo "════════════════════════════════════════════════"
echo "  Say: \"Can I run a 2-minute read-only check on your"
echo "        config? Nothing runs on the robot.\""
echo ""
START=$(date +%s)
"$NODE" "$SC" check --config "$DIR/robot.xml" --code "$DIR/code"
END=$(date +%s)
echo ""
echo "  ── now, OUT LOUD, to your 'team' ──"
echo "  1. Read each finding. Ask: \"did you already know about this?\""
echo "  2. War story: \"worst config surprise this robot ever pulled on you?\""
echo "  3. The money sentence, exactly:"
echo "       \"I'll keep this working for your team all season —"
echo "        \$20, or free if you'd rather. Which?\""
echo "  4. Fill the tally row for team $TEAM."
echo ""
echo "  scan took ${START}→${END} = $((END-START))s of machine time."
echo "  YOUR clock (talking included) is the one that must beat 3:00."
