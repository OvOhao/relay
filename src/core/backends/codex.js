'use strict';
// The OpenAI Codex CLI backend: a worker is a `codex exec --json` run, scoped to one ChatGPT login by CODEX_HOME.
// READ-ONLY jobs only. Every run, new or resumed, gets:
//   - its own CODEX_HOME (the account's configDir) and GIT_CONFIG_GLOBAL=/dev/null;
//   - the read-deny permission profile below (home denied, the job folder and the few program folders Codex needs
//     readable, nothing writable) and sandbox read-only, re-passed on every resume (resume forgets them);
//   - $CODEX_HOME/config.toml ignored, execpolicy rules ignored, plugins / apps / browser / computer use off, no MCP
//     servers, approvals never. Never any --dangerously-bypass-* flag.
// Relay never writes into a Codex home: everything is passed with -c. Before each run a canary check (`codex sandbox`
// with the same profile, no model call) must show that credentials cannot be read and the job folder can; after it,
// the session's rollout file is checked for the profile that was really applied.
// Interface: see ./index.js. Extras: preflight, verifyRun, resumeAcrossAccounts, register.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn: spawnProc } = require('child_process');
const store = require('../store');
const { cleanEnv, killTree } = require('../claude');

const id = 'codex';
const PROFILE = 'relay-review';
// A Codex session lives in one CODEX_HOME's sessions/ folder: it cannot be resumed under another account.
const resumeAcrossAccounts = false;
const FEATURES_OFF = ['plugins', 'apps', 'browser_use', 'computer_use'];

