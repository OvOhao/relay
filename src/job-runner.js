'use strict';
// Runs one background job (relay_start), detached from the window that started it: `node job-runner.js <job id>`.
// It runs the job with runWorker exactly as relay_run does, writes the result into the job record
// (~/.relay/jobs/<id>.json), tells the Relay app (a system notification, when the app is running) and exits.
// It stops cleanly, like a cancelled relay_run (worker stopped, folder and run file freed, ledger says cancelled), when
// "<id>.cancel" appears next to the record, or on SIGTERM / SIGINT.
//
// Park / wake (see core/park.js): when the worker's report ends with a valid RELAY_PARK line, the job becomes
// "parked" (no worker is held), this process sleeps until wakeAt and then resumes the same session with a scheduled
// check, as often as the worker parks again (at most RELAY_MAX_WAKES, 48, times). A runner started for a job that is
// already parked (after a restart: see jobs.reviveParked) just sleeps until its wakeAt, or wakes it at once if the
// time has passed. Only one runner works on a job: a second one finds a live runner in the record and leaves.
//
// Every wake runs the code on disk at wake time, not the code this process loaded (a promotion may have happened while
// it slept): a runner that had to sleep never wakes the job itself. At wakeAt it hands the job to a fresh runner
// process (jobs.handOver: the new pid goes into the record under its lock) and exits; the fresh runner finds the wake
// time passed and wakes the job. It also hands over as soon as the code under src/ changes while it sleeps (checked
// every sleep step). A runner wakes a job itself only if it did not sleep for it and its code is still the code on
// disk, or if a fresh runner cannot be started.

const fs = require('fs');
delete process.env.ELECTRON_RUN_AS_NODE; // set only so the tray app's binary runs this file as Node; workers must not inherit it
const jobs = require('./core/jobs');
const memory = require('./core/memory');
const park = require('./core/park');
const awake = require('./core/awake');
const { runWorker } = require('./core/workers');

const id = process.argv[2];
const BOOT_CODE = jobs.codeHash(); // the code this process runs (see the note at the top)
const log = (...a) => process.stdout.write(`[relay-job ${id}] ${new Date().toISOString()} ${a.join(' ')}\n`);
const controller = new AbortController();
const abort = (why) => { if (!controller.signal.aborted) { log('stopping:', why); controller.abort(); } };
process.on('SIGTERM', () => abort('SIGTERM'));
process.on('SIGINT', () => abort('SIGINT'));
process.on('uncaughtException', (e) => log('uncaught exception (kept running):', (e && e.stack) || e));
process.on('unhandledRejection', (e) => log('unhandled rejection (kept running):', (e && e.stack) || e));

// Sleeps until `atMs` in short steps, comparing with the wall clock each time: after the computer slept, a long timer
// would fire late by the time it slept; a step notices at once that the time has passed. false = cancelled.
// After each step `stop()` may end the sleep early. Returns 'time', 'stop' or 'cancelled'.
const STEP_MS = Number(process.env.RELAY_PARK_STEP_MS || 30000);
const pause = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, Math.max(10, ms));
  signal.addEventListener('abort', done);
});
// A step that took JUMP_MS longer than asked: the computer slept (timers do not run then) or the clock was moved. It is
// logged and kept in the record (sleepGaps), so a late wake can be told apart from a runner that was not there.
const JUMP_MS = Number(process.env.RELAY_CLOCK_JUMP_MS || 60000);
async function sleepUntil(atMs, signal, stop = async () => false, onStep = () => {}) {
  while (!signal.aborted && Date.now() < atMs) {
    const ask = Math.max(10, Math.min(STEP_MS, atMs - Date.now()));
    const t0 = Date.now();
    await pause(ask, signal);
    const took = Date.now() - t0;
    if (!signal.aborted && took > ask + JUMP_MS) noteGap(t0, took - ask);
    if (!signal.aborted) { try { onStep(); } catch { /* never stops the sleep */ } }
    if (!signal.aborted && Date.now() < atMs && await stop()) return 'stop';
  }
  return signal.aborted ? 'cancelled' : 'time';
}
function noteGap(from, gapMs) {
  log(`the computer slept or the clock jumped: ${Math.round(gapMs / 1000)} s passed with no timer running (from ${new Date(from).toISOString()})`);
  try { jobs.update(id, (c) => ({ ...c, sleepGaps: [...(c.sleepGaps || []), { from, gapMs, at: Date.now() }].slice(-20) })); } catch { /* only a note */ }
}

