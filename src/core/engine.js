'use strict';
// Runs one task as a headless `claude -p` process under some account. If that
// account runs out of quota mid-task, it is parked until its reset time and the same session
// (`--resume <id>`) continues on the next ready account. If every account is limited, wait for
// the earliest reset and carry on. Nothing for the user to do.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const store = require('./store');
const memory = require('./memory');
const { withFileLock, alive, token: newToken } = require('./fslock');
const { backendFor, getBackend, providerOf, DEFAULT_PROVIDER } = require('./backends');

const CONTINUE_PROMPT =
  'The previous account hit its usage limit in the middle of this task, so the session was moved to ' +
  'another account. Continue exactly where you left off. Do not redo steps that are already finished; ' +
  'if the last tool call was interrupted, check its effect first. If everything was already finished, just say so in one sentence.';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk'];
const UNKNOWN_RESET_COOLDOWN = 20 * 60;
// How long a resume waits for an account that already has the session when it cannot be copied to another one.
const sessionWaitSec = () => Number(process.env.RELAY_SESSION_WAIT_SEC || 20 * 60); // no reset time in the message: re-probe later, a failed probe is cheap
const MAX_ITEMS = 3000;

// Engines of this process that are using an account right now (engine -> account name), for the least-busy choice.
const activeHere = new Map();
const BUSY = Symbol('every ready worker is busy');

// ---- the fair queue for a free worker ----
// A run that finds every worker busy leaves a ticket in <home>/pickq/ (its priority and since when it waits) and
// refreshes it at every try. Every pick (under the pick lock) first counts the live tickets of the same provider that
// rank before it (higher priority, then older); it only takes a slot when there are more free slots than that, so a
// lower-priority or later job never takes the slot a waiting higher or earlier job is entitled to, whichever process
// happens to try first. A ticket whose process died or that was not refreshed for TICKET_STALE_MS is ignored and removed.
const ticketsDir = () => path.join(store.home(), 'pickq');
const TICKET_STALE_MS = 30000;
const rankOf = (p) => (Object.prototype.hasOwnProperty.call(store.PRIORITY_RANK, p) ? store.PRIORITY_RANK[p] : store.PRIORITY_RANK.normal);
// Does ticket a come before ticket b? Higher priority first, then the one waiting longer, then by token.
const before = (a, b) => (rankOf(b.priority) - rankOf(a.priority)) || (a.at - b.at) || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0);
function liveTickets() {
  const dir = ticketsDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const f = path.join(dir, n);
    let t = null;
    try { t = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { t = null; }
    if (!t || !t.pid || !alive(t.pid) || Date.now() - (Number(t.beat) || 0) > TICKET_STALE_MS) {
      try { fs.rmSync(f, { force: true }); } catch { /* next time */ }
      continue;
    }
    out.push(t);
  }
  return out.sort(before);
}

