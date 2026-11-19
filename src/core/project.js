'use strict';
// Per-project rules Relay enforces around a worker run, and the helpers for them:
//   - the project config, .relay/project.json in the job folder or a parent up to the git root (docs/project-config.md):
//     rules_file (appended to every worker's system prompt), protected_paths (no job may change them), post_checks
//     (commands Relay runs after a job), health_checks (parsed and kept for later);
//   - path patterns (globs relative to a folder), folder snapshots before / after a run and what changed;
//   - the worker's structured summary (a ```relay-summary block at the end of its report);
//   - the isolation breach scan (a job told to stay out of some paths that touched them anyway);
//   - writing the worker's report to a file for it (output_file), atomically.
// Nothing here starts a worker: core/workers.js calls these before and after a run.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const CONFIG_REL = path.join('.relay', 'project.json');
const RULES_MAX_BYTES = 20 * 1024;
const CHECK_TIMEOUT_SEC = 300;
const CHECK_TAIL_LINES = 20;
const MAX_EACH_RUNS = 50;
const EXPAND_MAX = 200000; // expandPattern: files a protected pattern may cover at most

const toSlash = (p) => String(p).split(path.sep).join('/');
const inside = (p, root) => { const a = path.resolve(p); const r = path.resolve(root); return a === r || a.startsWith(r + path.sep); };
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// ---- path patterns ----
// A pattern is a path relative to some folder, with optional globs: `*` and `?` within one path segment, `**` across
// segments. A pattern that names a folder also covers everything inside it ("ideas/alpha" = "ideas/alpha/**").
const hasGlob = (s) => /[*?]/.test(s);

// The pattern in canonical form ("a/b/*.md"), or { error }.
function cleanPattern(raw, what = 'path') {
  const s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
  if (!s) return { error: `${what}: empty path.` };
  if (/[\n\r\0]/.test(s)) return { error: `${what}: a path may not contain line breaks (got ${JSON.stringify(clip(s, 60))}).` };
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.startsWith('~')) return { error: `${what} must be relative to cwd (got: ${clip(s, 80)}).` };
  const segs = s.split('/').filter((x) => x && x !== '.');
  if (segs.some((x) => x === '..')) return { error: `${what} must stay inside cwd (got: ${clip(s, 80)}).` };
  if (!segs.length) return { error: `${what} must name something inside cwd, not cwd itself (got: ${clip(s, 80)}).` };
  return { pattern: segs.join('/') };
}

function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
const reCache = new Map();
const reFor = (p) => { if (!reCache.has(p)) reCache.set(p, globRe(p)); return reCache.get(p); };

// Does the pattern cover this path (both relative, "/"-separated)? Also true when it names a folder the path is in.
function matchPath(pattern, rel) {
  const r = toSlash(rel).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!r || r === '..' || r.startsWith('../')) return false;
  const re = reFor(pattern);
  if (re.test(r)) return true;
  const segs = r.split('/');
  for (let k = 1; k < segs.length; k++) if (re.test(segs.slice(0, k).join('/'))) return true;
  return false;
}

// The literal folder a pattern starts with ("ideas/*/runs" -> "ideas"; "*.md" -> "").
const literalPrefix = (pattern) => { const segs = pattern.split('/'); const out = []; for (const s of segs) { if (hasGlob(s)) break; out.push(s); } return out.join('/'); };

