# Context handoff and job priority

## Context handoff for long threads

A worker thread resumes the same Claude Code session call after call, and parked jobs add a segment at every wake.
A session that fills its model's context window ends with "Prompt is too long", and the thread is stuck. Relay
therefore watches how full each thread's session is and moves the thread to a new session before that happens.

**What Relay measures.** After every run: the input of the session's last model call (new input + cache writes +
cache reads, from the `usage` of the last top-level assistant message in the stream) against the model's context
window (`modelUsage[<model>].contextWindow` in the run's result for the session's own model, the one its `init`
event names; the largest reported when that model is not listed; otherwise the setting `contextWindow`, default
200 000). Checked live on Claude Code 2.1.32x: a haiku-5-5 run reported per-call usage such as 2 + 3 164 + 26 146 =
29 312 tokens and `contextWindow` 1 000 000, i.e. 3%. It is kept with the session id in the thread record (`threads.json`: `context`)
and, for background jobs, in the job record.

**Proactive handoff.** Before a new call on a thread, or the wake of a parked job, whose session was at
`handoffAt` (default `0.7`) or more of its window:

1. Relay sends the old session one short prompt (`RELAY_HANDOFF`, permission mode `default` with every edit tool denied; Codex: `plan`) asking for a
   handoff note with the sections Goal, Decisions made, State of files and runs, Open issues, Next step.
2. Relay saves the note to `~/.relay/.relay-handoff/<project>/<thread>-<n>.md` (a one-off parked job:
   `job-<id>-<n>.md`), never in the project folder.
