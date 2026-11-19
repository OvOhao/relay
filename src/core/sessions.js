'use strict';
// Carrying a Claude Code session to the account that resumes it.
//
// Claude Code keeps a session under the sign-in folder it runs with (CLAUDE_CONFIG_DIR):
//   <configDir>/projects/<project folder>/<session>.jsonl   the transcript
//   <configDir>/projects/<project folder>/<session>/         subagents/, tool-results/ (saved large tool outputs), ...
// `--resume <session>` only finds a transcript in the resuming account's own `projects` folder, under the folder
// named for the cwd; otherwise it fails with "No conversation found with session ID: ...". Most of Relay's accounts
// share one `projects` folder (a symlink to ~/.claude/projects), but an account whose `projects` is a real folder
// of its own (one that signed in before Relay prepared it, for instance) holds its sessions apart: a thread moved to
// or from it (its own account limited or full) lost its session: almost every "No conversation found" failure was a
// shared-folder session resumed on such an account, the rest the reverse.
//
// carry(): before every resume, the newest copy of the session among all the sign-in folders Relay knows (each
// account's, and ~/.claude) is copied into the resuming account under Claude Code's folder name for the cwd, with its
// session folder, and the copy is verified (same size) before the run starts.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code's folder name for a project (cwd), as in its 2.1.32x code:
//   k(e)  = e.replace(/[^a-zA-Z0-9]/g, "-")
//   nH(e) = k(e).length <= 200 ? k(e) : `${k(e).slice(0, 200)}-${Math.abs(lY(e)).toString(36)}`
//   lY(e) = 32-bit string hash: h = (h << 5) - h + charCode, |0 (Java's String.hashCode), over the cwd itself.
const NAME_MAX = 200;
function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}
function projectFolderName(cwd) {
  const s = String(cwd);
  const n = s.replace(/[^a-zA-Z0-9]/g, '-');
  return n.length <= NAME_MAX ? n : `${n.slice(0, NAME_MAX)}-${Math.abs(strHash(s)).toString(36)}`;
}
// Both the cwd as given and its real path (a symlinked folder): Claude Code names the folder after the cwd it sees.
function folderNames(cwd) {
  const forms = [path.resolve(String(cwd))];
  try { forms.push(fs.realpathSync(String(cwd))); } catch { /* as given */ }
  return [...new Set(forms.map(projectFolderName))];
}

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/; // a session id, never a path
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };

// Every place a copy of the session is: [{ projects (real path), folder, file, size, mtimeMs, dirs: [configDir...] }].
// The cwd's own folders are looked at first; the session may also have been written under another project folder
// (started from another cwd), so every project folder is searched.
function locate(sessionId, { cwd, configDirs = [] } = {}) {
  if (!SID_RE.test(String(sessionId || ''))) return [];
  const byProjects = new Map(); // real projects folder -> config dirs using it
  for (const d of configDirs.filter(Boolean)) {
    const r = real(path.join(d, 'projects'));
    if (!r) continue;
    if (!byProjects.has(r)) byProjects.set(r, []);
    byProjects.get(r).push(path.resolve(d));
  }
  const want = cwd ? folderNames(cwd) : [];
  const out = [];
  for (const [projects, dirs] of byProjects) {
    let names = [];
    try { names = fs.readdirSync(projects); } catch { continue; }
    const order = [...want.filter((n) => names.includes(n)), ...names.filter((n) => !want.includes(n))];
    for (const folder of order) {
      const file = path.join(projects, folder, `${sessionId}.jsonl`);
      const st = statOf(file);
      if (!st || !st.isFile()) continue;
      out.push({ projects, folder, file, size: st.size, mtimeMs: st.mtimeMs, dirs });
    }
  }
  return out;
}

// The copy to carry: the one with the most content (transcripts are append-only), then the newest.
const best = (copies) => [...copies].sort((a, b) => (b.size - a.size) || (b.mtimeMs - a.mtimeMs))[0] || null;