// Every file (not folder) under `base` the pattern covers, also files git ignores; symlinks are not followed and
// .git is skipped. At most `limit` files.
function expandPattern(base, pattern, { limit = EXPAND_MAX } = {}) {
  const segs = pattern.split('/');
  const out = new Set();
  const seen = new Set();
  const addTree = (abs) => {
    if (out.size >= limit) return;
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isFile() || st.isSymbolicLink()) { out.add(abs); return; }
    if (!st.isDirectory()) return;
    let ents = [];
    try { ents = fs.readdirSync(abs); } catch { return; }
    for (const n of ents) { if (n !== '.git') addTree(path.join(abs, n)); }
  };
  const rec = (abs, i) => {
    if (out.size >= limit) return;
    const key = `${abs}\0${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (i >= segs.length) { addTree(abs); return; }
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (!st.isDirectory()) { if (segs.slice(i).every((s) => s === '**')) out.add(abs); return; }
    const seg = segs[i];
    let ents = [];
    if (seg === '**' || hasGlob(seg)) { try { ents = fs.readdirSync(abs).filter((n) => n !== '.git'); } catch { return; } }
    if (seg === '**') {
      rec(abs, i + 1);
      for (const n of ents) rec(path.join(abs, n), i);
    } else if (!hasGlob(seg)) {
      rec(path.join(abs, seg), i + 1);
    } else {
      const re = reFor(seg);
      for (const n of ents) if (re.test(n)) rec(path.join(abs, n), i + 1);
    }
  };
  rec(path.resolve(base), 0);
  return [...out];
}

// ---- the project config ----
function gitRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// The folders searched for .relay/project.json, nearest first: cwd, then its parents up to the git root (only cwd
// when it is not in a git repository). Relay's own home folder is never read as a project config.
function configCandidates(cwd) {
  const start = path.resolve(cwd);
  const top = gitRoot(start);
  const out = [start];
  if (top && top !== start) {
    let dir = start;
    while (dir !== top) { dir = path.dirname(dir); out.push(dir); }
  }
  let relayHome = '';
  try { relayHome = path.resolve(require('./store').home()); } catch { /* no store in a bare helper test */ }
  return out.filter((d) => path.join(d, '.relay') !== relayHome);
}

const empty = () => ({ file: null, root: null, rules: null, protected: [], postChecks: [], healthChecks: [], requireScope: false, isolatedHide: [] });

// { config } or { error }. config: { file, root, rules: { file, text, truncated, bytes } | { file, missing } | null,
// protected: [{ pattern, appendOnly }], postChecks: [{ name, cmd, when, each, timeoutSec }], healthChecks: [...],
// requireScope: every job that may change files must name a scope (or write_paths / output_file),
// isolatedHide: patterns added to hide_paths of every isolated job in this project }.
// Paths in the file are relative to `root`, the folder that holds .relay/.
function loadConfig(cwd) {
  const root = configCandidates(cwd).find((d) => fs.existsSync(path.join(d, CONFIG_REL)));
  if (!root) return { config: empty() };
  const file = path.join(root, CONFIG_REL);
  const bad = (why) => ({ error: `Relay could not use the project config ${file}: ${why} Fix the file (format: docs/project-config.md in Relay); nothing was started.` });
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return bad(`${e.message}.`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('it must hold one JSON object.');
  const config = { ...empty(), file, root };

  if (raw.rules_file != null && raw.rules_file !== '') {
    if (typeof raw.rules_file !== 'string') return bad('rules_file must be a path (a string).');
    const p = path.resolve(root, raw.rules_file);
    try {
      const buf = fs.readFileSync(p);
      const truncated = buf.length > RULES_MAX_BYTES;
      config.rules = { file: p, text: buf.subarray(0, RULES_MAX_BYTES).toString('utf8'), truncated, bytes: buf.length };
    } catch (e) {
      config.rules = { file: p, missing: true, why: e.code === 'ENOENT' ? 'not found' : e.message };
    }
  }

  const list = (v, what) => (v == null ? [] : Array.isArray(v) ? v : { error: `${what} must be a list.` });
  const prot = list(raw.protected_paths, 'protected_paths');
  if (prot.error) return bad(prot.error);
  for (const p of prot) {
    const glob = typeof p === 'string' ? p : p && typeof p === 'object' ? p.glob || p.path : null;
    const c = cleanPattern(glob, 'protected_paths');
    if (c.error) return bad(c.error);
    config.protected.push({ pattern: c.pattern, appendOnly: !!(p && typeof p === 'object' && p.append_only) });
  }

  const checks = list(raw.post_checks, 'post_checks');
  if (checks.error) return bad(checks.error);
  for (const [i, c] of checks.entries()) {
    if (!c || typeof c !== 'object' || typeof c.cmd !== 'string' || !c.cmd.trim()) return bad(`post_checks[${i}] needs a "cmd" (a shell command).`);
    const when = c.when == null || c.when === '' ? 'always' : String(c.when).trim();
    let whenGlob = null;
    if (when !== 'always') {
      const m = /^changed:(.+)$/.exec(when);
      if (!m) return bad(`post_checks[${i}].when must be "always" or "changed:<glob>" (got: ${clip(when, 60)}).`);
      const g = cleanPattern(m[1], `post_checks[${i}].when`);
      if (g.error) return bad(g.error);
      whenGlob = g.pattern;
    }
    const eachM = /\{each:([^}]+)\}/.exec(c.cmd);
    let each = null;
    if (eachM) {
      const g = cleanPattern(eachM[1], `post_checks[${i}] {each:}`);
      if (g.error) return bad(g.error);
      each = g.pattern;
    }
    const t = Number(c.timeout_sec);
    config.postChecks.push({ name: String(c.name || `check ${i + 1}`).slice(0, 80), cmd: c.cmd, when, whenGlob, each, timeoutSec: Number.isFinite(t) && t > 0 ? t : CHECK_TIMEOUT_SEC });
  }

  if (raw.require_scope != null) {
    if (typeof raw.require_scope !== 'boolean') return bad('require_scope must be true or false.');
    config.requireScope = raw.require_scope;
  }

  const iso = list(raw.isolated_hide_paths, 'isolated_hide_paths');
  if (iso.error) return bad(iso.error);
  for (const g of iso) {
    if (typeof g !== 'string') return bad('isolated_hide_paths must be a list of paths (strings).');
    const c = cleanPattern(g, 'isolated_hide_paths');
    if (c.error) return bad(c.error);
    if (!config.isolatedHide.includes(c.pattern)) config.isolatedHide.push(c.pattern);
  }

  const health = list(raw.health_checks, 'health_checks');
  if (health.error) return bad(health.error);
  for (const [i, h] of health.entries()) {
    if (typeof h === 'string' && h.trim()) config.healthChecks.push({ name: clip(h.trim(), 80), cmd: h.trim() });
    else if (h && typeof h === 'object' && typeof h.cmd === 'string' && h.cmd.trim()) config.healthChecks.push({ name: String(h.name || h.cmd).slice(0, 80), cmd: h.cmd.trim() });
    else return bad(`health_checks[${i}] must be a command (a string) or { "name", "cmd" }.`);
  }
  return { config };
}

// The text Relay appends to the worker's system prompt for the project's rules file ('' when there is none).
function rulesPrompt(config) {
  const r = config && config.rules;
  if (!r || r.missing) return '';
  const where = toSlash(path.relative(config.root, r.file));
  return [
    `Project rules for this folder (from ${where}; Relay adds them to every worker's instructions in this project, follow them):`,
    '',
    r.text.trim(),
    r.truncated ? `\n[Relay: the rules file is ${Math.round(r.bytes / 1024)} KB; only its first 20 KB are shown here. Read the rest in ${r.file} if it matters for your task.]` : '',
  ].filter((x) => x !== '').join('\n');
}

// isolated_hide_paths (relative to the config's root) for a job in `cwd`: { inCwd: patterns relative to cwd (they
// join the job's hide_paths), outside: patterns relative to the root that lie outside cwd (only denied: Read deny
// rules and the sandbox) }. A pattern starting with a glob ("**/decisions.md") covers cwd too: it is in both.
function isolatedHideFor(config, cwd) {
  const out = { inCwd: [], outside: [] };
  if (!config || !config.root || !config.isolatedHide || !config.isolatedHide.length) return out;
  const root = path.resolve(config.root);
  const here = path.resolve(cwd);
  for (const p of config.isolatedHide) {
    if (here === root) { out.inCwd.push(p); continue; }
    const lp = literalPrefix(p);
    const absLp = path.join(root, lp);
    const rest = p.split('/').slice(lp ? lp.split('/').length : 0);
    if (inside(absLp, here)) { // its fixed part is cwd or inside it
      const rel = [toSlash(path.relative(here, absLp)), ...rest].filter(Boolean).join('/');
      if (rel) out.inCwd.push(rel); else out.outside.push(p);
    } else {
      out.outside.push(p);
      // a "**" right after a fixed part above cwd reaches below cwd as well ("**/decisions.md" seen from ideas/gamma)
      if (inside(here, absLp) && rest[0] === '**') out.inCwd.push(rest.join('/'));
    }
  }
  out.inCwd = [...new Set(out.inCwd.filter(Boolean))];
  return out;
}

// The repository's git data for a job in `cwd`: `.git` at the git root (cwd or above), and when that is a worktree's
// ".git" file, the git folder it names and the shared one (commondir). [] outside a git repository.
function gitDataDirs(cwd) {
  const top = gitRoot(cwd);
  if (!top) return [];
  const dot = path.join(top, '.git');
  const dirs = [dot];
  try {
    if (fs.statSync(dot).isFile()) { // a worktree: ".git" names its git folder, which names the shared one
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
      if (m) {
        const gd = path.resolve(top, m[1].trim());
        dirs.push(gd);
        try { dirs.push(path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim())); } catch { /* not a linked worktree */ }
      }
    }
  } catch { /* unreadable: deny the path anyway */ }
  return [...new Set(dirs)];
}