// ---- the binary ----
function findCodex() {
  const h = os.homedir();
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), path.join(h, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD').toLowerCase().split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, `codex${ext}`);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  throw Object.assign(new Error('The Codex CLI was not found. Install it (https://github.com/openai/codex), then try again.'), { code: 'codex_missing' });
}

function codexCmd() {
  const raw = process.env.RELAY_CODEX_CMD; // test hook: JSON array or a single path
  if (raw) return raw.trim().startsWith('[') ? JSON.parse(raw) : [raw];
  const custom = store.loadSettings().codexPath;
  return [custom || findCodex()];
}

function spawn(args, opts = {}) {
  const [cmd, ...pre] = codexCmd();
  const { group, ...rest } = opts;
  const own = !!group && process.platform !== 'win32';
  const child = spawnProc(cmd, [...pre, ...args], { windowsHide: true, shell: /\.(cmd|bat)$/i.test(cmd), ...(own ? { detached: true } : {}), ...rest });
  if (own) child.relayGroup = true;
  return child;
}

// Strip the host's OpenAI / Codex variables (an API key would bill the wrong thing, a CODEX_HOME would pick the wrong
// login) on top of the Claude ones, then point Codex at this account's home.
const HOST_VARS = /^(OPENAI_|CODEX_)/;
function env(acct, extra = {}) {
  const base = cleanEnv();
  for (const k of Object.keys(base)) if (HOST_VARS.test(k)) delete base[k];
  return { ...base, CODEX_HOME: acct.configDir, GIT_CONFIG_GLOBAL: '/dev/null', ...extra };
}

const prepare = () => {}; // nothing to sync: Relay never writes into a Codex home

// ---- the read-deny profile ----
const inside = (p, root) => { const a = path.resolve(p); const r = path.resolve(root); return a === r || a.startsWith(r + path.sep); };

// Folders under $HOME that hold the Codex program itself: it re-executes itself inside the sandbox, so they must stay
// readable even though $HOME is denied. Only program folders: never $HOME itself, ~/.codex, or Relay's folder.
function programPaths(cmd = codexCmd()) {
  const h = os.homedir();
  const out = new Set();
  const add = (p) => {
    if (!p || !inside(p, h) || inside(h, p)) return; // outside home: readable through the rules below; home or above: never
    if (path.resolve(p) === path.join(h, '.codex') || inside(p, store.home()) || inside(store.home(), p)) return;
    out.add(path.resolve(p));
  };
  for (const exe of cmd.slice(0, 1)) {
    if (!path.isAbsolute(exe)) continue;
    add(path.dirname(exe)); // e.g. ~/.local/bin (the whole folder: the link alone is not enough)
    let real = exe;
    try { real = fs.realpathSync(exe); } catch { /* keep the given path */ }
    const m = /^(.*[\\/]packages[\\/]standalone)(?:[\\/]|$)/.exec(real);
    add(m ? m[1] : path.dirname(path.dirname(real))); // ~/.codex/packages/standalone, or <prefix> of <prefix>/bin/codex
  }
  return [...out];
}

// Folders a job may not run in: home itself or anything above it, and the folders holding credentials (the job folder
// is made readable, which would undo the deny for anything inside it).
function unsafeCwd(cwd) {
  const h = os.homedir();
  if (inside(h, cwd)) return 'it is your home folder or contains it';
  const sensitive = [store.home(), path.join(h, '.codex'), path.join(h, '.ssh'), path.join(h, '.claude'), path.join(h, '.config'), path.join(h, 'Library'), path.join(h, '.aws'), path.join(h, '.gnupg')];
  for (const s of sensitive) if (inside(cwd, s) || inside(s, cwd)) return `it is or contains ${s}`;
  try { if (fs.readdirSync(h).some((n) => /^\.claude/.test(n) && inside(path.join(h, n), cwd))) return 'it contains a Claude configuration folder'; } catch { /* home unreadable */ }
  return null;
}

// path -> access, in the order written. The more specific path wins; equal paths: deny > write > read.
// `hidePaths`: absolute paths inside the job folder the job may not read (hide_paths), denied after the folder itself.
function profileEntries(cwd, hidePaths = []) {
  const h = os.homedir();
  const e = { ':minimal': 'read', ':workspace_roots': 'read' };
  for (const p of ['/opt/homebrew', '/usr/local']) if (fs.existsSync(p)) e[p] = 'read'; // git, rg, node, python
  e[h] = 'deny';
  e[path.resolve(store.home())] = 'deny'; // Relay's own folder, also when RELAY_HOME is outside home
  for (const p of programPaths()) e[p] = 'read';
  if (cwd) e[path.resolve(cwd)] = 'read'; // the job folder, also on resume (no -C there)
  for (const p of hidePaths || []) e[path.resolve(p)] = 'deny';
  return e;
}

const tomlStr = (s) => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string
function profileArgs(cwd, hidePaths = []) {
  const fsTable = Object.entries(profileEntries(cwd, hidePaths)).map(([p, a]) => `${tomlStr(p)}=${tomlStr(a)}`).join(',');
  return ['-c', `permissions={${PROFILE}={filesystem={${fsTable}}}}`, '-c', `default_permissions=${tomlStr(PROFILE)}`];
}

// Flags every run gets, new or resumed.
function isolationArgs(cwd, hidePaths = []) {
  return [
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    ...FEATURES_OFF.flatMap((f) => ['--disable', f]),
    '-c', 'approval_policy="never"',
    '-c', 'mcp_servers={}',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null"}',
    ...profileArgs(cwd, hidePaths),
  ];
}

// Claude names make no sense to Codex: refuse them instead of failing at the server.
const CLAUDE_MODEL = /^(haiku|sonnet|opus|fable|default|claude[-.].*|.*\[1m\])$/i;
const isClaudeModel = (m) => CLAUDE_MODEL.test(String(m || '').trim());

const fail = (code, message) => Object.assign(new Error(message), { code });

// isolated (an isolated job): the repository's git data is denied too (history would show other reviews). Home is
// denied anyway, but a .git inside the job folder (cwd is the git root) or a repository outside home is not.
function buildArgs({ sessionId, model, effort, permissionMode, appendSystemPrompt = '', cwd, hidePaths = [], isolated = false } = {}) {
  if (permissionMode !== 'plan') throw fail('codex_read_only', 'Codex workers only run read-only jobs (read_only: true).');
  if (!model) throw fail('codex_model_required', 'This Codex account has no model set: Codex needs one (e.g. `relay add-codex <name> <home> --model <id>`).');
  if (isClaudeModel(model)) throw fail('codex_model', `"${model}" is a Claude model; a Codex worker needs a Codex model id.`);
  const common = [
    '--json', '-m', model,
    ...(effort ? ['-c', `model_reasoning_effort=${tomlStr(effort)}`] : []),
    ...(appendSystemPrompt ? ['-c', `developer_instructions=${tomlStr(appendSystemPrompt)}`] : []),
    ...isolationArgs(cwd, isolated && cwd ? [...(hidePaths || []), ...require('../project').gitDataDirs(cwd)] : hidePaths),
  ];
  if (sessionId) return ['exec', 'resume', ...common, sessionId, '-']; // started in the job folder: resume has no -C
  // No `-s read-only` here: the -s flag overrides default_permissions, and the run then gets the stock read-only
  // sandbox that can read the whole disk (seen live on codex-cli 0.153.4: turn_context had no active profile).
  // `-c sandbox_mode="read-only"` (in isolationArgs) plus the profile is what resume uses, and it applies the profile.
  return ['exec', ...common, ...(cwd ? ['-C', cwd] : []), '-'];
}

// ---- events ----
const short = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function parseEvent(ev, acct, ctx = {}) {
  const account = acct.name;
  const seen = ctx.seen || (ctx.seen = new Set());
  if (ev.type === 'thread.started') return [{ kind: 'init', account, model: ctx.model || '' }];
  if (ev.type === 'turn.completed') return [{ kind: 'result', account, ok: true }];
  if (ev.type === 'turn.failed') return [{ kind: 'result', account, ok: false }];
  if (ev.type === 'error') return [{ kind: 'notice', level: 'warn', code: 'codex_error', text: short(ev.message, 300) }];
  if (!/^item\.(started|updated|completed)$/.test(ev.type || '') || !ev.item) return [];
  const it = ev.item;
  const once = (key) => { if (seen.has(key)) return false; seen.add(key); return true; };
  switch (it.type) {
    case 'agent_message':
      return ev.type === 'item.completed' && String(it.text || '').trim() ? [{ kind: 'text', account, text: it.text }] : [];
    case 'command_execution':
      return once(`cmd:${it.id}`) ? [{ kind: 'tool', account, name: 'Bash', summary: short(it.command), input: { command: String(it.command || '').slice(0, 4000) } }] : [];
    case 'file_change':
      return once(`fc:${it.id}`) ? (it.changes || []).map((c) => ({ kind: 'tool', account, name: 'Edit', summary: short(c.path), input: { file_path: String(c.path || '') } })) : [];
    case 'mcp_tool_call':
      return once(`mcp:${it.id}`) ? [{ kind: 'tool', account, name: `mcp__${it.server}__${it.tool}`, summary: short(JSON.stringify(it.arguments || {})) }] : [];
    case 'collab_tool_call':
      return once(`ag:${it.id}`) ? [{ kind: 'tool', account, name: 'Agent', summary: short(it.tool || it.prompt || '') }] : [];
    case 'web_search':
      return once(`ws:${it.id}`) ? [{ kind: 'tool', account, name: 'WebSearch', summary: short(it.query) }] : [];
    case 'error':
      return ev.type === 'item.completed' ? [{ kind: 'notice', level: 'warn', code: 'codex_error', text: short(it.message, 300) }] : [];
    default:
      return [];
  }
}

const sessionIdFrom = (ev) => (ev.type === 'thread.started' && ev.thread_id) || null;
const limitFromEvent = () => null; // the stream carries no rate-limit events
// The run's result: turn.completed / turn.failed; an `error` event stands in until one comes (it may be followed by a
// successful reconnect), and never replaces a turn's own result.
function resultFrom(ev, prev = null) {
  if (ev.type === 'turn.completed') return { ok: true, usage: ev.usage || null };
  if (ev.type === 'turn.failed') return { ok: false, message: String(ev.error?.message || 'turn failed') };
  if (ev.type === 'error' && (!prev || prev.provisional)) return { ok: false, provisional: true, message: String(ev.message || '') };
  return null;
}

// Texts from codex-rs/protocol/src/error.rs (UsageLimitReachedError, QuotaExceeded) and login/src/auth/manager.rs.
const LIMIT_RE = /(you've hit your usage limit|usage_limit_reached|quota exceeded)/i;
const AUTH_RE = /(401 unauthorized|missing bearer|sign in again|not logged in|refresh token (has expired|was already used|was revoked)|access token could not be refreshed)/i;
const RETRYING_RE = /^reconnecting\.\.\./i;

// "try again at 5:02 PM" (today, local time) or "try again at Nov 15th, 2026 5:02 PM".
function parseCodexReset(text, nowMs = Date.now()) {
  const m = /try again at\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([AP])M/i.exec(String(text || ''));
  if (!m) return null;
  const [, mon, day, year, hh, mm, ap] = m;
  const hour = (Number(hh) % 12) + (ap.toUpperCase() === 'P' ? 12 : 0);
  const now = new Date(nowMs);
  let t;
  if (mon) {
    const mi = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(mon.toLowerCase());
    if (mi < 0) return null;
    t = new Date(Number(year), mi, Number(day), hour, Number(mm), 0, 0);
  } else {
    t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, Number(mm), 0, 0);
    if (t.getTime() <= nowMs) t.setDate(t.getDate() + 1);
  }
  return t.getTime() / 1000;
}

const detectLimit = (text) => {
  const limited = LIMIT_RE.test(String(text || ''));
  return { limited, resetAt: limited ? parseCodexReset(text) : null };
};
const detectAuth = (text) => AUTH_RE.test(String(text || '')) && !RETRYING_RE.test(String(text || '').trim());

function outcome({ sid, result, stderr = '', code }) {
  if (result && result.ok) return { kind: 'done', sid, result };
  const text = (result && result.message) || String(stderr).trim();
  if (detectLimit(text).limited) return { kind: 'limited', sid, resetAt: parseCodexReset(text), limitType: 'usage', text };
  if (detectAuth(text)) return { kind: 'auth', sid, text };
  if (require('../parse').looksLikeContextLimit(text)) return { kind: 'error', code: 'context_limit', sid, text: short(text, 600) };
  return { kind: 'error', sid, text: short(text, 600) || `codex exited with code ${code}` };
}

// ---- one-off commands ----
function runCmd(args, acct, { timeoutMs = 30000, cwd = os.tmpdir(), input = null } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(args, { cwd, env: env(acct, { RELAY_TAKEOVER: 'codex' }), stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: e.message, error: e.message });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
    if (input != null) child.stdin.end(input);
  });
}

