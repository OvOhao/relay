# Project config: `.relay/project.json`

A project can give Relay rules that apply to **every** worker job in it, so the dispatcher does not have to repeat them
in each task. Relay reads them from `.relay/project.json` in the job's `cwd`, or in a parent folder up to the git root
(the first one found, nearest first, wins). Outside a git repository only `cwd` itself is searched.

All fields are optional. **Paths in the file are relative to the folder that holds `.relay/`** (the project root), and
use `/`. Patterns may use globs: `*` and `?` within one path segment, `**` across segments; a pattern that names a
folder also covers everything inside it (`ideas/alpha/runs` = `ideas/alpha/runs/**`).

A file Relay cannot read (bad JSON, a field of the wrong type, a path that leaves the project) refuses every job in that
project with a message naming the file, until it is fixed: a broken rule is never silently ignored.

## Fields

### `rules_file`

A Markdown file whose content Relay appends to every worker's system prompt in this project (Claude:
`--append-system-prompt`; Codex: `developer_instructions`), after any task preset. Use it for the rules every worker
must follow. At most the first 20 KB are given; a longer file is cut, the worker is told where to read the rest, and the
job's report says so. A missing file does not stop the job; its report says the rules could not be read.

### `protected_paths`

Globs no job may change: frozen plans, raw evidence, records of runs. Each entry is a pattern, or
`{ "glob": "<pattern>", "append_only": true }` for a folder where **new** files may appear but existing ones may never
be changed or removed (e.g. a folder of run records that experiments add to).

- Every job that may write (not `read_only`) is told the list, and Claude workers get `Edit(...)` / `Write(...)` deny
  rules for the plain (not append-only) patterns, so such edits are refused, not just detected.
- After every job that may write, Relay compares the files before and after the run (git's files, plus every file a
  protected pattern covers, also ones git ignores). Any change to a protected path makes the job **FAILED** with
  `PROTECTED PATH CHANGED` and the list of files. Nothing is reverted.
- `write_paths` and `output_file` that fall on a protected path are refused before the job starts.
- Only changes made *during* a worker run are seen. A process the worker launched that keeps writing while the job is
  parked is not; for folders such a process writes to, use `append_only` or leave them out.