// What an isolated job may not read besides its hide_paths: the repository's git data (`.git` at the git root above
// cwd, and for a worktree the git folders it points to: history would show other reviews), every account's auto
// memory folders (<configDir>/projects/*/memory) and other sessions' transcripts (<configDir>/projects/*/*.jsonl,
// <configDir>/projects/*/*/subagents). { rules: Read deny rules, abs: absolute paths for the sandbox }.
// Claude Code's folder name for a project (cwd): every character other than a-z, A-Z, 0-9 becomes "-"; a name longer
// than 200 characters is cut there and gets "-<hash>" (Claude Code 2.1.32x). Both cwd as given and its real path.
const CC_NAME_MAX = 200;
const ccProjectName = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');
function isOwnProjectFolder(name, cwd) {
  const forms = [path.resolve(cwd)];
  try { forms.push(fs.realpathSync(cwd)); } catch { /* as given */ }
  const n = String(name).toLowerCase();
  return forms.map((f) => ccProjectName(f).toLowerCase()).some((o) => n === o || (o.length > CC_NAME_MAX && n.startsWith(`${o.slice(0, CC_NAME_MAX)}-`)));
}
// Read allow rules for the job's own saved tool outputs (<configDir>/projects/<its project>/<session>/tool-results/):
// outside cwd the Read tool would otherwise ask for permission, which a headless run cannot grant. Deny rules win
// over allow rules, so other sessions' folders denied by isolationDenies stay denied. Both the account's path and
// the real one (a symlinked "projects"); a name over 200 characters ends in "-<hash>": matched with "-*".
function ownToolResultsRules({ cwd, configDirs = [] }) {
  const forms = [path.resolve(cwd)];
  try { forms.push(fs.realpathSync(cwd)); } catch { /* as given */ }
  const names = [...new Set(forms.map(ccProjectName).map((n) => (n.length > CC_NAME_MAX ? `${n.slice(0, CC_NAME_MAX)}-*` : n)))];
  const out = new Set();
  for (const c of new Set(configDirs.filter(Boolean).map((d) => path.resolve(d)))) {
    const bases = [path.join(c, 'projects')];
    try { bases.push(fs.realpathSync(path.join(c, 'projects'))); } catch { /* not there yet */ }
    for (const b of bases) for (const n of names) out.add(absRule('Read', path.join(b, n, '*', 'tool-results', '**')));
  }
  return [...out];
}
const OWN_SESSIONS_MAX = 1500; // session folders listed one by one in the job's own project folder (newest first)

// ownSessions: session ids the job continues (a resumed thread, a wake): their folders stay readable.
function isolationDenies({ cwd, configDirs = [], ownSessions = [] }) {
  const rules = [];
  const abs = [];
  const sessionDeny = { whole: new Set(), sessions: new Map() };
  for (const d of gitDataDirs(cwd)) { rules.push(absRule('Read', d), absRule('Read', `${d}/**`)); abs.push(d); }
  for (const c of [...new Set(configDirs.filter(Boolean).map((d) => path.resolve(d)))]) {
    rules.push(absRule('Read', path.join(c, 'projects', '*', 'memory', '**')));
    // Other sessions' transcripts: <project>/<session>.jsonl and <project>/<session>/subagents/. Not the whole
    // folder: <project>/<session>/tool-results/ holds the job's own large tool outputs, which it reads back.
    // Globs (thousands of files): Claude Code's sandbox takes glob patterns in denyRead.
    const transcripts = path.join(c, 'projects', '*', '*.jsonl');
    const subagents = path.join(c, 'projects', '*', '*', 'subagents');
    rules.push(absRule('Read', transcripts), absRule('Read', subagents), absRule('Read', `${subagents}/**`));
    abs.push(transcripts, subagents);
    // Saved tool outputs (<session>/tool-results/) and every other per-session folder that exists now. Other projects'
    // folders are denied whole; in the job's own project folder each existing session folder is denied one by one
    // (the job's own new session folder appears after the start and stays readable, as do sessions it continues).
    // Real paths (several accounts' "projects" are symlinks to ~/.claude/projects), deduplicated below.
    const projects = path.join(c, 'projects');
    let names = [];
    try { names = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); } catch { /* none */ }
    for (const n of names) {
      let real;
      try { real = fs.realpathSync(path.join(projects, n)); if (!fs.statSync(real).isDirectory()) continue; } catch { continue; }
      if (!isOwnProjectFolder(n, cwd)) { sessionDeny.whole.add(real); continue; }
      let sess = [];
      try { sess = fs.readdirSync(real, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'memory' && !ownSessions.includes(d.name)); } catch { /* none */ }
      for (const d of sess) { const p = path.join(real, d.name); let t = 0; try { t = fs.statSync(p).mtimeMs; } catch { /* 0 */ } sessionDeny.sessions.set(p, t); }
    }
    for (const n of names) { const m = path.join(projects, n, 'memory'); if (fs.existsSync(m)) abs.push(m); }
  }
  for (const d of sessionDeny.whole) { rules.push(absRule('Read', `${d}/**`)); abs.push(d); }
  const sessions = [...sessionDeny.sessions.entries()].sort((a, b) => b[1] - a[1]);
  for (const [d] of sessions.slice(0, OWN_SESSIONS_MAX)) { rules.push(absRule('Read', `${d}/**`)); abs.push(d); }
  return { rules: [...new Set(rules)], abs: [...new Set(abs)], sessionsNotListed: Math.max(0, sessions.length - OWN_SESSIONS_MAX) };
}

// Root-relative (config patterns) and cwd-relative paths of one absolute path.
const relTo = (base, abs) => toSlash(path.relative(base, abs));
const isProtected = (config, abs, { kind = 'changed' } = {}) => {
  if (!config || !config.protected.length) return null;
  const rel = relTo(config.root, abs);
  return config.protected.find((p) => matchPath(p.pattern, rel) && !(p.appendOnly && kind === 'added')) || null;
};

// ---- snapshots: which files a run changed ----
// A folder's file list comes from `git ls-files --cached --others --exclude-standard` (git's tracked and untracked,
// not ignored, files) in a git project. When that fails or times out it is retried once with a longer timeout; only
// then does Relay walk the folder itself, leaving out what .gitignore ignores (`git check-ignore`) and stopping at a
// time budget (the list is then marked truncated). Each list says how it was made (`mode`: git | walk | failed), so
// two lists made differently are never compared file by file (see compareSnapshots).
// In a large repository (~175 000 listed files on a loaded machine) one ls-files took 6-10 s. The timeouts leave room
// for a much busier machine.
const LS_TIMEOUT_MS = () => Number(process.env.RELAY_LS_FILES_TIMEOUT_MS || 120000);
const LS_RETRY_TIMEOUT_MS = () => Number(process.env.RELAY_LS_FILES_RETRY_MS || 300000);
const WALK_BUDGET_MS = () => Number(process.env.RELAY_WALK_BUDGET_MS || 60000);

