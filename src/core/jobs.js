'use strict';
// Background jobs (relay_start / relay_poll / relay_wait / relay_cancel): the same worker run as relay_run, but in a
// detached process of its own (src/job-runner.js), so the leader gets a job id at once and keeps talking to the user.
// Each job is one record, ~/.relay/jobs/<id>.json, written atomically: the request (no secrets: only what the leader
// passed), its state, timestamps and, once it finishes, the report exactly as relay_run would have returned it.
// The runner reuses runWorker as it is: folder and scope locks, BUSY waiting, failover, the Codex checks, the ledger and
// thread records all behave exactly as in relay_run. While it runs, its live status is the run file runWorker writes
// for the panel (found by the runner's pid). A cancel is a file "<id>.cancel" the runner watches for (works on every
// system, unlike a signal on Windows). Finished jobs are kept for 7 days.
// Parked jobs (the worker ended with RELAY_PARK, see core/park.js): state "parked" with wakeAt; nothing runs and no
// account is held. The runner sleeps until wakeAt, then hands the job to a fresh runner process (handOver), which
// resumes the same session on the code on disk now; it also hands over as soon as the code on disk changes while it
// sleeps. If the runner is gone (a restart, a crash), the tray app and every relay tool call start a new one
// (reviveParked): one runner per job, checked by pid and command line under the record's lock.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const store = require('./store');
const fslock = require('./fslock');
const memory = require('./memory');
const park = require('./park');

const RUNNER = path.join(__dirname, '..', 'job-runner.js');
const KEEP_MS = 7 * 86400e3;
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const WAIT_DEFAULT_SEC = 300;
const WAIT_MAX_SEC = 600;
const LIST_LIMIT = 10;

const dir = () => path.join(store.home(), 'jobs');
const validId = (id) => /^[a-z0-9-]{4,40}$/.test(String(id || ''));
const jobFile = (id) => path.join(dir(), `${id}.json`);
const cancelFile = (id) => path.join(dir(), `${id}.cancel`);
const logFile = (id) => path.join(dir(), `${id}.log`);

// The worker request from a tool call's arguments: one place, so relay_run and relay_start read them the same way.
function workerRequest(args = {}) {
  return {
    task: args.task, cwd: args.cwd, context: args.context, thread: args.thread ? String(args.thread).trim() : '', readOnly: !!args.read_only, model: args.model ? String(args.model).trim() : '',
    effort: args.effort ? String(args.effort).trim() : '',
    title: args.title ? String(args.title) : '', account: args.account ? String(args.account).trim() : '', scope: args.scope ?? null,
    preset: args.preset ? String(args.preset).trim() : '',
    agent: args.agent ? String(args.agent).trim() : '',
    // path rules (checked by runWorker): an isolated review, paths it may not read, the only paths it may write, and
    // a file Relay saves its report to
    isolated: !!args.isolated, hidePaths: args.hide_paths ?? null, writePaths: args.write_paths ?? null,
    outputFile: args.output_file == null ? '' : args.output_file, overwrite: !!args.overwrite,
    // who gets a freed worker slot first when jobs wait for one: high, normal (default), low
    priority: args.priority == null ? '' : String(args.priority).trim(),
  };
}

// What one worker segment adds to its job record (core/workers.js returns it as out.meta). Flags and breaches add up
// over a parked job's segments: a breach in an early segment stays reported. `flagAt` keeps, per needs-action item,
// when a segment last raised it: an acknowledgement (relay_ack) covers an item only if it is newer than that, so the
// same flag raised again by a later segment or wake needs action again.
function withMeta(cur, out, now = Date.now()) {
  const m = (out && out.meta) || {};
  const raised = segmentItems(m, out && out.code);
  if (!Object.keys(m).length && !raised.length) return cur;
  return {
    ...cur, ...m,
    flags: [...new Set([...(cur.flags || []), ...(m.flags || [])])],
    ...(cur.breach || m.breach ? { breach: [...(cur.breach || []), ...(m.breach || [])].slice(0, 100) } : {}),
    ...(raised.length || cur.flagAt ? { flagAt: { ...(cur.flagAt || {}), ...Object.fromEntries(raised.map((k) => [k, now])) } } : {}),
  };
}
// The needs-action items one segment raises (see needsAction).
function segmentItems(m, code) {
  const out = [...(m.flags || [])];
  if (['guard_violation', 'too_many_wakes'].includes(code) && !out.includes(code)) out.push(code);
  if (Number(m.concurrentProtected) > 0) out.push(`${m.concurrentProtected} in protected paths`);
  return out;
}
// relay_run's rule for which answers are errors (BUSY or "no worker" are answers the leader acts on, not errors).
const isErrorResult = (out) => !out.ok && !['no_workers', 'workers_limited', 'busy', 'cancelled'].includes(out.code);

function read(id) {
  if (!validId(id)) return null;
  try { return fslock.readJson(jobFile(id), null); } catch { return null; }
}
function write(job) {
  fs.mkdirSync(dir(), { recursive: true });
  fslock.writeJson(jobFile(job.id), job);
}
// Read-modify-write under a file lock: the runner and a cancel (or a poll noticing a dead runner) may both write.
function update(id, change) {
  const f = jobFile(id);
  return fslock.withFileLock(f, () => {
    const cur = read(id);
    if (!cur) return null;
    const next = change(cur);
    if (next) write(next);
    return next || cur;
  });
}
function list() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => read(n.slice(0, -5))).filter(Boolean);
}

function newId() {
  for (;;) {
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    if (!fs.existsSync(jobFile(id))) return id;
  }
}

// Finished jobs older than 7 days go, with their log and cancel files (and records whose runner is long gone).
function prune(now = Date.now()) {
  for (const j of list()) {
    if (j.state === 'parked') continue; // a parked job may sleep for days between checks: it is never pruned
    const old = FINISHED.has(j.state) ? now - (j.finishedAt || j.createdAt || 0) > KEEP_MS : now - (j.createdAt || 0) > KEEP_MS && !fslock.alive(j.pid);
    if (!old) continue;
    for (const f of [jobFile(j.id), logFile(j.id), cancelFile(j.id)]) { try { fs.rmSync(f, { force: true }); } catch { /* next time */ } }
  }
}