// `codex login status`: "Logged in using ChatGPT" (exit 0) / "Not logged in" (exit 1). Local, no model call.
async function loginStatus(acct, timeoutMs = 20000) {
  if (!acct.configDir || !fs.existsSync(acct.configDir)) return { loggedIn: false };
  const r = await runCmd(['login', 'status'], acct, { timeoutMs });
  const text = `${r.out}\n${r.err}`;
  if (r.error) return { loggedIn: false, error: r.error };
  if (r.timedOut) return { loggedIn: false, error: '`codex login status` timed out' };
  if (/not logged in/i.test(text)) return { loggedIn: false };
  if (r.code === 0 && /logged in/i.test(text)) return { loggedIn: true };
  return { loggedIn: false, error: short(text, 160) || `codex login status exited with ${r.code}` };
}

// ---- usage: `codex app-server` JSON-RPC account/rateLimits/read (+ account/read for e-mail and plan). No model call.
function rowsFromRateLimits(rl) {
  const rows = [];
  for (const [key, w] of [['primary', rl?.primary], ['secondary', rl?.secondary]]) {
    if (!w || w.usedPercent == null) continue;
    const mins = Number(w.windowDurationMins) || 0;
    const label = mins >= 6 * 24 * 60 ? 'Current week' : mins && mins <= 24 * 60 ? `Current session (${Math.round(mins / 60)}h)` : `Codex ${key} window`;
    const resetsAt = Number(w.resetsAt) > 0 ? Number(w.resetsAt) : null;
    rows.push({ label, pct: Number(w.usedPercent), resetsAt, resetsText: '', windowMins: mins || null });
  }
  if (!rows.length) return null;
  const week = rows.find((r) => r.windowMins >= 6 * 24 * 60) || null;
  const session = rows.find((r) => r !== week && r.windowMins && r.windowMins <= 24 * 60) || null;
  return { session, week, others: rows.filter((r) => r !== session && r !== week), planType: rl?.planType || null, limitReached: rl?.rateLimitReachedType || null };
}