// Runs git; resolves { code, signal, killed, stdout, stderr, ms } (code null when it could not start or was killed).
function runGit(cwd, args, { input = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try { child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); } catch (e) {
      return resolve({ code: null, signal: null, killed: false, stdout: '', stderr: e.message, ms: 0 });
    }
    const out = [];
    let err = '';
    let killed = false;
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: killed ? null : code, signal, killed, stdout: Buffer.concat(out).toString(), stderr: err.trim(), ms: Date.now() - t0 }); });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// Test hook: RELAY_TEST_LS_FILES_FAIL names a file; while it exists, `git ls-files` counts as failed. Its content is
// how many more calls fail ("always" or empty: every call).
function simulatedFailure() {
  const f = process.env.RELAY_TEST_LS_FILES_FAIL;
  if (!f || !fs.existsSync(f)) return null;
  let left = '';
  try { left = fs.readFileSync(f, 'utf8').trim(); } catch { return null; }
  if (/^\d+$/.test(left)) {
    if (Number(left) <= 0) return null;
    try { fs.writeFileSync(f, String(Number(left) - 1)); } catch { /* best effort */ }
  }
  return { code: 128, signal: null, killed: false, stdout: '', stderr: 'simulated git ls-files failure (test)', ms: 0 };
}

const describeGitError = (e) => `${e.killed ? `timed out after ${Math.round(e.timeoutMs / 1000)} s` : `exit ${e.code}${e.signal ? ` (${e.signal})` : ''}`}${e.stderr ? `: ${clip(e.stderr.replace(/\s+/g, ' '), 200)}` : ''} (${(e.ms / 1000).toFixed(1)} s)`;
const notRepo = (r) => r.code === 128 && /not a git repository/i.test(r.stderr || '');

// Walks the folder (symlinks not followed, .git skipped), breadth first, until `budgetMs` is spent. In a git project
// every level's entries go through `git check-ignore` first, so ignored folders (.venv, caches) are never entered.
async function walkFiles(cwd, { budgetMs = WALK_BUDGET_MS(), git = true } = {}) {
  const t0 = Date.now();
  const names = [];
  let level = [''];
  let filter = git;
  let why = '';
  while (level.length) {
    const entries = [];
    for (const rel of level) {
      if (Date.now() - t0 > budgetMs) return { names, truncated: true, why: `the walk stopped at its ${Math.round(budgetMs / 1000)} s time budget (${names.length} files so far)` };
      let ents = [];
      try { ents = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name === '.git') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        entries.push({ r, dir: e.isDirectory() });
      }
    }
    let ignored = new Set();
    if (filter && entries.length) {
      const left = budgetMs - (Date.now() - t0);
      const res = await runGit(cwd, ['check-ignore', '-z', '--stdin'], { input: entries.map((x) => (x.dir ? `${x.r}/` : x.r)).join('\0'), timeoutMs: Math.max(1000, left) });
      if (res.code === 0) ignored = new Set(res.stdout.split('\0').filter(Boolean).map((x) => x.replace(/\/$/, '')));
      else if (notRepo(res)) filter = false;
      else if (res.code !== 1) { why = `git check-ignore failed (${describeGitError({ ...res, timeoutMs: left })}), so ignored files could not be left out`; return { names, truncated: true, why }; }
    }
    level = [];
    for (const x of entries) {
      if (ignored.has(x.r)) continue;
      if (x.dir) level.push(x.r); else names.push(x.r);
    }
  }
  return { names, truncated: false, why };
}

// { names, complete, git, mode: 'git' | 'walk' | 'failed', truncated, errors: [git failures], why }.
// gitOnly: git ls-files only (mode 'failed' when it fails); walkOnly: the walk only. `log(msg)`: where failures go
// (the job log).
async function listFiles(cwd, { gitOnly = false, walkOnly = false, timeoutMs = 0, log = null } = {}) {
  const errors = [];
  let repo = true;
  if (!walkOnly) {
    for (const t of gitOnly ? [timeoutMs || LS_RETRY_TIMEOUT_MS()] : [timeoutMs || LS_TIMEOUT_MS(), LS_RETRY_TIMEOUT_MS()]) {
      const r = simulatedFailure() || await runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: t });
      if (r.code === 0) return { names: r.stdout.split('\0').filter(Boolean), complete: true, git: true, mode: 'git', truncated: false, errors, why: '' };
      if (notRepo(r)) { repo = false; break; }
      const e = { code: r.code, signal: r.signal, killed: r.killed, stderr: r.stderr, ms: r.ms, timeoutMs: t };
      errors.push(e);
      if (log) log(`git ls-files failed in ${cwd}: ${describeGitError(e)}`);
    }
    if (gitOnly) return { names: [], complete: false, git: false, mode: 'failed', truncated: false, errors, why: `git ls-files failed (${errors.map(describeGitError).join('; ')})` };
  }
  const w = await walkFiles(cwd, { git: repo });
  if (w.truncated && log) log(`folder walk in ${cwd} incomplete: ${w.why}`);
  return { names: w.names, complete: !w.truncated, git: false, mode: 'walk', truncated: w.truncated, errors, why: w.why };
}

// How a list was made, in words.
function listInfoText(info) {
  if (!info) return 'unknown';
  const failed = (info.errors || []).length ? `git ls-files failed (${info.errors.map(describeGitError).join('; ')})` : '';
  if (info.mode === 'git') return failed ? `${failed}, then git ls-files` : 'git ls-files';
  if (info.mode === 'failed') return failed || 'git ls-files failed';
  return `${failed ? `${failed}, so ` : ''}a directory walk${info.truncated ? ` that is incomplete (${info.why})` : ''}`;
}
// Two lists may be compared file by file only when both were made the same way and neither is incomplete.
const comparableLists = (a, b) => !!a && !!b && a.mode === b.mode && a.mode !== 'failed' && !a.truncated && !b.truncated;

const stamp = (abs) => { try { const st = fs.lstatSync(abs); return `${st.size}:${st.mtimeMs}`; } catch { return 'missing'; } };

// Map(absolute path -> "size:mtime"): the folder's files, plus every file a protected pattern covers (also ignored
// ones). `.info`: how the file list was made (listFiles).
async function snapshot(cwd, config = null, opts = {}) {
  const files = new Map();
  const listed = await listFiles(cwd, opts);
  for (const n of listed.names) { const abs = path.join(cwd, n); files.set(abs, stamp(abs)); }
  for (const p of (config && config.protected) || []) {
    for (const abs of expandPattern(config.root, p.pattern)) if (!files.has(abs)) files.set(abs, stamp(abs));
  }
  const { names, ...info } = listed;
  files.info = info;
  return files;
}