3. The thread continues in a **new session**: its first prompt is a full worker prompt with the note
   (*Handoff from this thread's previous session (handoff n)*) followed by the new task (a wake: the scheduled-check
   prompt and the job's original task).

**Reactive handoff.** A call that fails with the context-limit error (`Prompt is too long`, also
`prompt is too long: N tokens > M maximum` and `input is too long for requested model`, the wordings the 2.1.32x CLI
checks for; `Context limit reached`, `exceeds the context window`, …; not provoked live, so the exact result text of a
real overflow is unverified) is handed off the same way and the task is sent again to the new session (once per
call). If the full session cannot write a note, Relay builds one from what it kept: the task, the thread's last
recorded result, its ledger entries, the job's latest report, the files and commands of the failed run and its last
messages.

**What is kept and shown.** The thread record (and the job record) keeps `handoffs` (how many) and `sessions`: the
chain of earlier session ids with the account, time, reason (`proactive` / `reactive`), the context size, the note
file and who wrote it (`worker` / `relay`). The report header says `handed off (n)` with a line per handoff;
`relay_poll` shows `handed off (n)` and `context NN%`; `relay_status` shows both per thread.

**Settings** (`~/.relay/settings.json`): `handoffAt` (a share of the window, 0 < x ≤ 1, default 0.7) and
`contextWindow` (tokens assumed when the stream does not report the window, default 200000).

Codex jobs get the reactive handoff (on Codex's context-window error); their stream reports no per-call context size,
so there is no proactive one.

## Sessions across accounts

Claude Code keeps a session under the sign-in folder it runs with (`CLAUDE_CONFIG_DIR`):
`<configDir>/projects/<project folder>/<session>.jsonl` holds the transcript, and `<session>/` holds `subagents/`,
`tool-results/` and so on. `claude --resume <id>` only looks in the resuming account's own `projects` folder, under
the folder named for the cwd. If the transcript is not there it fails with
`No conversation found with session ID: <id>`.

Most accounts' `projects` folder is a symlink to `~/.claude/projects` (`setup.prepareConfigDir`), so they share their
sessions. An account whose `projects` is a real folder of its own does not; typically that is an account which
signed in before Relay linked it. The pick moves threads between accounts more often since fill-first and the
per-worker caps, and that produced failed jobs with "No conversation found":

- most often, a session written through the shared folder was resumed on the account with its own folder;
- more rarely, a session of that account was resumed on a shared account.

Typical cases: a job's session hit the 5-hour limit and failed over mid-run to the account with its own folder, or a
job continued a thread from an account that had become limited.

**Now** (`core/sessions.js`, called by the engine before every run that resumes a session, including a failover
and a wake):

1. **Find the newest copy.** Relay looks in the projects folder of every Claude account it knows and in
   `~/.claude`, checking the cwd's folder first and then every project folder. The copy with the most content wins
   (transcripts are append-only), then the newest.
2. **Copy it to the target account.** The transcript is copied atomically (a temporary file, then rename), along with
   the files of the session folder. It goes under Claude Code's own folder name for the cwd, for both the cwd as given
   and its real path. Claude Code 2.1.32x names the folder like this: every non-alphanumeric becomes `-`, and a name
   longer than 200 characters is cut there and gets `-` plus the base-36 absolute value of its 32-bit string hash of
   the cwd. The copy is verified by size before the run.
3. **Shared folders need no copy.** When the target already has a copy as complete as the best one, nothing is
   copied. The run's text and the ledger say when a session was carried: `[relay] The session moved to <account>…`,
   and `carried` in the record and ledger.
4. **If the copy fails.** When a copy exists but cannot be copied, the run waits for an account that already has it,
   at most `RELAY_SESSION_WAIT_SEC` (20 min). Accounts that are limited for longer are not waited for past that time.
5. **If the session is gone.** The CLI is still tried, because it may know a place Relay does not. If it then says
   "No conversation found", Relay carries the session again and retries once. If there is still no copy anywhere, the
   thread is handed over to a new session (`reason: 'lost'`). Relay builds the note from the thread's reports and
   ledger, and the job carries on instead of failing: `[relay] Session handoff N: the thread's session could not be
   resumed on any account…`.

Isolated jobs' deny rules are Read rules for the worker's own tools. They do not stop Relay copying the session or
Claude Code loading it, and the session the job continues keeps its folder readable.

A `relay_run` / `relay_start` pinned to an account (`account`) now runs there even when its thread last ran
elsewhere. Before, the thread's stored account silently won over the pin.

## Which worker gets a job

The rules: every worker gets one job before any worker gets a second, two before any gets a third;
no worker runs more than **3 jobs at once**; and an account whose weekly quota is nearly used up, with its reset still
days away, takes fewer jobs than one with quota to spare that resets soon.

**Each worker's own cap.** At every pick, from the latest usage reading of the account's weekly row (Claude: the
"Current week (all models)" row; Codex: its 7-day window):

    daily spare = (100 − weekly % used) / max(days until the weekly reset, 0.25)

| Daily spare | Cap (jobs at once) |
|---|---|
| 10 %/day or more | 3 |
| 5 to < 10 %/day | 2 |
| < 5 %/day | 1 |
| week at 95% used or more | 0: it takes a job (one) only when every other ready worker of its provider is at its own cap |
| usage unknown (no reading, or no reset time) | 2 |

A cap is never above `jobsPerWorker` in Settings (1, 2 or 3; a higher value, or the old 0 = "no limit", counts as 3).
A reading taken before the weekly reset it names counts as a new week (0% used). Example: an
account at 86% resetting in 4.5 days has 3.1 %/day → cap 1; one at 81% resetting in 1.7 days has 11.2 %/day → cap 3.

**The order.** Among the workers that are ready (not limited, signed in, of the job's provider, not avoided by the
health check) and under their cap, the pick (`engine._pick`, `pickOrder`) takes:

1. the fewest **running** jobs on the account right now (every live run file of every process; a parked job holds no
   run, so it counts 0; a job whose worker has exited and that only runs the project's `post_checks` counts 0 too);
2. at the same load, the lower tier (each worker's tier, 1 / 2 / 3, set on its card in the panel and stored as `tier`
   in `accounts.json`; 1 = most preferred and the default). With a, b at tier 1 and c at tier 2 the jobs go a, b, c,
   a, b, c: every worker still gets one job before any gets a second;
3. within that, an account whose 5-hour window is at 95% or more goes after the others;
4. the weekly window that resets soonest (unknown reset times after known ones);
5. the least recently used, then registry order.

**The leader.** The leader account (the one this Claude window is signed in to) never takes jobs, unless the switch
"Leader takes jobs too" (`主账号也接任务`) on its card is on (`takesJobs: true` on its record in `accounts.json`). Then it
is picked like any worker, with its own tier and quota cap, and can be named as `account`. `relay_status` says which.

Before this order the weekly reset came first, so every job went to the account whose week reset soonest (up to its
3 slots) while the others idled.

**Exceptions.** The account a resumed thread (or a parked job's wake) runs on is used while it is ready and under its
own cap; otherwise the job goes to the next worker in the order above. An explicit `account` is used while it is ready
and runs fewer than `jobsPerWorker` jobs, whatever its quota cap (the caller chose it); when it is full the job waits
for a slot there (its ticket names that account). An explicit account that is limited or signed out is passed over.
Codex workers follow the same rules among the Codex accounts.

`relay_status` shows, per ready worker, its cap and place, e.g. `1 running, 0 parked · daily spare 11.2%/day → cap 3
(resets Thu 08:59 AM) · next in line (fewest jobs; week resets Thu 08:59 AM)`, `usage unknown → cap 2`,
`week 96% used → cap 0 (takes one only when every other worker is full)`, or `full: 1 of 1 jobs`. The panel's account
card shows `Working · 2/3 jobs` (`正在工作 · 2/3 个任务`), with the daily spare in its tooltip.

## Job priority

`priority: "high" | "normal" | "low"` on `relay_run` / `relay_start` (default `normal`), kept in the job record and
the run file, shown in `relay_poll`, `relay_status` and on the panel's job card.

Priority only matters when jobs wait for a free worker (Settings › Jobs per worker, every ready worker full). Then:

- A job that finds no free slot leaves a **ticket** in `~/.relay/pickq/` (its priority, provider and since when it
  waits) and refreshes it at every try (every 2 s by default).
- Every pick runs under the existing cross-process pick lock and first goes through the live tickets of the same
  provider that rank before it: higher priority first, then the one waiting longest. Each of them is given, in turn,
  the slot the normal worker order (above, with each worker's cap) would give it among the accounts it accepts (a
  pinned job: its account), counting the load it adds; the
  pick may only use the slots left after that, and orders them with that load. So a lower-priority or later job never
  takes a slot that a higher-priority or earlier waiting job is entitled to, whichever process happens to try first;
  the entitled job takes it at its next try.
- A ticket is removed when its job gets a worker, stops or fails; one whose process died or that was not refreshed for
  30 s is ignored and removed.
- While waiting, the job's progress line says its place: `Waiting for a free worker … #2 in line (priority normal).`
- A parked job keeps its priority when it wakes (it is in the job's request).

The ticket counts only free slots of the job's own provider; a job pinned to one account (or a Codex wake bound to its
account) is counted like any other job of its provider.
