'use strict';
// Worker health checks. A project's .relay/project.json may list `health_checks`: commands its jobs depend on
// (`bin/researchctl status`, `ssh -o BatchMode=yes host true`, `latexmk -v`). A worker account whose own permissions
// refuse one of them, or whose Claude Code has not trusted the project folder, wastes every job that needs it.
// For each Claude worker account and such a project, Relay runs one tiny worker job (model haiku, effort low, the
// permissions a real job there gets, no file edits) that runs each listed command and reports, in a strict JSON block,
// whether it was allowed or refused and its exit code. It also reads the account's workspace trust for the project
// (<config dir>/.claude.json: projects[<path>].hasTrustDialogAccepted; nothing else is used, no credentials are read).
// Results: <home>/health.json, one record per account + project root. Checked at most every 6 h per account and
// project (the tray app), and on demand (relay_health, the panel). Relay never changes an account's trust or
// permissions: a problem comes with the exact fix for the user.
// When a job's text names a command that a worker refused at its last check (or the worker has not trusted the
// project), Relay runs the job on a healthy worker when there is one; otherwise it runs anyway with a warning.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const memory = require('./memory');
const project = require('./project');
const fslock = require('./fslock');
const { providerOf } = require('./backends');

const EVERY_MS = () => Number(process.env.RELAY_HEALTH_EVERY_MS || 6 * 3600e3);
const file = () => path.join(store.home(), 'health.json');
const key = (account, root) => `${account}|${path.resolve(root)}`;
const isClaudeWorker = (a) => store.isWorker(a) && !a.needsLogin && providerOf(a) === 'claude'; // the leader too while it takes jobs
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const REFUSED_RE = /(permission|denied|not allowed|requires approval|was blocked|haven't granted|has not been granted|refused)/i;

// The program a command runs, as a short name: "bin/researchctl status" → researchctl, "FOO=1 ssh -o … host true" → ssh.
function commandName(cmd) {
  const words = String(cmd || '').trim().split(/\s+/).filter(Boolean);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'env' && w !== 'sudo') || words[0] || '';
  return path.basename(first.replace(/^["']|["']$/g, '')) || first;
}
const checksOf = (config) => (config && Array.isArray(config.healthChecks) ? config.healthChecks : []).map((c) => ({ name: commandName(c.cmd), label: c.name, cmd: c.cmd }));

// ---- workspace trust ----
// Claude Code trusts a folder when it or a parent folder has hasTrustDialogAccepted in the account's .claude.json.
function trustOf(acct, folder) {
  const cfg = path.join(acct.configDir || '', '.claude.json');
  const want = path.resolve(folder);
  const fix = `set projects["${want}"].hasTrustDialogAccepted to true in ${cfg} (or run \`CLAUDE_CONFIG_DIR="${acct.configDir}" claude\` once in "${want}" and accept the trust prompt)`;
  let projects = null;
  try {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    projects = j && typeof j.projects === 'object' && j.projects ? j.projects : {};
  } catch (e) {
    return { trusted: false, known: false, path: want, file: cfg, why: e.code === 'ENOENT' ? 'no .claude.json in the account folder' : 'its .claude.json could not be read', fix };
  }
  for (let p = want; ; p = path.dirname(p)) {
    const entry = projects[p];
    if (entry && entry.hasTrustDialogAccepted === true) return { trusted: true, known: true, path: p, file: cfg };
    if (path.dirname(p) === p) break;
  }
  return { trusted: false, known: true, path: want, file: cfg, why: 'the project folder is not trusted', fix };
}

// ---- the check job ----
function prompt(checks) {
  return [
    'RELAY_HEALTH_CHECK: an automatic check by Relay that this account can run the commands a project needs. It is not a real task.',
    'Run each command below exactly as written, each in its own Bash call, in this order. Run nothing else: no other commands, no file reads or edits, no fixes, no retries.',
    '',
    ...checks.map((c, i) => `${i + 1}. ${c.cmd}`),
    '',
    'Then reply with only this block, one entry per command, in the same order:',
    '```relay-health',
    '{"results": [{"cmd": "<the command exactly as above>", "status": "allowed", "exit": 0}]}',
    '```',
    '"status": "refused" when the call was refused or blocked by permissions (it did not run), else "allowed" (it ran, whatever its exit code).',
    '"exit": the exit code as a number; null when it did not run.',
  ].join('\n');
}

// The worker's report + its tool calls → one result per listed command:
//   { name, cmd, status: 'allowed' | 'refused' | 'not_run', exit: number | null }
// The JSON block is what the worker says; a refusal seen in the tool calls themselves wins over it.
function parseReport(text, checks, tools = null) {
  let claimed = null;
  let error = '';
  const m = /```[ \t]*relay-health[ \t]*\n([\s\S]*?)```/.exec(String(text || ''));
  if (!m) error = 'the worker gave no relay-health block';
  else {
    try {
      const j = JSON.parse(m[1]);
      if (!j || !Array.isArray(j.results)) throw new Error('no results list');
      claimed = j.results;
    } catch (e) { error = `its relay-health block could not be read (${e.message})`; }
  }
  const results = checks.map((c, i) => {
    const byCmd = claimed && claimed.find((r) => r && String(r.cmd || '').trim() === c.cmd);
    const r = byCmd || (claimed && claimed[i]) || null;
    let status = r && ['allowed', 'refused', 'not_run'].includes(r.status) ? r.status : null;
    let exit = r && Number.isInteger(r.exit) ? r.exit : null;
    if (tools) {
      const calls = tools.filter((t) => t.name === 'Bash' && t.input && typeof t.input.command === 'string' && t.input.command.trim() === c.cmd);
      if (calls.some((t) => t.error && REFUSED_RE.test(t.errorText || ''))) { status = 'refused'; exit = null; }
      else if (!status) status = calls.length ? 'allowed' : 'not_run';
    }
    if (!status) status = 'not_run';
    if (status !== 'allowed') exit = null;
    return { name: c.name, cmd: c.cmd, status, exit };
  });
  return { results, error };
}

// ---- records ----
const readAll = () => { try { return fslock.readJson(file(), {}) || {}; } catch { return {}; } };
function save(rec) {
  fs.mkdirSync(store.home(), { recursive: true });
  fslock.withFileLock(file(), () => {
    const all = readAll();
    all[key(rec.account, rec.root)] = rec;
    fslock.writeJson(file(), all);
  });
}
const latest = (account, root) => readAll()[key(account, root)] || null;
const rootOf = (cwd, config) => path.resolve((config && config.root) || cwd);

// What a record says, in one line: "ok" or "2 refused (ssh, latexmk), untrusted".
function problems(rec) {
  if (!rec) return [];
  const out = [];
  const refused = (rec.results || []).filter((r) => r.status === 'refused');
  const failed = (rec.results || []).filter((r) => r.status === 'allowed' && r.exit !== 0 && r.exit != null);
  const notRun = (rec.results || []).filter((r) => r.status === 'not_run');
  if (refused.length) out.push(`${refused.length} refused (${refused.map((r) => r.name).join(', ')})`);
  if (failed.length) out.push(`${failed.length} failed (${failed.map((r) => `${r.name} exit ${r.exit}`).join(', ')})`);
  if (notRun.length) out.push(`${notRun.length} not run (${notRun.map((r) => r.name).join(', ')})`);
  if (rec.trust && !rec.trust.trusted) out.push('untrusted');
  if (rec.error) out.push(`check failed: ${rec.error}`);
  return out;
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const summary = (rec) => (rec ? `health: ${problems(rec).join(', ') || 'ok'}, checked ${hhmm(rec.at)}` : 'health: not checked');

// The exact fixes for a record's problems (Relay never applies them itself).
function fixes(rec, acct) {
  const out = [];
  const who = acct ? acct.email || acct.name : rec.account;
  if (rec.trust && !rec.trust.trusted && rec.trust.fix) out.push(`${who}: workspace not trusted (${rec.trust.why}). Fix: ${rec.trust.fix}.`);
  const refused = (rec.results || []).filter((r) => r.status === 'refused');
  if (refused.length) {
    const rules = refused.map((r) => `"Bash(${r.cmd})"`).join(', ');
    out.push(`${who}: refused ${refused.map((r) => `\`${r.cmd}\``).join(', ')}. Fix: add ${rules} to Relay's Settings › Allowed commands (passed to every worker as --allowedTools), or to permissions.allow in ${path.join(acct ? acct.configDir : '<account folder>', 'settings.json')}.`);
  }
  return out;
}

// Runs the check job for one account and one project; saves and returns the record.
async function checkOne(acct, cwd, config, { signal = null } = {}) {
  const { Engine } = require('./engine');
  const root = rootOf(cwd, config);
  const checks = checksOf(config);
  const rec = { account: acct.name, email: acct.email || '', root, cwd: path.resolve(cwd), at: Date.now(), trust: trustOf(acct, root), results: [], error: '' };
  if (!checks.length) { save(rec); return rec; }
  const runId = `health-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  memory.writeRun(runId, { kind: 'health', status: 'running', account: acct.name, project: path.basename(root), cwd: root, title: 'Health check', thread: '', startedAt: Date.now(), updatedAt: Date.now() });
  const engine = new Engine();
  engine.filter = (a) => a.name === acct.name; // this account only: no failover to another
  engine.provider = 'claude';
  engine.maxWait = 0; // a limited account is reported, not waited for
  engine.model = 'haiku';
  engine.effort = 'low';
  const tools = [];
  const byId = new Map();
  engine.on('item', (it) => {
    if (it.kind === 'tool') { const t = { name: it.name, id: it.id || null, input: it.input || {} }; tools.push(t); if (t.id) byId.set(t.id, t); }
    if (it.kind === 'tool_result' && it.error && it.id && byId.has(it.id)) Object.assign(byId.get(it.id), { error: true, errorText: it.text || '' });
  });
  const onAbort = () => engine.stop();
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    // The permissions a real job in this project gets (Settings), minus every file edit, and no reading Relay's records.
    const settings = store.loadSettings();
    const deniedTools = [...store.cleanAllowedTools(settings.deniedTools).rules, ...EDIT_TOOLS,
      ...['projects', 'jobs', '.relay-handoff'].map((d) => project.absRule('Read', path.join(store.home(), d, '**')))];
    await engine.send({ prompt: prompt(checks), cwd: root, permissionMode: settings.permissionMode === 'plan' ? 'default' : settings.permissionMode, deniedTools, hidden: true });
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    memory.removeRun(runId);
  }
  if (engine.status === 'error') {
    const e = engine.lastError || {};
    rec.error = e.code === 'workers_limited' ? 'the account is at its usage limit' : e.code === 'no_account' ? 'the account is not usable (signed out or limited)' : String(e.message || 'the check job failed').slice(0, 200);
    rec.results = checks.map((c) => ({ name: c.name, cmd: c.cmd, status: 'not_run', exit: null }));
  } else if (engine.stopped) {
    rec.error = 'cancelled';
    rec.results = checks.map((c) => ({ name: c.name, cmd: c.cmd, status: 'not_run', exit: null }));
  } else {
    const report = [...engine.items].reverse().find((i) => i.kind === 'text')?.text || '';
    const parsed = parseReport(report, checks, tools);
    rec.results = parsed.results;
    if (parsed.error && parsed.results.every((r) => r.status === 'not_run')) rec.error = parsed.error;
    // Only the listed commands may run: anything else it ran is recorded.
    const extra = tools.filter((t) => !(t.name === 'Bash' && checks.some((c) => c.cmd === String(t.input.command || '').trim())));
    if (extra.length) rec.extraCalls = extra.slice(0, 10).map((t) => `${t.name} ${String(t.input.command || t.input.file_path || '').slice(0, 120)}`);
  }
  rec.at = Date.now();
  save(rec);
  return rec;
}

// relay_health: every Claude worker (or the one asked for) for the project at cwd. force = ignore the 6-hour rule.
async function run({ cwd, account = '', force = true, onProgress = () => {}, signal = null } = {}) {
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return { ok: false, text: `relay_health needs cwd, an existing absolute project folder (got: ${cwd || 'nothing'}).`, isError: true };
  const pc = project.loadConfig(cwd);
  if (pc.error) return { ok: false, text: pc.error, isError: true };
  const config = pc.config;
  const root = rootOf(cwd, config);
  let workers = store.load().filter(isClaudeWorker);
  if (account) {
    const want = String(account).trim().toLowerCase();
    workers = workers.filter((w) => w.name.toLowerCase() === want || (w.email || '').toLowerCase() === want);
    if (!workers.length) return { ok: false, text: `No signed-in Claude worker account "${account}" (relay_status lists them).`, isError: true };
  }
  if (!workers.length) return { ok: false, text: 'No signed-in Claude worker accounts to check.', isError: true };
  const due = workers.filter((w) => force || !latest(w.name, root) || Date.now() - latest(w.name, root).at >= EVERY_MS());
  if (due.length) onProgress(`Checking ${due.map((w) => w.email || w.name).join(', ')}…`);
  const recs = await Promise.all(due.map((w) => checkOne(w, cwd, config, { signal }).catch((e) => ({ account: w.name, root, at: Date.now(), results: [], trust: trustOf(w, root), error: e.message }))));
  const all = workers.map((w) => recs.find((r) => r.account === w.name) || latest(w.name, root));
  const checks = checksOf(config);
  const lines = [
    `Worker health for ${root}${config.file ? '' : ' (no .relay/project.json)'}: ${checks.length ? `${checks.length} health_check${checks.length > 1 ? 's' : ''} (${checks.map((c) => c.cmd).join(' | ')})` : 'no health_checks in the project config, so only workspace trust was checked'}.`,
  ];
  const fixLines = [];
  for (const [i, w] of workers.entries()) {
    const rec = all[i];
    lines.push(`  - ${w.email || w.name}: ${summary(rec)}`);
    for (const r of (rec && rec.results) || []) lines.push(`      ${r.status === 'allowed' ? (r.exit === 0 ? 'ok     ' : 'FAILED ') : r.status === 'refused' ? 'REFUSED' : 'NOT RUN'} ${r.cmd}${r.status === 'allowed' ? ` (exit ${r.exit == null ? '?' : r.exit})` : ''}`);
    if (rec && rec.extraCalls) lines.push(`      note: the check job also ran ${rec.extraCalls.join('; ')}`);
    if (rec) fixLines.push(...fixes(rec, w));
  }
  if (fixLines.length) lines.push('', 'To fix (Relay does not change trust or permissions itself; tell the user):', ...fixLines.map((f) => `  - ${f}`));
  return { ok: true, text: lines.join('\n'), records: all };
}

// The tray app: every project with health_checks that had a job in the last 7 days, accounts not checked for 6 h.
async function runDue({ cwds = null } = {}) {
  let list = cwds;
  if (!list) {
    try { list = [...new Set(require('./jobs').list().map((j) => j.cwd).filter(Boolean))]; } catch { list = []; }
  }
  const roots = new Set();
  const done = [];
  for (const cwd of list) {
    if (!fs.existsSync(cwd)) continue;
    const pc = project.loadConfig(cwd);
    if (pc.error || !pc.config.healthChecks.length) continue;
    const root = rootOf(cwd, pc.config);
    if (roots.has(root)) continue;
    roots.add(root);
    try { done.push(await run({ cwd, force: false })); } catch { /* the next round tries again */ }
  }
  return done;
}

// Which workers a job should avoid: those that refused a command the job's text names (by its program name, e.g.
// "ssh", "latexmk", "researchctl") at their last check, or that have not trusted the project folder (read now; an
// account folder without a .claude.json counts as unknown, not untrusted). Only for projects with health_checks.
// Returns { avoid: Set of account names, warning, note, needed }. When every candidate is unhealthy nothing is
// avoided and `warning` says why (the job still runs).
function choose({ cwd, config, text, workers }) {
  const root = rootOf(cwd, config);
  const checks = checksOf(config);
  const hay = String(text || '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needed = checks.filter((c) => c.name && new RegExp(`(^|[^A-Za-z0-9_.-])${esc(c.name)}($|[^A-Za-z0-9_-])`, 'i').test(hay)).map((c) => c.name);
  const bad = new Map();
  for (const w of workers.filter(isClaudeWorker)) {
    const rec = latest(w.name, root);
    const trust = trustOf(w, root); // read now (a cheap file read): a fixed trust counts at once
    const why = [];
    const refused = ((rec && rec.results) || []).filter((r) => r.status === 'refused' && needed.includes(r.name)).map((r) => r.name);
    if (refused.length) why.push(`refused ${[...new Set(refused)].join(', ')}`);
    if (trust.known && !trust.trusted) why.push('workspace untrusted');
    if (why.length) bad.set(w.name, { who: w.email || w.name, why: why.join(', '), rec: { ...(rec || { account: w.name, results: [] }), trust }, acct: w });
  }
  const candidates = workers.filter(isClaudeWorker);
  if (!bad.size) return { avoid: new Set(), warning: '', note: '', needed };
  if (bad.size < candidates.length) {
    return { avoid: new Set(bad.keys()), warning: '', note: `health: not on ${[...bad.values()].map((b) => `${b.who} (${b.why})`).join('; ')} (last health check)`, needed };
  }
  const fix = [...bad.values()].flatMap((b) => fixes(b.rec, b.acct)).slice(0, 4).join(' ');
  return {
    avoid: new Set(), needed, note: '',
    warning: `HEALTH WARNING: every worker failed its last health check for this job: ${[...bad.values()].map((b) => `${b.who} ${b.why}`).join('; ')}. It runs anyway; expect refusals. ${fix}`.trim(),
  };
}

// For relay_status and the panel: the latest record per account (for one project root, or the newest of any).
function forAccount(account, root = null) {
  const all = Object.values(readAll()).filter((r) => r.account === account && (!root || r.root === path.resolve(root)));
  return all.sort((a, b) => b.at - a.at)[0] || null;
}

module.exports = { commandName, checksOf, trustOf, prompt, parseReport, problems, summary, fixes, checkOne, run, runDue, choose, latest, forAccount, rootOf, file, EVERY_MS };
