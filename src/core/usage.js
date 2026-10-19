'use strict';
// Per-account plan usage, read from Claude Code itself: `claude -p /usage` prints the same
// "Current session / Current week" numbers as the in-app /usage panel. No tokens are touched.
// (Needs a recent Claude Code; older builds answer "Unknown skill: usage".)

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const fslock = require('./fslock');
const { spawnClaude, accountEnv, authStatus } = require('./claude');
const { looksLikeAuthError } = require('./parse');

const cacheFile = () => path.join(store.home(), 'usage.json');
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

function readCache() {
  try { return fslock.readJson(cacheFile(), {}); } catch { return {}; }
}
// Every window's Relay process and the app refresh this cache: change one account's entry under a cross-process
// lock (re-reading inside it) so nobody drops another's reading, and never fail a job over a cache write.
function updateCache(name, fn) {
  try {
    return fslock.withFileLock(cacheFile(), () => {
      const c = readCache();
      c[name] = fn(c[name]);
      fslock.writeJson(cacheFile(), c, { space: 0 });
      return c[name];
    });
  } catch {
    return fn(readCache()[name]);
  }
}

// ---- turning "resets Oct 8, 5pm (Australia/Sydney)" into an instant ----
function wallClockIn(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: g('year'), mo: g('month') - 1, d: g('day'), h: g('hour'), mi: g('minute'), s: g('second') };
}
function zonedToEpochMs(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo, d, h, mi);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const w = wallClockIn(t, tz);
    t += wall - Date.UTC(w.y, w.mo, w.d, w.h, w.mi, 0); // move by the difference between wanted and actual wall time
  }
  return t;
}
function parseResetText(text, nowMs = Date.now()) {
  const tzm = /\(([A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)*)\)/.exec(text);
  let tz = tzm ? tzm[1] : Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; }
  const m = /(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(text);
  if (!m) return null;
  const [, mon, day, hh, mm, ap] = m;
  const hour = (Number(hh) % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
  const min = Number(mm || 0);
  const now = wallClockIn(nowMs, tz);
  const monthIdx = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
  let ms;
  if (monthIdx >= 0) {
    ms = zonedToEpochMs(now.y, monthIdx, Number(day), hour, min, tz);
    if (ms < nowMs - 2 * 86400000) ms = zonedToEpochMs(now.y + 1, monthIdx, Number(day), hour, min, tz);
  } else {
    ms = zonedToEpochMs(now.y, now.mo, now.d, hour, min, tz);
    if (ms <= nowMs) ms = zonedToEpochMs(now.y, now.mo, now.d + 1, hour, min, tz);
  }
  return ms / 1000;
}

function parseUsage(text, nowMs = Date.now()) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(Current [^:]+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•\-–]\s*resets\s+(.+?))?\s*$/i.exec(line);
    if (m) rows.push({ label: m[1], pct: Number(m[2]), resetsAt: m[3] ? parseResetText(m[3], nowMs) : null, resetsText: m[3] || '' });
  }
  if (!rows.length) return null;
  const session = rows.find((r) => /session/i.test(r.label)) || null;
  const week = rows.find((r) => /week.*all models/i.test(r.label)) || rows.find((r) => /week/i.test(r.label)) || null;
  return { session, week, others: rows.filter((r) => r !== session && r !== week) };
}

// A reading starts a whole Claude Code; on a computer that is very busy (several workers, a build, a VM) that can take
// minutes. It gets 3 minutes, and a reading cut short says so instead of "unreadable output". --strict-mcp-config:
// /usage needs no MCP servers, so none are started (fewer processes on a busy machine).
const USAGE_TIMEOUT_MS = () => Number(process.env.RELAY_USAGE_TIMEOUT_MS || 180000);
function fetchUsage(acct, timeoutMs = USAGE_TIMEOUT_MS()) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    let timedOut = false;
    try {
      child = spawnClaude(['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'], {
        // RELAY_TAKEOVER marks this as Relay's own run, so the SessionStart hook does not report it as a user session
        cwd: os.tmpdir(), env: accountEnv(acct, { RELAY_TAKEOVER: 'usage' }), stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      return resolve({ error: e.message });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) return resolve({ error: `timed out after ${Math.round(timeoutMs / 1000)} s: the computer is very busy`, timedOut: true });
      try {
        const text = String(JSON.parse(out).result || '');
        const data = parseUsage(text);
        resolve(data ? { data } : { error: text.slice(0, 160) || 'no usage data', authFailed: looksLikeAuthError(text) });
      } catch {
        resolve({ error: 'unreadable output' });
      }
    });
  });
}