// Copies a file atomically (a temporary name, then rename) and checks the size.
function copyFileChecked(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.relay-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* renamed */ }
  }
  const a = statOf(src);
  const b = statOf(dst);
  if (!a || !b || a.size !== b.size) throw new Error(`copy of ${path.basename(src)} is incomplete (${b ? b.size : 0} of ${a ? a.size : '?'} bytes)`);
}
// Every file under a folder (relative paths), for the copy and its check.
function filesUnder(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}
// The session folder (subagents/, tool-results/, ...): each file the target lacks or has smaller.
function copyFolder(src, dst) {
  let n = 0;
  for (const rel of filesUnder(src)) {
    const s = path.join(src, rel);
    const d = path.join(dst, rel);
    const a = statOf(s);
    const b = statOf(d);
    if (b && a && b.size >= a.size) continue;
    copyFileChecked(s, d);
    n++;
  }
  return n;
}

// Makes `sessionId` resumable by the account whose sign-in folder is `configDir`, for a run in `cwd`.
//   { ok: true, copied: false }                         it is already there (a shared folder, or its own newest copy)
//   { ok: true, copied: true, from, to, bytes, files }   carried and verified
//   { ok: false, code: 'session_missing', why }          no copy anywhere Relay looks
//   { ok: false, code: 'copy_failed', why, holders }     a copy exists but could not be carried (holders: config dirs
//                                                        that already see the newest copy: the run may wait for them)
function carry(configDir, sessionId, { cwd, configDirs = [] } = {}) {
  if (!configDir || !sessionId || !cwd) return { ok: true, copied: false };
  const all = [...new Set([...configDirs, configDir].filter(Boolean).map((d) => path.resolve(d)))];
  const copies = locate(sessionId, { cwd, configDirs: all });
  const src = best(copies);
  if (!src) return { ok: false, code: 'session_missing', why: `no transcript ${sessionId}.jsonl in the projects folder of any of ${all.length} sign-in folders` };
  const targetProjects = real(path.join(configDir, 'projects')) || path.join(configDir, 'projects');
  const names = folderNames(cwd);
  const have = (name) => { const st = statOf(path.join(targetProjects, name, `${sessionId}.jsonl`)); return st && st.isFile() ? st : null; };
  // Already resumable here: the cwd's folder in this account holds a copy as complete as the best one.
  const there = names.map(have).find((st) => st && st.size >= src.size);
  const srcDir = path.join(src.projects, src.folder, sessionId);
  if (there) {
    // its session folder may still lack files the best copy has (another account wrote it)
    if (path.join(src.projects, src.folder) !== path.join(targetProjects, names[0]) && statOf(srcDir)) {
      try { copyFolder(srcDir, path.join(targetProjects, names[0], sessionId)); } catch { /* the transcript is what resume needs */ }
    }
    return { ok: true, copied: false };
  }
  try {
    let bytes = 0;
    let files = 0;
    for (const name of names) {
      const to = path.join(targetProjects, name, `${sessionId}.jsonl`);
      if (to === src.file) continue;
      copyFileChecked(src.file, to);
      bytes = src.size;
      if (statOf(srcDir)) files += copyFolder(srcDir, path.join(targetProjects, name, sessionId));
    }
    // verified: the cwd's folder in the target now holds a transcript as long as the source
    const st = have(names[0]);
    if (!st || st.size < src.size) throw new Error('the copied transcript is not there after copying');
    return { ok: true, copied: true, from: src.file, to: path.join(targetProjects, names[0], `${sessionId}.jsonl`), bytes, files };
  } catch (e) {
    return { ok: false, code: 'copy_failed', why: (e && e.message) || String(e), holders: src.dirs };
  }
}

// Every Claude sign-in folder Relay knows: its accounts' and ~/.claude (or RELAY_HUB).
function claudeConfigDirs() {
  const store = require('./store');
  const { providerOf } = require('./backends');
  const hub = process.env.RELAY_HUB || path.join(os.homedir(), '.claude');
  let accts = [];
  try { accts = store.load(); } catch { accts = []; }
  return [...new Set([...accts.filter((a) => providerOf(a) === 'claude' && a.configDir).map((a) => a.configDir), hub])];
}

module.exports = { projectFolderName, folderNames, strHash, locate, best, carry, claudeConfigDirs, NAME_MAX };