// Settings › preventSleepForWakes: from preventSleepMinutes before the wake, caffeinate for this runner (core/awake.js).
let keepAwake = null;
function keepAwakeFor(wakeAt) {
  if (keepAwake) return;
  const s = awake.settings();
  if (!s.on || wakeAt - Date.now() > s.minutes * 60000) return;
  keepAwake = awake.hold({ untilMs: wakeAt + 5 * 60000 });
  if (!keepAwake) return;
  log(`keeping the Mac awake until the wake (caffeinate ${keepAwake.args.join(' ')}, pid ${keepAwake.pid})`);
  try { jobs.update(id, (c) => ({ ...c, keepAwake: { pid: keepAwake.pid, since: keepAwake.since, until: keepAwake.untilMs, phase: 'before wake' } })); } catch { /* only a note */ }
}
function releaseAwake() {
  if (!keepAwake) return;
  keepAwake.stop();
  keepAwake = null;
}

// Has the code on disk changed since this process started? Only a change that has settled counts (the same new hash
// again a moment later), so a promotion that is still writing files is not picked up half-way.
const SETTLE_MS = Number(process.env.RELAY_CODE_SETTLE_MS || 1000);
async function codeChanged() {
  const now = jobs.codeHash();
  if (now === BOOT_CODE) return false;
  await pause(SETTLE_MS, controller.signal);
  return !controller.signal.aborted && jobs.codeHash() === now;
}

// Gives the parked job to a fresh runner process and says whether this one must leave now. false only when a fresh
// runner could not be started: this process then keeps the job (it wakes it itself, on its own code).
function handOver(why) {
  try {
    const { child, job } = jobs.handOver(id, process.pid);
    if (child) { log(`handing over to a fresh runner (pid ${child.pid}, code on disk now): ${why}`); return true; }
    log('not handing over: the job is', job ? `${job.state}, runner pid ${job.pid}` : 'gone', '; leaving');
    return true;
  } catch (e) {
    log('could not start a fresh runner, waking here on the code this runner loaded:', (e && e.message) || e);
    return false;
  }
}

async function notify(job, check = null) {
  try { await jobs.notifyFinished(job, { check }); } catch { /* the app is not running: nothing to tell */ }
}

function finish(out, extra = {}) {
  const state = out.ok ? 'done' : out.code === 'cancelled' ? 'cancelled' : 'failed';
  return jobs.update(id, (cur) => ({
    ...jobs.withMeta(cur, out), state, code: out.code, isError: jobs.isErrorResult(out), report: out.text, finishedAt: Date.now(),
    account: out.accountName || cur.account || null, model: out.model || cur.model || null,
    files: [...new Set([...(cur.files || []), ...(out.files || [])])], commands: out.commands || [], sessionId: out.sessionId || cur.sessionId || null,
    wakeAt: null, ...(cur.wakes || cur.history ? { history: [...(cur.history || []), { at: Date.now(), state, wake: cur.wakes || 0, account: out.accountName || null, report: out.text }] } : {}),
    ...extra,
  }));
}