const hhmm = (sec) => new Date(sec * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function splitArgs(str) {
  return (str.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((s) => s.replace(/^(["'])(.*)\1$/, '$2'));
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done);
  });
}

// One run of the CLI under one account. The backend (by the account's provider) builds the command line, reads its
// event stream and says how the run ended: { kind: 'done' | 'limited' | 'auth' | 'error', sid, ... }. A backend with a
// preflight (Codex: the sandbox canary check) must pass it first; otherwise nothing is started.
async function runOnce(acct, opts, onEvent, setChild) {
  const backend = backendFor(acct);
  if (backend.preflight) {
    const pf = await backend.preflight(acct, { cwd: opts.cwd });
    if (onEvent.preflight) onEvent.preflight(acct, pf);
    if (!pf.ok) return { kind: 'error', code: pf.code || 'preflight_failed', sid: opts.sessionId, text: pf.text };
  }
  return spawnRun(backend, acct, opts, onEvent, setChild);
}

function spawnRun(backend, acct, { prompt, cwd, sessionId, extraArgs, allowedTools = [], deniedTools = [], appendSystemPrompt = '', permissionMode, model, effort, hidePaths = [], isolated = false }, onEvent, setChild) {
  return new Promise((resolve, reject) => {
    backend.prepare(acct);
    const args = backend.buildArgs({ sessionId, model, effort, permissionMode, allowedTools, deniedTools, appendSystemPrompt, extraArgs, cwd, hidePaths, isolated });
    // an isolated job: the backend's own switches for it (Claude: auto memory off), if it has any
    const isoEnv = isolated && typeof backend.isolatedEnv === 'function' ? backend.isolatedEnv() : {};

    let child;
    try {
      child = backend.spawn(args, { cwd: cwd || undefined, env: backend.env(acct, { RELAY_TAKEOVER: '1', ...isoEnv }), stdio: ['pipe', 'pipe', 'pipe'], group: true });
    } catch (e) {
      return reject(e);
    }
    setChild(child);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt); // via stdin: no command-line length or quoting problems

    let sid = sessionId;
    let result = null;
    let rejected = null;
    let stderr = '';
    let closed = false;
    let early = null; // a backend's early check found the run is not sandboxed as required: it was stopped
    // Backends that can check a running session's sandbox (Codex: the rollout's turn_context, written when the turn
    // starts) are checked as soon as the session is known, and the run is stopped at once if it is wrong.
    const before = backend.verifyRun && sessionId ? (backend.verifyRun(acct, sessionId).turns || 0) : 0;
    let watching = false;
    const watch = (id) => {
      watching = true;
      const deadline = Date.now() + Number(process.env.RELAY_EARLY_CHECK_MS || 20000);
      const tick = () => {
        if (closed) return;
        let v = null;
        try { v = backend.verifyRun(acct, id, { sinceTurns: before }); } catch { v = null; }
        if (v && v.turns > before) {
          if (v.status === 'violation') { early = v; backend.killTree(child); }
          return;
        }
        if (Date.now() < deadline) setTimeout(tick, 150);
      };
      tick();
    };
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      onEvent(ev, backend);
      const id = backend.sessionIdFrom(ev);
      if (id) sid = id;
      if (id && backend.verifyRun && !watching) watch(id);
      rejected = backend.limitFromEvent(ev) || rejected;
      result = backend.resultFrom(ev, result) || result;
    });
    child.on('close', (code) => {
      closed = true;
      if (early) return resolve({ kind: 'error', code: 'guard_violation', sid, text: `Stopped at the start: the session is not running under the required sandbox (${early.text}).` });
      resolve(backend.outcome({ sid, result, rejected, stderr, code }));
    });
  });
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.tick = Number(process.env.RELAY_TICK || 30) * 1000;
    this.busyPollMs = Number(process.env.RELAY_BUSY_POLL_MS || 2000);
    this.slack = Number(process.env.RELAY_SLACK || 5) * 1000;
    this.newChat(true);
  }

  newChat(force = false) {
    if (this.running && !force) throw new Error('A task is still running');
    this.running = false;
    this.status = 'idle'; // idle | running | waiting | error
    this.items = [];
    this.sessionId = null;
    this.account = null;
    this.waitingUntil = null;
    this.stopped = false;
    this.child = null;
    this.prepare = this.prepare || null;
    this.filter = this.filter || null; // restrict which accounts may be used (e.g. workers only)
    // Which CLI the session runs on. Only accounts of this provider are ever picked, so a failover on a limit never
    // hands a session to an account whose CLI cannot resume it.
    this.provider = this.provider || DEFAULT_PROVIDER;
    this.maxWait = this.maxWait ?? null; // seconds; refuse to wait for a reset longer than this
    this.maxPerAccount = this.maxPerAccount ?? null; // jobs one account may run at once (worker runs); null = no limit
    this.pinned = this.pinned ?? null; // an account the caller asked for: while it is ready but full, the run waits for it
    this.busyWaitSec = this.busyWaitSec ?? 1800; // how long to wait for a free worker before giving up
    this.priority = this.priority || 'normal'; // high | normal | low: who gets a freed worker slot first
    this.queuePos = null; // while waiting for a free worker: 1 = next in line
    this.lastError = null;
    this.abort = new AbortController();
    this.emit('reset');
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return { status: this.status, running: this.running, account: this.account, sessionId: this.sessionId, waitingUntil: this.waitingUntil, waitingFor: this.waitingFor || null, queuePos: this.queuePos || null };
  }

  _push(item) {
    item.t = Date.now();
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    this.emit('item', item);
  }

  _state(status, patch = {}) {
    this.status = status;
    Object.assign(this, patch);
    this.emit('state', this.snapshot());
  }

  stop() {
    this._dropTicket();
    if (!this.running) return;
    this.stopped = true;
    getBackend(this.provider).killTree(this.child);
    this.abort.abort();
  }

  // Continue a session that was started elsewhere (e.g. in the desktop app) and stopped on a limit.
  // `account` is the one it was running under; it is skipped while it is limited.
  takeover({ sessionId, cwd, permissionMode, account = null }) {
    this.sessionId = sessionId;
    this.account = account;
    return this.send({ prompt: CONTINUE_PROMPT, cwd, permissionMode, hidden: true });
  }

  // The account for the next attempt. Worker runs (maxPerAccount set) give each account its own cap from its weekly
  // quota (workerCaps: how much of its week is left per day until the reset; never above maxPerAccount): an account at
  // its cap is not free. Among the ready accounts under their caps, the preferred one (the account a resumed session
  // lives on) wins; otherwise the first in pickOrder (the fewest Relay runs on it right now, so every worker gets one
  // job before any gets a second; at the same load a 5-hour window at 95% or more goes last, then the weekly window that
  // resets soonest, the least recently used, registry order). An account the caller pinned (this.pinned) is used
  // while it is under maxPerAccount, whatever its quota cap (the caller chose it); when it is full the run waits for it.
  // When every ready account is at its cap, _pick answers BUSY and the run waits for a slot. Several windows start jobs
  // at the same moment, so choosing and reserving (lastUsed + this run's account in its run file, via onReserve) happen
  // under one cross-process lock: the next window to choose already sees this reservation. The caps are worked out
  // again at every pick from the latest usage reading.
  _pick(preferred) {
    return withFileLock(path.join(store.home(), 'pick'), () => {
      activeHere.delete(this); // a failover: the account this run leaves must not count against the others
      const now = store.nowSec();
      const accounts = store.load().filter((x) => this._accepts(x));
      const load = activeRuns();
      const cache = usageCache();
      const max = this.maxPerAccount;
      const ready = accounts.filter((x) => store.isReady(x, now));
      const openIn = (list, l) => (max == null ? list : openAccounts(list, { load: l, cache, now, max }).open);
      // A pinned account (the caller's `account`) that is ready: only it, under maxPerAccount.
      const pinnedReady = !!this.pinned && preferred === this.pinned && ready.some((x) => x.name === this.pinned);
      const pinnedRoom = (l) => max == null || (l.get(this.pinned) || 0) < max;
      this.accepts = pinnedReady ? [this.pinned] : ready.map((x) => x.name); // written into this run's ticket
      this.pinnedWait = pinnedReady ? this.pinned : null;
      let open = openIn(ready, load);
      if (pinnedReady ? !pinnedRoom(load) : ready.length && !open.length) return this._wait(0);
      // The fair queue: the waiting jobs that rank before this one take the free slots first, each one the slot the
      // normal order would give it among the accounts it accepts (a pinned one: its account), its load counted as it
      // takes it; this run may only use what is left, and sees the load those jobs will add.
      let seen = load;
      if (max != null) {
        const ahead = this._aheadTickets();
        if (ahead.length) {
          seen = new Map(load);
          const pool = store.load().filter((y) => providerOf(y) === this.provider && store.isReady(y, now));
          for (const t of ahead) {
            let n = null;
            if (t.pinned) n = pool.some((x) => x.name === t.pinned) && (seen.get(t.pinned) || 0) < max ? t.pinned : null;
            else {
              const can = openIn(pool, seen).filter((x) => !Array.isArray(t.accepts) || t.accepts.includes(x.name));
              n = can.length ? pickOrder(can, { load: seen, cache, now })[0].x.name : null;
            }
            if (n) seen.set(n, (seen.get(n) || 0) + 1);
          }
          open = openIn(ready, seen);
          if (pinnedReady ? !pinnedRoom(seen) : !open.length) return this._wait(ahead.length);
        }
      }
      let a = null;
      if (pinnedReady) a = ready.find((x) => x.name === this.pinned);
      else {
        a = (preferred && open.find((x) => x.name === preferred)) || null; // a resumed session's account, under its cap
        if (!a && open.length) a = pickOrder(open, { load: seen, cache, now })[0].x;
      }
      if (!a) return null;
      this._dropTicket();
      store.markUsed(a.name);
      this.account = a.name;
      activeHere.set(this, a.name);
      if (this.onReserve) { try { this.onReserve(a); } catch { /* reporting must not stop the run */ } }
      return a;
    });
  }

  // Gives back the account _pick reserved for this engine without running anything (a pick that is not followed by a run).
  _unreserve() { activeHere.delete(this); this._dropTicket(); }

  // This run's place in the queue for a free worker (called under the pick lock).
  _me() { return this.ticket || { priority: this.priority, at: Date.now(), token: '~' }; }
  _aheadTickets() {
    const me = this._me();
    return liveTickets().filter((t) => t.token !== me.token && t.provider === this.provider && before(t, me) < 0);
  }
  _ahead() { return this._aheadTickets().length; }
  // No slot for this run now: take or refresh its ticket, note its position, answer BUSY.
  _wait(ahead) {
    if (!this.ticket) this.ticket = { pid: process.pid, token: newToken(), priority: this.priority, provider: this.provider, at: Date.now() };
    try {
      fs.mkdirSync(ticketsDir(), { recursive: true });
      fs.writeFileSync(path.join(ticketsDir(), `${this.ticket.token}.json`), JSON.stringify({ ...this.ticket, accepts: this.accepts || null, pinned: this.pinnedWait || null, beat: Date.now() }));
    } catch { /* without a ticket it still waits, only without its place */ }
    this.queuePos = (ahead || this._ahead()) + 1;
    return BUSY;
  }
  _dropTicket() {
    if (!this.ticket) return;
    try { fs.rmSync(path.join(ticketsDir(), `${this.ticket.token}.json`), { force: true }); } catch { /* stale: ignored after TICKET_STALE_MS */ }
    this.ticket = null;
    this.queuePos = null;
  }

  // An account this run may use: the caller's filter, and the session's provider. While the session could not be
  // carried to another account (sessionHomes, until homeDeadline): only the accounts that already see it.
  _accepts(x) {
    const homeOk = !this.sessionHomes || Date.now() >= (this.homeDeadline || 0) || this.sessionHomes.has(x.name);
    return (!this.filter || this.filter(x)) && providerOf(x) === this.provider && homeOk;
  }

  // Before a resume on `acct`: the backend makes the session resumable there (Claude: its transcript and session folder
  // copied into that account's own projects folder, verified; core/sessions.js). 'ok' to run; 'wait' when it could
  // not be copied but other accounts already see it (the run waits for one of them, at most sessionWaitSec). A session
  // Relay finds nowhere is still tried (the CLI may know a place Relay does not); only once the CLI itself has not found
  // it (strict) does this throw session_missing, and the caller hands the thread over to a new session.
  _carry(acct, backend, cwd, { strict = false } = {}) {
    if (!this.sessionId || typeof backend.carrySession !== 'function') return 'ok';
    let r;
    try { r = backend.carrySession(acct, this.sessionId, { cwd }); } catch (e) { r = { ok: false, code: 'copy_failed', why: (e && e.message) || String(e), holders: [] }; }
    if (r && r.ok) {
      this.sessionHomes = null;
      if (r.copied) {
        this.carried = { account: acct.name, from: r.from, to: r.to, bytes: r.bytes, files: r.files, at: Date.now() };
        this._push({ kind: 'notice', level: 'info', code: 'session_carried', params: { account: acct.name, bytes: r.bytes }, text: `Carried the session to ${acct.name} (${r.bytes} bytes${r.files ? `, ${r.files} more files` : ''}); continuing it there.` });
        this.emit('carried', this.carried);
      }
      return 'ok';
    }
    if (r && r.code === 'copy_failed') {
      const holders = new Set((r.holders || []).map((d) => path.resolve(d)));
      const homes = store.load().filter((x) => (!this.filter || this.filter(x)) && providerOf(x) === this.provider && x.configDir && holders.has(path.resolve(x.configDir))).map((x) => x.name);
      if (homes.length && !homes.includes(acct.name)) {
        if (!this.homeDeadline) this.homeDeadline = Date.now() + sessionWaitSec() * 1000;
        if (Date.now() < this.homeDeadline) {
          this.sessionHomes = new Set(homes);
          this._unreserve();
          this._push({ kind: 'notice', level: 'warn', code: 'session_wait', params: { account: acct.name, homes }, text: `The session could not be copied to ${acct.name} (${r.why}); waiting for ${homes.join(' or ')}, which already ${homes.length > 1 ? 'have' : 'has'} it.` });
          return 'wait';
        }
      }
    }
    this.sessionHomes = null;
    if (!strict && r && r.code === 'session_missing') return 'ok';
    throw Object.assign(new Error(`The worker session ${this.sessionId} cannot be resumed on ${acct.name}: ${(r && r.why) || 'not found'}.`), { code: 'session_missing', why: (r && r.why) || '' });
  }

  // The commands workers may run and any extra arguments come from Settings unless the caller passes its own.
  // hidePaths: absolute paths the run may not read, for backends that enforce that in their sandbox (Codex).
  // isolated: an isolated job (the backend turns off what would carry other sessions' knowledge in, e.g. auto memory).
  async send({ prompt, cwd, permissionMode, extraArgs, allowedTools, deniedTools, appendSystemPrompt = '', hidePaths = [], isolated = false, hidden = false }) {
    if (this.running) throw new Error('A task is already running');
    if (cwd && !fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) throw new Error(`Unknown permission mode: ${permissionMode}`);

    this.running = true;
    this.stopped = false;
    this.missingRetried = false;
    this.sessionHomes = null;
    this.homeDeadline = null;
    this.abort = new AbortController();
    if (!hidden) this._push({ kind: 'user', text: prompt });
    this._state('running');
    try {
      const settings = store.loadSettings();
      await this._loop({
        prompt, cwd, permissionMode,
        extraArgs: splitArgs(extraArgs ?? settings.extraArgs ?? ''),
        allowedTools: allowedTools ?? store.cleanAllowedTools(settings.allowedTools).rules,
        deniedTools: deniedTools ?? store.cleanAllowedTools(settings.deniedTools).rules,
        appendSystemPrompt,
        hidePaths,
        isolated,
      });
      activeHere.delete(this);
      this._dropTicket();
      this.running = false;
      if (this.stopped) this._push({ kind: 'notice', level: 'info', code: 'stopped', text: 'Stopped.' });
      this._state('idle', { waitingUntil: null });
      if (!this.stopped) this.emit('done', this.snapshot());
    } catch (e) {
      activeHere.delete(this);
      this._dropTicket();
      this.running = false;
      if (this.stopped) {
        this._push({ kind: 'notice', level: 'info', code: 'stopped', text: 'Stopped.' });
        this._state('idle', { waitingUntil: null });
      } else {
        this.lastError = e;
        this._push({ kind: 'notice', level: 'error', code: e.code, text: e.message });
        this._state('error', { waitingUntil: null });
        this.emit('failed', e);
      }
    }
  }

  async _loop({ prompt, cwd, permissionMode, extraArgs, allowedTools, deniedTools, appendSystemPrompt, hidePaths = [], isolated = false }) {
    let next = prompt;
    let preferred = this.account;
    let busySince = 0;
    for (let attempt = 0; attempt < 200 && !this.stopped; attempt++) {
      const acct = this._pick(preferred);
      if (acct === BUSY) { // every ready worker already has its jobs: wait for one to come free
        if (!busySince) busySince = Date.now();
        if (Date.now() - busySince > this.busyWaitSec * 1000) throw Object.assign(new Error('Every worker is busy with other jobs.'), { code: 'workers_busy' });
        if (this.waitingFor !== 'worker' || this.queuePos !== this.shownPos) { this.shownPos = this.queuePos; this._state('waiting', { waitingUntil: null, waitingFor: 'worker' }); }
        await sleep(this.busyPollMs + Math.random() * 500, this.abort.signal);
        attempt--; // waiting for a free worker is not an account switch
        continue;
      }
      if (this.waitingFor === 'worker') { busySince = 0; this._state('running', { waitingFor: null }); }
      if (!acct) {
        let wake = store.earliestUnblock(store.nowSec(), (x) => this._accepts(x));
        // waiting for the accounts that hold the session: never past the end of that wait
        const homeEnd = this.sessionHomes && this.homeDeadline > Date.now() ? Math.ceil(this.homeDeadline / 1000) : null;
        if (homeEnd && (wake == null || wake > homeEnd)) wake = homeEnd;
        if (wake == null) throw Object.assign(new Error('No usable account. Add one, or sign in again from the Accounts panel.'), { code: 'no_account' });
        if (this.maxWait != null && wake !== homeEnd && wake - store.nowSec() > this.maxWait) throw Object.assign(new Error('Every worker account has reached its limit.'), { code: 'workers_limited', until: wake });
        this._push({ kind: 'notice', level: 'warn', code: 'all_limited', params: { until: wake }, text: `Every account has hit its limit. Resuming automatically at ${hhmm(wake)}.` });
        this._state('waiting', { waitingUntil: wake });
        while (!this.stopped && Date.now() < wake * 1000 + this.slack) {
          await sleep(Math.min(this.tick, Math.max(wake * 1000 + this.slack - Date.now(), 10)), this.abort.signal);
        }
        this._state('running', { waitingUntil: null });
        continue;
      }

      const backend = backendFor(acct);
      if (preferred && acct.name !== preferred) {
        // Some CLIs (Codex) keep a session inside one account's home: it cannot move. Start it again on the new
        // account from the original prompt instead (only read-only jobs run there, so a fresh start is safe).
        const fresh = backend.resumeAcrossAccounts === false && !!this.sessionId;
        if (fresh) { this.sessionId = null; next = prompt; }
        this._push({ kind: 'notice', level: 'switch', code: 'switch', params: { from: preferred, to: acct.name }, text: fresh ? `Switched account: ${preferred} → ${acct.name}. Its sessions cannot move between accounts, so the job starts again there.` : `Switched account: ${preferred} → ${acct.name}. Continuing the same session.` });
        this.emit('switch', { from: preferred, to: acct.name });
      }
      preferred = acct.name;
      this.account = acct.name; // _pick already marked it used, under the pick lock
      this.emit('state', this.snapshot());

      if (this.prepare) await this.prepare(acct, this.sessionId);
      if (this._carry(acct, backend, cwd) === 'wait') { attempt--; continue; }
      // Which model: the one asked for explicitly, else (worker runs only) the account's own default, else
      // whatever Claude Code defaults to. A takeover never applies a worker's default: it continues someone
      // else's session and should not silently switch its model. The effort is only ever the one asked for.
      const model = this.model || (this.useAccountModel ? acct.model : '') || '';
      const ctx = { model }; // per-run parsing state (the stream may not name the model)
      const onEvent = (ev, be) => {
        // known from the first event on, so a run stopped halfway (cancel, window closed) can still be resumed
        const id = be.sessionIdFrom(ev);
        if (id) this.sessionId = id;
        be.parseEvent(ev, acct, ctx).forEach((it) => this._push(it));
      };
      onEvent.preflight = (a, pf) => this.emit('preflight', { account: a.name, ok: !!pf.ok, code: pf.code || null, text: pf.text || '' });
      const out = await runOnce(
        acct,
        { prompt: next, cwd, sessionId: this.sessionId, extraArgs, allowedTools, deniedTools, appendSystemPrompt, permissionMode, model, effort: this.effort || '', hidePaths, isolated },
        onEvent,
        (c) => (this.child = c),
      );
      this.sessionId = out.sid || this.sessionId;
      if (this.stopped) return;

      if (out.kind === 'done') return;
      // The CLI did not find the session although it was carried (or another copy was written meanwhile): carry it
      // again and retry once; if that is not possible, _carry throws session_missing.
      if (out.kind === 'error' && out.code === 'session_missing' && this.sessionId && !this.missingRetried) {
        this.missingRetried = true;
        this._push({ kind: 'notice', level: 'warn', code: 'session_missing', params: { account: acct.name }, text: `${acct.name} did not find the session; carrying it again.` });
        if (this._carry(acct, backend, cwd, { strict: true }) === 'wait') { attempt--; continue; }
        attempt--;
        continue;
      }
      if (out.kind === 'limited') {
        const until = out.resetAt || store.nowSec() + UNKNOWN_RESET_COOLDOWN;
        store.markLimited(acct.name, until, out.limitType || 'usage');
        this._push({ kind: 'notice', level: 'warn', code: 'limited', params: { account: acct.name, type: out.limitType || 'usage', until }, text: `${acct.name} reached its ${out.limitType || 'usage'} limit (resets ${hhmm(until)}).` });
        if (this.sessionId) next = CONTINUE_PROMPT;
        this.emit('state', this.snapshot());
      } else if (out.kind === 'auth') {
        store.markNeedsLogin(acct.name);
        this._push({ kind: 'notice', level: 'warn', code: 'needs_login', params: { account: acct.name }, text: `${acct.name} needs to sign in again. Trying another account.` });
        this.emit('needs-login', acct.name);
      } else {
        throw Object.assign(new Error(out.text), out.code ? { code: out.code } : {});
      }
    }
    if (!this.stopped) throw new Error('Gave up after too many account switches.');
  }
}