- In a folder other jobs write in at the same time, only the job's own changes count against it; see
  [Which changes are a job's own](#which-changes-are-a-jobs-own).

### `post_checks`

Commands Relay runs in `cwd` after a job that may change files **finishes** (not after a park; then after the final
segment), one after the other. A job that does not finish normally is checked too:

- **failed or cancelled** (also `busy` / `workers_limited` after it started): Relay judges its changes as for a
  finished job (`PROTECTED PATH CHANGED`, `WRITE_PATHS_VIOLATED`) and runs the post checks on what it changed (its
  attributed changes, see the table below), but only when it changed files; the report adds `Post checks on the N
  files this unfinished job changed:` and the flags go into the job record and the ledger.
- **`too_many_wakes`** (it parked again at the last scheduled check Relay allows): the checks run at that last check,
  on all its segments' files, and the job is flagged `too_many_wakes` too.

The checks themselves:

```json
{ "name": "freeze check", "cmd": "bin/researchctl freeze check", "when": "always", "timeout_sec": 300 }
```

- `cmd`: a shell command (`sh -c` on macOS / Linux). Placeholders:
  - `{changed_files}`: the files the job added or changed (relative to `cwd`, each shell-quoted, space-separated;
    including the report file Relay wrote for `output_file`). For a job with a scope these are only its own changes
    ([below](#which-changes-are-a-jobs-own)): what other jobs changed in the folder meanwhile is never checked as
    this job's.
  - `{each:<glob>}`: run the command once per changed file matching the glob (the marker itself is removed from the
    command), with `{file}` (that file, quoted) and `{idea}` (the `<id>` of an `ideas/<id>/` folder in its path,
    quoted). A file outside `ideas/<id>/` is skipped when the command uses `{idea}`. At most 50 runs per check: with
    more matching files the rest are reported `NOT CHECKED (too many files)` and the job is flagged
    **CHECKS_INCOMPLETE** (not ok; not CHECKS_FAILED). Run the missing checks yourself.
- `when`: `"always"` (default) or `"changed:<glob>"`: run only when the job changed a file matching the glob.
- `timeout_sec`: default 300. A check that runs longer is stopped and counts as failed.

**Which jobs, on which files.**

| Job | Post checks run on |
|---|---|
| read-only (`read_only: true`, Claude or Codex), no `output_file` | nothing: **no post checks at all** (it changes no files). The report says `Post checks: not run (a read-only job changes no files; …)`. A Codex review's read-only guard still runs. |
| read-only with `output_file` | only that report file, once Relay has saved it |
| with a scope (`scope`, `write_paths` or `output_file`) | its own changes ([below](#which-changes-are-a-jobs-own)) |
| without a scope, while other jobs that may write ran in the folder at the same time | only the files its own edit tool calls named (`Edit` / `Write` / …); the report says how many other changed files were not checked (not attributed to it) |
| without a scope, alone in the folder | every change in the folder, as before |

**Time cap.** All of one job's checks together may take at most `postChecksMaxSec` seconds (in Relay's
`~/.relay/settings.json`; default 900). A check still running when the cap is reached is stopped and reported as
`stopped (time cap, after N s)`; the checks after it are reported as `not run (time cap)`. Neither counts as failed:
the job is flagged **CHECKS_INCOMPLETE** (not CHECKS_FAILED), and the report says how many were stopped and not run.

Each result (exit code and the last 20 lines of output) is appended to the job's report under **Relay checks** and kept
in the job record (`checks`). Any non-zero exit or timeout (the check's own `timeout_sec`) flags the job
**CHECKS_FAILED**: its state stays `done`, and the flag shows in `relay_poll`, `relay_wait`, `relay_status` and the
ledger. So does CHECKS_INCOMPLETE.

**Needs action.** Every flag that needs the leader's action is also gathered in one line at the very top of
`relay_poll`, `relay_wait` and `relay_status` (status: jobs that are open or finished in the last 24 h):

```
Needs action: k3x9-4f7a "G2 skeptic gamma": CHECKS_INCOMPLETE, 2 in protected paths; k3xa-11aa "audit": guard_violation.
```

It lists `CHECKS_FAILED`, `CHECKS_INCOMPLETE`, `ISOLATION BREACH`, `PROTECTED PATH CHANGED`, `WRITE_PATHS_VIOLATED`,
`OUTPUT_NOT_SAVED`, `READ_ONLY_VIOLATED`, `guard_violation` (Codex read-only guard), `too_many_wakes`, and `K in protected paths` when other
jobs changed K > 0 protected files while this one ran (the job record's `concurrentProtected`). No line when there is
nothing to act on.

**Resolving a flag: `relay_ack`.** Once the leader has looked into a flag and resolved it (fixed it, or proved it a
false positive), it records that:

```
relay_ack { job_ids: ["k3x9-4f7a"], resolution: "false positive: concurrent changes by other jobs, see job k3x9p2q1-4f7a" }
```

`flags` (optional, e.g. `["CHECKS_INCOMPLETE"]`; `"in protected paths"` for the *K in protected paths* item) limits it
to some flags; by default it covers every flag of those jobs that is still open. The acknowledgement is append-only: an
entry `{ at, by, flags, resolution }` in the job record's `acks` (`by` is the calling window's account,
`CLAUDE_CODE_USER_EMAIL`) and a `kind: "ack"` entry in the project ledger. Resolved flags leave the Needs action line
and the panel's warning badge (the alert icon on a run in *Recent*), but stay visible: the job header in `relay_poll` /
`relay_wait` shows `CHECKS_FAILED (resolved)` with a line `CHECKS_FAILED: resolved: <reason> (relay_ack by …, <time>)`,
and *Flagged jobs* in `relay_status` shows `(resolved: <reason>)` and `[resolved]`. An ack covers only what was raised
before it: the job record keeps when a segment last raised each item (`flagAt`), so the same flag raised again by a
later segment or wake of the job needs action again. Relay worker sessions (`RELAY_TAKEOVER` set) are refused.

The checks run after the worker has exited, and they hold no worker slot: the account the job ran on counts no job for
them and can take the next one at once. Meanwhile `relay_poll` shows the job as `running checks` (the panel shows it
with the account it ran on).

### Which changes are a job's own

Relay sees what a job changed by comparing a snapshot of the whole folder from before the run with one from after it.
When several conversations dispatch jobs into one folder at once (the normal case in a project with several workers),
that difference also holds what the *other* jobs changed meanwhile. So Relay attributes changes:

- **A job's own changes** are the changes inside its own area (its `scope` folders, its `write_paths`, the folder of
  its `output_file`; an `output_file` directly in `cwd` adds only that file), plus changes to any file its own edit tool
  calls named (Claude's `Edit` / `Write` / `MultiEdit` / `NotebookEdit`, also when the path is outside its area; Codex's
  file-change events). A refused edit call changed nothing and does not count.
- **Everything else** that changed during the job is a *concurrent change by others*. It is not listed among the job's
  files ("Files touched", the job record's and the ledger's `files`), not given to its post checks, and never one of
  its violations. The report says once:
  `Note: concurrent changes elsewhere in the folder: N files (not attributed: …; K in protected paths; other jobs ran
  here at the same time: "<thread>", …)`. The job record keeps `concurrentChanges` (the count), `concurrentSample`
  (up to 20 of the paths) and `sharedWith` (the other jobs' threads or titles); the ledger keeps the count apart from
  `files` (shown as `Concurrent changes by other jobs (not attributed to this one): N files`).
- **Enforcement where it can be attributed.** `WRITE_PATHS_VIOLATED`: a change outside `write_paths` that is inside
  the job's scope or in a file its own edit calls named. `PROTECTED PATH CHANGED`: a protected path changed inside the
  job's scope or by its own edit calls. Relay notes which other jobs that may write (not read-only ones without
  `output_file`) run in the same folder, from their live run files, every 2 s while the job runs. **While no other job
  ran in the folder, every change is still judged as before**, so a shell command that writes outside `write_paths`
  is still caught. When other jobs did run at the same time, such a shell-command change outside the job's own area
  cannot be told apart from theirs and is reported only in the note; the job's own `Edit` / `Write` calls outside
  `write_paths` are still refused (Claude) and fail the job.
- **Jobs without a scope** (no `scope`, `write_paths` or `output_file`; read-only jobs, or any job in a project
  without `require_scope`) keep the old behaviour: every change in the folder counts as theirs. When another job that
  may write ran in the same folder at the same time, the report adds:
  `Note: other jobs ran in this folder at the same time ("<thread>", …). This job has no scope, so the changed files
  listed here may include theirs.` Its post checks are limited all the same: none for a read-only job, and for a
  writing job only the files its own edit tool calls named ([post_checks](#post_checks)); the note then adds `Its
  post checks ran only on the N files its own edit tool calls named; M other changed files in the folder were not
  checked (not attributed to it).` Give such jobs a `scope` (or set `require_scope`) to get the attribution above.
- A job's files listed from `git status` follow the same rule (paths are resolved from the repository's top, so a
  `cwd` below it works); an untracked folder git lists as one line counts as the job's when it holds part of its area.
- **The read-only guard of Codex jobs** (the job folder must be unchanged after a Codex review) follows the same idea:
  - Any Codex file-change event is the job's own and fails it (`guard_violation`), whatever else ran.
  - A folder change while **no** other job that may write ran in the folder fails it, as before.
  - A folder change while other such jobs **did** run there does not fail it, but only if Relay verified from the
    session file that every turn ran under the read-only profile (`relay-review`, home denied, nothing writable).
    The change is then theirs. The report says
    `Note: concurrent changes elsewhere in the folder: N (not attributed: the Codex session ran under the read-only
    profile on every turn (verified: …), and other jobs ran here at the same time: "<thread>", …). The read-only guard
    did not fail this job for them…`, and the last line reads `Read-only guard: passed: the folder changed only by
    other jobs running here at the same time (N; this session verified read-only)`. Those changes are not the job's
    files and are not given to its post checks. The record keeps `concurrentChanges`, `concurrentSample` (the guard's
    lines, e.g. `added ideas/a/x.md`) and `sharedWith`.
  - If that check failed or could not be verified (e.g. no session file), a folder change still fails the job, with
    the reason in the report.
- Not covered: another job that started and finished between two 2-second samples is not noticed as sharing the
  folder.

#### How Relay lists the folder's files, and when it cannot compare

Both the before / after snapshot and the Codex guard's fingerprint start from a list of the folder's files:

- **Normally `git ls-files --cached --others --exclude-standard`**: tracked and untracked files, never ones `.gitignore`
  ignores. Timeout 120 s; if it fails or times out it is tried once more with 300 s. (In a large repository,
  about 175 000 listed files, one call took 6-10 s on a loaded machine; the timeouts leave room for a much busier
  machine.) Test and tuning hooks: `RELAY_LS_FILES_TIMEOUT_MS`, `RELAY_LS_FILES_RETRY_MS`.
- **Each failure is logged** with its exit code or timeout, git's stderr and how long it took: to the job log
  (`~/.relay/jobs/<id>.log`, as `[relay <time>] git ls-files failed in <folder>: …`) and in the job record
  (`folderLog`).
- **Only if both attempts fail** does Relay walk the folder itself. The walk leaves out what `.gitignore` ignores
  (each folder level goes through `git check-ignore`, so `.venv` or `.pytest_cache` are never entered) and stops at a
  time budget of 60 s (`RELAY_WALK_BUDGET_MS`). There is no file-count cap; a walk cut by the budget is marked
  *truncated*. If `git check-ignore` itself fails, the walk is marked truncated too.
- **Two lists are compared file by file only when both were made the same way and neither is truncated.** Otherwise
  the after list is made again the way the before list was: git ls-files once more with the 300 s timeout (or the walk,
  if the before list was a complete walk). If that still does not give two comparable lists, the comparison is
  **UNVERIFIABLE**. Relay then lists no changes from it (comparing a git list with a walk, or with a truncated walk,
  is what produced tens of thousands of fake "added" / "removed" files, such as ignored `.venv` files, in a large
  research repository), and says so:
  - Jobs that may write: `Note: the folder comparison is UNVERIFIABLE (before the job: …; after it: …). … Protected-path
    and write_paths checks and the post checks used only the N files this job's own edit tool calls named; changes
    made by shell commands could not be checked.` Those files are still judged: an own `Edit` outside `write_paths`
    or on a protected path still fails the job. The record keeps `folderCompare: { status: "unverifiable", why }`.
  - Read-only Claude jobs: the note says that a shell-command change could not be checked.
  - Codex reviews: the guard passes only on the session check: verified read-only on every turn and no file-change
    events of its own. The guard line then reads `Read-only guard: UNVERIFIABLE folder comparison (…); passed on
    the session check alone (…)`. If the session check failed or could not be verified, the job fails
    (`guard_violation`, "the folder comparison is UNVERIFIABLE (…) and the session's read-only profile could not be
    verified either").

### `health_checks`

A list of commands (strings, or `{ "name", "cmd" }`) the project's jobs depend on, e.g. `bin/researchctl status`,
`python3 -c 1`, `ssh -o BatchMode=yes gpu-box true`, `latexmk -v`. Relay uses them for **worker health checks**:

- For each Claude worker account, one tiny worker job (model haiku, effort low, the permission mode and allowed /
  denied commands of a real job from Settings, every file edit denied, Relay's own records unreadable) runs each
  command exactly as written, in the project root, and answers with a strict ` ```relay-health ` JSON block:
  `{"results": [{"cmd", "status": "allowed" | "refused", "exit"}]}`. A refusal visible in the tool calls themselves
  overrides what the worker claims; without a readable block Relay falls back to the tool calls.
- Relay also reads the account's workspace trust for the project root: `<account config dir>/.claude.json`,
  `projects[<path>].hasTrustDialogAccepted` (the folder or a parent). Nothing else in that file is used; no
  credentials are read.
- When: the tray app checks each account at most every 6 hours per project (projects with `health_checks` that had a
  job in the last 7 days); `relay_health` (`cwd`, optional `account`) and **Check health** in an account's menu check
  at once. Results are kept in `~/.relay/health.json`.
- Shown in `relay_status`: `health: ok`, or e.g. `health: 2 refused (ssh, latexmk), untrusted, checked 14:05`
  (a command is named by its program: `bin/researchctl status` → `researchctl`). `relay_health` lists each command and
  the exact fix: the `Bash(<cmd>)` rule to add to Settings › Allowed commands (or the account's own
  `settings.json`), and for trust the `.claude.json` key to set (or run `claude` once in the folder with that
  account and accept the prompt). **Relay never changes an account's trust or permissions itself.**
- **Worker choice.** When a job's title, task or context names a command (by its program name, as a whole word) that
  a worker refused at its last check, or a worker has not trusted the project folder (read at job start), the job
  goes to another worker. If every worker is affected it still runs, with a `HEALTH WARNING` line in its header and
  report (an `account` given explicitly is kept, also with a warning).

### `isolated_hide_paths`

A list of globs (relative to the project root) added to `hide_paths` of **every isolated job** in the project, e.g.
the leader's decisions and summaries a reviewer must not see:

```json
"isolated_hide_paths": ["ideas/*/decisions.md", "state/**", "portfolio/**"]
```

They are enforced exactly like the job's own `hide_paths` (told to the worker, Read deny rules, the bash sandbox's
`denyRead`, `ISOLATION BREACH` on access) and listed in the job record's `hidePaths`. For a job whose `cwd` is a
sub-folder of the project root, patterns under `cwd` are rewritten relative to it; patterns that lie outside `cwd` are
denied all the same (Read deny rules and the sandbox) but are not in the prompt's list or the breach scan. Jobs that
are not isolated are not affected.

### `require_scope`

`true` or `false` (default `false`). With `true`, every job in the project that may change files must say where it
writes: `scope` (the folders it changes), or `write_paths` or `output_file` (which say it too). A job without any of
them is refused at once, by `relay_run` and by `relay_start`, with:

> This project requires a scope for every job that may change files (require_scope in `<file>`). Pass scope (the
> folders this job changes, relative to cwd, e.g. ["src/auth"]), or write_paths, or output_file; or read_only: true for
> a job that changes nothing. Nothing was started.

A scope that is the whole folder after all is refused too: `"."`, `cwd` itself (also as an absolute path), or the
git root, also next to other entries or together with `write_paths` / `output_file`:

> This project requires a scope (require_scope in `<file>`), and scope "." is the whole folder (cwd, the git root),
> which names nothing. List the specific folders this job changes instead (relative to cwd, e.g. ["ideas/gamma",
> "portfolio/reports"]). Nothing was started.

A job that works across several folders lists each of them. Read-only jobs are never refused, and a parked job's
scheduled wake continues without the check (it passed it when it started). Any other value than `true` / `false` is a
config error.

## Example: a research repository

```
research-repo/
├── .relay/
│   ├── project.json
│   └── rules.md
├── bin/researchctl
├── CLAUDE.md
└── ideas/
    └── alpha/
        ├── plan.frozen.md        # frozen plan: evidence, never edited
        ├── runs/                 # run records: evidence, written only by bin/researchctl
        └── reviews/
```

`.relay/project.json`:

```json
{
  "rules_file": ".relay/rules.md",
  "protected_paths": [
    "ideas/*/plan.frozen.md",
    "ideas/*/frozen/**",
    { "glob": "ideas/*/runs/**", "append_only": true }
  ],
  "post_checks": [
    { "name": "freeze check", "cmd": "bin/researchctl freeze check", "when": "always" },
    { "name": "runs verify", "cmd": "{each:ideas/*/runs/**} bin/researchctl runs verify {idea}", "when": "changed:ideas/*/runs/**" },
    { "name": "audit numbers", "cmd": "{each:ideas/*/reviews/*.md} bin/researchctl audit numbers {file} --idea {idea}", "timeout_sec": 120 }
  ],
  "isolated_hide_paths": ["ideas/*/decisions.md", "state/**", "portfolio/**"],
  "health_checks": [
    { "name": "cli", "cmd": "bin/researchctl --version" },
    "nvidia-smi --query-gpu=name --format=csv"
  ]
}
```

`.relay/rules.md` (short and concrete; the worker sees it on every job):

```markdown
- Read CLAUDE.md first. Frozen plans (`ideas/*/plan.frozen.md`) and run records (`ideas/*/runs/`) are evidence:
  never edit, move or delete them.
- Start experiments only through `bin/researchctl run ...`; quote run ids in your report.
- Every number you report must come from a run record; say which.
```

With this file a review job such as

```
relay_start  task: "Independent venue review of alpha ...", cwd: ".../research-repo", read_only: true, isolated: true,
             hide_paths: ["ideas/alpha/reviews"], output_file: "ideas/alpha/reviews/venue-b.md"
```

gets the rules in its instructions, no ledger and no other reviews; Relay saves its report to
`ideas/alpha/reviews/venue-b.md`, then runs `freeze check` and `audit numbers` on that file with `--idea alpha`,
and flags the job if either fails.

## Related request parameters

These are per job (`relay_run` / `relay_start`), not in the file:

| Parameter | Effect |
|---|---|
| `isolated: true` | No project ledger, no other workers' results in the prompt; only a new thread or the job's own earlier isolated thread. Claude also runs with **auto memory off** (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `autoMemoryEnabled: false` in `--settings`: the account's `MEMORY.md` is not loaded and nothing is written there) and **without the git snapshot** (`includeGitInstructions: false`: no `gitStatus` block with recent commits in its system prompt), and may not read the repository's `.git` (at the git root above `cwd`; for a worktree also the git folders it points to) or any account's auto memory folder (`<config dir>/projects/*/memory`), and no other session's transcripts (`<config dir>/projects/*/*.jsonl` and `<config dir>/projects/*/*/subagents/`, for every account Relay knows plus `~/.claude`): Read deny rules plus the bash sandbox (glob patterns), so `git log` fails inside the job and a transcript gives "Operation not permitted". Other sessions' folders that exist when the job starts are denied too (they hold saved large tool outputs, `<session>/tool-results/`, subagent transcripts and session titles): every project folder other than the job's own is denied whole, and in the job's own project folder (Claude Code's name for `cwd`: each character other than a-z, A-Z, 0-9 becomes `-`, cut at 200 characters plus a hash) each existing session folder is denied one by one (at most 1500, newest first). Paths are resolved, so accounts whose `projects` is a symlink to `~/.claude/projects` add no duplicates (a few hundred KB of arguments for a job in a large project). The job's own new session folder appears after the start, and a session it continues (thread, wake) is left out, so its own saved tool outputs stay readable; every Claude job also gets a `Read` allow rule for `<config dir>/projects/<its project>/*/tool-results/**` (deny rules still win), because outside `cwd` the Read tool would otherwise ask for permission. Checked live (haiku, isolated): another session's `tool-results` file in the same project and one in another project (through the account's symlinked path and the real `~/.claude` path) were refused by both `head` and the Read tool, while the job's own 1.9 MB `seq` output was read back with `tail` and the Read tool. Isolated Codex jobs get the git root's `.git` (and a worktree's git folders) as deny entries in their permission profile (home is denied anyway; this covers a `.git` inside the job folder and repositories outside home). The project's `isolated_hide_paths` are added to its `hide_paths`. |
| `read_only: true` | Claude: permission mode `default` with `Edit`, `Write`, `MultiEdit` and `NotebookEdit` denied (not `plan`, whose harness prompts push Explore agents and ExitPlanMode), and the worker is told the job is read-only, shell commands included. Checked live (Claude Code 2.1.321, haiku): `Write` and an unapproved `touch` are refused; a command Settings allows (e.g. `Bash(python3 *)`) can still write (it did when the task explicitly asked; under plan mode the worker refused by itself, and with the read-only instruction it refuses the same way). So Relay also compares the folder before and after the job: a change while no other job that may write ran in the folder flags the job **READ_ONLY_VIOLATED** (listed, kept in `readOnlyChanges`; nothing reverted). Codex: its read-only profile and guard. |
| `hide_paths: [...]` | Paths (relative to `cwd`) the worker may not read. Claude: `Read(//abs/...)` deny rules for its file tools **and** Claude Code's bash sandbox with those paths in `filesystem.denyRead` (deny rules alone do not stop shell commands: a live probe's `grep -r TOKEN .` printed hidden files). In that sandbox, HTTP(S) works through its proxy, but `ssh` and other direct connections do not, and files can only be written inside `cwd`; it fails closed if the sandbox is unavailable. `isolated` jobs get the same for Relay's ledgers and job reports. Codex: deny entries in its sandbox profile. Tool calls that touch hidden paths anyway flag the job `ISOLATION BREACH` (a path named only to exclude it from a search, e.g. `--exclude-dir=x`, does not count). |
| `output_file`, `overwrite` | Relay writes the final report to this file (inside `cwd`, atomically), also for read-only and Codex jobs. If the file appeared during the job because the job's **own** edit tool calls (`Write` / `Edit` / …) wrote it, Relay keeps the worker's file and saves its report as `<name>.relay-report.md` next to it (`reviews/g2.md` → `reviews/g2.relay-report.md`), says so in the report (`relayReport` in the job record), and the post checks run on both. If anyone else created it (a shell command, another job), the job is flagged `OUTPUT_NOT_SAVED` as before. |
| `write_paths: [...]` | The only paths the worker may change (Claude: permission mode `default` with `Edit`/`Write` allow rules). Checked live: `Write`/`Edit` outside them and shell redirections (`echo x > f`) are refused, but a shell command Settings allows (e.g. `Bash(python3 *)`) can still write anywhere; that is not prevented, only caught: any change elsewhere fails the job (`WRITE_PATHS_VIOLATED`) with the list of files, nothing reverted. While other jobs write in the same folder at the same time, only changes Relay can attribute to this job count ([Which changes are a job's own](#which-changes-are-a-jobs-own)). Not for Codex. |