// A job whose runner process is gone without writing a result failed; say so once, in the record.
function settleIfOrphaned(job) {
  if (!job || FINISHED.has(job.state)) return job;
  if (job.state === 'parked') { reviveOne(job, process.env, { by: 'job view' }); return read(job.id) || job; } // nothing is lost: start a new runner
  if (!job.pid || fslock.alive(job.pid)) return job;
  if (Date.now() - (job.createdAt || 0) < 3000) return job; // just spawned
  const cancelled = fs.existsSync(cancelFile(job.id));
  return update(job.id, (cur) => (FINISHED.has(cur.state) ? null : {
    ...cur, state: cancelled ? 'cancelled' : 'failed', code: cancelled ? 'cancelled' : 'runner_died', isError: !cancelled, finishedAt: Date.now(),
    report: cancelled ? 'Cancelled.' : `Relay error: the job's background process ended without a result (log: ${logFile(cur.id)}).`,
  })) || job;
}

// The job's state right now, with its live run file (status, account, model, last line) while it runs. The one source
// of a job's state for every view (relay_poll, relay_wait, relay_status): the record's own state stays "queued" until
// the job finishes or parks; only the run file says whether its worker runs, waits or runs the post checks.
// `runs` (memory.listRuns()) may be passed in when viewing many jobs at once.
function view(job, runs = null) {
  job = settleIfOrphaned(job);
  const v = { ...job };
  if (FINISHED.has(job.state) || job.state === 'parked') return v;
  const run = job.pid ? (runs || memory.listRuns()).find((r) => r.pid === job.pid) : null;
  if (!run) { v.state = 'queued'; return v; }
  if (run.account) v.account = run.account;
  if (run.model) v.model = run.model;
  if (run.lastLine) v.lastLine = run.lastLine;
  v.state = run.status !== 'waiting' ? 'running' : /^Waiting for another worker changing/.test(run.lastLine || '') ? 'waiting for folder' : 'waiting for worker';
  // the worker has exited and Relay runs the project's post checks: no worker slot is held meanwhile
  if (run.phase === 'checks') { v.state = 'running checks'; if (run.ranOn) v.account = run.ranOn; }
  if (run.waitingUntil) v.waitingUntil = run.waitingUntil;
  if (run.queuePos && v.state === 'waiting for worker') v.queuePos = run.queuePos;
  if (run.folderPos && v.state === 'waiting for folder') v.queuePos = run.folderPos;
  return v;
}

const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const priorityOf = (j) => (j && (j.priority || (j.request && j.request.priority))) || 'normal';
const accountLabel = (name) => {
  if (!name) return '';
  const a = store.get(name);
  return a ? a.email || a.name : name;
};

// The report as relay_poll / relay_wait show it: the worker's own text in full, Relay's checks section shortened to
// about 8 KB (a project with many checks can add hundreds of KB; the full section stays in the job record).
function reportView(v) {
  if (!v.report) return '(no report)';
  return require('./project').capChecks(v.report, v.checks, { fullPath: jobFile(v.id) });
}

// What in a job needs the leader's action: its flags (CHECKS_FAILED, CHECKS_INCOMPLETE, ISOLATION BREACH, PROTECTED
// PATH CHANGED, WRITE_PATHS_VIOLATED, OUTPUT_NOT_SAVED, too_many_wakes), a Codex guard_violation, and changes by
// others in protected paths during the job ("K in protected paths", K > 0). flagItems: all of them; needsAction: those
// not acknowledged with relay_ack (an ack older than the segment that last raised the item does not count).
function flagItems(v) {
  if (!v) return [];
  const out = [...(v.flags || [])];
  for (const code of ['guard_violation', 'too_many_wakes']) if (v.code === code && !out.includes(code)) out.push(code);
  if (Number(v.concurrentProtected) > 0) out.push(`${v.concurrentProtected} in protected paths`);
  return out;
}
// The acknowledgement that resolves `item` in job `v` (the newest one), or null.
function ackOf(v, item) {
  const since = Number((v && v.flagAt && v.flagAt[item]) || 0);
  const acks = (v && Array.isArray(v.acks) ? v.acks : []).filter((a) => Array.isArray(a.flags) && a.flags.includes(item) && Number(a.at || 0) >= since);
  return acks.length ? acks[acks.length - 1] : null;
}
const needsAction = (v) => flagItems(v).filter((item) => !ackOf(v, item));
// The job's items with their state, for the views: [{ item, ack }] (ack null = still needs action).
const flagStates = (v) => flagItems(v).map((item) => ({ item, ack: ackOf(v, item) }));
// "CHECKS_FAILED, OUTPUT_NOT_SAVED (resolved: false positive ...)": every item, the acknowledged ones marked.
function flagsLabel(v, { reasonChars = 80 } = {}) {
  return flagStates(v).map(({ item, ack }) => (ack ? `${item} (resolved${reasonChars ? `: ${clipText(ack.resolution, reasonChars)}` : ''})` : item)).join(', ');
}
const clipText = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// One line listing them for every job in `views` that has any ('' when none): put at the top of poll/wait/status.
// A parked job whose wake is overdue (see isOverdue) is listed too: "wake overdue by N min" (no relay_ack: it leaves
// the line once it wakes).
function needsActionLine(views, now = Date.now()) {
  const seen = new Set();
  const parts = (views || []).filter(Boolean).filter((v) => !seen.has(v.id) && seen.add(v.id))
    .map((v) => ({ v, what: [...needsAction(v), ...(isOverdue(v, now) ? [`wake overdue by ${Math.round(overdueMs(v, now) / 60000)} min`] : [])] })).filter((x) => x.what.length)
    .map(({ v, what }) => `${v.id}${v.title ? ` "${String(v.title).slice(0, 40)}"` : ''}: ${what.join(', ')}`);
  return parts.length ? `Needs action: ${parts.join('; ')}. (Resolved one? relay_ack records it.)` : '';
}

