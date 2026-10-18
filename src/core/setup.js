'use strict';
// Per-account Claude config dirs. Each account gets its own dir (= its own login), but
// history, skills, plugins and settings are shared with the user's main ~/.claude so a
// session started under one account can be resumed under another.

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const fslock = require('./fslock');

const SHARED_DIRS = ['projects', 'skills', 'plugins', 'agents', 'commands'];
const SHARED_FILES = ['CLAUDE.md'];

const hubDir = () => process.env.RELAY_HUB || path.join(os.homedir(), '.claude');
const accountDir = (name) => path.join(store.home(), 'accounts', name);

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function prepareConfigDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hub = hubDir();
  fs.mkdirSync(path.join(hub, 'projects'), { recursive: true }); // the one dir that must exist to share
  for (const d of SHARED_DIRS) {
    const src = path.join(hub, d);
    const dst = path.join(dir, d);
    if (exists(src) && !exists(dst)) fs.symlinkSync(src, dst, 'junction'); // junction: no admin rights on Windows
  }
  syncSharedFiles(dir);
}

// What a worker account's settings.json should say: your own ~/.claude/settings.json, plus the commands workers may
// run (Settings › Commands workers may run) added to permissions.allow. They are written into each worker's own
// settings, not passed on the command line only, because Claude Code applies an account's own allow rules whatever
// folder it runs in and whoever starts it (a project's rules were not applied to worker sessions), and a Relay tool
// started by an older Claude window still gets them. Your own ~/.claude/settings.json is never changed.
// The program that runs Relay's guard hook (src/guard.js) for worker sessions: this Electron (or Node) itself, or the
// one the Relay app recorded in runtime.json when this is a plain Node process (the command line, the demo).
const GUARD = path.join(__dirname, '..', 'guard.js');
function hookRuntime() {
  if (process.versions.electron) return process.execPath;
  try { return JSON.parse(fs.readFileSync(path.join(store.home(), 'runtime.json'), 'utf8')).execPath || process.execPath; } catch { return process.execPath; }
}
const GUARD_MARK = 'relay-guard';
const guardHook = () => ({
  matcher: 'Bash',
  hooks: [{ type: 'command', timeout: 10, command: `ELECTRON_RUN_AS_NODE=1 "${hookRuntime()}" "${GUARD}" # ${GUARD_MARK}` }],
});

function workerSettings() {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(path.join(hubDir(), 'settings.json'), 'utf8')) || {};
  } catch (e) {
    base = e.code === 'ENOENT' ? {} : null; // no settings of yours: just the rules; unreadable ones: left as they are
  }
  const settings = store.loadSettings();
  const rules = store.cleanAllowedTools(settings.allowedTools).rules;
  const never = store.cleanAllowedTools(settings.deniedTools).rules;
  if (base === null) return null; // unreadable: copy it as it is
  if (!rules.length && !never.length) return base;
  const out = { ...base, permissions: { ...(base.permissions || {}) } };
  const merge = (key, add) => {
    const have = Array.isArray(out.permissions[key]) ? out.permissions[key] : [];
    if (add.length) out.permissions[key] = [...have, ...add.filter((r) => !have.includes(r))];
  };
  merge('allow', rules);
  merge('deny', never); // Claude Code's own rules, for the commands written the plain way
  if (never.length) { // and Relay's guard, for every other way of writing them
    const pre = (base.hooks?.PreToolUse || []).filter((h) => !JSON.stringify(h).includes(GUARD_MARK));
    out.hooks = { ...(base.hooks || {}), PreToolUse: [...pre, guardHook()] };
  }
  return out;
}

// Bring a worker account's shared files up to date; cheap enough to call before every run. settings.json is compared
// by content (so a change of the allowed commands applies at once); CLAUDE.md is copied when the hub's is newer.
function syncSharedFiles(dir) {
  if (path.resolve(dir) === path.resolve(hubDir())) return; // the main login: its settings are yours, never rewritten
  const dst = path.join(dir, 'settings.json');
  try {
    const want = workerSettings();
    if (want === null) {
      const src = path.join(hubDir(), 'settings.json');
      if (exists(src) && (!exists(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs)) fs.copyFileSync(src, dst);
    } else {
      const text = `${JSON.stringify(want, null, 2)}\n`;
      let cur = null;
      try { cur = fs.readFileSync(dst, 'utf8'); } catch { /* not written yet */ }
      if (cur !== text && (Object.keys(want).length || cur !== null)) fslock.writeFileAtomic(dst, text);
    }
  } catch { /* the next run tries again */ }
  for (const f of SHARED_FILES) {
    const src = path.join(hubDir(), f);
    const dst = path.join(dir, f);
    try {
      if (!exists(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) fs.copyFileSync(src, dst);
    } catch { /* hub file absent: nothing to share */ }
  }
}

// Unlink the shared junctions first (removing the link, never its target), then the rest.
function removeConfigDir(dir) {
  if (!store.ownsConfigDir(dir)) {
    throw new Error(`refusing to delete ${dir}: not inside a Relay accounts folder`);
  }
  for (const d of SHARED_DIRS) {
    const p = path.join(dir, d);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) {
        try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); }
      }
    } catch { /* not present */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

const sameFile = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
};
const sessionCopy = (acct, sessionId, transcriptPath) =>
  path.join(acct.configDir, 'projects', path.basename(path.dirname(transcriptPath)), `${sessionId}.jsonl`);

// The session was started under another login (the desktop app's), so its transcript may not be
// inside this account's projects dir. Copy it in; a no-op when the dirs share `projects`.
function ensureSession(acct, { sessionId, transcriptPath }) {
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) return;
  const dest = sessionCopy(acct, sessionId, transcriptPath);
  if (sameFile(dest, transcriptPath)) return;
  if (!exists(dest) || fs.statSync(transcriptPath).mtimeMs > fs.statSync(dest).mtimeMs) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(transcriptPath, dest);
  }
}

// After a takeover ran under `acct`, hand the progress back to where the original UI reads it.
function syncSessionBack(acct, { sessionId, transcriptPath }) {
  if (!sessionId || !transcriptPath) return;
  const src = sessionCopy(acct, sessionId, transcriptPath);
  if (!exists(src) || sameFile(src, transcriptPath)) return;
  if (!exists(transcriptPath) || fs.statSync(src).mtimeMs > fs.statSync(transcriptPath).mtimeMs) fs.copyFileSync(src, transcriptPath);
}

// Every worker account at once: after the allowed commands change, and now and then (a Relay tool started by an
// older Claude window copies your settings.json over the worker's when yours changes).
function syncAllAccounts() {
  for (const a of store.load()) { try { if (fs.existsSync(a.configDir)) syncSharedFiles(a.configDir); } catch { /* next round */ } }
}

module.exports = { prepareConfigDir, syncSharedFiles, syncAllAccounts, workerSettings, removeConfigDir, accountDir, hubDir, ensureSession, syncSessionBack };