// Retakes `after` until it can be compared with `before`: when they were made differently (or one is incomplete),
// once more in before's mode (git ls-files with the long timeout, or the walk). `take(opts)` makes a list with .info.
// Resolves { after, unverifiable: '' | why }.
async function comparableAfter(before, after, take) {
  const b = before && before.info;
  if (comparableLists(b, after.info)) return { after, unverifiable: '' };
  let again = after;
  if (b && !b.truncated && b.mode === 'git') again = await take({ gitOnly: true, timeoutMs: LS_RETRY_TIMEOUT_MS() });
  else if (b && !b.truncated && b.mode === 'walk') again = await take({ walkOnly: true });
  if (comparableLists(b, again.info)) return { after: again, unverifiable: '' };
  return { after: again, unverifiable: `before the job: ${listInfoText(b)}; after it: ${listInfoText(again.info)}` };
}

// What changed between `before` (a snapshot) and now: { changes, unverifiable: '' | why }. Never a file-by-file diff
// of two lists made differently: that turns ignored folders and a truncated walk into thousands of fake changes.
async function compareSnapshots(cwd, config, before, { log = null } = {}) {
  const take = (opts = {}) => snapshot(cwd, config, { ...opts, log });
  const { after, unverifiable } = await comparableAfter(before, await take(), take);
  return unverifiable ? { changes: [], unverifiable } : { changes: diffSnapshots(before, after), unverifiable: '' };
}

// [{ abs, kind: 'added' | 'changed' | 'removed' }], .git internals left out.
function diffSnapshots(before, after) {
  if (!before || !after) return [];
  const out = [];
  const gitInternal = (abs) => abs.split(path.sep).includes('.git');
  for (const [k, v] of after) {
    if (gitInternal(k)) continue;
    const was = before.get(k);
    if (was === undefined || was === 'missing') { if (v !== 'missing') out.push({ abs: k, kind: 'added' }); } else if (v === 'missing') out.push({ abs: k, kind: 'removed' });
    else if (was !== v) out.push({ abs: k, kind: 'changed' });
  }
  for (const [k, v] of before) if (!after.has(k) && v !== 'missing' && !gitInternal(k)) out.push({ abs: k, kind: 'removed' });
  return out.sort((a, b) => (a.abs < b.abs ? -1 : 1));
}

// What a run changed that it may not: { outside: changes outside write_paths, protectedHits: changes to protected paths }.
function judgeChanges(changes, { cwd, writePaths = null, config = null }) {
  const outside = [];
  const protectedHits = [];
  for (const c of changes) {
    const rel = relTo(cwd, c.abs);
    if (writePaths && writePaths.length && (rel.startsWith('../') || !writePaths.some((p) => matchPath(p, rel)))) outside.push({ ...c, rel });
    const hit = isProtected(config, c.abs, { kind: c.kind });
    if (hit) protectedHits.push({ ...c, rel, pattern: hit.pattern });
  }
  return { outside, protectedHits };
}

// ---- attribution: which of a folder's changes are this job's ----
// The before / after snapshot covers the whole folder, so in a folder where other jobs (other conversations' workers)
// write at the same time it also holds their changes. A job's own changes are those inside its own area (its scope
// folders, its write_paths, the folder of its output_file) or to a file its own edit tool calls named (Claude's
// Edit / Write / MultiEdit / NotebookEdit, Codex's file-change events). The rest are concurrent changes by others.

// p as an absolute path in cwd's own spelling: a worker reports paths under the real path of cwd (macOS: /private/var
// for /var), Relay's snapshots and scopes use cwd as given.
function cwdForm(cwd, p) {
  const abs = path.resolve(cwd, String(p));
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* as given */ }
  if (real !== path.resolve(cwd) && (abs === real || abs.startsWith(real + path.sep))) return path.join(path.resolve(cwd), abs.slice(real.length));
  return abs;
}

// The job's own area, or null when it names none (no scope, write_paths or output_file: the whole folder is its own).
// An output_file directly in cwd adds only that file (its folder would be the whole folder).
function ownArea({ cwd, scopes = null, writePaths = null, outputFile = '' }) {
  const root = path.resolve(cwd);
  const folders = (scopes || []).map((s) => path.resolve(cwd, s)).filter((s) => s !== root);
  if (outputFile) {
    const f = path.resolve(cwd, outputFile);
    folders.push(path.dirname(f) === root ? f : path.dirname(f));
  }
  const patterns = (writePaths || []).filter(Boolean);
  return folders.length || patterns.length ? { cwd: root, folders, patterns } : null;
}
function inArea(area, abs) {
  if (!area) return true;
  if (area.folders.some((f) => inside(abs, f))) return true;
  const rel = relTo(area.cwd, abs);
  return !rel.startsWith('../') && area.patterns.some((p) => matchPath(p, rel));
}

const OWN_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// The files the job's own edit tool calls named ({ name, input, error }; a refused call changed nothing), absolute.
function ownEditedFiles(toolCalls, { cwd }) {
  const out = new Set();
  for (const t of toolCalls || []) {
    if (!t || t.error || !OWN_EDIT_TOOLS.has(t.name)) continue;
    const p = t.input && (t.input.file_path || t.input.notebook_path || t.input.path);
    if (typeof p === 'string' && p.trim()) out.add(cwdForm(cwd, p.trim()));
  }
  return out;
}

// Splits changes ([{ abs, ... }]) into { mine, others }. Without an area every change is the job's (as before).
function attributeChanges(changes, { area = null, own = new Set() } = {}) {
  if (!area) return { mine: [...changes], others: [] };
  const mine = [];
  const others = [];
  for (const c of changes) (own.has(c.abs) || inArea(area, c.abs) ? mine : others).push(c);
  return { mine, others };
}

// ---- Claude Code permission rules ----
// Absolute-path rules ("//abs/path"): a rule's meaning then does not depend on where Claude Code thinks the project is.
const absRule = (tool, abs) => `${tool}(/${toSlash(abs)})`;
function pathRules(tool, base, pattern) {
  const abs = path.join(base, pattern);
  return pattern.endsWith('**') ? [absRule(tool, abs)] : [absRule(tool, abs), absRule(tool, `${abs}/**`)];
}

// ---- after the run: post checks ----
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ideaOf = (rootRel) => { const m = /(?:^|\/)ideas\/([^/]+)\//.exec(rootRel); return m ? m[1] : ''; };

function runShell(cmd, { cwd, timeoutSec }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let child;
    try {
      child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, timedOut: false, out: e.message, ms: 0 });
    }
    let timedOut = false;
    const keep = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutSec * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, timedOut, out: `${out}${e.message}`, ms: Date.now() - t0 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? null : code, timedOut, out, ms: Date.now() - t0 }); });
  });
}
const tail = (s, n = CHECK_TAIL_LINES) => String(s).replace(/\s+$/, '').split('\n').slice(-n).join('\n');