// One job as text for the leader: a header line, details, and for a finished job its full report (never cut).
function describe(v, { withReport = true } = {}) {
  const r = v.request || {};
  const elapsed = dur((v.finishedAt || Date.now()) - (v.createdAt || Date.now()));
  const bits = [
    v.account ? `account ${accountLabel(v.account)}` : '',
    r.isolated ? 'isolated' : '',
    Array.isArray(v.writePaths) && v.writePaths.length ? `write only ${v.writePaths.join(', ')}` : '',
    v.outputFile ? `report → ${v.outputFile}` : '',
    `agent ${v.provider || r.agent || 'claude'}`,
    v.model || r.model ? `model ${v.model || r.model}` : '',
    r.effort ? `effort ${r.effort}` : '',
    `priority ${priorityOf(v)}${v.queuePos ? ` (#${v.queuePos} in line for ${v.state === 'waiting for folder' ? 'its folder' : 'a worker'})` : ''}`,
    v.via === 'panel' ? 'dispatched from the panel' : '',
    r.thread ? `thread "${r.thread}"` : 'one-off (no thread)',
    v.handoffs ? `handed off (${v.handoffs})` : '',
    v.context && v.context.tokens ? `context ${Math.round((100 * v.context.tokens) / (v.context.window || 200000))}%` : '',
    r.readOnly ? 'read-only' : '',
    `${FINISHED.has(v.state) ? 'took' : 'elapsed'} ${elapsed}`,
  ].filter(Boolean).join(' · ');
  const states = flagStates(v);
  const flags = (v.flags || []).length ? ` · ${v.flags.map((f) => (ackOf(v, f) ? `${f} (resolved)` : f)).join(' · ')}` : '';
  const lines = [`## Job ${v.id} · ${v.state.toUpperCase()}${flags}${v.title ? ` · "${v.title}"` : ''}`, bits];
  for (const { item, ack } of states) if (ack) lines.push(`${item}: resolved: ${clipText(ack.resolution, 500)} (relay_ack by ${ack.by || '?'}, ${park.localTime(ack.at)})`);
  if (v.healthWarning) lines.push(v.healthWarning);
  // The worker's structured summary, compact, before anything else (the full report follows unchanged).
  if ((FINISHED.has(v.state) || v.state === 'parked') && (v.relaySummary || v.summaryNote)) lines.push(require('./project').summaryLine(v.relaySummary, v.summaryNote));
  const mc = lastManual(v);
  if (mc) lines.push(manualLine(mc));
  if (v.lastWake && v.lastWake.wokeAt && v.lastWake.manual) lines.push(`Last check (${v.lastWake.wake}): a manual progress check${v.lastWake.by ? ` asked for by ${v.lastWake.by}` : ''}, woken ${park.localTime(v.lastWake.wokeAt)}${v.lastWake.scheduledAt ? ` (its scheduled wake was ${park.localTime(v.lastWake.scheduledAt)})` : ''}.`);
  else if (v.lastWake && v.lastWake.wokeAt) lines.push(`Last scheduled check (${v.lastWake.wake}): due ${park.localTime(v.lastWake.wakeAt)}, woken ${park.localTime(v.lastWake.wokeAt)} (${v.lastWake.lateMs > 60000 ? `${dur(v.lastWake.lateMs)} late` : 'on time'})${v.lastWake.revived ? ', by a revived runner' : ''}.`);
  if (v.state === 'parked' && isOverdue(v)) lines.push(`WAKE OVERDUE by ${dur(overdueMs(v))}: Relay starts a new runner for it at the next tray check or Relay call${v.lastRevive ? ` (last revive ${park.localTime(v.lastRevive.at)}${v.lastRevive.by ? ` by ${v.lastRevive.by}` : ''}: ${v.lastRevive.why})` : ''}.`);
  if (v.keepAwake && v.keepAwake.pid) lines.push(`Keeping the Mac awake for this job's wake (caffeinate pid ${v.keepAwake.pid}, ${v.keepAwake.phase || ''}; Settings › preventSleepForWakes).`);
  if (v.state === 'parked') {
    lines.push(`${v.wakeAt < Date.now() ? 'Parked, wake was due' : 'Parked until'} ${park.localTime(v.wakeAt)} (${v.wakeAt < Date.now() ? `${dur(Date.now() - v.wakeAt)} ago` : `in ${dur(v.wakeAt - Date.now())}`}); scheduled checks so far: ${v.wakes || 0} of at most ${park.maxWakes()}. On wake it checks: ${v.parkCheck || '?'}`);
    lines.push('No worker is held while it is parked. relay_wait returns again when it finishes or parks again; relay_cancel stops it.');
    if (withReport) lines.push('', 'Latest report:', reportView(v));
    return lines.join('\n');
  }
  if (!FINISHED.has(v.state) && v.wakes) lines.push(`Scheduled check ${v.wakes} in progress (the job parked before; its earlier reports are kept in the job record).`);
  if (!FINISHED.has(v.state) && v.lastLine) lines.push(`Last progress: ${v.lastLine}`);
  if (FINISHED.has(v.state) && v.wakes) lines.push(`Finished after ${v.wakes} scheduled check${v.wakes > 1 ? 's' : ''}.`);
  if (FINISHED.has(v.state) && withReport) lines.push('', reportView(v));
  return lines.join('\n');
}

// The detached runner for one job: its own log file, no stdin from the caller, so it outlives whoever started it.
function spawnRunner(id, env = process.env) {
  fs.mkdirSync(dir(), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(logFile(id), 'a');
    // From the tray app (Electron) the same binary runs the runner as plain Node.
    const runEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
    const child = spawn(process.execPath, [RUNNER, id], { detached: true, stdio: ['ignore', fd, fd], env: runEnv, windowsHide: true, cwd: dir() });
    child.unref();
    return child;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* the child has its own copy */ } }
  }
}