// What the official numbers say wins over whatever we inferred earlier (a simulated event, a stale reset).
function applyTruth(acct, data) {
  const now = store.nowSec();
  let until = 0;
  let reason = '';
  for (const [r, row] of [['five_hour', data.session], ['seven_day', data.week]]) {
    if (row && row.pct >= 99 && row.resetsAt && row.resetsAt > now && row.resetsAt > until) { until = row.resetsAt; reason = r; }
  }
  if (until) store.markLimited(acct.name, until, reason);
  else if (acct.blockedUntil > now && ['five_hour', 'seven_day', 'rate'].includes(acct.blockedReason)) store.markLimited(acct.name, 0, '');
}

// A "sign in needed" flag must mean the login is really gone, not that one reply looked like an error: it takes
// two auth-looking failures in a row to set it, and any successful reading clears it (`recheck` lets a flagged
// account be tried again, which is how a login that still works comes back by itself after a restart).
const AUTH_STRIKES = 2;

// A login that disappears is rare and its cause is outside Relay (it never signs anyone out by itself, except when you
// remove an account): leave a dated line in events.log so it can be matched with whatever else happened then.
function noteSignedOut(acct, cached) {
  try {
    const line = { at: new Date().toISOString(), event: 'signed-out', account: acct.name, configDir: acct.configDir, lastUsageOk: cached?.okAt ? new Date(cached.okAt).toISOString() : null };
    fs.appendFileSync(path.join(store.home(), 'events.log'), `${JSON.stringify(line)}\n`);
  } catch { /* logging must never break a reading */ }
}

// One reading takes 13-20 s (it starts the official Claude Code and asks Anthropic), so it can never be instant.
// What keeps it feeling live is never reading the same account twice at once and reading all accounts side by side.
const inflight = new Map();
const isBusy = (name) => inflight.has(name);

// At most two readings at once: five Claude Codes starting together slow each other (and the workers) down.
const MAX_READING = 2;
let reading = 0;
const waiters = [];
async function slot(fn) {
  if (reading >= MAX_READING) await new Promise((r) => waiters.push(r));
  reading++;
  try { return await fn(); } finally { reading--; waiters.shift()?.(); }
}

function refresh(name, opts = {}) {
  if (inflight.has(name)) return inflight.get(name);
  const p = readOne(name, opts).finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

async function readOne(name, { recheck = false } = {}) {
  const acct = store.get(name);
  if (!acct || (acct.needsLogin && !recheck)) return null;
  const res = await slot(() => fetchUsage(acct));
  if (res.data) {
    applyTruth(acct, res.data);
    if (acct.needsLogin || acct.authFails) store.update(name, { needsLogin: false, authFails: 0 });
    return updateCache(name, () => ({ at: Date.now(), okAt: Date.now(), data: res.data }));
  }
  // No numbers came back. A folder whose login Claude Code cannot read answers /usage with a cost summary instead of an
  // error, which no text check recognises: ask Claude Code itself whether the folder has a login. On macOS that answer
  // can be "no" for one moment and "yes" the next (the Keychain may refuse a read, e.g. while it asks you to allow
  // access), so it counts as one strike like any other auth failure; "sign in needed" takes AUTH_STRIKES in a row.
  let signedOut = false;
  if (!res.authFailed && !res.timedOut) { // a reading cut short says nothing about the login
    const info = await authStatus(acct);
    signedOut = info.loggedIn === false && !info.error;
  }
  if (signedOut || res.authFailed) {
    const fails = (acct.authFails || 0) + 1;
    if (fails >= AUTH_STRIKES && !acct.needsLogin) { noteSignedOut(acct, readCache()[name]); store.markNeedsLogin(name); }
    store.update(name, { authFails: fails });
  }
  // `at` is when Relay last tried, `okAt` when a reading last worked: the panel dates the numbers by okAt.
  return updateCache(name, (prev) => ({ at: Date.now(), okAt: prev?.okAt || null, error: signedOut ? 'signed out' : res.error, data: prev?.data || null }));
}

// Accounts whose last reading is older than maxAgeMs (all of them when 0), skipping signed-out ones unless `recheck`
// (pressing Refresh tries those again too: a login that still works comes back by itself).
function stale(maxAgeMs = 0, names = null, { recheck = false } = {}) {
  const cache = readCache();
  return store.load()
    .filter((a) => (recheck || !a.needsLogin) && (!names || names.includes(a.name)))
    .filter((a) => !maxAgeMs || !cache[a.name] || Date.now() - cache[a.name].at >= maxAgeMs)
    .map((a) => a.name);
}

async function refreshAll({ maxAgeMs = 0 } = {}) {
  await Promise.all(stale(maxAgeMs).map((n) => refresh(n)));
  return readCache();
}

module.exports = { parseUsage, parseResetText, fetchUsage, refresh, refreshAll, readCache, isBusy, stale };