function appServer(acct, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(['app-server'], { cwd: os.tmpdir(), env: env(acct, { RELAY_TAKEOVER: 'usage' }), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      return resolve({ error: e.message });
    }
    const got = {};
    let done = false;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); try { child.stdin.end(); } catch { /* gone */ } child.kill(); resolve(res); };
    const timer = setTimeout(() => finish({ error: `timed out after ${Math.round(timeoutMs / 1000)} s`, timedOut: true, ...got }), timeoutMs);
    const send = (o) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`); } catch { /* closed */ } };
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', () => finish({ error: 'codex app-server stopped', ...got }));
    require('readline').createInterface({ input: child.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
        send({ id: 3, method: 'account/read', params: { refreshToken: false } });
      } else if (m.id === 2 || m.id === 3) {
        got[m.id === 2 ? 'limits' : 'account'] = m.error ? { error: m.error } : m.result;
        if (got.limits && got.account) finish(got);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'relay', version: '0.1.0' } } });
  });
}

const USAGE_TIMEOUT_MS = () => Number(process.env.RELAY_USAGE_TIMEOUT_MS || 60000);
async function readUsage(acct, timeoutMs = USAGE_TIMEOUT_MS()) {
  const r = await appServer(acct, timeoutMs);
  const data = r.limits && !r.limits.error ? rowsFromRateLimits(r.limits.rateLimits) : null;
  const acc = r.account && !r.account.error ? (r.account.account || r.account) : null;
  if (data) {
    const patch = {};
    if (acc && acc.email && acc.email !== acct.email) patch.email = acc.email;
    const plan = acc?.planType || data.planType;
    if (plan && plan !== acct.plan) patch.plan = plan;
    if (Object.keys(patch).length && store.get(acct.name)) { try { store.update(acct.name, patch); } catch { /* the reading still counts */ } }
    return { data };
  }
  const why = r.limits?.error ? short(JSON.stringify(r.limits.error), 200) : r.error || 'no rate limits in the answer';
  return { error: why, authFailed: detectAuth(why) || (r.account && !r.account.error && r.account.account === null), timedOut: !!r.timedOut };
}

// ---- the canary check before every run ----
const canaryFile = () => path.join(store.home(), 'canary', 'id_canary');
function ensureCanary() {
  const f = canaryFile();
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `relay canary ${crypto.randomBytes(16).toString('hex')}\nnot a credential: Codex workers must not be able to read this file\n`, { mode: 0o600 });
  }
  return f;
}

// A file in the job folder Relay can read itself: the sandbox must let the worker read it too.
function sampleFile(cwd) {
  try {
    const names = fs.readdirSync(cwd).sort((a, b) => (a.startsWith('.') - b.startsWith('.')) || a.localeCompare(b));
    for (const n of names) {
      const p = path.join(cwd, n);
      try { const st = fs.statSync(p); if (st.isFile() && st.size < 50e6) { fs.accessSync(p, fs.constants.R_OK); return p; } } catch { /* next */ }
    }
  } catch { /* unreadable: the ls probe fails too */ }
  return '';
}

// Each probe only checks whether access is allowed; output goes to /dev/null, nothing is printed or copied.
const PROBE = [
  'cat "$1" >/dev/null 2>&1 && exit 10', // Relay's canary: must be unreadable
  'ls "$2" >/dev/null 2>&1 && exit 11', // ~/.ssh
  'ls "$3" >/dev/null 2>&1 && exit 12', // ~/Library/Keychains
  'ls "$4" >/dev/null 2>&1 && exit 13', // ~/.claude
  'ls "$5" >/dev/null 2>&1 && exit 14', // this account's CODEX_HOME
  'ls "$6" >/dev/null 2>&1 && exit 15', // Relay's Claude sign-in folders
  'ls "$7" >/dev/null 2>&1 || exit 20', // the job folder: must be listable
  '[ -z "$8" ] || cat "$8" >/dev/null 2>&1 || exit 21', // and a file in it readable
  'echo RELAY-PREFLIGHT-OK',
].join('\n');
const PROBE_FAIL = {
  10: 'Relay\'s canary file under ~/.relay was readable', 11: '~/.ssh was listable', 12: '~/Library/Keychains was listable',
  13: '~/.claude was listable', 14: 'the account\'s CODEX_HOME was listable', 15: 'Relay\'s accounts folder was listable',
  20: 'the job folder was not listable', 21: 'a file in the job folder was not readable',
};

async function preflight(acct, { cwd } = {}) {
  const bad = (text) => ({ ok: false, code: 'codex_sandbox_unsafe', text: `Codex sandbox check failed, job refused (nothing was started): ${text}` });
  if (!cwd || !path.isAbsolute(cwd)) return bad('no absolute job folder');
  const unsafe = unsafeCwd(cwd);
  if (unsafe) return bad(`the job folder ${cwd} cannot be used for a Codex job: ${unsafe}.`);
  if (!acct.configDir || !fs.existsSync(acct.configDir)) return bad(`the account's CODEX_HOME ${acct.configDir || '(none)'} does not exist.`);
  let canary;
  try { canary = ensureCanary(); } catch (e) { return bad(`could not create the canary file: ${e.message}`); }
  const h = os.homedir();
  const probeArgs = [canary, path.join(h, '.ssh'), path.join(h, 'Library', 'Keychains'), path.join(h, '.claude'), acct.configDir, path.join(store.home(), 'accounts'), cwd, sampleFile(cwd)];
  const args = ['sandbox', ...profileArgs(cwd), '-P', PROFILE, '-C', cwd, '--', '/bin/sh', '-c', PROBE, 'relay-preflight', ...probeArgs];
  const r = await runCmd(args, acct, { cwd, timeoutMs: Number(process.env.RELAY_PREFLIGHT_TIMEOUT_MS || 30000) });
  if (r.error) return bad(r.error);
  if (r.timedOut) return bad('the check timed out');
  if (r.code === 0 && /^RELAY-PREFLIGHT-OK$/m.test(r.out)) return { ok: true, args };
  return bad(PROBE_FAIL[r.code] || `the sandbox probe exited with ${r.code}${r.err.trim() ? `: ${short(r.err, 200)}` : ''}`);
}

