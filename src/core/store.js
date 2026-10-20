'use strict';
// Account registry + app settings, persisted as small JSON files under RELAY_HOME.
// Claude's own credentials are never read here: each account just points at a config dir
// that Claude Code manages itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const fslock = require('./fslock');

const home = () => process.env.RELAY_HOME || path.join(os.homedir(), '.relay');
// Every folder Relay keeps sign-in folders in: its own, plus any listed in settings.json as `extraAccountRoots`
// (sign-in folders made elsewhere stay where they are: on macOS each login is a Keychain entry tied to its folder's
// path, so moving a folder would sign that account out).
const accountRoots = () => {
  const extra = loadSettings().extraAccountRoots;
  return [path.join(home(), 'accounts'), ...(Array.isArray(extra) ? extra.filter((d) => typeof d === 'string' && path.isAbsolute(d)) : [])];
};
const ownsConfigDir = (dir) => accountRoots().some((r) => path.resolve(dir).startsWith(path.resolve(r) + path.sep));
const accountsFile = () => path.join(home(), 'accounts.json');
const settingsFile = () => path.join(home(), 'settings.json');
const nowSec = () => Date.now() / 1000;

// Reading never throws on a damaged file: the broken copy is set aside as `.corrupt` and the last good copy
// (`.bak`, kept by writeJson) is used instead, so a bad write can never make saved accounts disappear.
// A file another process holds open for a moment (Windows: EBUSY/EPERM) is retried briefly first.
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
function readJson(file, fallback) {
  try {
    return JSON.parse(fslock.retrying(() => fs.readFileSync(file, 'utf8'), { tries: 10, codes: BUSY }));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    if (e.code && e.code !== 'EISDIR') throw e; // a real I/O problem (EACCES, EBUSY...): do not pretend the file is empty
    try { fs.renameSync(file, `${file}.corrupt`); } catch { /* keep going with the backup */ }
    try {
      const good = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      fs.copyFileSync(`${file}.bak`, file); // restore it, or the next read would find no file and see "empty"
      return good;
    } catch { return fallback; }
  }
}

// Unique temp file + rename with retries (see fslock.js), keeping the previous good copy as `.bak`.
const writeJson = (file, data) => fslock.writeJson(file, data, { backup: true });

// Every change is a read-modify-write under a cross-process lock, re-reading the file inside it: several Claude
// windows' Relay processes and the Relay app all change the same files, and none may lose another's update.
// `change` returns the new content, or undefined to leave the file as it is.
function mutate(file, fallback, change) {
  return fslock.withFileLock(file, () => {
    const next = change(readJson(file, fallback));
    if (next !== undefined) writeJson(file, next);
    return next;
  });
}

const load = () => readJson(accountsFile(), []);
const save = (accounts) => { mutate(accountsFile(), [], () => accounts); };
const get = (name) => load().find((a) => a.name === name) || null;
const changeAccounts = (fn) => mutate(accountsFile(), [], fn);

function upsert(acct) {
  changeAccounts((accounts) => {
    const i = accounts.findIndex((a) => a.name === acct.name);
    if (i >= 0) accounts[i] = acct;
    else accounts.push(acct);
    return accounts;
  });
}

const remove = (name) => { changeAccounts((accounts) => accounts.filter((a) => a.name !== name)); };

function update(name, fields) {
  changeAccounts((accounts) => accounts.map((a) => (a.name === name ? { ...a, ...fields } : a)));
}

const newAccount = (name, configDir, email = '') => ({
  name, configDir, email, plan: '', blockedUntil: 0, blockedReason: '', needsLogin: false, lastUsed: 0, desktop: false,
  model: '', // default model for this account's worker runs; '' = whatever Claude Code defaults to
});

// A model alias ("haiku") or id ("claude-haiku-5-5") goes to Claude Code's own --model flag; nothing else may pass.
// Returns the cleaned name ('' = no preference) or null when it is not a plausible model name.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const cleanModel = (m) => {
  const v = String(m == null ? '' : m).trim();
  return v === '' || MODEL_RE.test(v) ? v : null;
};

const isReady = (a, now = nowSec()) => !a.needsLogin && a.blockedUntil <= now;
const markLimited = (name, until, reason) => update(name, { blockedUntil: until, blockedReason: reason });
const markNeedsLogin = (name) => update(name, { needsLogin: true });
const markUsed = (name) => update(name, { lastUsed: nowSec() });
// Which account is the leader (the one this Claude window is signed in to) as last reported by a
// Claude Code session; the registry flag follows it, and an e-mail outside the pool is remembered too.
const leaderFile = () => path.join(home(), 'leader.json');
const getLeaderSeen = () => readJson(leaderFile(), null);