// Runs the project's post checks for a finished job. `changed`: absolute paths of the files the job added or changed.
// `maxSec`: the time cap for all of them together; a check the cap cuts short is `capped` (stopped), the ones after it
// are `capped` and `notRun`. Neither counts as failed (the job is flagged CHECKS_INCOMPLETE instead), nor do the files
// past the first MAX_EACH_RUNS of an {each:} check (`incomplete`, not ok).
// Returns [{ name, file, cmd, code, ok, timedOut, skipped, incomplete, capped, notRun, tail, ms }].
async function runPostChecks(config, { cwd, changed, maxSec = 0 }) {
  const results = [];
  if (!config || !config.postChecks.length) return results;
  const deadline = maxSec > 0 ? Date.now() + maxSec * 1000 : Infinity;
  const root = config.root;
  const items = changed.map((abs) => ({ abs, rootRel: relTo(root, abs), cwdRel: relTo(cwd, abs) }));
  for (const c of config.postChecks) {
    if (c.whenGlob && !items.some((f) => matchPath(c.whenGlob, f.rootRel))) {
      results.push({ name: c.name, cmd: c.cmd, skipped: `no changed file matches ${c.whenGlob}`, ok: true });
      continue;
    }
    const base = c.cmd.replace(/\{changed_files\}/g, items.map((f) => shq(f.cwdRel)).join(' '));
    const runs = [];
    if (c.each) {
      const files = items.filter((f) => matchPath(c.each, f.rootRel));
      if (!files.length) { results.push({ name: c.name, cmd: c.cmd, skipped: `no changed file matches ${c.each}`, ok: true }); continue; }
      for (const f of files.slice(0, MAX_EACH_RUNS)) {
        const idea = ideaOf(f.rootRel);
        if (/\{idea\}/.test(base) && !idea) { results.push({ name: c.name, file: f.cwdRel, cmd: c.cmd, skipped: 'the file is not inside ideas/<id>/', ok: true }); continue; }
        const cmd = base.replace(/\{each:[^}]+\}/g, '').replace(/\{file\}/g, shq(f.cwdRel)).replace(/\{idea\}/g, shq(idea)).trim();
        if (!runs.some((r) => r.cmd === cmd)) runs.push({ file: /\{file\}/.test(base) ? f.cwdRel : idea || f.cwdRel, cmd }); // e.g. only {idea}: once per idea
      }
      // not checked is not passed: the job is flagged CHECKS_INCOMPLETE
      if (files.length > MAX_EACH_RUNS) results.push({ name: c.name, cmd: c.cmd, skipped: `${files.length - MAX_EACH_RUNS} more matching files were not checked (at most ${MAX_EACH_RUNS} per check)`, ok: false, incomplete: true });
    } else {
      runs.push({ file: null, cmd: base });
    }
    for (const r of runs) {
      const left = (deadline - Date.now()) / 1000;
      if (left <= 0) { results.push({ name: c.name, file: r.file, cmd: r.cmd, ok: true, capped: true, notRun: true }); continue; }
      const byCap = left < c.timeoutSec;
      const x = await runShell(r.cmd, { cwd, timeoutSec: byCap ? left : c.timeoutSec });
      if (x.timedOut && byCap) results.push({ name: c.name, file: r.file, cmd: r.cmd, code: null, ok: true, capped: true, tail: tail(x.out), ms: x.ms });
      else results.push({ name: c.name, file: r.file, cmd: r.cmd, code: x.code, ok: x.code === 0 && !x.timedOut, timedOut: x.timedOut, tail: tail(x.out), ms: x.ms });
    }
  }
  return results;
}

function checksText(results) {
  if (!results || !results.length) return '';
  const lines = ['## Relay checks', ''];
  for (const r of results) {
    const head = `${r.name}${r.file ? ` (${r.file})` : ''}`;
    if (r.incomplete) { lines.push(`- NOT CHECKED (too many files): ${head}: ${r.skipped}`); continue; }
    if (r.skipped) { lines.push(`- skipped: ${head}: ${r.skipped}`); continue; }
    if (r.notRun) { lines.push(`- not run (time cap): ${head} · \`${clip(r.cmd, 200)}\``); continue; }
    if (r.capped) {
      lines.push(`- stopped (time cap, after ${Math.round((r.ms || 0) / 1000)} s): ${head} · \`${clip(r.cmd, 200)}\``);
      if (r.tail) lines.push('  ```', ...r.tail.split('\n').map((l) => `  ${l}`), '  ```');
      continue;
    }
    lines.push(`- ${r.ok ? 'passed' : 'FAILED'}: ${head}: ${r.timedOut ? 'timed out' : `exit ${r.code}`} · \`${clip(r.cmd, 200)}\``);
    if (r.tail) lines.push('  ```', ...r.tail.split('\n').map((l) => `  ${l}`), '  ```');
  }
  return lines.join('\n');
}