// Is this job's runner still there? The pid alone could have been reused after a restart: on macOS / Linux its
// command line must also be this job's runner.
function runnerAlive(job) {
  if (!job || !job.pid || !fslock.alive(job.pid)) return false;
  if (process.platform === 'win32') return true;
  try {
    const cmd = execFileSync('ps', ['-p', String(job.pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return cmd.includes('job-runner') && cmd.includes(job.id);
  } catch (e) {
    return e.status !== 1; // ps exits 1 when there is no such process; any other trouble: assume it is alive
  }
}

// How long past its wake time a parked job may still be parked before Relay calls it overdue: its runner checks the
// wall clock every 30 s, and after the computer wakes from sleep a pending timer fires at once.
const overdueGraceMs = () => Number(process.env.RELAY_OVERDUE_GRACE_MS || 3 * 60000);
// ms a parked job is past its wake time (0 when it is not parked or not due yet).
const overdueMs = (j, now = Date.now()) => (j && j.state === 'parked' && Number(j.wakeAt) ? Math.max(0, now - Number(j.wakeAt)) : 0);
const isOverdue = (j, now = Date.now()) => overdueMs(j, now) > overdueGraceMs();
// One line in the job's log file (the runner's own lines look the same), for what others did to the job.
function logLine(id, msg) {
  try { fs.appendFileSync(logFile(id), `[relay-job ${id}] ${new Date().toISOString()} ${msg}\n`); } catch { /* only a note */ }
}

// A parked job gets a new runner (under the record's lock: two callers never start two runners) when
//   - it has none, or its runner is gone (a restart, a crash); or
//   - its runner is alive but the wake is overdue (more than overdueGraceMs past wakeAt) and nothing just happened that
//     explains it: that runner was not started, handed over or revived within the grace time, and the computer did not
//     just wake (resumedAt, from the tray app's clock-jump check: the runner's own timer fires within a moment then).
//     Such a runner is stuck: it is killed with SIGKILL (SIGTERM would cancel the job) and replaced.
// by: who revives ('tray', 'tray (system wake)', 'tool call'), kept in the record and the job's log.
function reviveOne(job, env = process.env, { by = '', resumedAt = 0 } = {}) {
  let started = false;
  let why = '';
  try {
    update(job.id, (cur) => {
      if (cur.state !== 'parked') return null;
      const now = Date.now();
      const late = overdueMs(cur, now);
      if (runnerAlive(cur)) {
        const fresh = Math.max(Number(cur.runnerStartedAt) || 0, Number(cur.handedOverAt) || 0, Number(cur.revivedAt) || 0, Number(resumedAt) || 0);
        if (!(late > overdueGraceMs() && now - fresh > overdueGraceMs())) return null;
        try { process.kill(cur.pid, 'SIGKILL'); } catch { /* gone meanwhile */ }
        why = `its runner (pid ${cur.pid}) was alive but had not woken it ${Math.round(late / 60000)} min after the wake time; killed and replaced`;
      } else {
        why = cur.pid ? `its runner (pid ${cur.pid}) was gone` : 'it had no runner';
      }
      const child = spawnRunner(cur.id, env);
      started = true;
      return { ...cur, pid: child.pid, revivedAt: now, revives: (cur.revives || 0) + 1, lastRevive: { at: now, by: by || null, why, overdueMs: late } };
    });
  } catch { /* the next call tries again */ }
  if (started) logLine(job.id, `revived${by ? ` by ${by}` : ''}: ${why}`);
  return started;
}
function reviveParked(env = process.env, opts = {}) {
  let n = 0;
  for (const j of list()) if (j.state === 'parked' && reviveOne(j, env, opts)) n++;
  return n;
}

// A fingerprint of the code on disk: every file under src/ (names and contents). A parked runner takes it when it
// starts and compares it while it sleeps; a promotion changes it.
const SRC_DIR = path.join(__dirname, '..');
function codeHash(root = SRC_DIR) {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      h.update(`${path.relative(root, p)}\0`);
      try { h.update(fs.readFileSync(p)); } catch { h.update('(unreadable)'); }
      h.update('\0');
    }
  };
  walk(root);
  return h.digest('hex').slice(0, 16);
}

// A parked job's runner hands the job to a fresh runner process, which loads the code on disk now (job-runner.js
// sleeps in one process but every wake runs in a new one). Under the record's lock and only while `fromPid` still owns
// the parked job: the new pid is in the record before the lock is released, so a reviver (reviveOne) sees a live
// runner and starts none, and a new runner that dies leaves a dead pid that the next reviver replaces. The old runner
// must leave once this returns a child. Returns { child, job }: child null = not handed over (job = the record now).
// Throws when the new process cannot be started (the record is then unchanged and the caller still owns the job).
function handOver(id, fromPid = process.pid, env = process.env) {
  let child = null;
  const job = update(id, (cur) => {
    if (cur.state !== 'parked' || cur.pid !== fromPid) return null;
    child = spawnRunner(cur.id, env);
    return { ...cur, pid: child.pid, handovers: (cur.handovers || 0) + 1, handedOverAt: Date.now() };
  });
  return { child, job };
}

// The job record after a segment that ended with a valid RELAY_PARK line.
function parkedRecord(cur, out) {
  const now = Date.now();
  return {
    ...withMeta(cur, out), state: 'parked', wakeAt: out.park.wakeAt, wakeDueAt: null, parkCheck: out.park.check, parkMinutes: out.park.minutes, parkedAt: now,
    sessionId: out.sessionId || cur.sessionId || null, account: out.accountName || cur.account || null, model: out.model || cur.model || null,
    provider: out.provider || cur.provider, report: out.text, code: 'parked', lastLine: '',
    files: [...new Set([...(cur.files || []), ...(out.files || [])])],
    history: [...(cur.history || []), { at: now, state: 'parked', wake: cur.wakes || 0, account: out.accountName || null, wakeAt: out.park.wakeAt, report: out.text }],
  };
}

// relay_run whose worker parked: the job carries on as a background job (a detached runner sleeps until wakeAt).
function adoptParked(req, out, { env = process.env } = {}) {
  const id = newId();
  const cwd = path.resolve(req.cwd);
  const base = {
    id, state: 'queued', request: req, cwd, project: path.basename(cwd), title: req.title ? String(req.title).replace(/\s+/g, ' ').trim().slice(0, 60) : require('./workers').deriveTitle(req.task),
    provider: out.provider || 'claude', priority: (out.meta && out.meta.priority) || 'normal', createdAt: Date.now(), pid: null, log: logFile(id), wakes: 0, fromRun: true,
  };
  const job = { ...parkedRecord(base, out), parkSeenAt: Date.now() + 1 }; // the leader reads this park right now
  write(job);
  let note = '';
  try {
    const child = spawnRunner(id, env);
    update(id, (cur) => ({ ...cur, pid: child.pid }));
  } catch (e) {
    note = ` (its runner could not be started now: ${e.message}; the next Relay call starts it)`;
  }
  notifyFinished(job).catch(() => {});
  return {
    id,
    text: `${out.text}\n\nPARKED until ${park.localTime(out.park.wakeAt)}, job id ${id}; collect with relay_poll/relay_wait (job_ids: ["${id}"])${note}. ` +
      'It continues as a background job: at that time the worker resumes this session by itself, and the results also land in the project ledger (relay_ledger) and relay_status.',
  };
}

// ---- manual progress checks (the panel's "Check progress" button on a worker card, and relay_wake) ----
// A parked job is woken NOW, through the normal wake path: its wake time becomes now, and a fresh runner (the code on
// disk now) takes the job (a sleeping runner is replaced: killed with SIGKILL, as reviveOne does for a stuck one;
// SIGTERM would cancel the job). That runner wakes it like a scheduled check (session carried to the account that
// resumes it, wake prompt; a manual check's prompt asks for a short progress line first), marks the wake "manual" in
// wakeLog and keeps the check in the record (manualChecks: requested -> running -> done, with its short report).
// When it ends the tray app shows a system notification with that short report.
const MANUAL_KEEP = 20;
const lastManual = (v) => (v && Array.isArray(v.manualChecks) && v.manualChecks.length ? v.manualChecks[v.manualChecks.length - 1] : null);
function manualLine(mc) {
  const who = mc.by ? ` by ${mc.by}` : '';
  if (mc.state === 'done') return `Manual progress check (wake ${mc.wake || '?'}, asked for${who} ${park.localTime(mc.at)}, ${mc.outcome || 'done'} ${park.localTime(mc.finishedAt || mc.at)}): ${mc.short || '(no report)'}`;
  if (mc.state === 'running') return `Manual progress check (wake ${mc.wake || '?'}, asked for${who} ${park.localTime(mc.at)}): running now.`;
  if (mc.state === 'waiting') return `Manual progress check (asked for${who} ${park.localTime(mc.at)}): ${mc.note || 'waiting for a worker'}.`;
  return `Manual progress check asked for${who} ${park.localTime(mc.at)}: starting.`;
}
// The short report of a check: the worker's "Progress:" line if it wrote one, else the first plain paragraph of its
// report (no headings, no relay-summary block, no park line), at most `n` characters.
function shortReport(text, n = 220) {
  const body = park.stripParkLine(String(text || '').replace(/```[ \t]*relay-summary[\s\S]*?```/g, ''));
  const lines = body.split('\n').map((l) => l.trim());
  const prog = lines.find((l) => /^\**\s*(progress|进度)\s*\**\s*[:：]/i.test(l));
  const pick = prog ? prog.replace(/^\**\s*(progress|进度)\s*\**\s*[:：]\s*\**\s*/i, '')
    : (body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|\[relay\]|```|\|)/.test(p)) || '');
  return clipText(pick.replace(/[*_`#>]/g, ''), n);
}
// Wakes the given parked jobs now. by: who asked ("the panel", the leader's e-mail). Returns [{ id, ok, why }].
function wakeNow(ids, { by = '', env = process.env } = {}) {
  const out = [];
  for (const id of [...new Set((ids || []).map(String))]) {
    let res = null;
    try {
      update(id, (cur) => {
        if (cur.state !== 'parked') { res = { id, ok: false, why: FINISHED.has(cur.state) ? `already ${cur.state}` : 'not parked: it is running or being checked right now' }; return null; }
        const now = Date.now();
        let replaced = '';
        if (runnerAlive(cur)) {
          try { process.kill(cur.pid, 'SIGKILL'); replaced = ` (its sleeping runner, pid ${cur.pid}, replaced)`; } catch { /* gone meanwhile */ }
        }
        const child = spawnRunner(cur.id, env);
        const entry = { at: now, by: by || null, account: cur.account || null, scheduledAt: cur.wakeAt || null, state: 'requested' };
        res = { id, ok: true, title: cur.title || '', account: cur.account || null, scheduledAt: cur.wakeAt || null, why: `woken now${replaced}` };
        return {
          ...cur, wakeAt: now, wakeDueAt: null, pid: child.pid, handedOverAt: now, handovers: (cur.handovers || 0) + 1,
          manualWake: { at: now, by: by || null, scheduledAt: cur.wakeAt || null },
          manualChecks: [...(Array.isArray(cur.manualChecks) ? cur.manualChecks : []), entry].slice(-MANUAL_KEEP),
        };
      });
    } catch (e) {
      res = { id, ok: false, why: `could not wake it: ${(e && e.message) || e}` };
    }
    if (!res) res = read(id) ? { id, ok: false, why: 'not parked' } : { id, ok: false, why: 'no such job (finished jobs are kept for 7 days)' };
    if (res.ok) logLine(id, `manual progress check${by ? ` asked for by ${by}` : ''}: woken now (scheduled for ${res.scheduledAt ? new Date(res.scheduledAt).toISOString() : '?'})`);
    out.push(res);
  }
  return out;
}
// The parked jobs that last ran on an account (name or e-mail): what "Check progress" on its card wakes.
function parkedOn(account) {
  const want = String(account || '').trim().toLowerCase();
  const acct = store.load().find((a) => a.name.toLowerCase() === want || (a.email || '').toLowerCase() === want) || null;
  return { acct, jobs: acct ? list().filter((j) => j.state === 'parked' && j.account === acct.name).sort((a, b) => (a.wakeAt || 0) - (b.wakeAt || 0)) : [] };
}

// ---- relay_wake ----
// The leader window wakes parked jobs now for a progress check (by job ids, or every parked job of one worker).
// Worker sessions (Relay's own runs, RELAY_TAKEOVER set) are refused.
function wake({ job_ids: ids, account } = {}, { env = process.env } = {}) {
  if (env.RELAY_TAKEOVER) return { text: 'relay_wake refused: this is a Relay worker session. Only the leader window can wake parked jobs.', isError: true };
  const hasIds = Array.isArray(ids) && ids.length;
  if (!hasIds && !account) return { text: 'relay_wake needs job_ids (parked jobs) or account (a worker\'s e-mail or name: wakes every job parked on it).', isError: true };
  let target = hasIds ? ids.map(String) : [];
  let head = '';
  if (!hasIds) {
    const { acct, jobs: parked } = parkedOn(account);
    if (!acct) return { text: `No Relay account "${account}" (relay_status lists them).`, isError: true };
    if (!parked.length) return { text: `${acct.email || acct.name} has no parked jobs: nothing to wake.`, woken: [] };
    target = parked.map((j) => j.id);
    head = `${acct.email || acct.name}: ${parked.length} parked job${parked.length > 1 ? 's' : ''}.`;
  }
  const res = wakeNow(target, { by: callerIdentity(env), env });
  const ok = res.filter((r) => r.ok);
  const lines = [
    ...(head ? [head] : []),
    ...res.map((r) => (r.ok ? `Job ${r.id}${r.title ? ` "${r.title}"` : ''}: woken now for a progress check (its scheduled wake was ${r.scheduledAt ? park.localTime(r.scheduledAt) : '?'}).` : `Job ${r.id}: not woken: ${r.why}.`)),
  ];
  if (ok.length) lines.push('', `Each check resumes the job's own session now (a fresh runner, the session carried to the worker that takes it) and reports its progress; the tray app shows a notification with the short report when it ends. Collect the reports with relay_wait (job_ids: ${JSON.stringify(ok.map((r) => r.id))}) or relay_poll: a check that parks again or finishes counts as an event.`);
  return { text: lines.join('\n'), woken: ok.map((r) => r.id), isError: !ok.length && hasIds };
}

// ---- relay_start ----
// Validates exactly like relay_run (runWorker with validateOnly), then records the job and starts its runner, detached:
// it has its own log file and no stdin from the caller, so it outlives this process, the MCP server and the window.
async function start(args, { env = process.env, via = '' } = {}) {
  const { runWorker } = require('./workers');
  const req = workerRequest(args);
  const check = await runWorker({ ...req, validateOnly: true });
  if (!check.ok) return { text: check.text, isError: isErrorResult(check) };
  try { prune(); } catch { /* never blocks a start */ }

  const id = newId();
  const title = check.title || '';
  const job = {
    id, state: 'queued', request: req, cwd: path.resolve(req.cwd), project: path.basename(path.resolve(req.cwd)), title,
    provider: check.provider, priority: check.priority || 'normal', createdAt: Date.now(), pid: null, log: logFile(id),
    ...(check.healthWarning ? { healthWarning: check.healthWarning } : {}), ...(via ? { via } : {}),
  };
  write(job);
  let child;
  try {
    child = spawnRunner(id, env);
  } catch (e) {
    update(id, (cur) => ({ ...cur, state: 'failed', code: 'spawn_failed', isError: true, finishedAt: Date.now(), report: `Relay error: could not start the background job: ${e.message}` }));
    return { text: `Relay error: could not start the background job: ${e.message}`, isError: true };
  }
  update(id, (cur) => (cur.pid ? null : { ...cur, pid: child.pid }));
  return {
    text: [
      `Started job ${id}${title ? ` ("${title}")` : ''}: state queued, ${req.thread ? `thread "${req.thread}"` : 'one-off (no thread)'}, agent ${check.provider}, priority ${job.priority}.`,
      ...(check.healthWarning ? [check.healthWarning] : []),
      'It runs in the background, also if this window closes. Collect it with relay_wait (job_ids: ["' + id + '"]) or check it with relay_poll; stop it with relay_cancel.',
    ].join('\n'),
    job: { id, thread: req.thread, state: 'queued' },
  };
}

// ---- relay_poll ----
function poll({ job_ids: ids, cwd } = {}) {
  try { prune(); } catch { /* best effort */ }
  let jobs;
  if (Array.isArray(ids) && ids.length) {
    jobs = ids.map((id) => ({ id: String(id), job: read(String(id)) }));
  } else {
    if (!cwd || !path.isAbsolute(cwd)) return { text: 'Give job_ids, or cwd (an absolute project folder) to list that project\'s recent jobs.', isError: true };
    const here = path.resolve(cwd);
    jobs = list().filter((j) => j.cwd === here).sort((a, b) => b.createdAt - a.createdAt).slice(0, LIST_LIMIT).map((j) => ({ id: j.id, job: j }));
    if (!jobs.length) return { text: `No background jobs in ${here} in the last 7 days.` };
  }
  const views = jobs.map(({ id, job }) => ({ id, v: job ? view(job) : null }));
  markParksSeen(views.map((x) => x.v).filter(Boolean));
  const blocks = views.map(({ id, v }) => (v ? describe(v) : `## Job ${id} · UNKNOWN: no such job (finished jobs are kept for 7 days).`));
  const na = needsActionLine(views.map((x) => x.v));
  return { text: [...(na ? [na, ''] : []), blocks.join('\n\n')].join('\n'), isError: jobs.every(({ job }) => !job) };
}

// ---- relay_wait ----
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done);
});
// A park the leader has not been told about yet (each park is reported once, by relay_wait or relay_poll).
const newPark = (v) => v.state === 'parked' && (v.parkedAt || 0) > (v.parkSeenAt || 0);
function markParksSeen(views) {
  for (const v of views) {
    if (!newPark(v)) continue;
    try { update(v.id, (cur) => (cur.state === 'parked' && cur.parkedAt === v.parkedAt ? { ...cur, parkSeenAt: Date.now() } : null)); } catch { /* reported again next time */ }
  }
}
async function wait({ job_ids: ids, timeout_sec: timeoutSec, mode, include_parked: includeParked = true } = {}, { onProgress = () => {}, signal = null, pollMs = 500 } = {}) {
  if (!Array.isArray(ids) || !ids.length) return { text: 'relay_wait needs job_ids (from relay_start).', isError: true };
  ids = [...new Set(ids.map(String))];
  const all = mode === 'all';
  const sec = Math.min(WAIT_MAX_SEC, Math.max(1, Number(timeoutSec) > 0 ? Number(timeoutSec) : WAIT_DEFAULT_SEC));
  const deadline = Date.now() + sec * 1000;
  let lastReport = 0;
  let views;
  for (;;) {
    views = ids.map((id) => { const j = read(id); return j ? view(j) : { id, state: 'unknown' }; });
    const finished = views.filter((v) => FINISHED.has(v.state) || v.state === 'unknown');
    const parkEvent = includeParked !== false && views.some(newPark);
    const settled = views.every((v) => FINISHED.has(v.state) || v.state === 'unknown' || v.state === 'parked');
    const ready = all ? finished.length === views.length || (parkEvent && settled) : finished.length > 0 || parkEvent;
    if (ready || Date.now() >= deadline || signal?.aborted) break;
    if (Date.now() - lastReport >= 5000) {
      lastReport = Date.now();
      onProgress(views.map((v) => `${v.id} ${v.state}${v.lastLine ? `: ${String(v.lastLine).slice(0, 80)}` : ''}`).join(' | '));
    }
    await sleep(pollMs, signal);
  }
  const done = views.filter((v) => FINISHED.has(v.state));
  const parkedNew = includeParked !== false ? views.filter(newPark) : [];
  const open = views.filter((v) => !FINISHED.has(v.state) && v.state !== 'unknown' && !parkedNew.includes(v));
  const unknown = views.filter((v) => v.state === 'unknown');
  const n = views.length;
  const parkNote = parkedNew.length ? ` ${parkedNew.length} parked (long-running work launched; no worker is held until it wakes at ${parkedNew.map((v) => park.localTime(v.wakeAt)).join(', ')}).` : '';
  const head = signal?.aborted ? 'Wait cancelled; the jobs keep running.'
    : done.length === n ? `All ${n} job${n > 1 ? 's' : ''} finished.`
      : (done.length || parkedNew.length) && (!all || done.length + views.filter((v) => v.state === 'parked').length === n)
        ? `${done.length} of ${n} job${n > 1 ? 's' : ''} finished.${parkNote} Call relay_wait again for the others${parkedNew.length ? ' (a parked job returns when it finishes or parks again)' : ''}.`
        : `Timed out after ${sec} s: ${done.length} of ${n} finished. The jobs keep running; call relay_wait again.`;
  markParksSeen(parkedNew);
  const blocks = [
    ...done.map((v) => describe(v)),
    ...parkedNew.map((v) => describe(v)),
    ...open.map((v) => describe(v)),
    ...unknown.map((v) => `## Job ${v.id} · UNKNOWN: no such job (finished jobs are kept for 7 days).`),
  ];
  const na = needsActionLine([...done, ...parkedNew, ...open]);
  return { text: [...(na ? [na] : []), head, '', blocks.join('\n\n')].join('\n'), isError: unknown.length === views.length };
}