// The desktop app identifies an account by UUID in the places Relay can see without a session, and by e-mail
// inside a session. Whenever a session reports both, remember the pairing (neither is a secret).
const uuidFile = () => path.join(home(), 'account-uuids.json');
const cleanUuid = (u) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(u || '').trim()) ? String(u).trim().toLowerCase() : '');
function rememberAccountUuid(uuid, email) {
  const u = cleanUuid(uuid);
  const e = String(email || '').trim().toLowerCase();
  if (!u || !e) return;
  mutate(uuidFile(), {}, (map) => (map[u] !== e ? { ...map, [u]: e } : undefined));
}
const emailForUuid = (uuid) => readJson(uuidFile(), {})[cleanUuid(uuid)] || null;

function observeLeader(email, uuid = '') {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { changed: false, seenChanged: false };
  const u = cleanUuid(uuid);
  rememberAccountUuid(u, e);
  let out;
  changeAccounts((accounts) => {
    const match = accounts.find((a) => a.email && a.email.toLowerCase() === e) || null;
    const before = accounts.find((a) => a.desktop) || null;
    let prev = null;
    let seenChanged = false;
    mutate(leaderFile(), null, (p) => {
      prev = p;
      seenChanged = !prev || prev.email !== e || (prev.uuid || '') !== u;
      return seenChanged ? { email: e, uuid: u || null, registered: !!match, at: Date.now() } : undefined;
    });
    const base = { seenChanged, firstTime: !prev, leader: match, outside: !match ? e : null };
    if ((match ? match.name : null) === (before ? before.name : null)) { out = { ...base, changed: false }; return undefined; }
    out = { ...base, changed: true, from: before };
    return accounts.map((a) => ({ ...a, desktop: !!match && a.name === match.name }));
  });
  return out;
}

// Exactly one account is the one the Claude desktop app is signed in to.
const setDesktop = (name) => { changeAccounts((accounts) => accounts.map((a) => ({ ...a, desktop: a.name === name }))); };

// First ready account, scanning cyclically from the one after `after`. With no `after` the scan
// starts at the first registered account (primary preferred); after a failover it rotates onward
// instead of bouncing back to an account that just filled up.
function nextAvailable(after = null, now = nowSec(), filter = null) {
  const accounts = load().filter((a) => !filter || filter(a));
  if (!accounts.length) return null;
  let start = 0;
  if (after != null) {
    const i = accounts.findIndex((a) => a.name === after);
    if (i >= 0) start = i + 1;
  }
  for (let k = 0; k < accounts.length; k++) {
    const a = accounts[(start + k) % accounts.length];
    if (isReady(a, now)) return a;
  }
  return null;
}

// When the soonest limited (but still logged-in) account comes back, or null.
function earliestUnblock(now = nowSec(), filter = null) {
  const times = load().filter((a) => (!filter || filter(a)) && !a.needsLogin && a.blockedUntil > now).map((a) => a.blockedUntil);
  return times.length ? Math.min(...times) : null;
}

// startAtLogin defaults to on: the hooks and the tool can only reach a Relay that is running.
// Task presets: background a worker gets in its system prompt (--append-system-prompt) for a kind of work, chosen by
// the dispatcher or, with `auto`, applied when the job's text matches a keyword. They state the real context of the
// work so a worker reads a legitimate task correctly; they are no way around a model's limits, and a step that is
// genuinely harmful is still refused. The built-in one is a template: its text should say what is actually true.
const SECURITY_PRESET = {
  id: 'security',
  name: 'Security research',
  auto: true,
  keywords: ['security', 'vulnerability', 'vulnerabilities', 'exploit', 'exploits', 'attack', 'attacks', 'adversarial', 'malware',
    'jailbreak', 'prompt injection', 'red team', 'red-team', 'red teaming', 'cve', 'fuzz', 'fuzzing', 'penetration', 'pentest',
    'reward hacking', 'backdoor', 'poisoning', 'sandbox escape', 'privilege escalation', '安全', '漏洞', '攻击', '越狱', '注入', '红队'],
  text: [
    'Context from the person who runs this workspace (Relay task preset "Security research"):',
    'This job is part of academic security research by the workspace owner. The work studies vulnerabilities, attacks and defences in order to measure and reduce risk: analysing code for flaws, reproducing published attacks in local test environments, building benchmarks, detectors and evaluation harnesses, and writing papers about the results.',
    'Targets are the owner\'s own code, local sandboxes and containers, and public datasets or benchmarks. No third-party system is to be accessed or attacked.',
    'Work on that basis: explain and implement what the research needs, keep any attack or exploit code minimal and confined to the test environment, and report findings plainly. If a step would affect a real system outside that scope, or would only make sense for causing harm, do not do it and say why in your report.',
  ].join('\n\n'),
};