// ---- after a run: which profile did Codex really apply? (the session's rollout file) ----
function findRollout(home, sid) {
  const root = path.join(home, 'sessions');
  const want = `-${sid}.jsonl`;
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents.sort((a, b) => b.name.localeCompare(a.name))) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(want)) return p;
      if (e.isDirectory() && depth < 4) { const f = walk(p, depth + 1); if (f) return f; }
    }
    return null;
  };
  return walk(root, 0);
}

// { status: 'ok' | 'violation' | 'unverifiable', text }. Checks every turn of the session (`sinceTurns` skips
// turns checked before), so a resume that lost the profile is caught too.
function verifyRun(acct, sid, { sinceTurns = 0 } = {}) {
  if (!sid) return { status: 'unverifiable', text: 'no session id' };
  const file = findRollout(acct.configDir, sid);
  if (!file) return { status: 'unverifiable', text: 'session rollout file not found' };
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { return { status: 'unverifiable', text: `rollout unreadable: ${e.message}` }; }
  const h = path.resolve(os.homedir());
  const turns = [];
  for (const l of lines) {
    if (!l.includes('"turn_context"')) continue;
    try { const e = JSON.parse(l); if (e.type === 'turn_context') turns.push(e.payload || {}); } catch { /* partial line */ }
  }
  if (!turns.length) return { status: 'unverifiable', text: 'no turn context in the rollout' };
  const problems = [];
  turns.forEach((t, i) => {
    if (i < sinceTurns) return;
    const prof = t.active_permission_profile?.id;
    const entries = t.file_system_sandbox_policy?.entries || t.permission_profile?.file_system?.entries;
    if (prof !== PROFILE) problems.push(`turn ${i + 1}: permission profile ${JSON.stringify(prof ?? null)}`);
    if (!Array.isArray(entries)) { problems.push(`turn ${i + 1}: no file-system policy`); return; }
    if (!entries.some((x) => x.access === 'deny' && x.path?.type === 'path' && path.resolve(x.path.path) === h)) problems.push(`turn ${i + 1}: home is not denied`);
    const writes = entries.filter((x) => x.access === 'write');
    if (writes.length) problems.push(`turn ${i + 1}: writable ${writes.map((x) => x.path?.path || x.path?.value?.kind).join(', ')}`);
    const mode = t.sandbox_policy?.type;
    if (mode && mode !== 'read-only') problems.push(`turn ${i + 1}: sandbox ${mode}`);
  });
  if (problems.length) return { status: 'violation', text: problems.join('; '), turns: turns.length };
  return { status: 'ok', text: `profile "${PROFILE}" with home denied and nothing writable, on ${turns.length - sinceTurns} turn(s)`, turns: turns.length };
}

