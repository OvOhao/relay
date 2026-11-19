# Developing Relay next to a live Relay

If you use Relay while you work on it, the folder that Relay runs from is live code:

- the tray app is a LaunchAgent (`~/Library/LaunchAgents/dev.relay.app.plist`) that starts Electron on that folder, and
- every Claude window's Relay MCP server is `src/mcp.js` in that folder. Each tool call (`relay_run`, `relay_start`, …)
  runs `src/tool-call.js` in a new process, so it picks up every change to `src/` at once, half-finished or not.

So the live folder is never edited by hand. Work happens in a second git worktree, and the live folder only moves by a
fast-forward to commits that passed the tests.

| | Folder | Branch | Used for |
|---|---|---|---|
| live | `baton-macos/` | `main` | what the tray app and the MCP servers run. `~/.claude.json` and the LaunchAgent point here and never change. |
| dev | `relay-dev/` (next to it) | `dev` | all editing, testing and committing |

## One-time setup

```bash
cd baton-macos
git worktree add ../relay-dev -b dev
ln -s ../baton-macos/node_modules ../relay-dev/node_modules
```

**node_modules.** `npm test` needs no packages at all (the tests use only Node's built-ins and fake `claude` / `codex`
programs), so it works in relay-dev without anything installed. The symlink is only there so that Electron (the one
real dependency, about 250 MB) resolves from relay-dev too, without a second download. `.gitignore` lists
`node_modules` without a trailing slash so that git ignores the symlink.

Because the folder is shared, **do not run `npm install` or `npm ci` in relay-dev**: it would write into the live
tree's `node_modules`. If a change needs different dependencies, remove the symlink in relay-dev first
(`rm ../relay-dev/node_modules`), then `npm ci` there to get a separate copy.

## The loop

1. **Work in relay-dev, on branch `dev`.** Edit, then `npm test`, then commit on `dev`.
2. **Look at the panel safely.** `node src/dev.js --demo` (in a browser) or
   `"$(node -p "require('electron')")" . --demo` (the real Electron window) use throwaway accounts in a temporary
   folder. Do not start relay-dev *without* `--demo`: it would use your real `~/.relay` alongside the running tray app.
3. **Promote.** From either folder:

   ```bash
   scripts/promote-dev.sh
   ```

   It refuses if the live tree has uncommitted changes (ignored files do not count), if
   relay-dev has uncommitted changes (the tested code must be the promoted code), or if `main` cannot fast-forward to
   `dev`. Then it runs `npm test` in relay-dev and, only if that passes, runs `git merge --ff-only dev` in the live
   tree. It lists what changed and what will pick the change up. It never restarts anything.
4. **Restart the tray app if needed.** Tool calls use the new `src/` immediately. The tray app (main process, the
   panel UI, its local server) keeps the code it started with. If the promotion touched `src/main.js`,
   `src/server.js`, `src/core/*` or `ui/`, restart it when convenient:

   ```bash
   scripts/restart-tray.sh
   ```

   It sends SIGTERM to the pid launchd reports, waits up to 20 s for that process to exit (and stops, starting
   nothing, if it does not), runs `launchctl kickstart gui/$UID/dev.relay.app`, then checks that the new process
   listens on the port in `~/.relay/connect.json`.

## What picks up a change, and when

| Part | Loads code | After a promotion |
|---|---|---|
| Tool calls (`src/tool-call.js` and what it requires) | new process per call | new code at once |
| Tool definitions (`src/tool-defs.js`) | read again when the file changes | windows are told the tools changed |
| MCP server itself (`src/mcp.js`, `src/core/store.js`) | once per Claude session | new sessions only |
| Background jobs, running (`src/job-runner.js`) | once per job runner | a running job finishes its current segment on the code it started with; jobs started afterwards use the new code |
| Background jobs, parked | a fresh runner process per wake | every wake runs the code on disk at that time: the sleeping runner hands the job to a new `job-runner.js` process at the wake time, and within about a minute when `src/` changes ([park-wake.md](park-wake.md#a-fresh-process-for-every-wake)) |
| Tray app (`src/main.js`, `src/server.js`, `src/core/*`, `ui/`) | once at start | after `scripts/restart-tray.sh` |

Because running background jobs may still load a module lazily, prefer promoting changes to `src/core/` when no job is
running. `promote-dev.sh` says how many jobs are running and how many are parked; parked jobs need nothing: they pick up
the new code on their next wake. The one exception is a parked job whose sleeping runner was started by code from
before this handover existed (its record has no `runnerCode`; `promote-dev.sh` counts these separately): that runner
still wakes in its own process on its old code. Replacing it once (killing it with SIGKILL, *not* SIGTERM, which
cancels the job; the next Relay call or the tray app's minute check starts a new runner) gives it the new behaviour.

## Keeping dev up to date

If something is committed on `main` directly (for example by the one-time commit that created this setup), bring it
into dev before the next promotion:

```bash
cd ../relay-dev && git merge --ff-only main     # or: git rebase main
```