// The "## Relay checks" section of a report, shortened for relay_poll / relay_wait when it is longer than maxChars.
// The worker's own report is never touched; only this section (Relay's own output) is. Shortened, it keeps a status
// line for every check that did not pass (failed, stopped, not run, skipped), one line per check name for the passed
// ones (how many, and which files while room is left), and the last lines of the failed outputs while room is left. The
// full section stays in the job record (fullPath). `checks` are the record's structured results; without them each
// check's status line is kept from the text and the outputs are dropped.
const CHECKS_VIEW_MAX = 8000;
function checksSection(report) {
  const text = String(report || '');
  const start = text.startsWith('## Relay checks\n') ? 0 : text.lastIndexOf('\n## Relay checks\n') + 1;
  if (start < 0 || (start === 0 && !text.startsWith('## Relay checks\n'))) return null;
  const lines = text.slice(start).split('\n');
  let n = 1;
  if (lines[n] === '') n++;
  while (n < lines.length && /^(- | {2})/.test(lines[n])) n++;
  const end = start + lines.slice(0, n).join('\n').length;
  return { start, end };
}
function capChecks(report, checks, { maxChars = CHECKS_VIEW_MAX, fullPath = '' } = {}) {
  const text = String(report || '');
  const sec = checksSection(text);
  if (!sec || sec.end - sec.start <= maxChars) return text;
  const where = fullPath ? `every check and its full output: "checks" and "report" in ${fullPath}` : 'every check and its full output are in the job record';
  const out = [];
  let size = 0;
  const push = (l) => { out.push(l); size += l.length + 1; };
  if (!Array.isArray(checks) || !checks.length) {
    const heads = text.slice(sec.start, sec.end).split('\n').filter((l) => l.startsWith('- ')).map((l) => clip(l.replace(/ · `[\s\S]*$/, ''), 300));
    push(`## Relay checks (shortened for this view: ${heads.length} checks, outputs left out; ${where})`);
    push('');
    heads.forEach(push);
    return `${text.slice(0, sec.start)}${out.join('\n')}${text.slice(sec.end)}`;
  }
  const status = (r) => (r.skipped ? 'skipped' : r.notRun ? 'not run (time cap)' : r.capped ? 'stopped (time cap)' : r.ok ? 'passed' : 'FAILED');
  const head = (r) => `${r.name}${r.file ? ` (${r.file})` : ''}`;
  const count = {};
  for (const r of checks) count[status(r)] = (count[status(r)] || 0) + 1;
  push(`## Relay checks (shortened for this view: ${checks.length} checks: ${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(', ')}; ${where})`);
  push('');
  const bad = checks.filter((r) => status(r) !== 'passed');
  for (const r of bad) {
    const why = r.skipped ? r.skipped : r.notRun ? '' : r.capped ? `after ${Math.round((r.ms || 0) / 1000)} s` : r.timedOut ? 'timed out' : `exit ${r.code}`;
    push(clip(`- ${status(r)}: ${head(r)}${why ? `: ${why}` : ''}`, 300));
  }
  // Passed checks: one line per check name, with as many of its files as fit.
  const groups = new Map();
  for (const r of checks.filter((x) => status(x) === 'passed')) {
    if (!groups.has(r.name)) groups.set(r.name, []);
    groups.get(r.name).push(r.file);
  }
  const fileRoom = Math.max(120, Math.floor((maxChars / 2 - size) / Math.max(1, groups.size)));
  for (const [name, files] of groups) {
    const named = files.filter(Boolean);
    let list = '';
    let shown = 0;
    for (const f of named) {
      if (list.length + f.length + 2 > fileRoom) break;
      list += `${shown ? ', ' : ''}${f}`;
      shown++;
    }
    const more = named.length - shown;
    push(`- passed: ${name}${files.length > 1 ? ` (${files.length} checks)` : ''}${list ? `: ${list}` : ''}${more ? `, +${more} more` : ''}`);
  }
  // The last lines of each failed or stopped check's output, while room is left.
  const withOut = bad.filter((r) => r.tail);
  let cut = 0;
  for (const r of withOut) {
    const room = Math.min(1200, maxChars - size - 200);
    if (room < 200) { cut++; continue; }
    const tl = String(r.tail).split('\n');
    const keep = [];
    let used = 0;
    for (let i = tl.length - 1; i >= 0; i--) {
      const l = `  ${clip(tl[i], 300)}`;
      if (used + l.length + 1 > room) break;
      keep.unshift(l);
      used += l.length + 1;
    }
    push('');
    push(clip(`Output of ${status(r)} ${head(r)}${keep.length < tl.length ? ` (last ${keep.length} of ${tl.length} lines)` : ''}:`, 300));
    push('  ```');
    keep.forEach(push);
    push('  ```');
  }
  if (cut) { push(''); push(`(${cut} more output${cut > 1 ? 's' : ''} left out here; ${where})`); }
  return `${text.slice(0, sec.start)}${out.join('\n')}${text.slice(sec.end)}`;
}

// ---- the structured summary ----
const STATUSES = ['done', 'partial', 'blocked', 'failed'];
const SUMMARY_INSTRUCTIONS = [
  '- End your final report with a structured summary for Relay: after your normal report text (and before a RELAY_PARK line, if you park), a fenced block tagged relay-summary holding one JSON object:',
  '  ```relay-summary',
  '  {"status": "done|partial|blocked|failed", "run_ids": [], "key_files": [], "checks": [], "decisions_needed": [], "next_step": ""}',
  '  ```',
  '  status: one of done, partial, blocked, failed. run_ids: ids of experiment or job runs you launched or relied on. key_files: the files that matter for the result. checks: the checks you ran and their outcome, one short string each. decisions_needed: what only the user or the dispatcher can decide. next_step: the one next step you recommend.',
].join('\n');

// { summary, note }: summary null (with a note saying why) when the block is missing or unreadable.
function parseSummary(report) {
  const re = /```[ \t]*relay-summary[^\n]*\n([\s\S]*?)```/g;
  let m;
  let last = null;
  while ((m = re.exec(String(report || '')))) last = m[1];
  if (last == null) return { summary: null, note: 'the worker gave no relay-summary block' };
  let obj;
  try { obj = JSON.parse(last.trim()); } catch (e) { return { summary: null, note: `the relay-summary block is not valid JSON (${clip(e.message, 120)})` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { summary: null, note: 'the relay-summary block is not a JSON object' };
  const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => clip(typeof x === 'string' ? x : JSON.stringify(x), 300)).slice(0, 50);
  const status = String(obj.status || '').trim().toLowerCase();
  const summary = {
    status: STATUSES.includes(status) ? status : null,
    run_ids: arr(obj.run_ids), key_files: arr(obj.key_files), checks: arr(obj.checks), decisions_needed: arr(obj.decisions_needed),
    next_step: clip(typeof obj.next_step === 'string' ? obj.next_step : obj.next_step == null ? '' : JSON.stringify(obj.next_step), 500),
  };
  return { summary, note: summary.status ? null : `the relay-summary status ${JSON.stringify(clip(obj.status ?? null, 40))} is not one of ${STATUSES.join(', ')}` };
}

// One compact line for relay_poll / relay_wait.
function summaryLine(s, note) {
  if (!s) return note ? `Summary: none (${note}).` : '';
  const list = (label, a, n = 6) => (a && a.length ? `${label}: ${a.slice(0, n).join(', ')}${a.length > n ? ` (+${a.length - n})` : ''}` : '');
  return `Summary: ${[
    (s.status || 'status ?').toUpperCase(), list('runs', s.run_ids), list('key files', s.key_files), list('checks', s.checks, 4),
    list('decisions needed', s.decisions_needed, 4), s.next_step ? `next: ${s.next_step}` : '',
  ].filter(Boolean).join(' · ')}`;
}

// ---- the isolation breach scan ----
// Tool calls (name + input as the backend reported them) that touched a hidden path. A file tool's path is matched
// against the patterns; a shell command matches when it names a hidden path (as written, absolute, or as a word that
// resolves into one). Calls whose result was an error (e.g. refused by the deny rules) are "blocked", not a breach.
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
// Options that keep a search away from a path (grep/rg --exclude-dir=x, rg -g '!x', find -not -path x): naming a hidden
// path there is not an access. A live probe's reviewer ran `grep -r TOKEN . --exclude-dir=secret`, which was flagged.
const EXCLUDE_RE = /(?:--exclude(?:-dir)?|--ignore(?:-dir)?)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)|(?:--glob|--iglob|-g)(?:=|\s+)(?:"![^"]*"|'![^']*'|!\S+)|(?:-not|!)\s+-i?(?:path|name|wholename)\s+(?:"[^"]*"|'[^']*'|\S+)/g;
const withoutExclusions = (cmd) => String(cmd).replace(EXCLUDE_RE, ' ');
function scanBreach(tools, { cwd, hidePaths }) {
  const breaches = [];
  const blocked = [];
  if (!hidePaths || !hidePaths.length) return { breaches, blocked };
  const hits = (abs) => { const rel = relTo(cwd, abs); return hidePaths.find((p) => matchPath(p, rel)) || null; };
  for (const t of tools) {
    const input = t.input || {};
    let hit = null;
    let what = '';
    for (const k of PATH_KEYS) {
      if (typeof input[k] !== 'string' || !input[k]) continue;
      const abs = path.resolve(cwd, input[k]);
      hit = hits(abs);
      if (hit) { what = input[k]; break; }
    }
    if (!hit && typeof input.pattern === 'string' && /^(Glob|Grep)$/.test(t.name)) {
      const base = typeof input.path === 'string' && input.path ? path.resolve(cwd, input.path) : cwd;
      const pat = input.pattern;
      if (t.name === 'Glob') {
        const lit = literalPrefix(pat.replace(/\\/g, '/'));
        if (lit) { hit = hits(path.resolve(base, lit)); if (hit) what = `${input.path ? `${input.path}/` : ''}${pat}`; }
      }
      if (!hit && typeof input.glob === 'string') {
        const lit = literalPrefix(input.glob);
        if (lit) { hit = hits(path.resolve(base, lit)); if (hit) what = input.glob; }
      }
    }
    if (!hit && typeof input.command === 'string' && input.command) {
      const cmd = withoutExclusions(input.command);
      for (const p of hidePaths) {
        const lit = hasGlob(p) ? '' : p;
        if (lit && (cmd.includes(lit) || cmd.includes(path.join(cwd, lit)))) { hit = p; what = clip(input.command, 200); break; }
      }
      if (!hit) {
        for (const w of cmd.split(/[\s;|&<>()`$"']+/).filter(Boolean)) {
          if (!/[/.]/.test(w) || /^-/.test(w)) continue;
          const h = hits(path.resolve(cwd, w));
          if (h) { hit = h; what = clip(input.command, 200); break; }
        }
      }
    }
    if (!hit) continue;
    (t.error ? blocked : breaches).push({ tool: t.name, what, pattern: hit });
  }
  return { breaches, blocked };
}

// ---- output_file ----
// Checks an output file path before the job starts: { abs, rel } or { error }.
function checkOutputFile(cwd, raw, { overwrite = false, config = null, skipExists = false } = {}) {
  if (typeof raw !== 'string') return { error: 'output_file must be a path (a string) relative to cwd.' };
  const c = cleanPattern(raw, 'output_file');
  if (c.error) return { error: c.error };
  if (hasGlob(c.pattern)) return { error: `output_file must be one file, not a pattern (got: ${clip(raw, 80)}).` };
  if (c.pattern.split('/').includes('.git')) return { error: 'output_file may not be inside .git.' };
  if (/[\\/]$/.test(String(raw).trim())) return { error: `output_file must name a file, not a folder (got: ${clip(raw, 80)}).` };
  const abs = path.resolve(cwd, c.pattern);
  // A symlinked folder on the way must not lead outside cwd.
  let probe = path.dirname(abs);
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  try { if (!inside(fs.realpathSync(probe), fs.realpathSync(cwd))) return { error: `output_file must stay inside cwd (${clip(raw, 80)} leads outside it).` }; } catch { /* checked again when writing */ }
  const prot = isProtected(config, abs, { kind: fs.existsSync(abs) ? 'changed' : 'added' });
  if (prot) return { error: `output_file ${c.pattern} is a protected path in the project config (${prot.pattern}); choose another file.` };
  let st = null;
  try { st = fs.lstatSync(abs); } catch { /* does not exist: fine */ }
  if (st && st.isDirectory()) return { error: `output_file ${c.pattern} is a folder.` };
  if (st && !overwrite && !skipExists) return { error: `output_file ${c.pattern} already exists; pass overwrite: true to replace it, or choose another file name. Nothing was started.` };
  return { abs, rel: c.pattern };
}

// Writes the report atomically (a temp file in the same folder, then a rename; without overwrite a hard link, which
// fails if the file appeared meanwhile). { ok } or { error }.
function writeOutputFile(cwd, rel, text, { overwrite = false } = {}) {
  const abs = path.resolve(cwd, rel);
  if (!inside(abs, cwd)) return { error: 'the path leads outside cwd' };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!inside(fs.realpathSync(path.dirname(abs)), fs.realpathSync(cwd))) return { error: 'its folder leads outside cwd' };
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.relay-${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`);
    try {
      if (overwrite) fs.renameSync(tmp, abs);
      else {
        try { fs.linkSync(tmp, abs); } catch (e) { return e.code === 'EEXIST' ? { error: 'the file already exists (it appeared during the job) and overwrite is not set', exists: true } : { error: e.message }; }
      }
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* leftover temp file */ }
    }
    return { ok: true, abs };
  } catch (e) {
    return { error: e.message };
  }
}

// Where Relay keeps its report when the worker wrote the output_file itself: "<name>.relay-report.md" next to it
// ("reviews/g2.md" -> "reviews/g2.relay-report.md").
function relayReportPath(rel) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const stem = base.includes('.') && !base.startsWith('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return `${dir === '.' ? '' : `${dir}/`}${stem}.relay-report.md`;
}

module.exports = {
  CONFIG_REL, RULES_MAX_BYTES, SUMMARY_INSTRUCTIONS, STATUSES,
  cleanPattern, globRe, matchPath, literalPrefix, expandPattern, hasGlob,
  loadConfig, configCandidates, rulesPrompt, isProtected, gitRoot, gitDataDirs, isOwnProjectFolder, ccProjectName, ownToolResultsRules, isolatedHideFor, isolationDenies, relayReportPath,
  listFiles, walkFiles, snapshot, diffSnapshots, judgeChanges, compareSnapshots, comparableAfter, comparableLists, listInfoText,
  cwdForm, ownArea, inArea, ownEditedFiles, attributeChanges,
  absRule, pathRules,
  runPostChecks, checksText, capChecks, checksSection, CHECKS_VIEW_MAX, ideaOf, shq,
  parseSummary, summaryLine,
  scanBreach, checkOutputFile, writeOutputFile,
};