const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// { presets, bad }: presets that are well formed (an id, a name, some text), and a reason for the first that is not.
function cleanPresets(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const id = String(p?.id || '').trim().toLowerCase();
    const name = String(p?.name || '').trim().slice(0, 60);
    const text = String(p?.text || '').trim();
    if (!PRESET_ID.test(id)) return { presets: out, bad: `"${id}" is not a preset id: lowercase letters, digits and -, up to 32.` };
    if (!text) return { presets: out, bad: `Preset "${id}" has no text.` };
    if (text.length > 6000) return { presets: out, bad: `Preset "${id}" is longer than 6000 characters.` };
    if (out.some((x) => x.id === id)) return { presets: out, bad: `Two presets are called "${id}".` };
    const keywords = [...new Set((Array.isArray(p.keywords) ? p.keywords : String(p.keywords || '').split(','))
      .map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 60);
    out.push({ id, name: name || id, text, keywords, auto: p.auto !== false });
  }
  return { presets: out, bad: null };
}

// Which preset a job gets: the one asked for ('none' = none), else the first automatic one whose keyword appears in
// the job's text (whole words for Latin keywords, anywhere for Chinese ones). Returns { preset } or { error }.
function choosePreset(asked, text) {
  const presets = cleanPresets(loadSettings().presets).presets;
  const want = String(asked || '').trim().toLowerCase();
  if (want === 'none') return { preset: null };
  if (want) {
    const p = presets.find((x) => x.id === want);
    return p ? { preset: p } : { error: `No task preset "${want}" (Relay settings has: ${presets.map((x) => x.id).join(', ') || 'none'}).` };
  }
  const hay = String(text || '').toLowerCase();
  const hit = (k) => (/^[\x00-\x7f]+$/.test(k) ? new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(hay) : hay.includes(k));
  return { preset: presets.find((p) => p.auto && p.keywords.some(hit)) || null };
}

// folderLock: one job at a time per project folder (off: jobs share a folder, and only jobs whose scopes overlap wait).
// jobsPerWorker: how many jobs one worker account runs at once (0 = no limit); with every worker busy, a job waits.
const DEFAULT_SETTINGS = { permissionMode: 'acceptEdits', extraArgs: '', allowedTools: [], deniedTools: [], folderLock: false, jobsPerWorker: 1, presets: [SECURITY_PRESET], claudePath: '', startAtLogin: true, language: 'en' };

// Commands (and other tools) workers may use without asking: Claude Code permission rules, passed to every worker and
// takeover run as --allowedTools. A rule is a tool name, optionally with a pattern in parentheses: "Bash(npm test)",
// "Bash(python3 *)", "WebFetch", "mcp__github__get_issue". One line, starting with a letter, so it can never be read
// as another command-line flag. Returns { rules, bad }: the cleaned, de-duplicated rules and whatever was refused.
const RULE_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^\n\r]{1,300}\))?$/;
function cleanAllowedTools(list) {
  const rules = [];
  const bad = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const r = String(raw == null ? '' : raw).trim();
    if (!r) continue;
    if (!RULE_RE.test(r)) bad.push(r);
    else if (!rules.includes(r)) rules.push(r);
  }
  return { rules: rules.slice(0, 100), bad };
}
const cleanLanguage = (l) => (l === 'zh' ? 'zh' : 'en');
const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) });
const saveSettings = (patch) => mutate(settingsFile(), {}, (cur) => {
  const next = { ...DEFAULT_SETTINGS, ...cur, ...patch };
  next.language = cleanLanguage(next.language);
  return next;
});

module.exports = {
  home, accountRoots, ownsConfigDir, load, save, get, upsert, remove, update, newAccount, isReady, cleanModel,
  markLimited, markNeedsLogin, markUsed, setDesktop, observeLeader, getLeaderSeen, rememberAccountUuid, emailForUuid, nextAvailable, earliestUnblock,
  loadSettings, saveSettings, cleanAllowedTools, cleanPresets, choosePreset, SECURITY_PRESET, nowSec,
};
