# Park / wake, pick order, several jobs per worker

## Park / wake (long-running work)

**Worker side.** Every worker prompt (new, follow-up, all providers) carries the protocol (`core/park.js` `INSTRUCTIONS`).
Once a worker has launched long-running work and verified that it runs, with nothing useful left until it finishes,
it may end its reply with this as the very last line:

```
RELAY_PARK: <minutes> | <what to check on wake>
```

Before that line, its report must say what it launched, where the logs and results are, and how to check the status.

**Parsing.** Only the last non-empty line counts (`parseParkLine`).
- Minutes are rounded and clamped to [5, 1440].
- A line that starts like `RELAY_PARK` but cannot be read is ignored. The job then ends normally, and its report says the line was ignored.
- A park without a known session id cannot be woken, so that job also ends normally.

**Relay side.** `runWorker` returns `park: { minutes, check, wakeAt }`. The leader-facing text drops the park line
and adds a `PARKED: … woken in N min (time) to check: …` line. The ledger gets one entry per segment, and parked
entries start with `PARKED until …`.

The detached runner (`src/job-runner.js`) loops as follows:

1. On a park, the record becomes `state: parked` with `wakeAt`, `parkCheck`, `parkedAt`, `sessionId` and `account`.
   The segment's report goes into `history`. The tray app gets a notification with the wake time.
2. Nothing runs and no run file exists, so the job counts as no load on any account.
3. The runner sleeps in 30 s steps against the wall clock, so a Mac that slept or a wake time that already passed
   wakes at once.