// The usage readings (core/usage.js keeps them): only read here, never refreshed by a pick.
function usageCache() {
  try { return require('./usage').readCache(); } catch { return {}; }
}
const WEEK = 7 * 86400;
const SESSION_HOT = 95; // a 5-hour window this full is used after the others with the same number of jobs
// When the account's weekly usage window resets next (seconds), or null when unknown. A reading from before the
// last reset still tells the weekday and time: the window repeats every 7 days.
function weeklyReset(u, now) {
  let r = Number(u?.week?.resetsAt);
  if (!Number.isFinite(r) || r <= 0) return null;
  if (r <= now) r += Math.ceil((now - r) / WEEK) * WEEK;
  return r;
}
// The order accounts that are ready and have a free slot are used in (every worker gets one job before any worker gets
// a second, two before any gets a third; then worker tiers):
//   1. the fewest Relay runs on it right now (parked jobs hold no run, so they count 0);
//   2. at the same load, the lower tier first (Accounts panel: 1 = most preferred, the default; 2; 3). With a and b at
//      tier 1 and c at tier 2, jobs go a, b, c, a, b, c, ...: c gets its first job once a and b have one each;
//   3. within a tier, a 5-hour window at 95% or more goes after the others;
//   4. the weekly window that resets soonest ("use it or lose it": what is left of it is gone at the reset), unknown
//      reset times after known ones;
//   5. the least recently used, then registry order.
// Returns [{ x: account, i, n: runs now, tier, reset, hot }], best first.
function pickOrder(accounts, { load = activeRuns(), cache = usageCache(), now = store.nowSec() } = {}) {
  return accounts.map((x, i) => {
    const u = cache[x.name]?.data || null;
    return { x, i, n: load.get(x.name) || 0, tier: store.tierOf(x), reset: weeklyReset(u, now), hot: Number(u?.session?.pct) >= SESSION_HOT, pct: Number(u?.session?.pct) };
  }).sort((p, q) => (p.n - q.n) || (p.tier - q.tier) || (p.hot - q.hot)
    || ((p.reset == null) - (q.reset == null)) || (p.reset != null && q.reset != null ? p.reset - q.reset : 0)
    || (p.x.lastUsed || 0) - (q.x.lastUsed || 0) || p.i - q.i);
}