// ---- relay_ack ----
// The leader records that it looked into a job's flags and resolved them (e.g. a false positive): append-only, in the
// job record (`acks`) and the project ledger. Acknowledged items leave the "Needs action" line and the panel's warning
// badge, but stay visible, marked resolved, in relay_poll / relay_wait, the job detail and relay_status. An ack covers
// what was raised before it: the same flag raised again by a later segment or wake needs action again.
// Worker sessions (Relay's own runs, RELAY_TAKEOVER set) cannot acknowledge anything.
const ACK_REASON_MAX = 1000;
// Touched by every ack, so the tray app's panel refreshes its warning badges without reading every ledger each time.
const ackStampFile = () => path.join(dir(), '.acked');
const ackStamp = () => { try { return fs.statSync(ackStampFile()).mtimeMs; } catch { return 0; } };
const normItem = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
// Which of the job's items a requested flag name means: the exact item (case, "_" and spaces ignored), or for the
// "K in protected paths" item also "in protected paths" / "concurrent_protected".
function matchItems(items, want) {
  const w = normItem(want);
  return items.filter((it) => normItem(it) === w || (/ in protected paths$/.test(it) && ['in protected paths', 'concurrent protected', 'concurrentprotected'].includes(w)));
}
function callerIdentity(env = process.env) {
  const real = (v) => (v && !String(v).includes('${') ? String(v).trim() : '');
  const email = real(env.CLAUDE_CODE_USER_EMAIL);
  if (email) return email;
  try { const seen = store.getLeaderSeen(); if (seen && seen.email) return `${seen.email} (last window seen by Relay)`; } catch { /* none */ }
  return 'the leader window (account unknown)';
}
function ack({ job_ids: ids, resolution, flags } = {}, { env = process.env, now = Date.now() } = {}) {
  if (env.RELAY_TAKEOVER) return { text: 'relay_ack refused: this is a Relay worker session. Only the leader window can acknowledge flags; report what you found instead.', isError: true };
  if (!Array.isArray(ids) || !ids.length) return { text: 'relay_ack needs job_ids (the flagged jobs).', isError: true };
  const reason = String(resolution == null ? '' : resolution).replace(/\s+/g, ' ').trim();
  if (!reason) return { text: 'relay_ack needs a resolution: what you found and why no action is needed, e.g. "false positive: concurrent changes by other jobs, see job k3x9p2q1-4f7a".', isError: true };
  if (flags != null && !Array.isArray(flags)) return { text: 'flags must be a list of flag names, e.g. ["CHECKS_FAILED"].', isError: true };
  const want = (flags || []).map((f) => String(f).trim()).filter(Boolean);
  const by = callerIdentity(env);
  const entry = { at: now, by, resolution: reason.slice(0, ACK_REASON_MAX) };
  const out = [];
  let failed = 0;
  const unique = [...new Set(ids.map(String))];
  for (const id of unique) {
    const job = read(id);
    if (!job) { out.push(`Job ${id}: no such job (finished jobs are kept for 7 days).`); failed++; continue; }
    let done = null;
    let problem = '';
    update(id, (cur) => {
      const items = flagItems(cur);
      let target;
      if (want.length) {
        const unknown = want.filter((w) => !matchItems(items, w).length);
        if (unknown.length) { problem = `no flag ${unknown.map((u) => `"${u}"`).join(', ')} on this job (its flags: ${items.join(', ') || 'none'})`; return null; }
        target = [...new Set(want.flatMap((w) => matchItems(items, w)))];
      } else {
        target = needsAction(cur);
        if (!target.length) { problem = items.length ? `nothing open to acknowledge (already resolved: ${flagsLabel(cur, { reasonChars: 60 })}); name them in flags to record a new resolution` : 'it has no flags'; return null; }
      }
      done = { ...cur, acks: [...(Array.isArray(cur.acks) ? cur.acks : []), { ...entry, flags: target }] };
      return done;
    });
    if (!done) { out.push(`Job ${id}: not acknowledged: ${problem}.`); failed++; continue; }
    try { fs.writeFileSync(ackStampFile(), String(now)); } catch { /* the panel catches up at its next change */ }
    const target = done.acks[done.acks.length - 1].flags;
    try {
      memory.appendLedger(done.cwd, {
        kind: 'ack', jobId: id, thread: (done.request && done.request.thread) || '', account: by, title: `Flags resolved on job ${id}${done.title ? ` "${done.title}"` : ''}`,
        summary: `RESOLVED ${target.join(', ')}: ${entry.resolution}`, ackFlags: target, ok: true,
      });
    } catch (e) { out.push(`(job ${id}: the ledger entry could not be written: ${e.message})`); }
    const open = needsAction(done);
    out.push(`Job ${id}${done.title ? ` "${done.title}"` : ''}: resolved ${target.join(', ')} (by ${by}).${open.length ? ` Still needs action: ${open.join(', ')}.` : ' Nothing left to act on.'}`);
  }
  out.push('', 'Resolved flags leave the "Needs action" line and the panel\'s warning badge; relay_poll and relay_status still show them, marked resolved. The same flag raised again by a later segment or wake needs action again.');
  return { text: out.join('\n'), isError: failed === unique.length };
}