async function main() {
  const job = jobs.read(id);
  if (!job) { log('no such job'); return; }
  if (jobs.FINISHED.has(job.state)) { log('already', job.state); return; }
  // One runner per job: whoever started this process wrote its pid into the record; another live runner wins.
  const mine = jobs.update(id, (cur) => (cur.pid && cur.pid !== process.pid && jobs.runnerAlive(cur) ? null : { ...cur, pid: process.pid, runnerStartedAt: Date.now(), runnerCode: BOOT_CODE }));
  if (!mine || mine.pid !== process.pid) { log('another runner has this job: pid', mine && mine.pid); return; }
  log('started', JSON.stringify({ cwd: job.cwd, thread: job.request.thread, agent: job.request.agent || 'claude', state: job.state, code: BOOT_CODE }));

  const watch = setInterval(() => { if (fs.existsSync(jobs.cancelFile(id))) abort('cancel requested'); }, 300);
  if (fs.existsSync(jobs.cancelFile(id))) abort('cancel requested');
  let lastSave = 0;
  try {
    for (;;) {
      let cur = jobs.read(id);
      let wake = null;
      if (!cur || jobs.FINISHED.has(cur.state)) { log('the record is', cur ? cur.state : 'gone', '; leaving'); return; }
      if (cur.state === 'parked') {
        if (Date.now() < cur.wakeAt) {
          log('parked until', new Date(cur.wakeAt).toISOString());
          const wakeAt = cur.wakeAt;
          keepAwakeFor(wakeAt);
          const slept = await sleepUntil(wakeAt, controller.signal, codeChanged, () => keepAwakeFor(wakeAt));
          if (slept === 'cancelled') { const c = jobs.cancelParked(id); log('cancelled while parked'); if (!c) log('(record was not parked any more)'); return; }
          if (handOver(slept === 'stop' ? 'the code on disk changed while parked' : 'wake time')) return;
          cur = jobs.read(id); // no fresh runner: this one wakes the job
          if (!cur || cur.state !== 'parked') { log('the record is', cur ? cur.state : 'gone', '; leaving'); return; }
        } else if (jobs.codeHash() !== BOOT_CODE && handOver('the code on disk changed since this runner started')) {
          return;
        }
        if (!cur.sessionId) {
          const f = finish({ ok: false, code: 'failed', text: `Relay error: the parked job cannot be woken: its worker session id is unknown.\n\nLatest report:\n${cur.report || ''}` });
          await notify(f);
          return;
        }
        const n = (cur.wakes || 0) + 1;
        // Only the owner of the parked record wakes it (checked under the record's lock): never two wakes.
        // wokeAt and how late against the time the park asked for (wakeDueAt: kept over "no free worker" retries).
        let owned = false;
        let manual = null; // a progress check asked for now (the panel's "Check progress", relay_wake): jobs.wakeNow
        const wokeAt = Date.now();
        cur = jobs.update(id, (c) => {
          if (c.state !== 'parked' || c.pid !== process.pid) return null;
          owned = true;
          manual = c.manualWake || null;
          const dueAt = c.wakeDueAt || c.wakeAt;
          const entry = {
            wake: n, wakeAt: dueAt, wokeAt, lateMs: wokeAt - dueAt, ...(c.wakeDueAt && c.wakeDueAt !== c.wakeAt ? { retryAt: c.wakeAt } : {}), runner: process.pid, ...(c.revivedAt && c.revivedAt > (c.parkedAt || 0) ? { revived: true } : {}),
            ...(manual ? { manual: true, kind: 'manual check', by: manual.by || null, askedAt: manual.at, scheduledAt: manual.scheduledAt || null } : {}),
          };
          const checks = Array.isArray(c.manualChecks) ? c.manualChecks.map((m) => (manual && m.at === manual.at ? { ...m, state: 'running', wake: n, wokeAt } : m)) : c.manualChecks;
          const { manualWake, ...rest } = c;
          return { ...rest, ...(checks ? { manualChecks: checks } : {}), state: 'queued', wakes: n, wokenAt: wokeAt, wokeOnCode: BOOT_CODE, lastLine: `${manual ? 'Progress check' : 'Scheduled check'} ${n}…`, lastWake: entry, wakeDueAt: null, wakeLog: [...(c.wakeLog || []), entry].slice(-100) };
        });
        if (!owned) { log('not waking: the job is', cur ? `${cur.state}, runner pid ${cur.pid}` : 'gone'); return; }
        // the wake keeps the job's priority (it is in the request) and its context state, for a handoff if it is full
        // final: a park at this check ends the job (too_many_wakes), so its changes are checked now
        wake = { manual: !!manual, manualReq: manual, sessionId: cur.sessionId, account: cur.account, provider: cur.provider, n, final: n >= park.maxWakes(), files: cur.files || [], jobId: id, report: cur.report || '', context: cur.context || null, handoffs: cur.handoffs || 0, sessions: cur.sessions || [], dueAt: cur.lastWake.wakeAt, wokeAt, lateMs: cur.lastWake.lateMs };
        log(manual ? `waking (manual progress check${manual.by ? ` asked for by ${manual.by}` : ''}):` : 'waking:', n, 'on', cur.account || '?', 'code', BOOT_CODE, `due ${new Date(cur.lastWake.wakeAt).toISOString()}, late ${Math.round(cur.lastWake.lateMs / 1000)} s`);
        releaseAwake();
        // the check itself: kept awake until it ends (the runner may park again and sleep in this same process)
        keepAwake = awake.hold({});
        if (keepAwake) {
          log(`keeping the Mac awake during the check (caffeinate ${keepAwake.args.join(' ')}, pid ${keepAwake.pid})`);
          try { jobs.update(id, (c) => ({ ...c, keepAwake: { pid: keepAwake.pid, since: keepAwake.since, until: null, phase: 'check' } })); } catch { /* only a note */ }
        }
      }
      let out;
      try {
        out = await runWorker({
          ...cur.request,
          jobId: id,
          wake,
          background: true, // waits for a worker and its folder as long as it takes (Settings: backgroundMaxWaitMin)
          signal: controller.signal,
          onProgress: (line) => {
            if (Date.now() - lastSave < 2000) return; // the live line is in the run file; the record keeps a recent one
            lastSave = Date.now();
            try { jobs.update(id, (c) => ({ ...c, lastLine: line, beat: Date.now() })); } catch { /* next one */ }
          },
        });
      } catch (e) {
        out = { ok: false, code: 'failed', text: `Relay error: ${(e && e.message) || e}` };
        log('runWorker threw:', (e && e.stack) || e);
      }
      releaseAwake();
      if (wake) {
        // when a worker took the check (it may have waited for a free one) and how it ended: into the wake's entry
        const t = (out.meta && out.meta.wakeTiming) || null;
        try {
          jobs.update(id, (c) => {
            const h = [...(c.wakeLog || [])];
            for (let k = h.length - 1; k >= 0; k--) if (h[k].wake === wake.n && h[k].wokeAt === wake.wokeAt) { h[k] = { ...h[k], workerAt: t ? t.workerAt : null, waitMs: t ? t.waitMs : null, outcome: out.park ? 'parked' : out.code || (out.ok ? 'done' : 'failed') }; break; }
            return { ...c, wakeLog: h, ...(c.lastWake && c.lastWake.wokeAt === wake.wokeAt ? { lastWake: h[h.length - 1] && h[h.length - 1].wokeAt === wake.wokeAt ? h[h.length - 1] : c.lastWake } : {}), keepAwake: null };
          });
        } catch { /* only a note */ }
      }

      // A manual progress check: its outcome and short report go into the record (and into the notification below).
      let check = null;
      if (wake && wake.manual && !(['busy', 'workers_limited'].includes(out.code) && !controller.signal.aborted)) {
        const atWake = jobs.read(id);
        const m = atWake && Array.isArray(atWake.manualChecks) ? [...atWake.manualChecks].reverse().find((x) => x.wake === wake.n && x.wokeAt === wake.wokeAt) : null;
        check = {
          ...(m || { at: wake.wokeAt, by: null }), state: 'done', wake: wake.n, wokeAt: wake.wokeAt, finishedAt: Date.now(), ranOn: out.accountName || null,
          outcome: out.park ? 'parked again' : out.ok ? 'finished' : out.code === 'cancelled' ? 'cancelled' : `failed${out.code ? ` (${out.code})` : ''}`,
          short: jobs.shortReport(out.report || out.text),
        };
        try {
          jobs.update(id, (c) => {
            const list = Array.isArray(c.manualChecks) ? [...c.manualChecks] : [];
            const k = list.findIndex((x) => x.wake === wake.n && x.wokeAt === wake.wokeAt);
            if (k >= 0) list[k] = check; else list.push(check);
            return { ...c, manualChecks: list.slice(-20) };
          });
        } catch { /* the notification still says it */ }
        log('manual progress check ended:', check.outcome, '-', check.short);
      }

      if (out.ok && out.park && !controller.signal.aborted) {
        if ((cur.wakes || 0) >= park.maxWakes()) {
          const max = park.maxWakes();
          memory.appendLedger(cur.cwd, { thread: cur.request.thread || '', account: out.account || 'a worker account', title: cur.title || '', summary: `FAILED: the job parked again after ${max} scheduled checks, the most Relay does for one job.`, files: [], ok: false });
          const meta = { ...(out.meta || {}), flags: [...new Set([...((out.meta && out.meta.flags) || []), 'too_many_wakes'])] };
          const f = finish({ ...out, meta, ok: false, code: 'too_many_wakes', text: `Relay stopped this job: the worker parked again after ${max} scheduled checks, the most Relay does for one job. Check the launched work yourself, or start a new job to keep watching it.\n\nLatest report:\n${out.text}` });
          log('finished: failed too_many_wakes');
          await notify(f, check);
          return;
        }
        const p = jobs.update(id, (c) => jobs.parkedRecord(c, out));
        log('parked:', out.park.minutes, 'min, until', new Date(out.park.wakeAt).toISOString());
        await notify(p, check);
        continue;
      }
      // At a scheduled check every worker was busy or limited: try again a little later (this does not count as a wake).
      if (wake && ['busy', 'workers_limited'].includes(out.code) && !controller.signal.aborted) {
        const at = Math.max(Date.now() + park.RETRY_MINUTES * park.minuteMs(), out.until ? out.until * 1000 + 5000 : 0);
        if (wake.manual) {
          try { jobs.update(id, (c) => ({ ...c, manualChecks: (c.manualChecks || []).map((m) => (m.wake === wake.n && m.wokeAt === wake.wokeAt ? { ...m, state: 'waiting', note: `no free worker (${out.code}); trying again at ${park.localTime(at)}` } : m)) })); } catch { /* only a note */ }
        }
        jobs.update(id, (c) => ({ ...c, ...(wake.manualReq ? { manualWake: wake.manualReq } : {}), state: 'parked', wakes: Math.max(0, (c.wakes || 1) - 1), wakeAt: at, wakeDueAt: (c.lastWake && c.lastWake.wakeAt) || c.wakeAt, parkedAt: c.parkedAt || Date.now(), lastLine: `No free worker at the scheduled check (${out.code}); trying again at ${park.localTime(at)}.` }));
        log('no worker at wake:', out.code, '; retry at', new Date(at).toISOString());
        continue;
      }
      const f = finish(out);
      log('finished:', f.state, out.code || '');
      await notify(f, check);
      return;
    }
  } finally {
    clearInterval(watch);
  }
}

main()
  .catch((e) => log('failed:', (e && e.stack) || e))
  .finally(() => { releaseAwake(); memory.releaseAll(); process.exit(0); });