// ---- each worker's cap from its weekly quota ----
// Daily spare = (100 - weekly % used) / days until the weekly reset (at least 0.25 day): how much of its week an account
// can still spend per day. 10 %/day or more: 3 jobs at once; 5 to 10: 2; below 5: 1. A week at 95% or more: 0 (it only
// takes a job, one, when every other ready worker is at its own cap). Unknown usage: 2. Never above `max` (Settings).
const WEEK_FULL = 95;
const DAY = 86400;
function dailyCap(u, now, max = 3) {
  let pct = Number(u?.week?.pct);
  const raw = Number(u?.week?.resetsAt);
  const reset = weeklyReset(u, now);
  if (!Number.isFinite(pct) || reset == null) return { cap: Math.min(2, max), unknown: true, spare: null, pct: null, reset: null };
  if (Number.isFinite(raw) && raw > 0 && raw <= now) pct = 0; // the reading is from before the reset: a new week
  const days = Math.max((reset - now) / DAY, 0.25);
  const spare = (100 - pct) / days;
  if (pct >= WEEK_FULL) return { cap: 0, weekFull: true, spare, pct, reset, days };
  return { cap: Math.min(max, spare >= 10 ? 3 : spare >= 5 ? 2 : 1), spare, pct, reset, days };
}
// The caps of a set of ready accounts of one provider, under a given load: Map name -> dailyCap(...) plus lastResort
// (an account with a full week that may take one job because every other one is at its cap).
function workerCaps(accounts, { load = activeRuns(), cache = usageCache(), now = store.nowSec(), max = 3 } = {}) {
  const caps = new Map(accounts.map((x) => [x.name, dailyCap(cache[x.name]?.data || null, now, max)]));
  const full = new Map(accounts.map((x) => [x.name, (load.get(x.name) || 0) >= caps.get(x.name).cap]));
  for (const x of accounts) {
    const c = caps.get(x.name);
    if (c.weekFull && max > 0 && accounts.every((y) => y === x || full.get(y.name))) caps.set(x.name, { ...c, cap: 1, lastResort: true });
  }
  return caps;
}
// The accounts (ready, one provider) that are under their caps: { open, caps }.
function openAccounts(accounts, opts = {}) {
  const load = opts.load || activeRuns();
  const caps = workerCaps(accounts, { ...opts, load });
  return { open: accounts.filter((x) => (load.get(x.name) || 0) < caps.get(x.name).cap), caps };
}

// How many Relay runs use each account right now: the live run files of every process (each Claude window's Relay
// tool writes one per job) plus this process's own engines (counted once: its own run files are skipped).
function activeRuns() {
  const count = new Map();
  const add = (name) => name && count.set(name, (count.get(name) || 0) + 1);
  for (const r of memory.listRuns()) if (r.pid !== process.pid) add(r.account);
  for (const name of activeHere.values()) add(name);
  return count;
}

module.exports = { Engine, splitArgs, PERMISSION_MODES, CONTINUE_PROMPT, pickOrder, weeklyReset, activeRuns, SESSION_HOT, dailyCap, workerCaps, openAccounts, WEEK_FULL, liveTickets, ticketsDir };
