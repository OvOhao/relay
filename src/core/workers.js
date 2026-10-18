'use strict';
// Runs one delegated task on a worker account (any registered account except the leader, i.e. the
// account this Claude window is signed in to) and returns the worker's report to the dispatcher.
// Memory across runs: a named thread resumes the same worker session (even on another account), and
// the project ledger tells every worker what the others already did.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const memory = require('./memory');
const usage = require('./usage');
const { Engine } = require('./engine');

const isWorker = (a) => !a.desktop;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_WAIT_SEC = Number(process.env.RELAY_MAX_WAIT || 120); // never leave the dispatcher hanging for hours
// How long a job waits for another job in the same folder before answering BUSY (read per call: tests shorten it).
const queueWaitSec = () => Number(process.env.RELAY_QUEUE_WAIT_SEC || 1800);
const QUEUE_POLL_MS = 500;
const WAIT_REPORT_MS = 4000;

// Resolves after `ms`, or at once when `signal` aborts.
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done);
  });
}

// Waits its turn for the part of the project it changes (its scopes; the whole folder when it names none), first come,
// first served among the jobs it clashes with, across every window. A job that clashes with nobody ahead of it starts
// at once: jobs on different parts of one project run side by side on different workers. Resolves { lock } once this
// job holds its scopes, { cancelled } when aborted, { busy: holder } after the time limit.
async function waitForFolder(cwd, thread, { signal, onWait, scopes = null, legacy = true }) {
  const me = { scopes };
  const ticket = memory.joinQueue(cwd, { thread, scopes });
  const deadline = Date.now() + queueWaitSec() * 1000;
  try {
    for (;;) {
      if (signal && signal.aborted) return { cancelled: true };
      const line = memory.queue(cwd);
      const mine = line.findIndex((t) => t.token === ticket.token);
      const ahead = (mine < 0 ? [] : line.slice(0, mine)).filter((t) => memory.clash(cwd, t, me));
      let holder = null;
      if (!ahead.length) { // nobody it clashes with is ahead of it (or its ticket was lost: then just try)
        const lock = memory.acquireScopes(cwd, scopes, { thread }, { legacy });
        if (lock.release) return { lock };
        holder = lock.busy;
      } else {
        holder = memory.liveScopeLocks(cwd, { legacy }).find((t) => memory.clash(cwd, t, me)) || ahead[0];
      }
      if (Date.now() >= deadline) return { busy: holder || { thread: '?' } };
      onWait(holder || {}, ahead.length);
      await pause(QUEUE_POLL_MS + Math.random() * 250, signal);
    }
  } finally {
    ticket.release();
  }
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
// A short label for the panel: the dispatcher's own `title`, else the task's first sentence or line without markdown.
function deriveTitle(task) {
  const first = String(task || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const plain = first.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = plain.match(/^.*?[.!?。！？](?=\s|$)/)?.[0] || plain;
  return clip(sentence.trim(), 64);
}
const when = (sec) => new Date(sec * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const label = (a) => a.email || a.name;

// Files a worker changed can't be read off its tool calls alone (it may write with a shell command), so
// in a git project compare `git status` before and after. null = not a git project / no git.
function gitState(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain', '-unormal'], { timeout: 15000, windowsHide: true, maxBuffer: 8e6 }, (err, out) => {
      resolve(err ? null : new Set(String(out).split('\n').map((l) => l.trimEnd()).filter(Boolean)));
    });
  });
}

function buildPrompt({ task, context, ledger, resumed, scopes = null }) {
  const limit = scopes && scopes.length
    ? `Only create or change files inside: ${scopes.join(', ')} (relative to the current folder). Other workers may be changing other parts of this project at the same time.`
    : '';
  if (resumed) {
    return [
      'Follow-up from the dispatcher on this same thread (you keep all your earlier context):',
      '',
      task,
      limit ? `\n${limit}` : '',
      context ? `\nExtra background:\n${context}` : '',
      ledger ? `\nWhile you were away, other workers did this in the same project:\n${ledger}` : '',
      '\nFinish with a short report: what you did, files changed, how you verified, open issues.',
    ].filter((x) => x !== '').join('\n');
  }
  return [
    'You are a worker agent dispatched by Relay for another Claude session (the "dispatcher") that talks to the user.',
    'You cannot see their conversation: everything you need is below. Work in the current folder.',
    '',
    '## Task',
    task,
    '',
    '## Background from the dispatcher',
    context || '(none given: read the project files and CLAUDE.md to orient yourself)',
    '',
    '## Project ledger: what earlier workers already did here (oldest first)',
    ledger || '(nothing yet)',
    '',
    '## How to work',
    ...(limit ? [`- ${limit}`] : []),
    '- Do the whole task. Do not stop to ask questions unless you are truly blocked; state your assumptions instead.',
    '- Do not delegate further. If a command or edit is refused by permissions, say exactly what was refused.',
    '- Finish with a short report the dispatcher will read: what you did, files changed, how you verified, open issues or follow-ups.',
  ].join('\n');
}