// ---- relay_cancel ----
async function cancel({ job_ids: ids } = {}, { timeoutMs = 20000, pollMs = 250 } = {}) {
  if (!Array.isArray(ids) || !ids.length) return { text: 'relay_cancel needs job_ids.', isError: true };
  const out = [];
  for (const id of [...new Set(ids.map(String))]) {
    const job = read(id);
    if (!job) { out.push(`Job ${id}: no such job.`); continue; }
    if (FINISHED.has(job.state)) { out.push(`Job ${id}: already ${job.state}; nothing to stop.`); continue; }
    try { fs.writeFileSync(cancelFile(id), String(Date.now())); } catch (e) { out.push(`Job ${id}: could not ask it to stop (${e.message}).`); continue; }
    if (job.state === 'parked' && !runnerAlive(job)) { // nothing runs and no runner sleeps: just record it
      const c = cancelParked(id);
      if (c) { out.push(`Job ${id}: cancelled while parked (it will not wake).`); continue; }
    }
    // The runner stops its worker (the whole process tree), frees its locks and run file and writes "cancelled".
    const deadline = Date.now() + timeoutMs;
    let cur = job;
    while (Date.now() < deadline) {
      cur = settleIfOrphaned(read(id)) || cur;
      if (FINISHED.has(cur.state)) break;
      await sleep(pollMs);
    }
    out.push(FINISHED.has(cur.state)
      ? `Job ${id}: ${cur.state}.${cur.state === 'cancelled' ? '' : ' It finished before the stop reached it.'}\n${cur.report || ''}`.trim()
      : `Job ${id}: asked to stop; it is still shutting down (check with relay_poll).`);
  }
  return { text: out.join('\n\n') };
}

