'use strict';
// Runs one delegated task on a worker account (any registered account except the leader, i.e. the
// account this Claude window is signed in to) and returns the worker's report to the dispatcher.
// Memory across runs: a named thread resumes the same worker session (even on another account), and
// the project ledger tells every worker what the others already did.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const store = require('./store');
const memory = require('./memory');
const usage = require('./usage');
const { Engine } = require('./engine');
const { providerOf, DEFAULT_PROVIDER } = require('./backends');
const park = require('./park');
const project = require('./project');
const health = require('./health');

const isWorker = store.isWorker; // every account but the leader, and the leader too when it takes jobs
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_WAIT_SEC = Number(process.env.RELAY_MAX_WAIT || 120); // never leave the dispatcher hanging for hours
// How long a job waits for another job in the same folder before answering BUSY (read per call: tests shorten it).
const queueWaitSec = () => Number(process.env.RELAY_QUEUE_WAIT_SEC || 1800);
const QUEUE_POLL_MS = 500;
const WAIT_REPORT_MS = 4000;
// How often a job looks for other jobs writing in its folder while it runs (read per call: tests shorten it).
const shareSampleMs = () => Number(process.env.RELAY_SHARE_SAMPLE_MS || 2000);
const within = (p, root) => { const a = path.resolve(p); const r = path.resolve(root); return a === r || a.startsWith(r + path.sep); };

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
async function waitForFolder(cwd, thread, { signal, onWait, scopes = null, legacy = true, waitSec = queueWaitSec() }) {
  const me = { scopes };
  const ticket = memory.joinQueue(cwd, { thread, scopes });
  const deadline = Date.now() + waitSec * 1000; // waitSec Infinity: a background job waits as long as it takes
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
// `here`: only what is inside cwd (the read-only guard: other workers may change other parts of the same repository).
function gitState(cwd, here = false) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain', '-unormal', ...(here ? ['--', '.'] : [])], { timeout: 15000, windowsHide: true, maxBuffer: 8e6 }, (err, out) => {
      resolve(err ? null : new Set(String(out).split('\n').map((l) => l.trimEnd()).filter(Boolean)));
    });
  });
}
// cwd's path inside its git repository ("" at the top, "sub/dir/" below it); null = not a git project.
function gitPrefix(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-prefix'], { timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}
// A `git status --porcelain` path (relative to the repository's top) as an absolute path in cwd's spelling.
function gitPathAbs(cwd, prefix, rel) {
  const r = String(rel).includes(' -> ') ? String(rel).split(' -> ').pop() : String(rel);
  const p = prefix ? path.posix.relative(path.posix.join('/', prefix), path.posix.join('/', r)) : r;
  return path.join(path.resolve(cwd), p) + (r.endsWith('/') ? path.sep : '');
}

// isolated: an independent review or audit; the worker gets no project ledger (no other workers' results).
// hidePaths / writePaths / protectedPaths / outputFile: the job's path rules, told to the worker (Relay enforces them).
const ISOLATED_NOTE = 'This is an ISOLATED job (an independent review or audit): Relay gives you no project ledger and no results or conclusions of other workers, and you must not look for them (not in Relay\'s files either). Form your own judgment from the material itself.';
// handoff: { note, n } when this is the first prompt of a new session that continues a thread whose context was full.
function buildPrompt({ task, context, ledger, resumed, scopes = null, isolated = false, readOnly = false, hidePaths = null, writePaths = null, protectedPaths = null, outputFile = '', handoff = null }) {
  const limit = readOnly
    ? `This job is READ-ONLY: do not create, change or delete any file in the project, neither with edit tools (they are disabled) nor with shell commands (no redirects, no python or other scripts that write)${outputFile ? '; Relay writes the report file itself' : ''}. Put scratch files, if you need any, in a temporary folder outside the project. Relay compares the folder before and after the job and flags any change as READ_ONLY_VIOLATED.`
    : writePaths && writePaths.length
    ? `You may create or change files ONLY under: ${writePaths.join(', ')} (relative to the current folder). Edits anywhere else are refused, and any change outside these paths (also by a shell command) makes Relay fail the job.`
    : scopes && scopes.length
      ? `Only create or change files inside: ${scopes.join(', ')} (relative to the current folder). Other workers may be changing other parts of this project at the same time.`
      : '';
  const rules = [
    limit,
    hidePaths && hidePaths.length ? `These paths are OFF-LIMITS for this job: ${hidePaths.join(', ')} (relative to the current folder). Do not read, open, search, list or quote them in any way, also not with shell commands. Relay checks the job's tool calls afterwards and reports any access as an isolation breach. Shell commands run in a sandbox that cannot read them; in it, HTTP(S) works but ssh and other direct network connections do not, and files can only be written inside the current folder.` : '',
    protectedPaths && protectedPaths.length ? `Protected by the project's rules, never change, move or delete: ${protectedPaths.join(', ')}. A change there makes Relay fail the job.` : '',
    outputFile ? `Relay saves your final report to ${outputFile} itself when you finish: do not write that file yourself; put the complete content (Markdown) in your final reply.` : '',
  ].filter(Boolean);
  if (resumed) {
    return [
      'Follow-up from the dispatcher on this same thread (you keep all your earlier context):',
      '',
      task,
      ...rules.map((r) => `\n${r}`),
      context ? `\nExtra background:\n${context}` : '',
      isolated ? `\n${ISOLATED_NOTE}` : ledger ? `\nWhile you were away, other workers did this in the same project:\n${ledger}` : '',
      '\nFinish with a short report: what you did, files changed, how you verified, open issues.',
      `\n${project.SUMMARY_INSTRUCTIONS}`,
      `\n${park.INSTRUCTIONS}`,
    ].filter((x) => x !== '').join('\n');
  }
  return [
    'You are a worker agent dispatched by Relay for another Claude session (the "dispatcher") that talks to the user.',
    'You cannot see their conversation: everything you need is below. Work in the current folder.',
    '',
    ...(handoff ? [
      `## Handoff from this thread's previous session (handoff ${handoff.n})`,
      'The previous worker session on this line of work ran out of context, so you continue its work in a new session. Its handoff note:',
      '',
      handoff.note,
      '',
      'Trust the note for what was done and decided; check the current state of files and runs yourself before relying on it.',
      '',
    ] : []),
    '## Task',
    task,
    '',
    '## Background from the dispatcher',
    context || '(none given: read the project files and CLAUDE.md to orient yourself)',
    '',
    ...(isolated ? ['## Independence', ISOLATED_NOTE] : ['## Project ledger: what earlier workers already did here (oldest first)', ledger || '(nothing yet)']),
    '',
    '## How to work',
    ...rules.map((r) => `- ${r}`),
    '- Do the whole task. Do not stop to ask questions unless you are truly blocked; state your assumptions instead.',
    '- Do not delegate further. If a command or edit is refused by permissions, say exactly what was refused.',
    '- Finish with a short report the dispatcher will read: what you did, files changed, how you verified, open issues or follow-ups.',
    project.SUMMARY_INSTRUCTIONS,
    park.INSTRUCTIONS,
  ].join('\n');
}

// A list of paths relative to cwd (globs allowed), cleaned: { list } or { error }.
function cleanPathList(raw, what) {
  if (raw == null || raw === '') return { list: [] };
  const arr = Array.isArray(raw) ? raw : [raw];
  if (arr.length > 100) return { error: `${what}: at most 100 paths.` };
  const out = [];
  for (const x of arr) {
    if (typeof x !== 'string') return { error: `${what} must be a list of paths relative to cwd.` };
    const c = project.cleanPattern(x, what);
    if (c.error) return { error: c.error };
    if (!out.includes(c.pattern)) out.push(c.pattern);
  }
  return { list: out };
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

// A read-only Codex job must leave its folder exactly as it was. What is compared: `git status`, and the size and
// modification time of every file (git's tracked and untracked files, or a walk that leaves out ignored files: see
// project.listFiles). Returns { files: Map(path -> "size:mtime"), complete, info } (info: how the list was made; two
// fingerprints made differently are not compared file by file) or null when the folder is unreadable.
const { listFiles } = project;
async function folderFingerprint(cwd, opts = {}) {
  try {
    const { names, complete, git, ...info } = await listFiles(cwd, opts);
    const files = new Map();
    for (const n of names) {
      try { const st = fs.lstatSync(path.join(cwd, n)); files.set(n, `${st.size}:${st.mtimeMs}`); } catch { files.set(n, 'missing'); }
    }
    if (git) for (const n of ['.git/HEAD', '.git/packed-refs']) { try { const st = fs.statSync(path.join(cwd, n)); files.set(n, `${st.size}:${st.mtimeMs}`); } catch { /* none */ } }
    const status = await gitState(cwd, true);
    const hash = require('crypto').createHash('sha256').update([...files].sort().map(([k, v]) => `${k}\0${v}`).join('\n')).update(status ? [...status].sort().join('\n') : '').digest('hex');
    return { files, status, hash, complete, info: { ...info, git } };
  } catch {
    return null;
  }
}
function fingerprintDiff(before, after) {
  if (!before || !after) return ['the folder could not be fingerprinted'];
  if (before.hash === after.hash) return [];
  const changed = [];
  for (const [k, v] of after.files) if (before.files.get(k) !== v) changed.push(before.files.has(k) ? `changed ${k}` : `added ${k}`);
  for (const k of before.files.keys()) if (!after.files.has(k)) changed.push(`removed ${k}`);
  const sb = before.status || new Set();
  const sa = after.status || new Set();
  for (const l of sa) if (!sb.has(l)) changed.push(`git status: ${l}`);
  for (const l of sb) if (!sa.has(l)) changed.push(`git status no longer: ${l}`);
  return changed.length ? changed : ['the folder fingerprint changed'];
}

const AGENTS = ['claude', 'codex'];

// ---- context handoff ----
// A thread whose session is nearly out of context (at least `handoffAt` of its window at the end of its last run) or
// that fails with the context-limit error continues in a new session: the old one is asked for a handoff note first.
const HANDOFF_PROMPT = [
  'RELAY_HANDOFF: this session\'s context is (nearly) full. Relay will continue this line of work in a NEW session that cannot see this one.',
  'Do no more work and call no tools. Write a handoff note for the worker who takes over, in Markdown, with exactly these sections:',
  '## Goal', '## Decisions made', '## State of files and runs (what changed, what is committed, what is running and where its logs and results are)',
  '## Open issues', '## Next step',
  'Be concrete: paths, commands, run ids, numbers. Reply with the note only.',
].join('\n');
const pctOf = (at, defWindow) => (at && at.tokens ? `${Math.round((100 * at.tokens) / (at.window || defWindow))}% (${Math.round(at.tokens / 1000)}k of ${Math.round((at.window || defWindow) / 1000)}k tokens)` : '?');
const handoffDir = (cwd) => path.join(store.home(), '.relay-handoff', path.basename(memory.projectDir(cwd)));
// <home>/.relay-handoff/<project>/<thread>-<n>.md (never in the project folder). Returns the path.
function saveHandoffNote(cwd, name, n, note) {
  const safe = String(name || 'thread').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'thread';
  const f = path.join(handoffDir(cwd), `${safe}-${n}.md`);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    require('./fslock').writeFileAtomic(f, `${note.replace(/\s+$/, '')}\n`);
  } catch { /* the note still goes into the new session's prompt */ }
  return f;
}
// When the old session cannot write a note (its context is already full): one from what Relay kept about the thread.
function fallbackNote({ cwd, thread, task, existing, wake, items = [], files, commands, sid, why = '' }) {
  const entries = memory.readLedger(cwd).filter((e) => (thread ? e.thread === thread : false)).slice(-8);
  const texts = items.filter((i) => i.kind === 'text').slice(-3).map((i) => clip(i.text.trim(), 1500));
  return [
    `# Handoff note (built by Relay: ${why || 'the previous session could not write one'})`,
    `Previous session: ${sid || '?'}${thread ? ` · thread "${thread}"` : ''}`,
    '', '## Goal (the task as last given)', clip(String(task || '').trim(), 4000),
    ...(existing && existing.lastSummary ? ['', '## Last result Relay recorded for this thread', clip(existing.lastSummary, 2000)] : []),
    ...(wake && wake.report ? ['', '## The job\'s latest report before this check', clip(wake.report, 3000)] : []),
    ...(entries.length ? ['', '## Ledger entries of this thread (oldest first)', ...entries.map((e) => `- ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.ok === false ? '(not finished) ' : ''}${clip(e.summary || e.title || '', 800)}${e.files && e.files.length ? ` Files: ${e.files.slice(0, 20).join(', ')}` : ''}`)] : []),
    ...(files && files.size ? ['', '## Files touched in the previous session\'s last run', [...files].slice(0, 50).join(', ')] : []),
    ...(commands && commands.length ? ['', '## Commands it ran', commands.slice(-10).map((c) => `- ${clip(c, 160)}`).join('\n')] : []),
    ...(texts.length ? ['', '## Its last messages', ...texts] : []),
    '', '## Next step', 'Check the current state of the files and runs above, then continue the task.',
  ].join('\n');
}

// The worker's report, from the texts, tool calls and turn ends ('result') of its final run, in order. Not simply the
// last text: when a background task the worker started finishes after its report, `claude -p` gives the session a
// task notification and runs one more turn in the same process (a second init, text and result), and taking only that
// turn's short note lost the report. The report is the last text with a relay-summary block; with none, the longest
// text that ended a turn (one not followed by a tool call), else the last text. Texts after it follow under a
// "Postscript" heading.
const SUMMARY_RE = /```[ \t]*relay-summary/;
function pickReport(items) {
  const seq = (items || []).filter((i) => i && (i.kind === 'text' || i.kind === 'tool' || i.kind === 'result'));
  const texts = [];
  seq.forEach((it, k) => { if (it.kind === 'text' && String(it.text || '').trim()) texts.push({ k, text: String(it.text), ends: !(seq[k + 1] && seq[k + 1].kind === 'tool') }); });
  if (!texts.length) return { text: '', main: '', postscript: [] };
  let main = [...texts].reverse().find((t) => SUMMARY_RE.test(t.text));
  if (!main) {
    const ends = texts.filter((t) => t.ends);
    main = ends.length ? ends.reduce((a, b) => (b.text.trim().length >= a.text.trim().length ? b : a)) : texts[texts.length - 1];
  }
  const postscript = texts.filter((t) => t.k > main.k).map((t) => t.text.trim());
  return { main: main.text, postscript, text: withPostscript(main.text, postscript) };
}
const withPostscript = (main, ps) => (ps.length ? `${String(main).replace(/\s+$/, '')}\n\n## Postscript\n\n(The worker wrote this after its report.)\n\n${ps.join('\n\n')}` : String(main));

// The flags a job's post check results raise, and the note for CHECKS_INCOMPLETE (time cap, or more matching files
// than one check runs on): { flags, note }.
function checkFlags(checks, capSec) {
  const flags = [];
  const notes = [];
  if (checks.some((c) => !c.ok && !c.skipped)) flags.push('CHECKS_FAILED');
  const capped = checks.filter((c) => c.capped);
  const tooMany = checks.filter((c) => c.incomplete);
  if (capped.length || tooMany.length) flags.push('CHECKS_INCOMPLETE');
  if (capped.length) {
    const notRun = capped.filter((c) => c.notRun).length;
    notes.push(`Post checks hit Relay's time cap (postChecksMaxSec, ${capSec} s for all of a job's checks): ${capped.length - notRun} stopped, ${notRun} not run.`);
  }
  if (tooMany.length) notes.push(`${tooMany.map((c) => `${c.name}: ${c.skipped}`).join('; ')}.`);
  const note = notes.length ? `${notes.join(' ')} The job is flagged CHECKS_INCOMPLETE (not CHECKS_FAILED): run the missing checks yourself.` : '';
  return { flags, note };
}

async function runWorker({
  task, context = '', cwd, thread = '', readOnly = false, model = '', effort = '', title = '', account = '', scope = null, preset = '', agent = '',
  isolated = false, hidePaths = null, writePaths = null, outputFile = '', overwrite = false, priority = '',
  onProgress = () => {}, signal = null, validateOnly = false, wake = null, jobId = '', background = false,
}) {
  if (!task || !String(task).trim()) return { ok: false, code: 'bad_request', text: 'relay_run needs a task.' };
  const wantAgent = String(agent || '').trim().toLowerCase();
  if (wantAgent && !AGENTS.includes(wantAgent)) return { ok: false, code: 'bad_request', text: `agent must be one of ${AGENTS.join(', ')} (got: ${String(agent).slice(0, 40)}).` };
  const cleaned = store.cleanModel(model);
  if (cleaned === null) return { ok: false, code: 'bad_request', text: `model must be a model alias or id such as "haiku" or "claude-haiku-5-5" (got: ${String(model).slice(0, 40)}).` };
  model = cleaned;
  const level = store.cleanEffort(effort);
  if (level === null) return { ok: false, code: 'bad_request', text: `effort must be one of ${store.EFFORTS.join(', ')} (got: ${String(effort).slice(0, 40)}).` };
  effort = level;
  const prio = store.cleanPriority(priority);
  if (prio === null) return { ok: false, code: 'bad_request', text: `priority must be one of ${store.PRIORITIES.join(', ')} (got: ${String(priority).slice(0, 40)}).` };
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return { ok: false, code: 'bad_request', text: `cwd must be an existing absolute folder path (got: ${cwd || 'nothing'}).` };

  // A thread continues on the provider it started on (its session only exists in that CLI's format); a new job runs
  // on the agent asked for, Claude by default.
  const prior = thread ? memory.getThread(cwd, thread) : null;
  // A scheduled wake of a parked job continues its own session, on the provider it ran on.
  const provider = wake && wake.provider ? wake.provider : prior ? providerOf(prior) : wantAgent || DEFAULT_PROVIDER;
  if (prior && wantAgent && wantAgent !== provider && !wake) {
    return { ok: false, code: 'bad_request', text: `Thread "${thread}" runs on ${provider}; it cannot continue on ${wantAgent}. Use another thread name for a ${wantAgent} job.` };
  }
  const codex = provider === 'codex';
  if (codex && !readOnly) {
    return { ok: false, code: 'bad_request', text: 'Codex workers only take read-only jobs: pass read_only: true (reviews, audits, investigation). Nothing was started.' };
  }
  if (codex && model && require('./backends').getBackend('codex').isClaudeModel(model)) {
    return { ok: false, code: 'bad_request', text: `"${model}" is a Claude model; for a Codex job omit model (the account's own is used) or give a Codex model id.` };
  }
  const workers = store.load().filter((a) => isWorker(a) && !a.needsLogin && providerOf(a) === provider);
  if (!workers.length) {
    if (codex) return { ok: false, code: 'no_workers', text: 'NO_WORKER_AVAILABLE: Relay has no Codex account signed in (add one with `relay add-codex <name> <codexHome> --model <id>`). Nothing was started.' };
    if (store.load().some((a) => a.desktop && !a.needsLogin && providerOf(a) === provider)) return { ok: false, code: 'no_workers', text: 'NO_WORKER_AVAILABLE: Relay has no worker accounts signed in, and the leader account (this window) does not take jobs (its switch "Leader takes jobs too" in Relay\'s panel is off). Do the work yourself, or ask the user to add another account or turn that switch on.' };
    return { ok: false, code: 'no_workers', text: 'NO_WORKER_AVAILABLE: Relay has no worker accounts signed in (the leader account is this window). Do the work yourself, or ask the user to add another account in Relay.' };
  }

  const sc = cleanScopes(cwd, scope);
  if (sc.error) return { ok: false, code: 'bad_request', text: sc.error };
  const bad = (text) => ({ ok: false, code: 'bad_request', text });
  // The project's own rules: .relay/project.json in cwd or a parent up to the git root (core/project.js).
  const pc = project.loadConfig(cwd);
  if (pc.error) return bad(pc.error);
  const config = pc.config;
  // require_scope: in this project every job that may change files names what it changes (scope, or write_paths /
  // output_file, which say it too). A scheduled wake continues a job that was accepted when it started.
  const named = (v) => (Array.isArray(v) ? v : [v]).some((x) => x != null && String(x).trim() !== '');
  if (config.requireScope && !readOnly && !wake && !named(scope) && !named(writePaths) && !named(outputFile)) {
    return bad(`This project requires a scope for every job that may change files (require_scope in ${config.file}). Pass scope (the folders this job changes, relative to cwd, e.g. ["src/auth"]), or write_paths, or output_file; or read_only: true for a job that changes nothing. Nothing was started.`);
  }
  // ...and a scope that is the whole folder after all ("." , cwd itself, the git root) names nothing: refused.
  if (config.requireScope && !wake && named(scope)) {
    const here = path.resolve(cwd);
    const top = project.gitRoot(cwd);
    const whole = (Array.isArray(scope) ? scope : [scope]).map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
      .filter((x) => { const abs = path.resolve(here, x); return abs === here || (!!top && abs === top); });
    if (whole.length) {
      return bad(`This project requires a scope (require_scope in ${config.file}), and scope ${whole.map((x) => JSON.stringify(x)).join(', ')} is the whole folder (cwd${top && top === here ? ', the git root' : ''}), which names nothing. List the specific folders this job changes instead (relative to cwd, e.g. ["ideas/gamma", "portfolio/reports"]). Nothing was started.`);
    }
  }
  const isolatedJob = !!isolated;
  // An isolated job sees no other worker's results: it may only continue a thread that is its own isolated line.
  if (isolatedJob && prior && !prior.isolated && !wake) {
    return bad(`Thread "${thread}" already has history from a job that was not isolated, so an isolated job cannot continue it (that history may hold other workers' results). Use a new thread name, or omit thread.`);
  }
  const hp = cleanPathList(hidePaths, 'hide_paths');
  if (hp.error) return bad(hp.error);
  const wp = cleanPathList(writePaths, 'write_paths');
  if (wp.error) return bad(wp.error);
  // An isolated job also hides the project's isolated_hide_paths (those under cwd join its hide_paths; those outside
  // cwd are only denied).
  const isoHide = isolatedJob ? project.isolatedHideFor(config, cwd) : { inCwd: [], outside: [] };
  const hide = [...new Set([...hp.list, ...isoHide.inCwd])];
  const writeOnly = wp.list;
  if (writeOnly.length) {
    if (codex) return bad('write_paths is not available for agent "codex": Codex workers only run read-only jobs. To keep a Codex review as a file, pass output_file instead: Relay writes the report there itself.');
    if (readOnly) return bad('write_paths and read_only exclude each other: read_only changes nothing; write_paths lets the worker change files only under those paths. Pass one of them.');
    for (const w of writeOnly) {
      const rel = path.relative(config.root || cwd, path.join(cwd, w)).split(path.sep).join('/');
      const hit = config.protected.find((p) => !p.appendOnly && project.matchPath(p.pattern, rel));
      if (hit) return bad(`write_paths ${w} is protected by the project config (${hit.pattern} in ${config.file}); no job may write there.`);
    }
  }
  if (overwrite && !outputFile) return bad('overwrite only applies together with output_file.');
  let out = null;
  if (outputFile !== '' && outputFile != null) {
    out = project.checkOutputFile(cwd, outputFile, { overwrite: !!overwrite, config, skipExists: !!wake });
    if (out.error) return bad(out.error);
  }
  // A task preset (Settings › Task presets): for this project's folder, asked for by name, or applied because the job's
  // text matches its keywords.
  const chosen = store.choosePreset(preset, [title, task, context].join('\n'), cwd);
  if (chosen.error) return { ok: false, code: 'bad_request', text: chosen.error };
  const usedPresets = chosen.presets || (chosen.preset ? [chosen.preset] : []);
  // A write-limited job without its own scope locks the folders it may write (so other jobs there wait for it).
  let scopes = sc.scopes;
  if (!scopes && writeOnly.length && (scope == null || (Array.isArray(scope) && !scope.length) || scope === '')) {
    const prefixes = writeOnly.map(project.literalPrefix);
    scopes = prefixes.some((x) => !x) ? null : [...new Set(prefixes.map((x) => path.resolve(cwd, x)))];
  }
  // Worker health (core/health.js): a worker that refused a command this job names, or has not trusted the project, at
  // its last health check is skipped while a healthy one exists; with none, the job runs with a warning.
  let pinned = null;
  if (account) {
    const want = String(account).trim().toLowerCase();
    const same = (w) => w.name.toLowerCase() === want || (w.email || '').toLowerCase() === want;
    pinned = workers.find(same) || null;
    // the leader is named but does not take jobs: refused (it never runs a job while its switch is off)
    if (!pinned && !wake) {
      const lead = store.load().find((w) => w.desktop && same(w));
      if (lead) return bad(`${label(lead)} is the leader account (this window) and does not take jobs: its switch "Leader takes jobs too" in Relay's panel is off. Omit account to let Relay pick a worker, or name a worker. Nothing was started.`);
    }
  }
  let hc = { avoid: new Set(), warning: '', note: '' };
  if (!codex && config.healthChecks.length) {
    try { hc = health.choose({ cwd, config, text: [title, task, context].join('\n'), workers }); } catch { /* no health records: nothing to avoid */ }
    if (pinned && hc.avoid.has(pinned.name)) {
      hc = { ...hc, avoid: new Set(), note: '', warning: `HEALTH WARNING: the account asked for (${label(pinned)}) failed its last health check for this job (${hc.note.replace(/^health: not on /, '')}); it runs there anyway as asked.` };
    }
  }
  // relay_start: the request is checked exactly as relay_run checks it, then runs later in a background process.
  if (validateOnly) return { ok: true, code: 'valid', provider, priority: prio, healthWarning: hc.warning || '', thread: thread || '', title: clip(String(title || '').replace(/\s+/g, ' ').trim(), 60) || deriveTitle(task) };

  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const given = clip(String(title || '').replace(/\s+/g, ' ').trim(), 60);
  const ledgerTitle = given || clip(task, 120);
  const run = { provider, priority: prio, preset: usedPresets.length ? usedPresets.map((p) => p.name).join(', ') : null, project: path.basename(cwd) || cwd, cwd, scopes: scopes ? scopes.map((s) => path.relative(cwd, s)) : null, thread: thread || '', title: given || deriveTitle(task), kind: 'worker', status: 'running', account: null, lastLine: '', startedAt: Date.now(), writes: !readOnly || !!out };
  const tick = () => memory.writeRun(runId, { ...run, updatedAt: Date.now() });

  // Several jobs share one project folder: a job only waits for another when both named the files they change
  // (scope) and those overlap, or when Settings asks for one job per folder (then a job without scope takes the whole
  // folder, as before). A read-only job changes nothing, so it never waits and never makes anyone else wait. The
  // waiting shows in the panel and, every few seconds, as progress to the dispatcher, which keeps its call alive.
  const settings = store.loadSettings();
  const folderLock = settings.folderLock === true;
  let reported = 0;
  const needsLock = !readOnly && (folderLock || !!scopes);
  // A background job (relay_start, a parked job's wake, a job from the panel) waits for its folder and for a worker as
  // long as it takes, or Settings' backgroundMaxWaitMin; relay_run blocks its window, so it gives up after 30 minutes.
  const waitSec = background ? store.backgroundWaitSec(settings) : queueWaitSec();
  const got = !needsLock ? { lock: { release: () => {} } } : await waitForFolder(cwd, thread || '(one-off)', {
    signal, scopes, legacy: folderLock, waitSec,
    onWait: (holder, ahead) => {
      run.status = 'waiting';
      run.lastLine = `Waiting for another worker changing the same files (thread ${holder.thread || '?'})…${ahead ? ` #${ahead + 1} in line for this folder.` : ''}`;
      run.folderPos = ahead + 1;
      tick();
      if (Date.now() - reported >= WAIT_REPORT_MS) { reported = Date.now(); onProgress(run.lastLine); }
    },
  });
  if (!got.lock) {
    memory.removeRun(runId);
    if (got.cancelled) return { ok: false, code: 'cancelled', text: 'Cancelled while waiting for the folder; nothing was started.' };
    const sec = waitSec;
    return { ok: false, code: 'busy', text: `BUSY: another Relay worker (thread "${got.busy.thread || '?'}") is still changing the same files after waiting ${sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`}. Wait for it, work on something else, or give jobs on different parts of the project their own \`scope\`.` };
  }
  const lock = got.lock;
  run.status = 'running';
  run.lastLine = '';
  // The job's own area (scope folders, write_paths, the output_file's folder): what changes there, or in a file its own
  // edit tool calls named, is its own; other changes in the folder are concurrent changes by other jobs. null = no
  // scope: every change in the folder counts as its own, as before.
  const area = project.ownArea({ cwd, scopes, writePaths: writeOnly, outputFile: out ? out.rel : '' });
  // Other jobs that may write and ran in the same folder while this one ran (sampled from their run files).
  const sharedWith = new Map();
  const sameFolder = (c) => !!c && (within(c, cwd) || within(cwd, c) || (!!config.root && within(c, config.root) && within(cwd, config.root)));
  const noteShared = () => {
    try {
      for (const r of memory.listRuns()) if (r.id !== runId && r.status === 'running' && r.writes !== false && sameFolder(r.cwd)) sharedWith.set(r.id, r.thread || r.title || r.id);
    } catch { /* the next sample */ }
  };
  let shareTimer = null;

  let engine = null;
  const files = new Set();
  const commands = [];
  const toolCalls = []; // { name, id, input }: checked against hide_paths after the run
  const failedTools = new Set(); // tool call ids whose result was an error (e.g. refused by a deny rule)
  let noteItems = []; // the same for the handoff note call
  let runItems = []; // the texts and tool calls of the latest work run (the report is picked from them)
  let snapBefore = null;
  // Why a folder file list could not be made by git (also written to the job log), for the record.
  const folderLog = [];
  const fpLog = (m) => {
    if (folderLog.length < 20) folderLog.push(m);
    try { console.error(`[relay ${new Date().toISOString()}] ${m}`); } catch { /* no log */ }
  };
  let modelUsed = '';
  let gitBefore = null;
  let fpBefore = null;
  let preflight = null;
  // Context handoff state: how full the session is, the chain of sessions this thread had, the handoffs made now.
  const hs = store.loadSettings();
  const handoffAt = Number(hs.handoffAt) > 0 && Number(hs.handoffAt) <= 1 ? Number(hs.handoffAt) : 0.7;
  const ctxDefaultWindow = Number(hs.contextWindow) > 0 ? Number(hs.contextWindow) : 200000;
  let ctx = { tokens: null, window: null };
  let phase = 'work';
  let noteText = '';
  let handoffDue = null;
  let handoffNote = null;
  let freshPrompt = null;
  let sessions = [];
  let handoffs = 0;
  const handed = [];
  const carriedLog = []; // sessions Relay copied to the account that resumed them (core/sessions.js)
  let lostWhy = '';
  let firstReserveAt = null; // when the engine first got a worker account (a wake's wait for a worker)
  const onAbort = () => { if (engine) engine.stop(); };
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    const existing = thread ? memory.getThread(cwd, thread) : null; // re-read: a job ahead in the queue may have moved it on
    engine = new Engine();
    engine.filter = hc.avoid.size ? (a) => isWorker(a) && !hc.avoid.has(a.name) : isWorker;
    engine.provider = provider; // failover stays on accounts of this provider
    engine.priority = prio; // who gets a freed worker slot first (a parked job's wake keeps its job's priority)
    engine.maxWait = MAX_WAIT_SEC;
    // Jobs per worker at once (Settings, never more than 3): with every worker full, the job waits for a free slot.
    engine.maxPerAccount = store.jobsPerWorker(settings);
    engine.busyWaitSec = waitSec;
    // Run on this worker (by name or e-mail): while it is ready but full, the job waits for a slot there; while it is
    // limited or signed out, Relay picks another one.
    if (pinned) { engine.account = pinned.name; engine.pinned = pinned.name; }
    engine.model = model; // asked for in this call: wins over the account's default model
    engine.useAccountModel = true; // otherwise each worker account runs on the model chosen for it in Relay
    engine.effort = effort; // asked for in this call; '' leaves it to the project's or account's own settings
    // a pinned account wins over the account the thread last ran on (the session is carried there)
    if (existing?.sessionId) { engine.sessionId = existing.sessionId; engine.account = pinned ? pinned.name : existing.account || null; }
    if (wake) {
      // A parked job's scheduled check: the same session, preferably on the account it ran on (if that one is busy
      // or limited, the normal pick chooses another ready one). A Codex session cannot move between accounts.
      engine.sessionId = wake.sessionId;
      engine.account = wake.account || null;
      if (codex && wake.account) engine.filter = (a) => isWorker(a) && a.name === wake.account;
    }

    const promptBase = {
      context: String(context || ''), scopes: run.scopes,
      isolated: isolatedJob, readOnly: !!readOnly, hidePaths: hide, writePaths: writeOnly, outputFile: out ? out.rel : '',
      protectedPaths: readOnly ? null : config.protected.map((p) => `${p.pattern}${p.appendOnly ? ' (new files may be added)' : ''}`),
    };
    const prompt = wake ? park.wakePrompt(wake.n || 1, { manual: !!wake.manual }) : buildPrompt({
      ...promptBase, task: String(task), resumed: !!existing?.sessionId,
      // an isolated job gets no ledger at all: not even what other threads did meanwhile
      ledger: isolatedJob ? '' : memory.ledgerText(cwd, existing ? { sinceMs: existing.updatedAt, excludeThread: thread } : {}),
    });
    // The first prompt of a new session that takes over from a full one: the handoff note, then the task (a wake: the
    // scheduled check, with the job's original task for reference).
    freshPrompt = (h) => buildPrompt({
      ...promptBase, resumed: false, handoff: h,
      task: wake ? `${park.wakePrompt(wake.n || 1, { manual: !!wake.manual })}\n\nThe job's original task, for reference:\n${task}` : String(task),
      ledger: isolatedJob ? '' : memory.ledgerText(cwd, {}),
    });
    // Context handoff: how full the session it continues was at the end of its last run.
    const src = wake || existing || {};
    sessions = Array.isArray(src.sessions) ? [...src.sessions] : [];
    handoffs = Number(src.handoffs) || 0;
    const priorCtx = src.context && src.context.sessionId && src.context.sessionId === engine.sessionId ? src.context : null;
    if (priorCtx && engine.sessionId && priorCtx.tokens / (priorCtx.window || ctxDefaultWindow) >= handoffAt) handoffDue = priorCtx;
    if (wake) run.lastLine = `${wake.manual ? 'Progress check' : 'Scheduled check'} (wake ${wake.n || 1})…`;

    noteShared();
    shareTimer = setInterval(noteShared, shareSampleMs());
    if (shareTimer.unref) shareTimer.unref();
    gitBefore = await gitState(cwd);
    if (codex) fpBefore = await folderFingerprint(cwd, { log: fpLog });
    // What changed is needed for write_paths, protected paths (write jobs) and the post checks.
    // A read-only Claude job: to see whether it changed the folder anyway (an allowed shell command can write).
    if (writeOnly.length || (!readOnly && config.protected.length) || (config.postChecks.length && (!readOnly || out)) || (readOnly && !codex)) snapBefore = await project.snapshot(cwd, config, { log: fpLog });
    engine.on('preflight', (p) => { preflight = p; });
    engine.on('carried', (c) => { if (carriedLog.length < 20) carriedLog.push(c); });
    tick();
    // Recorded while the account is chosen (under the cross-process pick lock), so other windows choosing at the
    // same moment already count this run against that account.
    engine.onReserve = (a) => { run.account = a.name; if (!firstReserveAt) firstReserveAt = Date.now(); tick(); };
    engine.on('state', (st) => {
      run.account = st.status === 'waiting' && st.waitingFor === 'worker' ? null : st.account;
      run.status = st.status === 'waiting' ? 'waiting' : 'running';
      run.waitingUntil = st.waitingUntil;
      if (st.waitingFor === 'worker') {
        run.queuePos = st.queuePos || null;
        run.lastLine = `Waiting for a free worker: every worker is busy with another job…${st.queuePos ? ` #${st.queuePos} in line (priority ${prio}).` : ''}`;
        if (Date.now() - reported >= WAIT_REPORT_MS) { reported = Date.now(); onProgress(run.lastLine); }
      }
      tick();
    });
    engine.on('item', (it) => {
      if (it.kind === 'context') {
        if (phase !== 'work') return; // the handoff note call's numbers belong to the old session
        if (it.tokens) ctx.tokens = it.tokens;
        if (it.window) ctx.window = (it.windows && modelUsed && it.windows[modelUsed]) || it.window; // the session's model, else the largest
        return;
      }
      if (phase !== 'work') { if (it.kind === 'text' || it.kind === 'tool') { noteItems.push({ kind: it.kind, text: it.text || '' }); noteText = pickReport(noteItems).text; } return; }
      if (it.kind === 'init' && it.model) { modelUsed = it.model; run.model = it.model; }
      if (it.kind === 'tool_result' && it.error && it.id) failedTools.add(it.id);
      if ((it.kind === 'text' || it.kind === 'tool' || it.kind === 'result') && runItems.length < 50000) runItems.push({ kind: it.kind, text: it.kind === 'text' ? it.text : '' });
      if (it.kind === 'tool') {
        if (toolCalls.length < 20000) toolCalls.push({ name: it.name, id: it.id || null, input: it.input || {} });
        run.lastLine = `${it.name} ${it.summary}`;
        if (EDIT_TOOLS.has(it.name) && it.summary) files.add(it.summary);
        if (it.name === 'Bash' && it.summary) commands.push(it.summary);
        onProgress(run.lastLine);
      } else if (it.kind === 'text') {
        run.lastLine = it.text.replace(/\s+/g, ' ').slice(0, 140);
      }
      tick();
    });

    // Permissions. write_paths: Claude Code's "default" mode, where only what is allowed may edit: Edit/Write rules for
    // those paths, plus the commands Settings allows. hide_paths: Read deny rules (Claude) or deny entries in the
    // sandbox profile (Codex). Protected paths: Edit/Write deny rules for every job that may write.
    const now = store.loadSettings();
    const allowedTools = store.cleanAllowedTools(now.allowedTools).rules;
    const deniedTools = store.cleanAllowedTools(now.deniedTools).rules;
    // Hidden paths as absolute paths (globs expanded to files) for the backend's sandbox: Codex's read-deny profile, and
    // for Claude the bash sandbox's filesystem.denyRead. Read deny rules alone do not stop shell commands: a live probe
    // (Claude Code 2.1.32x, auto mode) showed `grep -r TOKEN .` printing hidden files while Read was refused.
    let hiddenAbs = hide.flatMap((h) => (project.hasGlob(h) ? project.expandPattern(cwd, h, { limit: 2000 }) : [path.join(cwd, h)]));
    // isolated_hide_paths outside cwd: denied the same way, relative to the project root
    for (const h of isoHide.outside) {
      hiddenAbs.push(...(project.hasGlob(h) ? project.expandPattern(config.root, h, { limit: 2000 }) : [path.join(config.root, h)]));
      if (!codex) deniedTools.push(...project.pathRules('Read', config.root, h));
    }
    if (!codex) {
      for (const w of writeOnly) allowedTools.push(...project.pathRules('Edit', cwd, w), ...project.pathRules('Write', cwd, w));
      for (const h of hide) deniedTools.push(...project.pathRules('Read', cwd, h));
      if (isolatedJob) {
        for (const d of ['projects', 'jobs', '.relay-handoff']) {
          deniedTools.push(project.absRule('Read', path.join(store.home(), d, '**')));
          hiddenAbs.push(path.join(store.home(), d));
        }
        // the repository's git data and every account's auto memory folders (core/project.js isolationDenies)
        const configDirs = [...store.load().map((a) => a.configDir), path.join(os.homedir(), '.claude')];
        // the session it continues (a thread, a wake) keeps its own folder readable (saved tool outputs)
        const iso = project.isolationDenies({ cwd, configDirs, ownSessions: [engine.sessionId].filter(Boolean) });
        deniedTools.push(...iso.rules);
        hiddenAbs.push(...iso.abs);
      }
      // its own saved large tool outputs stay readable with the Read tool (outside cwd it would ask, and be refused)
      allowedTools.push(...project.ownToolResultsRules({ cwd, configDirs: [...store.load().filter((a) => providerOf(a) !== 'codex').map((a) => a.configDir), path.join(os.homedir(), '.claude')] }));
      // read-only: no edit tool at all (Claude Code's "default" mode; plan mode made the harness push Explore agents
      // and ExitPlanMode, at odds with the job's own instructions)
      if (readOnly) deniedTools.push(...EDIT_TOOLS);
      if (!readOnly) for (const p of config.protected) if (!p.appendOnly) deniedTools.push(...project.pathRules('Edit', config.root, p.pattern), ...project.pathRules('Write', config.root, p.pattern));
    }
    // read-only: Codex needs 'plan' (its read-only profile); Claude runs in 'default' with every edit tool denied.
    const permissionMode = readOnly ? (codex ? 'plan' : 'default') : writeOnly.length ? 'default' : now.permissionMode;
    const systemText = [...usedPresets.map((p) => p.text), project.rulesPrompt(config)].filter(Boolean).join('\n\n---\n\n');
    const sendWork = (p) => { runItems = []; return engine.send({ prompt: p, cwd, permissionMode, allowedTools, deniedTools, appendSystemPrompt: systemText, hidePaths: hiddenAbs, isolated: isolatedJob, hidden: true }); };
    // Hands the thread to a new session: asks the old one for a handoff note (or builds one from what Relay kept),
    // saves it under Relay's home, and clears the session so the next send starts a new one.
    const handOff = async (reason, at) => {
      const oldSid = engine.sessionId;
      const oldAccount = engine.account;
      phase = 'note';
      noteText = '';
      noteItems = [];
      run.lastLine = reason === 'lost' ? 'The thread\'s session cannot be resumed on any account: Relay builds a handoff note…' : `Context ${reason === 'proactive' ? 'nearly full' : 'full'}: asking the session for a handoff note…`;
      tick();
      onProgress(run.lastLine);
      let note = '';
      // a lost session (nowhere to resume it) cannot write a note: Relay builds one from the thread's reports and ledger
      if (oldSid && reason !== 'lost' && !(signal && signal.aborted)) {
        await engine.send({ prompt: HANDOFF_PROMPT, cwd, permissionMode: codex ? permissionMode : 'default', allowedTools: [], deniedTools: [...new Set([...deniedTools, ...EDIT_TOOLS])], appendSystemPrompt: systemText, hidePaths: hiddenAbs, isolated: isolatedJob, hidden: true });
        if (engine.status !== 'error' && !engine.stopped) note = String(noteText || '').trim();
      }
      phase = 'work';
      if (signal && signal.aborted) return false;
      const built = !note;
      if (built) note = fallbackNote({ cwd, thread, task, existing, wake, items: engine.items, files, commands, sid: oldSid, why: reason === 'lost' ? 'the previous session could not be found on any account, so it could not be resumed' : '' });
      handoffs += 1;
      const noteFile = saveHandoffNote(cwd, thread || (wake && wake.jobId ? `job-${wake.jobId}` : `one-off-${runId}`), handoffs, note);
      sessions.push({ id: oldSid || null, account: oldAccount || null, endedAt: Date.now(), reason, ...(at && at.tokens ? { tokens: at.tokens, window: at.window || ctxDefaultWindow } : {}), note: noteFile, noteBy: built ? 'relay' : 'worker' });
      handed.push({ reason, n: handoffs, file: noteFile, built, from: oldSid, at });
      engine.sessionId = null; // the next send starts a new session (on the same account when it is free)
      ctx = { tokens: null, window: null };
      run.lastLine = `Handed off (${handoffs}): continuing in a new session…`;
      tick();
      onProgress(run.lastLine);
      handoffNote = { note: clip(note, 20000), n: handoffs };
      return true;
    };
    if (!(signal && signal.aborted)) {
      let first = prompt;
      if (handoffDue && await handOff('proactive', handoffDue)) first = freshPrompt(handoffNote);
      if (!(signal && signal.aborted)) {
        const sending = sendWork(first);
        if (signal && signal.aborted) engine.stop(); // aborted while the first attempt was being set up
        await sending;
      }
      // The session ran out of context during the run: hand off and run the task again in a new session (once).
      if (!engine.stopped && !(signal && signal.aborted) && engine.status === 'error' && engine.lastError && engine.lastError.code === 'context_limit' && handed.length < 2) {
        const at = ctx.tokens ? { tokens: ctx.tokens, window: ctx.window || ctxDefaultWindow } : null;
        if (await handOff('reactive', at)) await sendWork(freshPrompt(handoffNote));
      }
      // The session could not be resumed anywhere (never carried, or its transcript is gone): never fail the job with
      // "No conversation found"; continue the thread in a new session with a note Relay builds from its reports.
      if (!engine.stopped && !(signal && signal.aborted) && engine.status === 'error' && engine.lastError && engine.lastError.code === 'session_missing' && handed.length < 3) {
        lostWhy = engine.lastError.message;
        if (await handOff('lost', null)) await sendWork(freshPrompt(handoffNote));
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (shareTimer) clearInterval(shareTimer);
    noteShared();
    lock.release();
    memory.removeRun(runId);
  }

  // The files the job's own edit tool calls named (a refused call changed nothing), also in its earlier segments.
  const own = project.ownEditedFiles(toolCalls.map((t) => ({ ...t, error: !!(t.id && failedTools.has(t.id)) })), { cwd });
  for (const f of (wake && wake.files) || []) if (path.isAbsolute(String(f))) own.add(project.cwdForm(cwd, f));
  const gitAfter = gitBefore ? await gitState(cwd) : null;
  const prefix = gitAfter && area ? await gitPrefix(cwd) : null;
  // git status lines new since the start. With a scope only those in the job's own area (or its own edits; or an
  // untracked folder git lists as one line that holds part of its area).
  const ownGitLine = (rel) => {
    if (!area || prefix === null) return true;
    const abs = gitPathAbs(cwd, prefix, rel);
    const bare = abs.replace(/[\\/]+$/, '');
    return own.has(bare) || project.inArea(area, bare) || (abs.endsWith(path.sep) && area.folders.some((f) => within(f, bare)));
  };
  const gitFiles = new Set(); // what only git status said (a read-only Codex job whose guard saw concurrent changes drops them)
  if (gitAfter) for (const line of gitAfter) if (!gitBefore.has(line)) { const rel = line.slice(3).replace(/^"|"$/g, ''); if (ownGitLine(rel) && !files.has(rel)) { files.add(rel); gitFiles.add(rel); } }
  // Other jobs that may write and ran in this folder while this job ran.
  const shared = [...new Set(sharedWith.values())];
  const sharedList = shared.length ? `${shared.slice(0, 5).map((t) => `"${clip(t, 40)}"`).join(', ')}${shared.length > 5 ? ` (+${shared.length - 5} more)` : ''}` : '';

  const acct = engine.account && store.get(engine.account);
  // Codex (read-only): the folder must be unchanged, and the session must show the read-deny profile was applied.
  let guard = null;
  let sandboxCheck = null;
  if (codex && fpBefore !== null && !(preflight && !preflight.ok)) {
    // Two fingerprints made differently (git ls-files on one side, a walk on the other) or an incomplete one are
    // never compared file by file: the after one is retaken in the before one's way, else the comparison is unverifiable.
    const take = (o = {}) => folderFingerprint(cwd, { ...o, log: fpLog });
    const after = await take();
    const cmp = after ? await project.comparableAfter(fpBefore, after, async (o) => (await take(o)) || { info: { mode: 'failed' } }) : { after: null, unverifiable: 'the folder could not be read after the job' };
    guard = cmp.unverifiable ? { changes: [], unverifiable: cmp.unverifiable, complete: false } : { changes: fingerprintDiff(fpBefore, cmp.after), complete: true };
    if (acct && engine.sessionId) {
      try { sandboxCheck = require('./backends').getBackend('codex').verifyRun(acct, engine.sessionId); } catch (e) { sandboxCheck = { status: 'unverifiable', text: e.message }; }
    } else {
      sandboxCheck = { status: 'unverifiable', text: 'the run left no session' };
    }
  }
  const picked = pickReport(runItems);
  const report = picked.text;
  const who = acct ? label(acct) : 'a worker account';
  const cancelled = engine.stopped || !!(signal && signal.aborted);
  const capSec = store.postChecksMaxSec();
  // Runs the post checks on `changed` (absolute paths) after the worker exited. Its run file comes back without an
  // account, so the job shows as "running checks" without holding a worker slot.
  const checksPhase = async (changed) => {
    run.status = 'running';
    run.phase = 'checks';
    run.account = null;
    run.ranOn = engine.account || null;
    run.lastLine = 'Running the project\'s post checks…';
    tick();
    onProgress(run.lastLine);
    try {
      return await project.runPostChecks(config, { cwd, changed, maxSec: capSec });
    } finally {
      memory.removeRun(runId);
    }
  };
  // A job that did not finish normally (cancelled, failed) is checked too, on what is attributed to it as for a
  // finished job: protected paths, write_paths, and the post checks (only when it changed files).
  // What changed in the folder: { all, unverifiable }. When the two file lists cannot be compared (made differently,
  // incomplete), `all` is only the files the job's own edit tool calls named, and `unverifiable` says why.
  let folderCmp = null;
  const compareFolder = async () => {
    if (folderCmp) return folderCmp;
    if (!snapBefore) return (folderCmp = { all: [], unverifiable: '' });
    const r = await project.compareSnapshots(cwd, config, snapBefore, { log: fpLog });
    if (!r.unverifiable) return (folderCmp = { all: r.changes, unverifiable: '' });
    const all = [];
    for (const abs of own) {
      const was = snapBefore.get(abs);
      const existed = was !== undefined && was !== 'missing';
      if (fs.existsSync(abs)) all.push({ abs, kind: existed ? 'changed' : 'added' }); else if (existed) all.push({ abs, kind: 'removed' });
    }
    return (folderCmp = { all, unverifiable: r.unverifiable });
  };
  const folderNoteFor = (cmp) => (!cmp || !cmp.unverifiable ? '' : `Note: the folder comparison is UNVERIFIABLE (${cmp.unverifiable}). Relay did not compare the two file lists file by file (that lists thousands of files that did not change). ${readOnly
    ? 'Whether this read-only job changed the folder with a shell command could not be checked.'
    : `Protected-path and write_paths checks and the post checks used only the ${cmp.all.length} file${cmp.all.length === 1 ? '' : 's'} this job's own edit tool calls named; changes made by shell commands could not be checked.`}`);
  const checkUnfinished = async () => {
    const res = { flags: [], lines: [], meta: {} };
    if (readOnly || !snapBefore) return res;
    let all = [];
    let cmpU = null;
    try { cmpU = await compareFolder(); all = cmpU.all; } catch { return res; }
    if (cmpU.unverifiable) { res.lines.push(folderNoteFor(cmpU)); res.meta.folderCompare = { status: 'unverifiable', why: cmpU.unverifiable, ...(folderLog.length ? { log: folderLog } : {}) }; }
    const { mine } = project.attributeChanges(all, { area, own });
    const j = project.judgeChanges(area && shared.length ? mine : all, { cwd, writePaths: writeOnly, config });
    const list = (xs) => `${xs.slice(0, 30).map((c) => `${c.rel} (${c.kind})`).join(', ')}${xs.length > 30 ? ` (+${xs.length - 30} more)` : ''}`;
    if (j.protectedHits.length) { res.flags.push('PROTECTED PATH CHANGED'); res.lines.push(`[relay] PROTECTED PATH CHANGED (project config ${config.file}): ${list(j.protectedHits)}. Nothing was reverted: check these files.`); }
    if (j.outside.length) { res.flags.push('WRITE_PATHS_VIOLATED'); res.lines.push(`[relay] WRITE_PATHS_VIOLATED: files changed outside write_paths (${writeOnly.join(', ')}): ${list(j.outside)}. Nothing was reverted: check these files.`); }
    if (j.protectedHits.length || j.outside.length) res.meta.violations = [...j.protectedHits, ...j.outside].map(({ rel, kind, pattern }) => ({ path: rel, kind, ...(pattern ? { protected: pattern } : {}) }));
    const changedF = mine.filter((c) => c.kind !== 'removed');
    const changed = new Set((!area && shared.length ? changedF.filter((c) => own.has(c.abs)) : changedF).map((c) => c.abs));
    for (const f of (wake && wake.files) || []) {
      if (!area && shared.length && !path.isAbsolute(String(f))) continue;
      const abs = path.resolve(cwd, String(f));
      try { if (fs.statSync(abs).isFile()) changed.add(abs); } catch { /* gone */ }
    }
    if (config.postChecks.length && changed.size) {
      const checks = await checksPhase([...changed]);
      const cf = checkFlags(checks, capSec);
      res.flags.push(...cf.flags);
      res.lines.push(`Post checks on the ${changed.size} file${changed.size === 1 ? '' : 's'} this unfinished job changed:`, project.checksText(checks));
      if (cf.note) res.lines.push(cf.note);
      res.meta.checks = checks.map((c) => ({ ...c, tail: c.tail ? clip(c.tail, 4000) : c.tail }));
      if (cf.note) res.meta.checksNote = cf.note;
    }
    if (res.flags.length) res.meta.flags = res.flags;
    return res;
  };
  const unfinished = cancelled || engine.status === 'error' ? await checkUnfinished() : { flags: [], lines: [], meta: {} };
  const unfinishedText = unfinished.lines.length ? `\n\n${unfinished.lines.join('\n')}` : '';
  const unfinishedFlags = unfinished.flags.length ? ` [${unfinished.flags.join(', ')}]` : '';
  // keep the panel's numbers fresh, in the background (not while the window is closing: nothing may outlive it)
  // (Several jobs finishing on one account at once read it once: a reading less than a minute old is fresh enough.)
  if (acct && !cancelled && !(Date.now() - (usage.readCache()[acct.name]?.at || 0) < 60000)) usage.refresh(acct.name).catch(() => {});

  // A run that stops early keeps its worker session: the next call on the same thread resumes it.
  // How full the session is now (kept with its id: a later call compares it with the session it resumes).
  const ctxRec = ctx.tokens && engine.sessionId ? { tokens: ctx.tokens, window: ctx.window || ctxDefaultWindow, sessionId: engine.sessionId, at: Date.now() } : null;
  const chain = { sessions: sessions.slice(-50), handoffs, ...(ctxRec ? { context: ctxRec } : {}) };
  const keepSession = (reason) => {
    if (thread && engine.sessionId) memory.putThread(cwd, thread, { sessionId: engine.sessionId, account: engine.account, provider, title: ledgerTitle, lastSummary: `stopped: ${reason}`, stopped: true, isolated: isolatedJob, ...chain });
  };
  // What the job record and the ledger keep about this job's path rules (only what was set).
  const rulesMeta = {
    ...(isolatedJob ? { isolated: true } : {}), ...(hide.length ? { hidePaths: hide } : {}), ...(writeOnly.length ? { writePaths: writeOnly } : {}),
    ...(out ? { outputFile: out.rel } : {}),
  };
  // A scheduled check: when it was due, when the runner woke it and when a worker took it (every ledger entry of it).
  const wakeInfo = wake && wake.wokeAt ? {
    n: wake.n || 1, wakeAt: wake.dueAt || null, wokeAt: wake.wokeAt, lateMs: wake.lateMs != null ? wake.lateMs : null, ...(wake.manual ? { manual: true } : {}),
    workerAt: firstReserveAt, waitMs: firstReserveAt ? Math.max(0, firstReserveAt - wake.wokeAt) : null,
  } : null;
  const ledger = (entry) => memory.appendLedger(cwd, { ...entry, ...rulesMeta, ...(jobId || (wake && wake.jobId) ? { jobId: jobId || wake.jobId } : {}), ...(wakeInfo ? { wake: wakeInfo } : {}) });
  const resumeHint = thread && engine.sessionId ? ` Call again with thread "${thread}" to continue where it stopped.` : '';

  if (cancelled) {
    keepSession('cancelled');
    ledger({ thread, account: who, title: ledgerTitle, summary: `CANCELLED${unfinishedFlags}: stopped from the dispatcher window before it finished.`, files: [...files], ok: false, ...(unfinished.flags.length ? { flags: unfinished.flags } : {}) });
    return { ok: false, code: 'cancelled', accountName: engine.account || null, files: [...files], meta: { ...rulesMeta, ...unfinished.meta }, text: `Cancelled.${resumeHint}${files.size ? `\nFiles touched before it stopped: ${[...files].join(', ')}` : ''}${unfinishedText}` };
  }
  if (engine.status === 'error') {
    const err = engine.lastError;
    if (err && err.code === 'workers_busy') {
      keepSession('every worker was busy');
      return { ok: false, code: 'busy', meta: { ...rulesMeta, ...unfinished.meta }, text: `BUSY: every worker is still busy with other jobs after waiting ${Math.round(waitSec / 60)} min. Retry later, or do the work yourself.${resumeHint}${unfinishedText}` };
    }
    if (err && err.code === 'workers_limited') {
      keepSession('every worker account reached its limit');
      ledger({ thread, account: who, title: ledgerTitle, summary: `NOT FINISHED${unfinishedFlags}: every worker account reached its limit (the first is back at ${when(err.until)}).`, files: [...files], ok: false, ...(unfinished.flags.length ? { flags: unfinished.flags } : {}) });
      return { ok: false, code: 'workers_limited', until: err.until, meta: { ...rulesMeta, ...unfinished.meta }, text: `NO_WORKER_AVAILABLE: every worker account has reached its limit; the first one is back at ${when(err.until)}. Tell the user, then either do the work yourself or retry later.${resumeHint}${unfinishedText}` };
    }
    keepSession(clip(err?.message || 'unknown error', 120));
    const guardNote = guard && guard.changes.length ? ` The job folder also changed during this read-only job: ${guard.changes.slice(0, 10).join('; ')}.` : '';
    ledger({ thread, account: who, title: ledgerTitle, summary: `FAILED${err?.code ? ` (${err.code})` : ''}${unfinishedFlags}: ${clip(err?.message || 'unknown error', 300)}${guardNote}`, files: [...files], ok: false, ...(unfinished.flags.length ? { flags: unfinished.flags } : {}) });
    return { ok: false, code: ['codex_sandbox_unsafe', 'guard_violation'].includes(err?.code) ? err.code : 'failed', accountName: engine.account || null, files: [...files], meta: { ...rulesMeta, ...unfinished.meta }, text: `Worker failed: ${err?.message || 'unknown error'}${guardNote}${files.size ? `\nFiles touched before failing: ${[...files].join(', ')}` : ''}${unfinishedText}` };
  }

  // The read-only guard. A Codex file-change event is always the job's own and fails it. A folder change fails it too,
  // unless other jobs that may write ran in the folder at the same time AND the session file shows the read-only
  // profile on every turn (verified): then the change is theirs, reported as concurrent changes. Unverified: it fails.
  const codexEdits = codex ? toolCalls.filter((t) => EDIT_TOOLS.has(t.name)).map((t) => String((t.input && t.input.file_path) || '')).filter(Boolean) : [];
  const guardConcurrent = !!(guard && guard.changes.length && !codexEdits.length && shared.length && sandboxCheck && sandboxCheck.status === 'ok');
  if (guardConcurrent) {
    guard.concurrent = true;
    for (const f of gitFiles) files.delete(f);
  }
  // An unverifiable folder comparison passes only on the session check: verified read-only, no file changes of its own.
  const guardUnverified = !!(guard && guard.unverifiable);
  const guardFailed = guard && !guardConcurrent && (guard.changes.length || codexEdits.length || (guardUnverified && !(sandboxCheck && sandboxCheck.status === 'ok')));
  const sandboxFailed = sandboxCheck && sandboxCheck.status === 'violation';
  if (guardFailed || sandboxFailed) {
    const why = [
      guardFailed && codexEdits.length ? `the worker changed files itself (Codex file changes): ${codexEdits.slice(0, 20).join(', ')}${codexEdits.length > 20 ? ` (+${codexEdits.length - 20} more)` : ''}` : '',
      guardFailed && guard.changes.length ? `the job folder changed during a read-only Codex job: ${guard.changes.slice(0, 20).join('; ')}${guard.changes.length > 20 ? ` (+${guard.changes.length - 20} more)` : ''}${shared.length ? ` (other jobs ran here at the same time, but the session's read-only profile could not be verified: ${sandboxCheck ? sandboxCheck.text : 'not checked'})` : ''}` : '',
      guardFailed && guardUnverified && !codexEdits.length ? `the folder comparison is UNVERIFIABLE (${guard.unverifiable}) and the session's read-only profile could not be verified either (${sandboxCheck ? sandboxCheck.text : 'not checked'})` : '',
      sandboxFailed ? `the session did not run under the expected sandbox: ${sandboxCheck.text}` : '',
    ].filter(Boolean).join('. ');
    keepSession('guard violation');
    ledger({ thread, account: `${who} (codex)`, title: ledgerTitle, summary: `FAILED (guard_violation): ${clip(why, 600)}`, files: [...files], ok: false });
    return {
      ok: false, code: 'guard_violation', account: who, accountName: engine.account || null, files: [...files], sessionId: engine.sessionId, sandbox: sandboxCheck, guard,
      text: [`[relay] Codex worker ${who} FAILED the read-only guard: ${why}. Nothing was rolled back; check the folder.`, '', 'Its report (treat with care):', report || '(no text)'].join('\n'),
    };
  }

  // What the run changed, against the snapshot from before it: write_paths and protected paths (any job that may write).
  // The snapshot covers the whole folder, so it also holds what other jobs changed meanwhile: with a scope only the
  // job's own changes (its area, its own edit tool calls) are its files, its post checks' input and its violations.
  // While no other job ran in the folder, every change is still judged (a shell command outside the area is caught).
  const folderCompared = await compareFolder();
  const allChanges = folderCompared.all;
  const folderNote = folderNoteFor(folderCompared);
  let { mine: changes, others: concurrent } = project.attributeChanges(allChanges, { area, own });
  // A read-only Codex job verified read-only on every turn changed nothing in the folder itself.
  if (guardConcurrent) { changes = []; concurrent = allChanges; }
  const judged = project.judgeChanges(area && shared.length ? changes : allChanges, { cwd, writePaths: writeOnly, config: readOnly ? null : config });
  const concurrentProtected = concurrent.filter((c) => !readOnly && project.isProtected(config, c.abs, { kind: c.kind })).length;
  // A read-only Claude job that changed the folder (edit tools are denied; an allowed shell command can still write).
  // Only while no other job that may write ran here: otherwise the changes cannot be told apart from theirs.
  const roChanges = readOnly && !codex && !shared.length ? allChanges : [];
  // The guard's count: one per file (its git status lines say the same again), all of them if it saw only those.
  const guardOthers = guardConcurrent ? (guard.changes.filter((c) => !/^git status/.test(c)).length ? guard.changes.filter((c) => !/^git status/.test(c)) : guard.changes) : [];
  // What the post checks get. A read-only job changed nothing: no checks at all, or with output_file only that file
  // (Codex reviews too). A job without scope while other jobs wrote in the folder: only the files its own edit tool
  // calls named (the rest cannot be told apart from theirs). Otherwise: the job's changes, as attributed above.
  const checkMode = readOnly ? (out ? 'output' : 'none') : !area && shared.length ? 'own' : 'changes';
  const changedFiles = changes.filter((c) => c.kind !== 'removed');
  const checkable = checkMode === 'changes' ? changedFiles : checkMode === 'own' ? changedFiles.filter((c) => own.has(c.abs)) : [];
  const unchecked = checkMode === 'own' ? changedFiles.length - checkable.length : 0;
  const hasChecks = config.postChecks.length > 0;
  const concurrentNote0 = guardConcurrent
    ? `Note: concurrent changes elsewhere in the folder: ${guardOthers.length} (not attributed: the Codex session ran under the read-only profile on every turn (verified: ${sandboxCheck.text}), and other jobs ran here at the same time: ${sharedList}). The read-only guard did not fail this job for them; they are not listed as its files and not given to its post checks.`
    : concurrent.length
    ? `Note: concurrent changes elsewhere in the folder: ${concurrent.length} file${concurrent.length === 1 ? '' : 's'} (not attributed: outside this job's scope and not edited by its own tool calls${concurrentProtected ? `; ${concurrentProtected} in protected paths` : ''}${shared.length ? `; other jobs ran here at the same time: ${sharedList}` : ''}). They are not listed as its files and not given to its post checks.`
    : !area && shared.length ? `Note: other jobs ran in this folder at the same time (${sharedList}). This job has no scope, so the changed files listed here may include theirs.${checkMode === 'own' && hasChecks ? ` Its post checks ran only on the ${checkable.length} file${checkable.length === 1 ? '' : 's'} its own edit tool calls named; ${unchecked} other changed file${unchecked === 1 ? '' : 's'} in the folder ${unchecked === 1 ? 'was' : 'were'} not checked (not attributed to it).` : ''}` : '';
  const concurrentNote = [folderNote, concurrentNote0].filter(Boolean).join('\n\n');
  // What the job record and the ledger keep about concurrent changes (only when there were any), and an unverifiable
  // folder comparison (with why git could not list the files).
  const concurrentMeta = {
    ...(folderCompared.unverifiable ? { folderCompare: { status: 'unverifiable', why: folderCompared.unverifiable } } : {}),
    ...(guardUnverified ? { folderCompare: { status: 'unverifiable', why: guard.unverifiable, guard: true } } : {}),
    ...(folderLog.length ? { folderLog: [...folderLog] } : {}),
    ...(guardConcurrent ? { concurrentChanges: guardOthers.length, concurrentSample: guardOthers.slice(0, 20) }
      : concurrent.length ? { concurrentChanges: concurrent.length, concurrentSample: concurrent.slice(0, 20).map((c) => path.relative(cwd, c.abs).split(path.sep).join('/')) } : {}),
    ...(shared.length ? { sharedWith: shared.slice(0, 20) } : {}),
    ...(concurrentProtected ? { concurrentProtected } : {}),
  };
  if (judged.outside.length || judged.protectedHits.length) {
    const list = (xs) => `${xs.slice(0, 30).map((c) => `${c.rel} (${c.kind})`).join(', ')}${xs.length > 30 ? ` (+${xs.length - 30} more)` : ''}`;
    const flags = [...(judged.protectedHits.length ? ['PROTECTED PATH CHANGED'] : []), ...(judged.outside.length ? ['WRITE_PATHS_VIOLATED'] : [])];
    const why = [
      judged.protectedHits.length ? `PROTECTED PATH CHANGED (project config ${config.file}): ${list(judged.protectedHits)}` : '',
      judged.outside.length ? `files changed outside write_paths (${writeOnly.join(', ')}): ${list(judged.outside)}` : '',
    ].filter(Boolean).join('. ');
    keepSession(flags.join(', ').toLowerCase());
    // the worker's own summary still says what it did (live probe: a write_paths job's block was dropped here)
    const { summary: failedSummary, note: failedNote } = project.parseSummary(report);
    ledger({ thread, account: who, title: ledgerTitle, summary: `FAILED (${flags.join(', ')}): ${clip(why, 800)}`, files: [...files], ok: false, flags, ...(failedSummary ? { relaySummary: failedSummary } : {}), ...concurrentMeta });
    return {
      ok: false, code: judged.protectedHits.length ? 'protected_changed' : 'write_violation', account: who, accountName: engine.account || null, files: [...files], sessionId: engine.sessionId,
      meta: { ...rulesMeta, flags, relaySummary: failedSummary, summaryNote: failedNote, ...concurrentMeta, violations: [...judged.protectedHits, ...judged.outside].map(({ rel, kind, pattern }) => ({ path: rel, kind, ...(pattern ? { protected: pattern } : {}) })) },
      text: [
        `[relay] worker ${who} FAILED · ${flags.join(' · ')}: ${why}.`,
        area && shared.length
          ? 'Nothing was reverted: check these files. (Other jobs ran in this folder at the same time, so only changes inside this job\'s scope or to files its own edit tool calls named were counted.)'
          : 'Nothing was reverted: check these files. (A job working in the same folder at the same time can also have made a change listed here.)',
        ...(concurrentNote ? [concurrentNote] : []),
        '', 'Its report:', report || '(no text)',
      ].join('\n'),
    };
  }

  // RELAY_PARK as the report's last line: the worker launched long-running work and asks to be woken later.
  // (A park line at the end of the report itself still counts when a postscript follows it.)
  let parsed = park.parseParkLine(report);
  const parkInMain = !parsed && picked.postscript.length ? park.parseParkLine(picked.main) : null;
  if (parkInMain && parkInMain.park) parsed = parkInMain;
  const parked = parsed && parsed.park && engine.sessionId ? { ...parsed.park, wakeAt: Date.now() + parsed.park.minutes * park.minuteMs() } : null;
  const parkNote = parsed && parsed.malformed ? `Note: the worker's last line looked like a RELAY_PARK request but could not be read ("${clip(parsed.malformed, 120)}"), so it was ignored and the job ended normally. The format is: RELAY_PARK: <minutes> | <what to check on wake>.`
    : parsed && parsed.park && !parked ? 'Note: the worker asked to park, but its session id is unknown, so it cannot be woken: the job ended normally.' : '';
  const shown = !parked ? report : parkInMain && parkInMain.park ? withPostscript(park.stripParkLine(picked.main), picked.postscript) : park.stripParkLine(report);
  const parkLine = parked ? `PARKED: the worker launched long-running work and will be woken in ${parked.minutes} min (${park.localTime(parked.wakeAt)})${parked.asked !== parked.minutes ? ` (asked for ${parked.asked}, kept within ${park.MIN_MINUTES}-${park.MAX_MINUTES})` : ''} to check: ${parked.check}` : '';

  const flags = [];
  if (roChanges.length) flags.push('READ_ONLY_VIOLATED');
  const roList = roChanges.slice(0, 30).map((c) => `${path.relative(cwd, c.abs).split(path.sep).join('/')} (${c.kind})`).join(', ') + (roChanges.length > 30 ? ` (+${roChanges.length - 30} more)` : '');
  // hide_paths: did the worker touch a hidden path anyway? (a call refused by the deny rules is only "blocked")
  const scan = project.scanBreach(toolCalls.map((t) => ({ ...t, error: !!(t.id && failedTools.has(t.id)) })), { cwd, hidePaths: hide });
  if (scan.breaches.length) flags.push('ISOLATION BREACH');
  const breachList = (xs) => xs.slice(0, 10).map((b) => `${b.tool} ${b.what} (hidden: ${b.pattern})`).join('; ') + (xs.length > 10 ? ` (+${xs.length - 10} more)` : '');
  // The worker's structured summary (a relay-summary block at the end of its report).
  const { summary: relaySummary, note: summaryNote } = project.parseSummary(shown);
  // output_file: Relay writes the final report itself (not on a park: the job is not finished yet).
  let outputSaved = null;
  let outputError = '';
  let relayReport = ''; // the worker wrote output_file itself: Relay's copy of the report went here
  if (out && !parked) {
    const w = project.writeOutputFile(cwd, out.rel, shown, { overwrite: !!overwrite });
    if (w.ok) outputSaved = out.rel;
    else if (w.exists && own.has(project.cwdForm(cwd, out.rel))) {
      // The file appeared during the job and the job's own edit tool calls wrote it: the worker's file stays, and
      // Relay's report goes next to it. (A file someone else created still fails the save, as before.)
      const alt = project.relayReportPath(out.rel);
      const w2 = project.writeOutputFile(cwd, alt, shown, { overwrite: false });
      if (w2.ok) { outputSaved = out.rel; relayReport = alt; } else { outputError = `${w.error}; the worker wrote it itself, and Relay's report could not be saved to ${alt} either (${w2.error})`; flags.push('OUTPUT_NOT_SAVED'); }
    } else { outputError = w.error; flags.push('OUTPUT_NOT_SAVED'); }
  }
  // The project's post checks, once the job is finished (not on a park), on what it changed (all its segments). A park
  // at the last scheduled check Relay allows ends the job (too_many_wakes): its changes are checked then as well.
  const finalPark = !!(parked && wake && wake.final);
  const checkNow = !parked || finalPark;
  let checks = [];
  let checksNote = '';
  if (checkNow && hasChecks && checkMode === 'none') checksNote = 'Post checks: not run (a read-only job changes no files; with output_file they run on that file).';
  if (checkNow && hasChecks && checkMode === 'output' && !outputSaved) checksNote = parked ? 'Post checks: not run (a read-only job changes no files, and its report file is only saved when it finishes).' : 'Post checks: not run (the report file was not saved).';
  if (checkNow && hasChecks && (checkMode === 'changes' || checkMode === 'own' || (checkMode === 'output' && outputSaved))) {
    const changed = new Set(checkable.map((c) => c.abs));
    // earlier segments' files (a parked job): all of them, or with 'own' only its own edit calls' (absolute) paths
    for (const f of (wake && wake.files) || []) {
      if (checkMode === 'own' && !path.isAbsolute(String(f))) continue;
      const abs = path.resolve(cwd, String(f));
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) changed.add(abs);
    }
    if (outputSaved) changed.add(path.resolve(cwd, outputSaved));
    if (relayReport) changed.add(path.resolve(cwd, relayReport));
    // The worker has exited and its run file is gone, so its account's slot is already free for the next job.
    checks = await checksPhase([...changed]);
    const cf = checkFlags(checks, capSec);
    flags.push(...cf.flags);
    if (cf.note) checksNote = cf.note;
  }

  const flagText = flags.length ? `${flags.join(', ')}. ` : '';
  const plain = shown.replace(/```[ \t]*relay-summary[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  const summary = clip(`${flagText}${parked ? `PARKED until ${park.localTime(parked.wakeAt)} (check: ${parked.check}). ` : ''}${plain}`, 1500);
  if (thread) memory.putThread(cwd, thread, { sessionId: engine.sessionId, account: engine.account, provider, title: ledgerTitle, lastSummary: summary, files: [...files], stopped: false, isolated: isolatedJob, ...chain });
  ledger({
    thread, account: codex ? `${who} (codex${modelUsed ? ` ${modelUsed}` : ''})` : who, title: ledgerTitle, summary, files: [...files], commands: commands.slice(0, 8).map((c) => clip(c, 100)), ok: true,
    ...(flags.length ? { flags } : {}), ...(relaySummary ? { relaySummary } : {}), ...(scan.breaches.length ? { breach: scan.breaches.slice(0, 20) } : {}), ...concurrentMeta,
    ...(carriedLog.length ? { carried: carriedLog.map((c) => ({ account: c.account, bytes: c.bytes, at: c.at })) } : {}),
  });
  const meta = {
    ...rulesMeta, flags, relaySummary, summaryNote, presets: usedPresets.map((p) => p.id), ...chain, priority: prio, ...concurrentMeta,
    ...(hc.warning ? { healthWarning: hc.warning } : {}),
    ...(carriedLog.length ? { carried: carriedLog } : {}), ...(wakeInfo ? { wakeTiming: wakeInfo } : {}),
    ...(out ? { outputSaved, ...(relayReport ? { relayReport } : {}), ...(outputError ? { outputError } : {}) } : {}),
    ...(checks.length ? { checks: checks.map((c) => ({ ...c, tail: c.tail ? clip(c.tail, 4000) : c.tail })) } : {}),
    ...(checksNote ? { checksNote } : {}),
    ...(roChanges.length ? { readOnlyChanges: roChanges.slice(0, 50).map((c) => ({ path: path.relative(cwd, c.abs).split(path.sep).join('/'), kind: c.kind })) } : {}),
    ...(scan.breaches.length ? { breach: scan.breaches.slice(0, 50) } : {}), ...(scan.blocked.length ? { blockedReads: scan.blocked.slice(0, 50) } : {}),
    ...(config.file ? { projectConfig: { file: config.file, healthChecks: config.healthChecks } } : {}),
  };
  const rulesNote = config.rules && config.rules.missing ? `Note: the project config names rules_file ${config.rules.file}, which could not be read (${config.rules.why}); the worker ran without it.`
    : config.rules && config.rules.truncated ? `Note: the project rules file ${config.rules.file} is ${Math.round(config.rules.bytes / 1024)} KB; only its first 20 KB were given to the worker (it was told so).` : '';
  const presetLabel = usedPresets.length === 1 ? ` · preset "${usedPresets[0].id}"` : usedPresets.length ? ` · presets ${usedPresets.map((p) => `"${p.id}"`).join(', ')}` : '';

  const codexLines = !codex ? [] : [
    `Read-only guard: ${guard ? (guardUnverified ? `UNVERIFIABLE folder comparison (${guard.unverifiable}); passed on the session check alone (verified read-only on every turn, no file changes of its own)` : guardConcurrent ? `passed: the folder changed only by other jobs running here at the same time (${guardOthers.length}; this session verified read-only)` : guard.complete ? 'job folder unchanged' : 'no change found, but the folder was too large to fingerprint completely') : 'not run'}. ` +
    `Sandbox: ${sandboxCheck ? (sandboxCheck.status === 'ok' ? `verified (${sandboxCheck.text})` : `UNVERIFIED (${sandboxCheck.text})`) : 'not checked'}. Preflight canary check: ${preflight ? (preflight.ok ? 'passed' : 'failed') : 'not run'}.`,
  ];
  return {
    ok: true, code: 'done', sessionId: engine.sessionId, thread, account: who, accountName: engine.account || null, model: modelUsed, files: [...files], commands, provider, sandbox: sandboxCheck, guard,
    report: shown, park: parked, wake: wake ? wake.n || 1 : 0, meta,
    text: [
      `[relay] ${codex ? 'Codex ' : ''}worker ${who}${modelUsed ? ` · model ${modelUsed}` : ''}${effort ? ` · effort ${effort}` : ''}${prio !== 'normal' ? ` · priority ${prio}` : ''}${thread ? ` · thread "${thread}"` : ''}${isolatedJob ? ' · isolated' : ''}${presetLabel}${wake ? ` · wake ${wake.n || 1}` : ''}${handoffs ? ` · handed off (${handoffs})` : ''} ${parked ? 'parked' : 'finished'}${flags.length ? ` · ${flags.join(' · ')}` : ''}.`,
      hc.warning ? `[relay] ${hc.warning}` : hc.note ? `[relay] ${hc.note}.` : '',
      ...handed.map((h) => (h.reason === 'lost'
        ? `[relay] Session handoff ${h.n}: the thread's session could not be resumed on any account (${clip(lostWhy || 'not found', 300)}), so Relay built a handoff note from the thread's reports and ledger (${h.file}); the work continued in a new session.`
        : `[relay] Context handoff ${h.n} (${h.reason === 'proactive' ? `the session was at ${pctOf(h.at, ctxDefaultWindow)} of its context window` : 'the session ran out of context during the run'}): ${h.built ? 'the old session could not write a note, so Relay built one from the thread\'s reports and ledger' : 'the old session wrote a handoff note'} (${h.file}); the work continued in a new session.`)),
      ...carriedLog.map((c) => `[relay] The session moved to ${c.account}: Relay copied it there first (${c.bytes} bytes${c.files ? `, ${c.files} more files` : ''}, from ${c.from}).`),
      scan.breaches.length ? `[relay] ISOLATION BREACH: the worker touched paths it was told to stay out of (hide_paths): ${breachList(scan.breaches)}. Treat its independence as compromised.` : '',
      roChanges.length ? `[relay] READ_ONLY_VIOLATED: this read-only job changed the folder (no other job wrote here meanwhile): ${roList}. Nothing was reverted: check these files.` : '',
      thread && !parked ? `Continue this line of work later with the same thread name; the worker remembers everything.` : '',
      '',
      shown || '(the worker returned no text)',
      parkLine ? `\n${parkLine}` : '',
      parkNote ? `\n${parkNote}` : '',
      relayReport ? `\nNote: the worker wrote ${outputSaved} itself (its own tool calls), so Relay kept that file and saved its report to ${relayReport} next to it (in ${cwd}).`
        : outputSaved ? `\nReport saved by Relay to ${outputSaved} (in ${cwd}).` : out && !parked ? `\nReport NOT saved to ${out.rel}: ${outputError}.` : out ? `\nRelay saves the report to ${out.rel} when the job finishes.` : '',
      checks.length ? `\n${project.checksText(checks)}` : '',
      checksNote ? `\n${checksNote}` : '',
      concurrentNote ? `\n${concurrentNote}` : '',
      scan.blocked.length ? `\nNote: the worker tried to reach hidden paths, and was refused: ${breachList(scan.blocked)}.` : '',
      summaryNote ? `\nNote: ${summaryNote}${relaySummary ? '' : ' (Relay has no structured summary for this job)'}.` : '',
      rulesNote ? `\n${rulesNote}` : '',
      files.size ? `\nFiles touched: ${[...files].join(', ')}` : '',
      commands.length ? `Commands run: ${commands.slice(0, 6).map((c) => clip(c, 80)).join(' | ')}${commands.length > 6 ? ` (+${commands.length - 6} more)` : ''}` : '',
      ...codexLines,
    ].filter((x) => x !== '').join('\n'),
  };
}

// For relay_status: who is leader, who are workers, how much each has used.
function statusText(cwd) {
  const cache = usage.readCache();
  const lines = ['Relay accounts:'];
  const accounts = store.load();
  if (!accounts.length) lines.push('  (none yet)');
  const { pickOrder, activeRuns } = require('./engine');
  let jobList = [];
  try { jobList = require('./jobs').list(); } catch { /* no job records */ }
  const parkedJobs = jobList.filter((j) => j.state === 'parked');
  const load = activeRuns();
  const now = store.nowSec();
  const cap = store.jobsPerWorker();
  // Which worker the next job goes to, per provider: the same order the pick uses (ready, under its own cap from its
  // weekly quota), and why.
  const { openAccounts } = require('./engine');
  const place = new Map();
  const capOf = new Map();
  for (const prov of new Set(accounts.filter(isWorker).map(providerOf))) {
    const ready = accounts.filter((a) => isWorker(a) && providerOf(a) === prov && store.isReady(a, now));
    const { open, caps } = openAccounts(ready, { load, cache, now, max: cap });
    caps.forEach((c, n) => capOf.set(n, c));
    const order = pickOrder(open, { load, cache, now });
    const fewest = order.length ? order[0].n : 0;
    order.forEach((o, k) => place.set(o.x.name, { k, o, fewest, alone: order.length === 1, order }));
  }
  for (const a of accounts) {
    const u = cache[a.name]?.data;
    const state = a.needsLogin ? 'SIGN-IN NEEDED' : a.blockedUntil > now ? `limited until ${when(a.blockedUntil)}` : 'ready';
    const fable = (u?.others || []).find((r) => /fable/i.test(r.label));
    const bits = [u?.session ? `${providerOf(a) === 'codex' ? 'session' : '5h'} window ${u.session.pct}% used` : '', u?.week ? `week ${u.week.pct}% used` : '', fable ? `Fable week ${fable.pct}% used` : ''].filter(Boolean).join(', ');
    const kind = a.desktop ? (isWorker(a) ? 'LEADER: this window; also takes jobs (switch "Leader takes jobs too" on)' : 'LEADER: this window, does not take jobs (switch "Leader takes jobs too" off)')
      : providerOf(a) === 'codex' ? `codex worker, read-only jobs only (agent: "codex")${a.model ? `, model ${a.model}` : ''}` : 'worker';
    let extra = '';
    if (isWorker(a)) {
      const running = load.get(a.name) || 0;
      const parkedHere = parkedJobs.filter((j) => j.account === a.name).length;
      const p = place.get(a.name);
      // Its own cap from its weekly quota (only for a ready worker: the pick never considers the others).
      const c = capOf.get(a.name);
      const capText = !c ? '' : c.unknown ? `usage unknown → cap ${c.cap}`
        : c.weekFull ? `week ${Math.round(c.pct)}% used → cap ${c.cap} (${c.lastResort ? 'every other worker is full' : 'takes one only when every other worker is full'})`
          : `daily spare ${c.spare.toFixed(1)}%/day → cap ${c.cap} (resets ${when(c.reset)})`;
      // The order: fewest running jobs first; at the same load the lower tier; then a 5h window at 95%+ goes last; then
      // the earliest weekly reset.
      const order = p ? p.order : [];
      const why = !p ? '' : [
        p.alone ? 'only free worker' : p.o.n === p.fewest ? 'fewest jobs' : `more jobs than others`,
        // the tier, when it put this worker before another one with as many jobs
        !p.alone && order.some((o) => o.n === p.o.n && o.tier > p.o.tier) ? `tier ${p.o.tier} before tier ${Math.max(...order.filter((o) => o.n === p.o.n).map((o) => o.tier))}` : '',
        p.o.hot ? `5h window at ${Math.round(p.o.pct)}%, used after others with as many jobs` : '',
        p.o.reset ? `week resets ${when(p.o.reset)}` : 'weekly reset unknown',
      ].filter(Boolean).join('; ');
      const line = !store.isReady(a, now) ? '' : !p ? `full: ${running} of ${c ? c.cap : cap} jobs`
        : `${p.k === 0 ? 'next in line' : `#${p.k + 1} in line`} (${why})`;
      // its tier (Accounts panel: 1 = most preferred): at the same number of running jobs a lower tier goes first
      extra = ` · ${running} running, ${parkedHere} parked${capText ? ` · ${capText}` : ` (up to ${cap} at once)`}${line ? ` · ${line}` : ''} · tier ${store.tierOf(a)}`;
    }
    lines.push(`  - ${label(a)} [${kind}] ${state}${bits ? ` (${bits})` : ''}${extra}`);
  }
  // Each open job's live state, from the same view relay_poll uses (its run file: running, waiting for a worker or the
  // folder, running checks), not the record's stored state, which stays "queued" while the job runs.
  const jobsMod = require('./jobs');
  const runs = memory.listRuns();
  const live = jobList.filter((j) => !jobsMod.FINISHED.has(j.state)).map((j) => { try { return jobsMod.view(j, runs); } catch { return j; } })
    .filter((j) => !jobsMod.FINISHED.has(j.state)).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  if (live.length) {
    lines.push('', 'Background jobs (relay_poll / relay_wait with their ids):');
    for (const j of live.slice(-20)) {
      const who = j.account ? ` on ${label(store.get(j.account) || { name: j.account })}` : '';
      const fl = jobsMod.flagItems(j).length ? ` [${jobsMod.flagsLabel(j, { reasonChars: 0 })}]` : '';
      const pr = jobsMod.priorityOf(j);
      const st = j.state === 'parked' ? `PARKED${who}, wakes ${when(j.wakeAt / 1000)}${jobsMod.isOverdue(j) ? ` (WAKE OVERDUE by ${Math.round(jobsMod.overdueMs(j) / 60000)} min)` : ''}, checks so far ${j.wakes || 0}`
        : `${j.state}${j.state === 'waiting for worker' && j.queuePos ? ` (#${j.queuePos} in line)` : ''}${who}`;
      lines.push(`  - ${j.id} "${j.title || ''}" (${j.project || ''}): ${st} · priority ${pr}${j.handoffs ? ` · handed off (${j.handoffs})` : ''}${fl}`);
    }
  }
  // Finished jobs Relay flagged (isolation breach, failed checks, protected path changed...) in the last 24 hours.
  // Resolved ones (relay_ack) stay listed, marked resolved, but leave the Needs action line.
  const flagged = jobList.filter((j) => ['done', 'failed', 'cancelled'].includes(j.state) && (j.flags || []).length && Date.now() - (j.finishedAt || 0) < 86400e3)
    .sort((x, y) => (y.finishedAt || 0) - (x.finishedAt || 0)).slice(0, 10);
  // One line at the very top with everything that needs the leader's action (finished in the last 24 h, or open).
  const na = jobsMod.needsActionLine([...live, ...jobList.filter((j) => jobsMod.FINISHED.has(j.state) && Date.now() - (j.finishedAt || 0) < 86400e3 && jobsMod.needsAction(j).length)
    .sort((x, y) => (y.finishedAt || 0) - (x.finishedAt || 0)).slice(0, 20)]);
  if (na) lines.unshift(na, '');
  if (flagged.length) {
    lines.push('', 'Flagged jobs (last 24 h; details with relay_poll):');
    for (const j of flagged) lines.push(`  - ${j.id} "${j.title || ''}" (${j.project || ''}): ${j.state}, ${jobsMod.flagsLabel(j)}${jobsMod.needsAction(j).length ? '' : ' [resolved]'}`);
  }
  // Worker health (core/health.js): for this project when cwd is given, else each worker's latest check anywhere.
  const pc = cwd && path.isAbsolute(cwd) && fs.existsSync(cwd) ? project.loadConfig(cwd) : null;
  const hRoot = pc && !pc.error ? health.rootOf(cwd, pc.config) : null;
  const hLines = [];
  for (const a of accounts.filter((x) => isWorker(x) && providerOf(x) === 'claude')) {
    const rec = health.forAccount(a.name, hRoot);
    if (rec) hLines.push(`  - ${label(a)}: ${health.summary(rec)}${hRoot ? '' : ` (${path.basename(rec.root)})`}`);
  }
  if (hLines.length || (pc && !pc.error && pc.config.healthChecks.length)) {
    lines.push('', `Worker health${hRoot ? ` in ${hRoot}` : ' (latest check per worker)'} (relay_health checks again):`);
    lines.push(...(hLines.length ? hLines : ['  (not checked yet: run relay_health with this cwd)']));
  }
  const seen = store.getLeaderSeen();
  if (seen && !seen.registered) lines.push(`  Note: this window is signed in as ${seen.email}, which is not in Relay's pool.`);
  if (cwd && path.isAbsolute(cwd)) {
    const threads = memory.listThreads(cwd);
    const names = Object.keys(threads);
    lines.push('', `Threads in ${cwd}:`);
    if (!names.length) lines.push('  (none yet)');
    for (const n of names) {
      const t = threads[n];
      const c = t.context && t.context.tokens && t.context.sessionId === t.sessionId ? ` · context ${Math.round((100 * t.context.tokens) / (t.context.window || 200000))}%` : '';
      lines.push(`  - "${n}" (${new Date(t.updatedAt).toISOString().slice(0, 16).replace('T', ' ')})${t.handoffs ? ` · handed off (${t.handoffs})` : ''}${c}: ${clip(t.lastSummary || t.title || '', 160)}`);
    }
  }
  return lines.join('\n');
}

module.exports = { runWorker, pickReport, statusText, buildPrompt, deriveTitle, cleanScopes, HANDOFF_PROMPT, fallbackNote, saveHandoffNote, handoffDir };