// The folders a job will change, as absolute paths inside its project folder; null = the whole folder.
function cleanScopes(cwd, scope) {
  const list = (Array.isArray(scope) ? scope : scope == null || scope === '' ? [] : [scope]).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return { scopes: null };
  const root = path.resolve(cwd);
  const out = [];
  for (const s of list) {
    const abs = path.resolve(root, s);
    if (abs !== root && !abs.startsWith(root + path.sep)) return { error: `scope must be inside cwd (got: ${s}).` };
    if (abs === root) return { scopes: null }; // the whole folder after all
    out.push(abs);
  }
  return { scopes: out };
}

async function runWorker({ task, context = '', cwd, thread = '', readOnly = false, model = '', title = '', account = '', scope = null, onProgress = () => {}, signal = null }) {
  if (!task || !String(task).trim()) return { ok: false, code: 'bad_request', text: 'relay_run needs a task.' };
  const cleaned = store.cleanModel(model);
  if (cleaned === null) return { ok: false, code: 'bad_request', text: `model must be a model alias or id such as "haiku" or "claude-haiku-5-5" (got: ${String(model).slice(0, 40)}).` };
  model = cleaned;
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return { ok: false, code: 'bad_request', text: `cwd must be an existing absolute folder path (got: ${cwd || 'nothing'}).` };

  const workers = store.load().filter((a) => isWorker(a) && !a.needsLogin);
  if (!workers.length) {
    return { ok: false, code: 'no_workers', text: 'NO_WORKER_AVAILABLE: Relay has no worker accounts signed in (the leader account is this window). Do the work yourself, or ask the user to add another account in Relay.' };
  }

  const sc = cleanScopes(cwd, scope);
  if (sc.error) return { ok: false, code: 'bad_request', text: sc.error };
  const scopes = sc.scopes;

  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const given = clip(String(title || '').replace(/\s+/g, ' ').trim(), 60);
  const ledgerTitle = given || clip(task, 120);
  const run = { project: path.basename(cwd) || cwd, cwd, scopes: scopes ? scopes.map((s) => path.relative(cwd, s)) : null, thread: thread || '', title: given || deriveTitle(task), kind: 'worker', status: 'running', account: null, lastLine: '', startedAt: Date.now() };
  const tick = () => memory.writeRun(runId, { ...run, updatedAt: Date.now() });

  // Several jobs share one project folder: a job only waits for another when both named the files they change
  // (scope) and those overlap, or when Settings asks for one job per folder (then a job without scope takes the whole
  // folder, as before). A read-only job changes nothing, so it never waits and never makes anyone else wait. The
  // waiting shows in the panel and, every few seconds, as progress to the dispatcher, which keeps its call alive.
  const settings = store.loadSettings();
  const folderLock = settings.folderLock === true;
  let reported = 0;
  const needsLock = !readOnly && (folderLock || !!scopes);
  const got = !needsLock ? { lock: { release: () => {} } } : await waitForFolder(cwd, thread || '(one-off)', {
    signal, scopes, legacy: folderLock,
    onWait: (holder, ahead) => {
      run.status = 'waiting';
      run.lastLine = `Waiting for another worker changing the same files (thread ${holder.thread || '?'})…${ahead > 1 ? ` ${ahead} jobs ahead.` : ''}`;
      tick();
      if (Date.now() - reported >= WAIT_REPORT_MS) { reported = Date.now(); onProgress(run.lastLine); }
    },
  });
  if (!got.lock) {
    memory.removeRun(runId);
    if (got.cancelled) return { ok: false, code: 'cancelled', text: 'Cancelled while waiting for the folder; nothing was started.' };
    const sec = queueWaitSec();
    return { ok: false, code: 'busy', text: `BUSY: another Relay worker (thread "${got.busy.thread || '?'}") is still changing the same files after waiting ${sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`}. Wait for it, work on something else, or give jobs on different parts of the project their own \`scope\`.` };
  }
  const lock = got.lock;
  run.status = 'running';
  run.lastLine = '';

  let engine = null;
  const files = new Set();
  const commands = [];
  let modelUsed = '';
  let gitBefore = null;
  const onAbort = () => { if (engine) engine.stop(); };
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    const existing = thread ? memory.getThread(cwd, thread) : null;
    engine = new Engine();
    engine.filter = isWorker;
    engine.maxWait = MAX_WAIT_SEC;
    // One job per worker at a time (Settings): with every worker busy, the job waits for the first one to come free.
    const per = Number(settings.jobsPerWorker);
    engine.maxPerAccount = Number.isFinite(per) && per > 0 ? per : null;
    engine.busyWaitSec = queueWaitSec();
    if (account) { // run on this worker (by name or e-mail) when it is ready; otherwise Relay picks one
      const want = String(account).trim().toLowerCase();
      const a = workers.find((w) => w.name.toLowerCase() === want || (w.email || '').toLowerCase() === want);
      if (a) engine.account = a.name;
    }
    engine.model = model; // asked for in this call: wins over the account's default model
    engine.useAccountModel = true; // otherwise each worker account runs on the model chosen for it in Relay
    if (existing?.sessionId) { engine.sessionId = existing.sessionId; engine.account = existing.account || null; }

    const prompt = buildPrompt({
      task: String(task), context: String(context || ''), resumed: !!existing?.sessionId, scopes: run.scopes,
      ledger: memory.ledgerText(cwd, existing ? { sinceMs: existing.updatedAt, excludeThread: thread } : {}),
    });

    gitBefore = await gitState(cwd);
    tick();
    // Recorded while the account is chosen (under the cross-process pick lock), so other windows choosing at the
    // same moment already count this run against that account.
    engine.onReserve = (a) => { run.account = a.name; tick(); };
    engine.on('state', (st) => {
      run.account = st.status === 'waiting' && st.waitingFor === 'worker' ? null : st.account;
      run.status = st.status === 'waiting' ? 'waiting' : 'running';
      run.waitingUntil = st.waitingUntil;
      if (st.waitingFor === 'worker') {
        run.lastLine = 'Waiting for a free worker: every worker is busy with another job…';
        if (Date.now() - reported >= WAIT_REPORT_MS) { reported = Date.now(); onProgress(run.lastLine); }
      }
      tick();
    });
    engine.on('item', (it) => {
      if (it.kind === 'init' && it.model) { modelUsed = it.model; run.model = it.model; }
      if (it.kind === 'tool') {
        run.lastLine = `${it.name} ${it.summary}`;
        if (EDIT_TOOLS.has(it.name) && it.summary) files.add(it.summary);
        if (it.name === 'Bash' && it.summary) commands.push(it.summary);
        onProgress(run.lastLine);
      } else if (it.kind === 'text') {
        run.lastLine = it.text.replace(/\s+/g, ' ').slice(0, 140);
      }
      tick();
    });

    if (!(signal && signal.aborted)) {
      const sending = engine.send({ prompt, cwd, permissionMode: readOnly ? 'plan' : store.loadSettings().permissionMode, hidden: true });
      if (signal && signal.aborted) engine.stop(); // aborted while the first attempt was being set up
      await sending;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    lock.release();
    memory.removeRun(runId);
  }

  const gitAfter = gitBefore ? await gitState(cwd) : null;
  if (gitAfter) for (const line of gitAfter) if (!gitBefore.has(line)) files.add(line.slice(3).replace(/^"|"$/g, ''));

  const acct = engine.account && store.get(engine.account);
  const report = [...engine.items].reverse().find((i) => i.kind === 'text')?.text || '';
  const who = acct ? label(acct) : 'a worker account';
  const cancelled = engine.stopped || !!(signal && signal.aborted);
  // keep the panel's numbers fresh, in the background (not while the window is closing: nothing may outlive it)
  if (acct && !cancelled) usage.refresh(acct.name).catch(() => {});

  // A run that stops early keeps its worker session: the next call on the same thread resumes it.
  const keepSession = (reason) => {
    if (thread && engine.sessionId) memory.putThread(cwd, thread, { sessionId: engine.sessionId, account: engine.account, title: ledgerTitle, lastSummary: `stopped: ${reason}`, stopped: true });
  };
  const resumeHint = thread && engine.sessionId ? ` Call again with thread "${thread}" to continue where it stopped.` : '';

  if (cancelled) {
    keepSession('cancelled');
    memory.appendLedger(cwd, { thread, account: who, title: ledgerTitle, summary: 'CANCELLED: stopped from the dispatcher window before it finished.', files: [...files], ok: false });
    return { ok: false, code: 'cancelled', text: `Cancelled.${resumeHint}${files.size ? `\nFiles touched before it stopped: ${[...files].join(', ')}` : ''}` };
  }
  if (engine.status === 'error') {
    const err = engine.lastError;
    if (err && err.code === 'workers_busy') {
      keepSession('every worker was busy');
      return { ok: false, code: 'busy', text: `BUSY: every worker is still busy with other jobs after waiting ${Math.round(queueWaitSec() / 60)} min. Retry later, or do the work yourself.${resumeHint}` };
    }
    if (err && err.code === 'workers_limited') {
      keepSession('every worker account reached its limit');
      memory.appendLedger(cwd, { thread, account: who, title: ledgerTitle, summary: `NOT FINISHED: every worker account reached its limit (the first is back at ${when(err.until)}).`, files: [...files], ok: false });
      return { ok: false, code: 'workers_limited', text: `NO_WORKER_AVAILABLE: every worker account has reached its limit; the first one is back at ${when(err.until)}. Tell the user, then either do the work yourself or retry later.${resumeHint}` };
    }
    keepSession(clip(err?.message || 'unknown error', 120));
    memory.appendLedger(cwd, { thread, account: who, title: ledgerTitle, summary: `FAILED: ${clip(err?.message || 'unknown error', 300)}`, files: [...files], ok: false });
    return { ok: false, code: 'failed', text: `Worker failed: ${err?.message || 'unknown error'}${files.size ? `\nFiles touched before failing: ${[...files].join(', ')}` : ''}` };
  }

  const summary = clip(report.replace(/\s+/g, ' ').trim(), 1500);
  if (thread) memory.putThread(cwd, thread, { sessionId: engine.sessionId, account: engine.account, title: ledgerTitle, lastSummary: summary, files: [...files], stopped: false });
  memory.appendLedger(cwd, { thread, account: who, title: ledgerTitle, summary, files: [...files], commands: commands.slice(0, 8).map((c) => clip(c, 100)), ok: true });

  return {
    ok: true, code: 'done', sessionId: engine.sessionId, thread, account: who,
    text: [
      `[relay] worker ${who}${modelUsed ? ` · model ${modelUsed}` : ''}${thread ? ` · thread "${thread}"` : ''} finished.`,
      thread ? `Continue this line of work later with the same thread name; the worker remembers everything.` : '',
      '',
      report || '(the worker returned no text)',
      files.size ? `\nFiles touched: ${[...files].join(', ')}` : '',
      commands.length ? `Commands run: ${commands.slice(0, 6).map((c) => clip(c, 80)).join(' | ')}${commands.length > 6 ? ` (+${commands.length - 6} more)` : ''}` : '',
    ].filter((x) => x !== '').join('\n'),
  };
}

