'use strict';
// Local HTTP + SSE bridge between the panel UI, the Claude Code hook and the takeover manager.
// Loopback only. The UI is guarded by a random token cookie plus Host/Origin checks; the hook
// endpoint by a separate token from connect.json: this process can run Claude Code in the
// user's folders, so a random web page must not be able to drive it.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./core/store');
const setup = require('./core/setup');
const hook = require('./core/hook');
const connect = require('./core/connect');
const usage = require('./core/usage');
const memory = require('./core/memory');
const desktop = require('./core/desktop');
const { reconcile } = require('./core/reconcile');
const { startLogin, openLoginPage } = require('./core/login');
const { authStatus, claudeCmd } = require('./core/claude');
const { Takeovers } = require('./core/takeover');
const platform = require('./core/platform');
const { PERMISSION_MODES } = require('./core/engine');
const { getBackend } = require('./core/backends');
const jobs = require('./core/jobs');
const health = require('./core/health');

const UI_DIR = path.join(__dirname, '..', 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function slug(email) {
  const base = (email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const taken = new Set(store.load().map((a) => a.name));
  const stem = base || 'account';
  let name = stem;
  for (let i = 2; taken.has(name); i++) name = `${stem}-${i}`;
  return name;
}
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
// The Windows hook sends these percent-encoded; the macOS / Linux one (sh + curl) sends them as they are. A raw value
// with a stray "%" must not turn the whole event into a 400.
const header = (v) => {
  const s = String(v || '');
  try { return decodeURIComponent(s); } catch { return s; }
};

// Every call from the Claude Code hook leaves a line here, so "did it fire?" is answerable later.
let removed = false;
function logEvent(entry) {
  if (removed) return;
  try {
    const file = path.join(store.home(), 'events.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1e6) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}
`);
  } catch { /* logging must never break the hook */ }
}

function createServer({ shell = {}, takeovers = new Takeovers() } = {}) {
  const uiToken = crypto.randomBytes(24).toString('hex');
  const clients = new Set();
  let hookToken = '';
  let login = null; // what the UI shows about a sign-in in progress
  let loginHandle = null;
  let loginCancelled = false;
  let origin = '';

  const broadcast = (type, data = {}) => {
    const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const c of clients) c.write(msg);
  };

  // Parked background jobs (RELAY_PARK): no worker is held, but each card lists the ones that last ran on it.
  // A parked job whose wake is overdue (core/jobs.js isOverdue) is marked, for the card's WAKE OVERDUE badge.
  const parkedJobs = () => {
    try {
      return jobs.list().filter((j) => j.state === 'parked').map((j) => ({
        id: j.id, account: j.account || null, title: j.title || j.project || '', project: j.project || '', wakeAt: j.wakeAt || null, wakes: j.wakes || 0,
        overdueMin: jobs.isOverdue(j) ? Math.round(jobs.overdueMs(j) / 60000) : 0,
      }));
    } catch { return []; }
  };
  // Manual progress checks (the "Check progress" button, relay_wake) asked for in the last 24 hours, per account they
  // were asked on: the card shows each one (pending, or its short report).
  const manualChecks = () => {
    const out = [];
    try {
      for (const j of jobs.list()) {
        for (const m of Array.isArray(j.manualChecks) ? j.manualChecks : []) {
          if (Date.now() - (m.at || 0) > 86400e3) continue;
          out.push({ id: j.id, title: j.title || j.project || '', account: m.account || j.account || null, at: m.at, state: m.state || 'requested', outcome: m.outcome || '', short: m.short || '', note: m.note || '', finishedAt: m.finishedAt || null, jobState: j.state });
        }
      }
    } catch { /* none shown */ }
    return out.sort((a, b) => b.at - a.at);
  };
  // The panel's Recent list (from the project ledgers), each run with the flags still open on its job: a flag the
  // leader resolved with relay_ack loses its warning badge. A run without a job record (relay_run, or a job pruned
  // after 7 days) keeps the flags its ledger entry has.
  const recentRuns = () => memory.recentRuns().map((r) => {
    if (!r.flags || !r.jobId) return r;
    let job = null;
    try { job = jobs.read(r.jobId); } catch { /* keep the entry's flags */ }
    if (!job) return r;
    const open = r.flags.filter((f) => !jobs.ackOf(job, f));
    return { ...r, flags: open.length ? open : undefined };
  });
  // Worker health checks (core/health.js): the newest record per account, and which accounts are being checked now.
  const healthBusy = new Set();
  const healthView = (name) => {
    try {
      const rec = health.forAccount(name);
      return rec ? { at: rec.at, project: path.basename(rec.root), root: rec.root, problems: health.problems(rec) } : null;
    } catch { return null; }
  };
  // The projects to check: those with health_checks that had a job in the last 7 days or were checked before.
  const healthProjects = () => {
    const cwds = new Set();
    try { for (const j of jobs.list()) if (j.cwd) cwds.add(j.cwd); } catch { /* none */ }
    try { for (const r of Object.values(require('./core/fslock').readJson(health.file(), {}) || {})) if (r.cwd) cwds.add(r.cwd); } catch { /* none */ }
    return [...cwds];
  };
  // Checks run here, in the tray app, one round at a time; the panel follows through 'accounts' events.
  let healthRound = null;
  const runHealth = ({ name = null, force = false } = {}) => {
    if (healthRound) return healthRound;
    const names = name ? [name] : store.load().filter((a) => store.isWorker(a) && a.provider !== 'codex').map((a) => a.name);
    names.forEach((n) => healthBusy.add(n));
    pushAccounts();
    healthRound = (async () => {
      const seen = new Set();
      for (const cwd of healthProjects()) {
        if (removed || !fs.existsSync(cwd)) continue;
        const pc = require('./core/project').loadConfig(cwd);
        if (pc.error || !pc.config.healthChecks.length) continue;
        const root = health.rootOf(cwd, pc.config);
        if (seen.has(root)) continue;
        seen.add(root);
        try { await health.run({ cwd, account: name || '', force }); } catch { /* the next round */ }
      }
    })().finally(() => { healthRound = null; names.forEach((n) => healthBusy.delete(n)); pushAccounts(); });
    return healthRound;
  };
  const publicAccounts = () => {
    const cache = usage.readCache();
    const live = [...takeovers.snapshot().active, ...memory.listRuns()].filter((j) => j.status === 'running');
    const busy = new Set(live.map((j) => j.account));
    const parked = parkedJobs();
    const checks = manualChecks();
    // Each ready worker's cap from its weekly quota (core/engine.js workerCaps), as the next pick would see it.
    const caps = new Map();
    try {
      const { openAccounts, activeRuns } = require('./core/engine');
      const { providerOf } = require('./core/backends');
      const all = store.load();
      const load = activeRuns();
      const max = store.jobsPerWorker();
      const now = store.nowSec();
      for (const prov of new Set(all.filter(store.isWorker).map(providerOf))) {
        const ready = all.filter((a) => store.isWorker(a) && !a.needsLogin && providerOf(a) === prov && store.isReady(a, now));
        openAccounts(ready, { load, cache, now, max }).caps.forEach((c, n) => caps.set(n, { cap: c.cap, max, spare: c.spare == null ? null : Math.round(c.spare * 10) / 10, unknown: !!c.unknown, weekFull: !!c.weekFull, lastResort: !!c.lastResort }));
      }
    } catch { /* no caps shown: the card shows the job count alone */ }
    return store.load().map((a) => ({
      cap: caps.get(a.name) || null,
      // the jobs this account runs right now (several at once with Settings › Jobs per worker), and its parked ones
      work: live.filter((j) => j.account === a.name).map((j) => ({ id: j.id, title: j.title || j.project || '', project: j.project || '' })),
      parked: parked.filter((j) => j.account === a.name),
      // the latest manual progress checks asked for on this account (newest first)
      checks: checks.filter((c) => c.account === a.name).slice(0, 3),
      // takes worker jobs (every worker; the leader only with its switch on), and its tier (1 = most preferred)
      worker: store.isWorker(a),
      takesJobs: a.takesJobs === true,
      tier: store.tierOf(a),
      // the newest health check of this worker (any project): what is wrong, if anything
      health: healthView(a.name),
      healthBusy: healthBusy.has(a.name),
      usage: cache[a.name]?.data || null,
      usageAt: cache[a.name]?.okAt || null, // when the numbers shown were read
      usageTriedAt: cache[a.name]?.at || null, // when Relay last tried (a failed try does not make old numbers new)
      usageError: cache[a.name]?.error || null,
      usageBusy: usage.isBusy(a.name),
      name: a.name,
      label: a.email || a.name,
      // The panel shows the plan as a tag: a Codex account reads "Codex pro", so it is told apart from Claude ones.
      plan: a.provider === 'codex' ? `Codex${a.plan ? ` ${a.plan}` : ''}` : a.plan,
      provider: a.provider || 'claude',
      desktop: !!a.desktop,
      model: a.model || '',
      status: a.needsLogin ? 'login' : a.blockedUntil > store.nowSec() ? 'limited' : 'ready',
      blockedUntil: a.blockedUntil,
      blockedReason: a.blockedReason,
      active: busy.has(a.name),
    }));
  };

  function claudeProblem() {
    try {
      claudeCmd();
      return null;
    } catch (e) {
      return e.message;
    }
  }

  // Whether the command-line Claude Code in ~/.claude is signed in. Only that login can be "adopted" with one click;
  // the desktop app keeps its own sign-in inside the app, which Relay neither can nor should read.
  let cli = { checkedAt: 0, loggedIn: false, email: '' };
  let cliProbing = false;
  function probeCli() {
    if (cliProbing || Date.now() - cli.checkedAt < 60000 || removed) return;
    cliProbing = true;
    authStatus(store.newAccount('main', setup.hubDir()))
      .then((info) => { cli = { checkedAt: Date.now(), loggedIn: !!info.loggedIn, email: info.email || '' }; })
      .catch(() => { cli = { ...cli, checkedAt: Date.now() }; })
      .finally(() => { cliProbing = false; });
  }

  // Who is the window's account? Best source is a session reporting its e-mail (leader.json). Without a session,
  // the desktop app's own folders tell which account it last used; that only names someone once a session has
  // reported the same account's e-mail before. A leader from before an account switch is not shown as current.
  function leaderView() {
    const seen = store.getLeaderSeen();
    const d = desktop.activeAccount();
    const known = !!d && !!store.emailForUuid(d.uuid);
    const stale = !!d && !known && !!seen && !!seen.uuid && seen.uuid !== d.uuid;
    return { leader: stale ? null : seen, desktop: { detected: !!d, pending: !!d && !known && (stale || !seen) } };
  }

  // Other tools that undo Relay's sign-ins. clauth (another multi-account manager) deletes, at every Claude Code
  // session start, each per-folder Keychain login it cannot match to one of its own folders: that includes every
  // Relay account on macOS. Relay cannot stop it, so it says so instead of showing "sign in needed" with no reason.
  function conflicts() {
    if (process.platform !== 'darwin' && !process.env.RELAY_CHECK_CONFLICTS) return [];
    try {
      const plugins = JSON.parse(fs.readFileSync(path.join(setup.hubDir(), 'settings.json'), 'utf8')).enabledPlugins || {};
      return Object.entries(plugins).some(([k, on]) => on && /^clauth@/.test(k)) ? ['clauth'] : [];
    } catch { return []; }
  }

  const fullState = () => {
    syncLeaderFromDesktop();
    probeCli();
    return {
      accounts: publicAccounts(),
      jobs: takeovers.snapshot(),
      connect: connect.status(),
      ...leaderView(),
      cli: { loggedIn: cli.loggedIn, email: cli.email, checked: cli.checkedAt > 0 },
      runs: memory.listRuns(),
      recent: recentRuns(),
      settings: store.loadSettings(),
      login,
      claudeProblem: claudeProblem(),
      conflicts: conflicts(),
      permissionModes: PERMISSION_MODES,
      canPickFolder: typeof shell.pickFolder === 'function',
      canAutoStart: typeof shell.setAutoStart === 'function',
      platform: process.platform, // the panel names the menu bar and "this Mac" instead of the tray and Windows
    };
  };

  const pushAccounts = () => broadcast('accounts', { accounts: publicAccounts(), ...leaderView() });

  // The desktop app puts the signed-in e-mail and account UUID in every session's environment; hooks and the MCP
  // tool forward them here, so Relay knows who the leader is, including right after you switch accounts.
  function observeIdentity(email, takeover, uuid = '') {
    if (!email || takeover || removed) return;
    const r = store.observeLeader(email, uuid);
    if (!r.changed && !r.seenChanged) return;
    pushAccounts();
    if (r.changed && !r.firstTime) {
      const n = { kind: 'leader', from: r.from ? r.from.name : null, to: r.leader ? r.leader.name : null, outside: r.outside || null };
      broadcast('notify', { notice: n });
      if (shell.notify) shell.notify(n, publicAccounts());
    }
  }

  // No session needed: if the desktop app's active account has been seen before, the e-mail is already known.
  function syncLeaderFromDesktop() {
    if (removed) return;
    const d = desktop.activeAccount();
    const email = d && store.emailForUuid(d.uuid);
    if (!email) return;
    const seen = store.getLeaderSeen();
    if (seen && seen.email === email && seen.uuid === d.uuid) return;
    observeIdentity(email, '', d.uuid);
  }
  // Read the plan usage of accounts whose last reading is older than maxAgeMs. The panel hears about it twice:
  // when the readings start (so it can say "reading…") and again as each one lands.
  function refreshUsage({ maxAgeMs = 0, names = null, recheck = false } = {}) {
    if (removed) return Promise.resolve();
    const todo = usage.stale(maxAgeMs, names, { recheck });
    if (!todo.length) return Promise.resolve();
    const runs = todo.map((n) => usage.refresh(n, { recheck }));
    broadcast('usage', { accounts: publicAccounts() });
    return Promise.all(runs.map((p) => p.catch(() => {}).finally(() => broadcast('usage', { accounts: publicAccounts() }))));
  }
  takeovers.on('update', (jobs) => broadcast('jobs', { jobs, accounts: publicAccounts() }));
  takeovers.on('notify', (n) => {
    broadcast('notify', { notice: { ...n, accounts: undefined } });
    shell.notify?.(n, publicAccounts());
  });

  function setLogin(patch) {
    login = patch === null ? null : { ...login, ...patch };
    broadcast('login', { login });
  }

  function beginLogin(acct) {
    if (loginHandle) throw new Error('Another sign-in is already in progress.');
    loginCancelled = false;
    setLogin({ account: acct.name, label: acct.email || acct.name, status: 'starting', url: null, manual: false, message: '' });
    loginHandle = startLogin(acct, {
      onUrl: (url, { manual }) => {
        const how = openLoginPage(url, acct);
        setLogin({ status: manual ? 'need-code' : 'waiting', url, manual, opened: how.method });
      },
    });
    loginHandle.done.then(({ ok, output }) => {
      loginHandle = null;
      if (loginCancelled) {
        setLogin(null);
      } else if (ok) {
        setLogin({ status: 'done' });
        setTimeout(() => !loginHandle && setLogin(null), 2500);
        refreshUsage({ names: [acct.name] }); // a new account shows its usage right away, not at the next round
      } else {
        setLogin({ status: 'failed', message: output.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'Sign-in did not finish.' });
      }
      pushAccounts();
    });
  }

  const routes = {
    'GET /api/state': () => fullState(),

    'POST /api/settings': (body) => {
      const before = store.loadSettings().language;
      const patch = pick(body, ['permissionMode', 'extraArgs', 'allowedTools', 'deniedTools', 'folderLock', 'jobsPerWorker', 'presets', 'startAtLogin', 'language', 'panelPinned', 'backgroundMaxWaitMin', 'preventSleepForWakes', 'preventSleepMinutes']);
      if ('backgroundMaxWaitMin' in patch) {
        const n = Number(patch.backgroundMaxWaitMin);
        if (!Number.isFinite(n) || n < 0 || n > 7 * 24 * 60) throw new Error('The longest wait of a background job is in minutes, from 0 (no limit) to 10080 (a week).');
        patch.backgroundMaxWaitMin = Math.round(n);
      }
      if ('preventSleepForWakes' in patch) patch.preventSleepForWakes = !!patch.preventSleepForWakes;
      if ('preventSleepMinutes' in patch) {
        const n = Number(patch.preventSleepMinutes);
        if (!Number.isFinite(n) || n < 0 || n > 120) throw new Error('Minutes before a wake: a number from 0 to 120.');
        patch.preventSleepMinutes = Math.round(n);
      }
      if ('presets' in patch) {
        const { presets, bad } = store.cleanPresets(patch.presets);
        if (bad) throw new Error(bad);
        patch.presets = presets;
      }
      if ('folderLock' in patch) patch.folderLock = !!patch.folderLock;
      if ('jobsPerWorker' in patch) {
        const n = Number(patch.jobsPerWorker);
        if (!Number.isInteger(n) || n < 1 || n > store.MAX_JOBS_PER_WORKER) throw new Error(`Jobs per worker must be a whole number from 1 to ${store.MAX_JOBS_PER_WORKER}.`);
        patch.jobsPerWorker = n;
      }
      if ('permissionMode' in patch && !PERMISSION_MODES.includes(patch.permissionMode)) throw new Error(`Unknown permission mode: ${patch.permissionMode}`);
      if ('panelPinned' in patch) patch.panelPinned = !!patch.panelPinned;
      if ('allowedTools' in patch) {
        const { rules, bad } = store.cleanAllowedTools(patch.allowedTools);
        if (bad.length) throw new Error(`Not a permission rule: ${bad.join(', ')}. Use a tool name, optionally with a pattern in parentheses, e.g. Bash(npm test).`);
        patch.allowedTools = rules;
      }
      if ('deniedTools' in patch) {
        const { rules, bad } = store.cleanAllowedTools(patch.deniedTools);
        if (bad.length) throw new Error(`Not a permission rule: ${bad.join(', ')}. Use a tool name, optionally with a pattern in parentheses, e.g. Bash(git push *).`);
        patch.deniedTools = rules;
      }
      const next = store.saveSettings(patch);
      if ('startAtLogin' in body) shell.setAutoStart?.(!!next.startAtLogin);
      if ('allowedTools' in patch || 'deniedTools' in patch) setup.syncAllAccounts(); // every worker account gets the new rules right away
      if (next.language !== before) shell.onLanguage?.(next.language);
      return next;
    },

    'POST /api/accounts': async (body) => {
      const email = String(body.email || '').trim();
      if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('That does not look like an email address.');
      if (email && store.load().some((a) => a.email.toLowerCase() === email.toLowerCase())) throw new Error('That account is already added.');
      const name = slug(email);
      const dir = setup.accountDir(name);
      setup.prepareConfigDir(dir);
      const acct = { ...store.newAccount(name, dir, email), needsLogin: true };
      store.upsert(acct);
      pushAccounts();
      beginLogin(acct);
      return { ok: true, name };
    },

    // One-click start for people who already use Claude Code: adopt the existing login.
    'POST /api/accounts/import-current': async () => {
      const hub = setup.hubDir();
      if (store.load().some((a) => a.configDir === hub)) throw new Error('Your current Claude Code login is already added.');
      const probe = store.newAccount('main', hub);
      const info = await authStatus(probe);
      if (!info.loggedIn) {
        throw new Error('No command-line Claude Code sign-in found. The Claude desktop app keeps its own sign-in inside the app, which Relay cannot see: it recognises that window by itself once you connect and start a session. Use “Add account” for your other accounts.');
      }
      store.upsert({ ...probe, name: slug(info.email || 'main'), email: info.email || '', plan: info.subscriptionType || '' });
      pushAccounts();
      return { ok: true };
    },

    // Register an existing Codex login (a CODEX_HOME signed in with `CODEX_HOME=<dir> codex login`): { name, codexHome, model }.
    'POST /api/accounts/codex': async (body) => {
      const r = await getBackend('codex').register({ name: body.name, codexHome: body.codexHome, model: body.model });
      pushAccounts();
      refreshUsage({ names: [r.name] });
      return { ok: true, ...r };
    },

    'POST /api/accounts/login': (body) => {
      const acct = store.get(body.name);
      if (!acct) throw new Error('Unknown account.');
      if (acct.provider === 'codex') throw new Error(`Sign in to a Codex account in a terminal: CODEX_HOME="${acct.configDir}" codex login`);
      beginLogin(acct);
      return { ok: true };
    },

    // The model this account's worker runs use by default ('' = Claude Code's own default).
    'POST /api/accounts/model': (body) => {
      const target = store.get(body.name);
      if (!target) throw new Error('Unknown account.');
      const model = store.cleanModel(body.model);
      if (model === null) throw new Error('That does not look like a model name. Use an alias such as “haiku” or an id such as “claude-haiku-5-5”.');
      if (target.provider === 'codex' && (!model || getBackend('codex').isClaudeModel(model))) throw new Error('A Codex account needs a Codex model id, such as “gpt-6-astra”.');
      store.update(body.name, { model });
      pushAccounts();
      return { ok: true, model };
    },

    // The leader's switch "Leader takes jobs too": stored on that account in accounts.json (takesJobs).
    'POST /api/accounts/takes-jobs': (body) => {
      const a = store.get(body.name);
      if (!a) throw new Error('Unknown account.');
      store.update(a.name, { takesJobs: !!body.on });
      pushAccounts();
      return { ok: true, takesJobs: !!body.on };
    },
    // A worker's tier: 1 (most preferred, the default), 2 or 3.
    'POST /api/accounts/tier': (body) => {
      const a = store.get(body.name);
      if (!a) throw new Error('Unknown account.');
      const tier = store.cleanTier(body.tier);
      if (tier == null) throw new Error('A tier is 1, 2 or 3.');
      store.update(a.name, { tier });
      pushAccounts();
      return { ok: true, tier };
    },
    // "Check progress" on a worker's card: every job parked on it wakes now for a progress check (core/jobs.js wakeNow).
    'POST /api/accounts/check-progress': (body) => {
      const { acct, jobs: parked } = jobs.parkedOn(body.name);
      if (!acct) throw new Error('Unknown account.');
      if (!parked.length) return { ok: true, woken: [], none: true };
      const res = jobs.wakeNow(parked.map((j) => j.id), { by: 'the Relay panel' });
      pushAccounts();
      return { ok: true, woken: res.filter((r) => r.ok).map((r) => r.id), failed: res.filter((r) => !r.ok) };
    },

    // ---- the dispatch dialog ("Dispatch a job") ----
    // Starts a background job exactly like relay_start (the same checks; a refusal comes back as the error).
    'POST /api/jobs/start': async (body) => {
      const args = { ...pick(body, ['task', 'cwd', 'thread', 'title', 'agent', 'model', 'effort', 'read_only', 'scope', 'priority', 'account']) };
      if (typeof args.scope === 'string') args.scope = args.scope.split(',').map((x) => x.trim()).filter(Boolean);
      if (Array.isArray(args.scope) && !args.scope.length) delete args.scope;
      for (const k of ['thread', 'title', 'agent', 'model', 'effort', 'priority', 'account']) if (args[k] === '' || args[k] == null) delete args[k];
      const r = await jobs.start(args, { via: 'panel' });
      if (!r.job) throw new Error(r.text);
      broadcast('runs', { runs: memory.listRuns(), recent: recentRuns(), accounts: publicAccounts() });
      return { ok: true, id: r.job.id, text: r.text };
    },
    // Recent project folders (ledgers and job records), newest first.
    'POST /api/projects': () => {
      const seen = new Map();
      try { for (const p of memory.recentProjects(20)) seen.set(p.cwd, Math.max(seen.get(p.cwd) || 0, p.at)); } catch { /* none */ }
      try { for (const j of jobs.list()) if (j.cwd && fs.existsSync(j.cwd)) seen.set(j.cwd, Math.max(seen.get(j.cwd) || 0, j.createdAt || 0)); } catch { /* none */ }
      return { folders: [...seen].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([cwd]) => cwd) };
    },
    // What the dialog needs to know about a folder: whether it exists, whether its project requires a scope, its threads.
    'POST /api/project-info': (body) => {
      const cwd = String(body.cwd || '').trim();
      if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return { exists: false };
      const pc = require('./core/project').loadConfig(cwd);
      let threads = [];
      try { threads = Object.entries(memory.listThreads(cwd)).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).map(([n]) => n).slice(0, 30); } catch { /* none */ }
      return { exists: true, requireScope: !pc.error && !!pc.config.requireScope, configError: pc.error || null, threads };
    },
    'POST /api/pick-folder': async () => {
      if (typeof shell.pickFolder !== 'function') throw new Error('Type the folder path: the folder picker is only in the Relay app.');
      return { cwd: (await shell.pickFolder()) || '' };
    },
    // One job's latest report and manual checks (a check's full report, opened from a worker card).
    'POST /api/jobs/report': (body) => {
      const j = jobs.read(String(body.id || ''));
      if (!j) throw new Error('No such job (finished jobs are kept for 7 days).');
      return { id: j.id, title: j.title || '', project: j.project || '', state: j.state, report: j.report || '', manualChecks: j.manualChecks || [], wakeAt: j.wakeAt || null };
    },

    'POST /api/accounts/desktop': (body) => {
      if (!store.get(body.name)) throw new Error('Unknown account.');
      store.setDesktop(body.name);
      pushAccounts();
      return { ok: true };
    },

    'POST /api/accounts/remove': async (body) => {
      const acct = store.get(body.name);
      if (!acct) return { ok: true };
      if (takeovers.snapshot().active.some((j) => j.account === acct.name)) throw new Error('A takeover is using this account. Stop it first.');
      // A Codex home is only registered, never created by Relay: removing the account leaves it (and its login) alone.
      const own = acct.provider !== 'codex' && store.ownsConfigDir(acct.configDir);
      if (own) await platform.forgetLogin(acct); // macOS: the login lives in the Keychain, not in the folder
      store.remove(acct.name);
      if (own) setup.removeConfigDir(acct.configDir);
      fs.rmSync(path.join(store.home(), 'browser', acct.name), { recursive: true, force: true });
      pushAccounts();
      return { ok: true };
    },

    'POST /api/login/cancel': () => {
      loginCancelled = true;
      loginHandle?.cancel();
      if (!loginHandle) setLogin(null);
      return { ok: true };
    },
    'POST /api/login/code': (body) => {
      if (!loginHandle) throw new Error('No sign-in in progress.');
      loginHandle.sendCode(body.code || '');
      return { ok: true };
    },
    'POST /api/login/reopen': () => {
      const acct = login && store.get(login.account);
      if (acct && login.url) openLoginPage(login.url, acct);
      return { ok: true };
    },

    'POST /api/connect': async () => { const c = await connect.install(); broadcast('connect', { connect: c }); return c; },
    'POST /api/disconnect': async () => { const c = await connect.uninstall(); broadcast('connect', { connect: c }); return c; },
    // Saved sign-ins are only deleted when the request says so (`logins: true`); the default keeps them.
    'POST /api/remove-all': async (body) => {
      if (takeovers.snapshot().active.length) throw new Error('Stop the running takeover first.');
      removed = true;
      const done = await connect.removeAll({ logins: body.logins === true });
      setTimeout(() => shell.quit && shell.quit(), 800);
      return { ok: true, logins: done.logins };
    },
    // Returns at once: a reading takes 13-20 s, the panel follows it through the 'usage' events instead of waiting.
    'POST /api/usage/refresh': (body) => {
      refreshUsage({ names: body.name ? [body.name] : null, recheck: true }); // pressed by you: signed-out ones too
      return { ok: true };
    },

    'POST /api/takeover/stop': (body) => (takeovers.stop(body.id), { ok: true }),
    // Check now, for every project with health_checks Relay knows (pressed in the panel: ignores the 6-hour rule).
    'POST /api/health': (body) => {
      if (body.name && !store.get(body.name)) throw new Error('Unknown account.');
      runHealth({ name: body.name || null, force: true }).catch(() => {});
      return { ok: true };
    },
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 2e6) throw new Error('Request too large.');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const port = () => new URL(origin).port;
  const hostOk = (req) => [`127.0.0.1:${port()}`, `localhost:${port()}`].includes(req.headers.host || ''); // DNS-rebinding guard

  function uiAuthorised(req, url) {
    const o = req.headers.origin;
    if (o && o !== origin && o !== `http://localhost:${port()}`) return false;
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('relay='));
    return cookie === `relay=${uiToken}` || url.searchParams.get('t') === uiToken;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin || 'http://127.0.0.1');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!hostOk(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden');
    }

    // Claude Code hook -> takeover
    if (req.method === 'POST' && url.pathname === '/hook') {
      if (req.headers['x-relay-token'] !== hookToken) return json(403, { error: 'bad token' });
      try {
        const payload = JSON.parse((await readBody(req)).replace(/^﻿/, '')); // tolerate a UTF-8 BOM from the shell
        const meta = {
          configDir: header(req.headers['x-relay-config-dir']),
          takeover: req.headers['x-relay-takeover'] || '',
          email: header(req.headers['x-relay-email']),
          accountUuid: req.headers['x-relay-account-uuid'] || '',
          entrypoint: req.headers['x-relay-entrypoint'] || '',
        };
        observeIdentity(meta.email, meta.takeover, meta.accountUuid);
        if (payload.hook_event_name === 'SessionStart') {
          if (!meta.takeover) logEvent({ event: 'SessionStart', email: meta.email || null, entrypoint: meta.entrypoint || null, result: 'identity noted' }); // Relay's own runs would only fill the log
          return json(200, { identity: true });
        }
        const out = takeovers.handleHook(payload, meta);
        logEvent({ error: payload.error, session: payload.session_id, cwd: payload.cwd, configDir: meta.configDir || null, email: meta.email || null, result: out.ignored ? `ignored: ${out.ignored}` : 'takeover started' });
        return json(200, out.ignored ? { ignored: out.ignored } : { started: true });
      } catch (e) {
        logEvent({ result: `bad request: ${e.message}` });
        return json(400, { error: e.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/ident') {
      if (req.headers['x-relay-token'] !== hookToken) return json(403, { error: 'bad token' });
      try {
        const body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, ''));
        observeIdentity(String(body.email || ''), '', String(body.uuid || ''));
        return json(200, { ok: true });
      } catch (e) {
        return json(400, { error: e.message });
      }
    }

    // A background job (relay_start) finished: a system notification with its title, account and outcome.
    if (req.method === 'POST' && url.pathname === '/job') {
      if (req.headers['x-relay-token'] !== hookToken) return json(403, { error: 'bad token' });
      try {
        const body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, ''));
        const n = {
          kind: 'job', id: String(body.id || ''), title: String(body.title || ''), project: String(body.project || ''), account: String(body.account || ''), ok: !!body.ok, state: String(body.state || ''), wakeAt: Number(body.wakeAt) || null,
          ...(body.check ? { check: { short: String(body.check.short || '').slice(0, 300), outcome: String(body.check.outcome || '') } } : {}),
        };
        if (n.check) pushAccounts(); // the card shows the check's short report
        broadcast('notify', { notice: n });
        shell.notify?.(n, publicAccounts());
        return json(200, { ok: true });
      } catch (e) {
        return json(400, { error: e.message });
      }
    }

    if (!uiAuthorised(req, url)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Open Relay from its window.');
    }
    if (url.searchParams.get('t') === uiToken) {
      res.writeHead(302, { 'set-cookie': `relay=${uiToken}; Path=/; HttpOnly; SameSite=Strict`, location: url.pathname });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      refreshUsage({ maxAgeMs: 20000 }); // the panel was just opened: show fresh numbers
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(keepAlive); clients.delete(res); });
      return;
    }

    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      try {
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
        return json(200, await route(body));
      } catch (e) {
        return json(400, { error: e.message });
      }
    }

    // static UI files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(UI_DIR, rel);
    if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      hookToken = hook.writeConnect(server.address().port);

      // After a restart or reboot: list again any sign-in found on disk, and re-test accounts flagged "sign in
      // needed" (a flag set by one bad reply must not outlive a login that still works), then read usage.
      const settle = async () => {
        if (removed) return;
        try {
          const r = await reconcile();
          if (r.adopted.length || r.revived.length) pushAccounts();
        } catch { /* the next round tries again */ }
      };
      setTimeout(() => settle().then(() => refreshUsage()), 1500).unref();
      // Live while someone is looking (panel visible): re-read anything older than a minute. Otherwise stay quiet:
      // every account is only re-read when its last reading is 4 minutes old. On a computer that is very busy (load
      // well above its number of cores) readings are spaced out further: each one starts a whole Claude Code.
      const watching = () => (shell.isPanelVisible ? !!shell.isPanelVisible() : clients.size > 0);
      const strained = () => os.loadavg()[0] > 2 * os.cpus().length;
      setInterval(() => refreshUsage({ maxAgeMs: (watching() ? 60 : 4 * 60) * 1000 * (strained() ? 3 : 1) }), 30 * 1000).unref();
      setInterval(settle, 30 * 60 * 1000).unref();
      setInterval(syncLeaderFromDesktop, 10 * 1000).unref();
      // Keep each worker account's settings (your settings + the commands workers may run) current.
      setTimeout(() => { if (!removed) { setup.syncAllAccounts(); connect.refreshSkill(); } }, 300).unref();
      setInterval(() => { if (!removed) setup.syncAllAccounts(); }, 20 * 1000).unref();
      setTimeout(syncLeaderFromDesktop, 500).unref();
      setTimeout(probeCli, 800).unref();

      // Parked jobs must wake even after a restart: a runner is started for any that has none (and checked again
      // every minute, in case one dies).
      // A tick that comes much later than asked means the computer slept (no timer runs then): the parked runners' own
      // timers fire within a moment of the wake, so for one grace time a live runner is not taken for a stuck one.
      // Electron's powerMonitor says so directly ('resume'); the clock check also works without it.
      let lastRevive = Date.now();
      let resumedAt = 0;
      const revive = (by = 'tray') => {
        if (removed) return;
        const now = Date.now();
        if (now - lastRevive > 60 * 1000 + 45 * 1000) { resumedAt = now; by = 'tray (after the computer slept)'; }
        lastRevive = now;
        try { jobs.reviveParked(process.env, { by, resumedAt }); } catch { /* next round */ }
      };
      setTimeout(revive, 2000).unref();
      setInterval(revive, 60 * 1000).unref();
      try {
        const { powerMonitor } = process.versions.electron ? require('electron') : {};
        if (powerMonitor) {
          powerMonitor.on('resume', () => {
            resumedAt = Date.now();
            // the runners' own check first; then whatever is still overdue and has no live runner
            setTimeout(() => revive('tray (system wake)'), 30 * 1000).unref();
          });
        }
      } catch { /* not in Electron: the clock check above */ }
      // Worker health: every 30 minutes, the accounts not checked for 6 hours in each project with health_checks.
      setTimeout(() => { if (!removed) runHealth().catch(() => {}); }, 5 * 60 * 1000).unref();
      setInterval(() => { if (!removed) runHealth().catch(() => {}); }, 30 * 60 * 1000).unref();

      let runsSig = '';
      setInterval(() => {
        if (removed) return;
        const runs = memory.listRuns();
        const sig = JSON.stringify([runs.map((r) => [r.id, r.status, r.account, r.lastLine]), parkedJobs().map((j) => [j.id, j.account, j.wakeAt]), jobs.ackStamp()]);
        if (sig !== runsSig) {
          runsSig = sig;
          broadcast('runs', { runs, recent: recentRuns(), accounts: publicAccounts() });
          shell.onRuns?.(runs); // the menu-bar count includes jobs handed to workers, not only takeovers
        }
      }, 2000).unref();

      resolve({ url: `${origin}/?t=${uiToken}`, origin, takeovers, refreshUsage, close: () => server.close() });
    });
  });
}

module.exports = { createServer };