4. The sleeping runner does not wake the job itself. At the wake time it hands the job to a fresh runner process,
   which runs the code on disk now, and exits (see [A fresh process for every wake](#a-fresh-process-for-every-wake)).
5. At the wake, `wakes` goes up by one, and `runWorker({ ...request, wake: { sessionId, account, provider, n } })`
   resumes the same session with the scheduled-check prompt. The account it ran on is preferred; otherwise the normal
   pick runs, with `jobsPerWorker` and BUSY waiting as usual. A Claude session is carried to the account that runs the
   check (see [Sessions across accounts](handoff-and-priority.md#sessions-across-accounts)). Codex sessions cannot
   move, so a Codex wake is limited to its own account.
6. If every worker is busy or limited at a wake, the job parks again for 5 minutes (or until the limit resets).
   This does not count as a wake.
7. After 48 wakes (`RELAY_MAX_WAKES`), one more park ends the job as `failed`, with code `too_many_wakes`.

### A fresh process for every wake

A runner is a long-lived Node process: a parked job's runner may sleep for hours, and a promotion
(`scripts/promote-dev.sh`) may change `src/` in the meantime. So every wake runs in a new process that loads the code
on disk at that time:

- **At the wake time** the sleeping runner calls `jobs.handOver`. Under the job record's lock, and only while the record
  is still `parked` and names this runner's pid, it starts a new detached `job-runner.js <id>` (the usual
  `spawnRunner`) and writes the new pid into the record before the lock is released. Then the old runner exits. The new
  runner claims the record (its own pid is already there), finds the wake time passed and wakes the job.
- **When the code changes while it sleeps.** The runner takes a hash of every file under `src/` when it starts
  (`jobs.codeHash`, stored as `runnerCode` in the record) and compares it at every sleep step (30 s). A change counts
  once the new hash is the same again a moment later (`RELAY_CODE_SETTLE_MS`, 1 s), so a promotion that is still
  writing files is not picked up half-way. Then it hands over the same way. The new runner just sleeps on until the
  wake time, and hands over once more then.
- **Who wakes.** A runner wakes a job itself only if it did not sleep for it (a runner started for a job whose wake time
  has passed: after a handover, a revive or a restart) and its code hash still matches the code on disk. The switch
  from `parked` to `queued` happens under the record's lock and only if the record still names this runner, so two
  runners never wake the same job. The record keeps `wokeOnCode` (the hash the wake ran on) and `handovers` (how many
  times a sleeping runner handed over).
- **No gap, no double.** At every moment the record names exactly one runner pid. A reviver (`reviveOne`, below) checks
  that pid under the same lock: during a handover it sees either the old runner or the new one, both alive, and starts
  nothing. If the new runner dies right away, the record names a dead pid, and the next reviver starts another runner.
- **Fallback.** If a new process cannot be started, the sleeping runner keeps the job and wakes it itself, on the code
  it loaded, as before.

Running (not parked) jobs still finish their current segment on the code they started with. When such a job parks, the
same process sleeps, and its next wake runs in a fresh process.

**Durability.** `jobs.reviveParked()` runs on every tool call (`tool-call.js`), at tray-app start, every minute in
the app, and 30 s after the Mac wakes from sleep (Electron's `powerMonitor` `resume`; `server.js`). Under the record's
lock it starts a new runner for a parked job when:
- its runner is gone. The pid must be alive, and on macOS/Linux its command line must be `job-runner.js <id>`, which
  catches a pid reused after a reboot.
- its runner is alive but stuck: the wake is more than 3 minutes overdue (`RELAY_OVERDUE_GRACE_MS`), and in those
  3 minutes the runner was not started, handed over or revived and the computer did not wake. The tray app notices a
  wake from `powerMonitor`, or from a minute tick that came more than 45 s late. Without that guard, a runner whose
  own timer is about to fire would be taken for a stuck one. The stuck runner is killed with SIGKILL. SIGTERM would
  cancel the job.

Each revive is recorded as `revives`, `revivedAt` and `lastRevive: { at, by, why, overdueMs }` (`by`: `tool call`,
`tray`, `tray (system wake)`), and logged in the job's log as `revived by …: …`. A new runner leaves at once if
another live runner owns the record. Parked jobs are never pruned.

### Wake timing, overdue wakes, keeping the Mac awake

- **Every wake is recorded.** It goes into `wakeLog` (and `lastWake`) in the job record, as `{ wake, wakeAt (when it
  was due), wokeAt, lateMs, runner, revived?, retryAt?, workerAt, waitMs, outcome }`. Every ledger entry of that
  segment carries the same timing as `wake: { n, wakeAt, wokeAt, lateMs, workerAt, waitMs }`. `workerAt` is when a
  worker account took the check: a check that waited for a free worker shows it in `waitMs`. A "no free worker"
  retry keeps the original due time (`wakeDueAt`), so its lateness counts from the time the park asked for.
  `relay_poll` shows `Last scheduled check (n): due …, woken … (on time | Xm late)`. The runner log line reads
  `waking: n … due <ISO>, late N s`.
- **Clock jumps.** The sleeping runner times each 30 s step. A step that took more than 60 s longer than asked
  (`RELAY_CLOCK_JUMP_MS`) means the computer slept (no timer runs then) or the clock moved. It is logged
  (`the computer slept or the clock jumped: N s passed with no timer running`) and kept in `sleepGaps`. The wake time
  is always compared against the wall clock, so after a sleep the job wakes on the runner's next step.
- **Overdue.** A parked job more than 3 minutes past its wake time is listed in the Needs action line as
  `wake overdue by N min`. That line heads `relay_poll`, `relay_wait` and `relay_status`, and no `relay_ack` is
  needed: the item leaves once the job wakes. `relay_status` and `relay_poll` also show `WAKE OVERDUE by …` on the
  job itself.
- **Keeping the Mac awake** (`settings.json`: `preventSleepForWakes`, default `false`; `preventSleepMinutes`, default
  10). With the setting on, a parked job's runner holds `caffeinate -i -s -w <runner pid> -t <until wake + 5 min>` from
  `preventSleepMinutes` before the wake. During the check itself it holds `caffeinate -i -s -w <pid>` until the check
  ends. It is recorded as `keepAwake` in the record and log, and `relay_poll` shows "Keeping the Mac awake…". The panel
  has a switch for it under Settings › Scheduled wakes (macOS), and shows a **WAKE OVERDUE** badge on an overdue parked
  job in its worker's card. `-i`
  stops idle sleep, `-s` stops system sleep on AC power, and `-w` ends it with the runner. **Closing the lid on battery
  still sleeps the Mac.** No process can prevent that, so such a wake runs at the next (dark) wake of the Mac.

**What the logs showed.** In the first days of use almost every logged wake ran within 0.2 s of its due time and
none needed a revive; there were no "no worker at wake" retries and no runner crashes. The one late wake was due while
the lid was closed (clamshell sleep) and ran a few minutes later, at the Mac's first DarkWake (`pmset -g log`).

**Tools.**
- `relay_wait` returns a park once as an event (`parkedAt > parkSeenAt`), unless it is called with `include_parked: false`.
- `relay_poll` shows `PARKED`, the wake time, the number of checks and the latest report. Reporting a park marks it as seen.
- `relay_cancel` cancels a parked job. Without a live runner, it does so directly in the record.
- A `relay_run` whose worker parks returns at once, with the report and "PARKED until …, job id …". The job is then
  adopted as a background job (`jobs.adoptParked`).

## Pick order (`engine.pickOrder`)

These rules apply to accounts that are ready and have a free slot under their own cap
([handoff-and-priority.md](handoff-and-priority.md#which-worker-gets-a-job)). An explicit `account`, or the account
of a resumed session, still wins.

1. The account with the fewest Relay runs right now (a parked job holds no run: it counts 0).
2. At the same load, the lower **tier** (Accounts panel: 1, 2 or 3 per worker; 1 = most preferred, the default). With
   a and b at tier 1 and c at tier 2, jobs go a, b, c, a, b, c.
3. Within that, an account whose 5-hour window is at least 95% used goes last.
4. Next comes the weekly window (`usage.json` → `week.resetsAt`) that resets soonest. A reset time already in the past
   is moved forward in steps of 7 days. Unknown reset times go after known ones.
5. Then the least recently used account, then registry order.

`relay_status` shows the place in line and the reason, for example "next in line (fewest jobs; tier 1 before tier 2;
week resets Thu 09:00)", and each worker's tier at the end of its line. It also shows the running and parked jobs per
worker.

## Manual progress checks ("Check progress", `relay_wake`)

Every worker card in the panel has a **Check progress** button (`检查进度`); the leader window has the tool
`relay_wake` (`job_ids`, or `account` for every job parked on that worker; refused in worker sessions). Both call
`jobs.wakeNow`: under the record's lock, a parked job's `wakeAt` becomes now, its sleeping runner is replaced by a fresh
one (SIGKILL, as for a stuck runner: SIGTERM would cancel the job), and the request is kept as `manualWake` and as an
entry in `manualChecks` (`requested`). The fresh runner then wakes the job through the normal wake path (session
carried to the account that resumes it, the same wake prompt, asking first for one `Progress:` line). The wake's
`wakeLog` entry says `manual: true, kind: "manual check"`, who asked and the time it was scheduled for. When the check
ends, its `manualChecks` entry becomes `done` with the outcome (finished, parked again, failed) and a short report (the
worker's `Progress:` line, else the first plain paragraph); the tray app shows it as a notification, the worker card
lists it (a click opens the full report), and `relay_poll` shows it above the report. A worker with no parked jobs
gets "has no parked jobs".

## Waiting for a worker or a folder

Background jobs (`relay_start`, parked jobs' wakes, jobs started from the panel's dispatch dialog) never give up with
BUSY: they wait for a free worker or their folder as long as it takes and show their place in line (`#2 in line for a
worker`, `#1 in line for its folder`). `settings.json` `backgroundMaxWaitMin` (panel: Settings › Jobs; default 0 = no
limit) bounds that wait. Only `relay_run`, which blocks its window, keeps the 30-minute limit.

## Several jobs per worker

`jobsPerWorker` defaults to 3 for new installs. A settings file saved before the setting existed keeps 1
(`withLegacy`), and saved values are never changed.

Each job is its own session under the same `CLAUDE_CONFIG_DIR`. Run files are per run id.
- Shared files are now copied into worker config folders atomically.
- A usage refresh after a job is skipped when the account was read less than 60 s ago.

The panel's account cards show "Working · N jobs" with the job titles, and the parked jobs as
"Parked · wakes 15:30".

## Priority and context at a wake

- A wake keeps the job's `priority` (it is part of the job's request): when every worker is busy at the scheduled
  check, the woken job queues for a worker by that priority, before older jobs of lower priority.
- A parked job's record keeps how full its session's context was at the end of each segment. If it is at or above
  `handoffAt` (70% by default) when the job wakes, Relay first asks that session for a handoff note and runs the
  scheduled check in a new session that gets the note, the check prompt and the job's original task. See
  [handoff-and-priority.md](handoff-and-priority.md).