// For relay_status: who is leader, who are workers, how much each has used.
function statusText(cwd) {
  const cache = usage.readCache();
  const lines = ['Relay accounts:'];
  const accounts = store.load();
  if (!accounts.length) lines.push('  (none yet)');
  for (const a of accounts) {
    const u = cache[a.name]?.data;
    const state = a.needsLogin ? 'SIGN-IN NEEDED' : a.blockedUntil > store.nowSec() ? `limited until ${when(a.blockedUntil)}` : 'ready';
    const bits = [u?.session ? `5h window ${u.session.pct}% used` : '', u?.week ? `week ${u.week.pct}% used` : ''].filter(Boolean).join(', ');
    lines.push(`  - ${label(a)} [${a.desktop ? 'LEADER: this window, do not delegate to it' : 'worker'}] ${state}${bits ? ` (${bits})` : ''}`);
  }
  const seen = store.getLeaderSeen();
  if (seen && !seen.registered) lines.push(`  Note: this window is signed in as ${seen.email}, which is not in Relay's pool.`);
  if (cwd && path.isAbsolute(cwd)) {
    const threads = memory.listThreads(cwd);
    const names = Object.keys(threads);
    lines.push('', `Threads in ${cwd}:`);
    if (!names.length) lines.push('  (none yet)');
    for (const n of names) lines.push(`  - "${n}" (${new Date(threads[n].updatedAt).toISOString().slice(0, 16).replace('T', ' ')}): ${clip(threads[n].lastSummary || threads[n].title || '', 160)}`);
  }
  return lines.join('\n');
}

module.exports = { runWorker, statusText, buildPrompt, deriveTitle, cleanScopes };