// A parked job that is cancelled: it never wakes; its session stays on its thread for a later continue.
function cancelParked(id) {
  let done = null;
  update(id, (cur) => {
    if (cur.state !== 'parked') return null;
    done = { ...cur, state: 'cancelled', code: 'cancelled', isError: false, finishedAt: Date.now(), report: `Cancelled while parked (it would have woken at ${park.localTime(cur.wakeAt)}).\n\nLatest report:\n${cur.report || ''}` };
    return done;
  });
  if (!done) return null;
  try {
    const r = done.request || {};
    if (r.thread && done.sessionId) memory.putThread(done.cwd, r.thread, { sessionId: done.sessionId, account: done.account, provider: done.provider, lastSummary: 'stopped: cancelled while parked', stopped: true });
    memory.appendLedger(done.cwd, { thread: r.thread || '', account: accountLabel(done.account) || 'a worker account', title: done.title || '', summary: 'CANCELLED while parked: it will not wake.', files: [], ok: false });
  } catch { /* the record says it */ }
  notifyFinished(done).catch(() => {});
  return done;
}

// ---- the tray app's notification ----
// Tells the running Relay app a job finished (it shows a system notification). Silent when the app is not running.
function notifyFinished(job, { timeoutMs = 3000, check = null } = {}) {
  return new Promise((resolve) => {
    let conn;
    try { conn = JSON.parse(fs.readFileSync(path.join(store.home(), 'connect.json'), 'utf8')); } catch { return resolve(false); }
    const body = JSON.stringify({
      id: job.id, title: job.title || '', project: job.project || '', account: accountLabel(job.account), ok: job.state === 'done', state: job.state,
      wakeAt: job.state === 'parked' ? job.wakeAt || null : null, wakes: job.wakes || 0,
      // a manual progress check ended: its short report goes into the notification
      ...(check ? { check: { short: String(check.short || '').slice(0, 300), outcome: check.outcome || '' } } : {}),
    });
    const req = http.request({ host: '127.0.0.1', port: conn.port, path: '/job', method: 'POST', timeout: timeoutMs, headers: { 'x-relay-token': conn.token, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

module.exports = {
  wakeNow, wake, parkedOn, shortReport, lastManual, manualLine,
  workerRequest, withMeta, needsAction, needsActionLine, flagItems, flagStates, flagsLabel, ackOf, ack, ackStamp, callerIdentity, isErrorResult, start, poll, wait, cancel, notifyFinished, prune, read, update, list, view, describe,
  jobFile, cancelFile, logFile, dir, FINISHED, KEEP_MS, priorityOf,
  spawnRunner, runnerAlive, reviveOne, reviveParked, overdueMs, isOverdue, overdueGraceMs, logLine, codeHash, handOver, parkedRecord, adoptParked, cancelParked, newPark,
};