// ---- registering an existing Codex login (CLI and server) ----
async function register({ name, codexHome, model }) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(n)) throw new Error('Name: letters, digits, ".", "_" or "-", up to 41 characters.');
  if (store.get(n)) throw new Error(`"${n}" already exists.`);
  const dir = path.resolve(String(codexHome || '').replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!codexHome || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Codex home not found: ${dir}`);
  if (dir === path.join(os.homedir(), '.codex')) throw new Error('~/.codex is your own Codex: give Relay a separate CODEX_HOME (e.g. ~/.relay/codex/<name>, signed in with `CODEX_HOME=<dir> codex login`).');
  if (store.accountRoots().some((r) => inside(dir, r))) throw new Error('A Codex home must not be inside a Relay accounts folder (those are probed with `claude`). Use e.g. ~/.relay/codex/<name>.');
  if (store.load().some((a) => path.resolve(a.configDir) === dir)) throw new Error('That folder is already registered.');
  const m = store.cleanModel(model);
  if (!m) throw new Error('A Codex account needs a model id (--model <id>): its default model may be refused.');
  if (isClaudeModel(m)) throw new Error(`"${m}" is a Claude model; give a Codex model id.`);
  const acct = { ...store.newAccount(n, dir), provider: 'codex', model: m };
  const info = await loginStatus(acct);
  store.upsert({ ...acct, needsLogin: !info.loggedIn });
  return { name: n, configDir: dir, model: m, loggedIn: !!info.loggedIn, error: info.error || null };
}

module.exports = {
  id, PROFILE, resumeAcrossAccounts, buildArgs, env, spawn, killTree, prepare, parseEvent, sessionIdFrom, limitFromEvent,
  resultFrom, outcome, detectLimit, detectAuth, readUsage, loginStatus, preflight, verifyRun, register,
  // for tests and the docs
  codexCmd, profileEntries, profileArgs, isolationArgs, programPaths, unsafeCwd, parseCodexReset, rowsFromRateLimits, isClaudeModel, canaryFile, findRollout,
};
