#!/usr/bin/env bash
# Promote tested work from the development worktree (branch `dev`) to the live tree (branch `main`).
#
# The live tree is the folder the tray app and every Claude window's Relay MCP server run from, so it only ever
# moves by a fast-forward to commits that passed `npm test`. This script never restarts anything.
#
#   scripts/promote-dev.sh            (run from either worktree)
#
# RELAY_LIVE / RELAY_DEV override the two folders; by default they are the worktrees on `main` and `dev`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

worktree_on() { # print the path of the worktree that has branch $1 checked out
  git -C "$here" worktree list --porcelain | awk -v want="branch refs/heads/$1" '
    /^worktree / { wt = substr($0, 10) }
    $0 == want   { print wt; exit }'
}

LIVE="${RELAY_LIVE:-$(worktree_on main)}"
DEV="${RELAY_DEV:-$(worktree_on dev)}"
die() { echo "promote-dev: $*" >&2; exit 1; }

[ -n "$LIVE" ] && [ -d "$LIVE" ] || die "no worktree on branch main found (set RELAY_LIVE)."
[ -n "$DEV" ] && [ -d "$DEV" ] || die "no worktree on branch dev found (set RELAY_DEV, or: git worktree add ../relay-dev -b dev)."
[ "$(git -C "$LIVE" symbolic-ref --short HEAD 2>/dev/null)" = main ] || die "$LIVE is not on branch main."
[ "$(git -C "$DEV" symbolic-ref --short HEAD 2>/dev/null)" = dev ] || die "$DEV is not on branch dev."

echo "live: $LIVE (main)"
echo "dev:  $DEV (dev)"

# 1. The live tree must be clean (ignored files, such as local scratch folders listed in .gitignore, do not count).
dirty="$(git -C "$LIVE" status --porcelain --untracked-files=normal)"
if [ -n "$dirty" ]; then
  echo "$dirty" >&2
  die "the live tree has uncommitted changes (above). Commit them on main, or move them to dev, before promoting."
fi

# The tests must run on exactly what will be promoted: no uncommitted changes in dev either.
dirty_dev="$(git -C "$DEV" status --porcelain --untracked-files=normal)"
if [ -n "$dirty_dev" ]; then
  echo "$dirty_dev" >&2
  die "the dev worktree has uncommitted changes (above). Commit them on dev first, so the tested code is the promoted code."
fi

old="$(git -C "$LIVE" rev-parse HEAD)"
new="$(git -C "$DEV" rev-parse HEAD)"
if [ "$old" = "$new" ]; then echo "main is already at dev ($(git -C "$LIVE" log -1 --format='%h %s')). Nothing to promote."; exit 0; fi
git -C "$LIVE" merge-base --is-ancestor "$old" "$new" \
  || die "dev does not contain main's latest commit, so main cannot fast-forward. In $DEV run: git rebase main (or git merge main), test, and promote again."

# 2. Tests, in the dev worktree.
echo
echo "== npm test in $DEV"
(cd "$DEV" && npm test) || die "npm test failed in $DEV. Nothing was promoted."

# Background jobs that are not finished: running ones keep the code they loaded; parked ones wake on the code on disk
# (their runner hands over to a fresh process). "old" = parked jobs whose sleeping runner predates that handover (no
# runnerCode in the record): it still wakes in its own process, on its old code. Printed as "running parked old".
jobcounts="$(node -e '
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = path.join(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"), "jobs");
  let running = 0, parked = 0, old = 0;
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (["done", "failed", "cancelled"].includes(j.state)) continue;
      if (j.state === "parked") { parked++; if (!j.runnerCode) old++; } else running++;
    } catch {}
  } } catch {}
  console.log(running, parked, old);' 2>/dev/null || echo "? ? ?")"
read -r running parked oldparked <<<"$jobcounts"

# 3. Fast-forward main. This changes files in the live tree, all at once, to a tested commit.
echo
echo "== fast-forward main to dev"
git -C "$LIVE" merge --ff-only dev
echo
echo "Promoted $(git -C "$LIVE" rev-list --count "$old..$new") commit(s):"
git -C "$LIVE" log --format='  %h %s' "$old..$new"

changed="$(git -C "$LIVE" diff --name-only "$old" "$new")"
echo
echo "Changed files:"
echo "$changed" | sed 's/^/  /'

# 4. What picks the change up, and what needs a restart.
echo
echo "What happens next:"
echo "  - Relay tool calls (relay_run, relay_start, ...) run src/ in a fresh process each time: they use the new code now."
if echo "$changed" | grep -qE '^src/(mcp\.js|core/store\.js)$'; then
  echo "  - src/mcp.js or src/core/store.js changed: these are loaded once per Claude session by the MCP server."
  echo "    Open Claude sessions keep the old copy until they are restarted; new sessions get the new one."
fi
if echo "$changed" | grep -qE '^(src/|ui/|package\.json)'; then
  echo "  - REMINDER: the tray app (main process and panel UI) still runs the old code. If this change touches"
  echo "    src/main.js, src/server.js, src/core/* or ui/, restart it when convenient: scripts/restart-tray.sh"
else
  echo "  - No src/ or ui/ changes: the tray app does not need a restart."
fi
echo "  - Background jobs: $running running, $parked parked."
if [ "$running" != "0" ]; then
  echo "    Running jobs finish their current segment on the code they started with; jobs started from now on use the new code."
fi
if [ "$parked" != "0" ]; then
  echo "    Parked jobs pick up the new code on their next wake: a sleeping runner hands over to a fresh process at the"
  echo "    wake time, and within about a minute when src/ changes."
  if [ "$oldparked" != "0" ]; then
    echo "    Except $oldparked parked job(s) whose runner started before this handover existed: those still wake on the"
    echo "    code their runner loaded, until that runner is replaced."
  fi
fi
echo
echo "Nothing was restarted."
