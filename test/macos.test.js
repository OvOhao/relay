'use strict';
// The macOS port: where the desktop app keeps its Claude Code, open-at-login, PATH for apps opened from Finder,
// the sh hook's raw headers, signing out (Keychain) before a login folder is deleted, and stopping a whole run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-claude.js');
const posix = process.platform !== 'win32';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mac-'));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'),
    RELAY_HUB: path.join(root, 'hub'),
    FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: '{}',
    RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE]),
  });
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  return root;
}

test('the desktop app\'s Claude Code is found inside its macOS app bundle, newest version first', { skip: !posix }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bundle-'));
  const make = (v, build, rel) => {
    const p = path.join(root, v, build, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    return p;
  };
  make('2.1.9', 'aaa', path.join('claude.app', 'Contents', 'MacOS', 'claude'));
  const newest = make('2.1.295', '9d6405864fdc', path.join('claude.app', 'Contents', 'MacOS', 'claude'));
  make('2.1.100', 'bbb', 'claude'); // the plain layout still counts
  process.env.RELAY_BUNDLED_DIR = root;
  try {
    const { bundledClaudes } = require(`${SRC}/core/claude`);
    const found = bundledClaudes();
    assert.deepEqual(found.map((f) => f.version), ['2.1.295', '2.1.100', '2.1.9']);
    assert.equal(found[0].path, newest);
  } finally {
    delete process.env.RELAY_BUNDLED_DIR;
  }
});

test('open at login is a LaunchAgent that starts Relay hidden, packaged or from source', { skip: !posix }, () => {
  const root = sandbox();
  process.env.RELAY_LAUNCH_AGENTS_DIR = path.join(root, 'LaunchAgents');
  try {
    const p = require(`${SRC}/core/platform`);
    const packaged = p.agentPlist({ packaged: true, execPath: '/Applications/Relay.app/Contents/MacOS/Relay' });
    assert.match(packaged, /<string>\/usr\/bin\/open<\/string>\s*<string>-g<\/string>\s*<string>-a<\/string>\s*<string>\/Applications\/Relay\.app<\/string>\s*<string>--args<\/string>\s*<string>--hidden<\/string>/);
    assert.match(packaged, /<key>Label<\/key>\s*<string>dev\.relay\.app<\/string>/);
    assert.match(packaged, /<key>RunAtLoad<\/key>\s*<true\/>/);

    const fromSource = p.agentPlist({ packaged: false, execPath: '/x/Electron.app/Contents/MacOS/Electron', appPath: '/Users/me/R&D <relay>' });
    assert.match(fromSource, /<string>\/Users\/me\/R&amp;D &lt;relay&gt;<\/string>\s*<string>--hidden<\/string>/);

    assert.equal(p.autoStartInstalled(), false);
    p.setAutoStart(true, { packaged: false, execPath: '/e', appPath: '/a' });
    assert.ok(fs.existsSync(path.join(root, 'LaunchAgents', 'dev.relay.app.plist')));
    assert.equal(p.autoStartInstalled(), true);
    p.setAutoStart(false);
    assert.equal(p.autoStartInstalled(), false);
  } finally {
    delete process.env.RELAY_LAUNCH_AGENTS_DIR;
  }
});

test('Remove Relay also removes the open-at-login agent', async () => {
  const root = sandbox();
  process.env.RELAY_LAUNCH_AGENTS_DIR = path.join(root, 'LaunchAgents');
  try {
    const p = require(`${SRC}/core/platform`);
    const connect = require(`${SRC}/core/connect`);
    p.setAutoStart(true, { packaged: false, execPath: '/e', appPath: '/a' });
    await connect.removeAll({ logins: false });
    assert.equal(p.autoStartInstalled(), false);
  } finally {
    delete process.env.RELAY_LAUNCH_AGENTS_DIR;
  }
});

test('PATH for an app opened from Finder: the login shell first, then what was there, then the install folders, no repeats', { skip: !posix }, () => {
  const { mergePath, standardDirs } = require(`${SRC}/core/platform`);
  const merged = mergePath('/a:/b', '/usr/bin:/b:/c', standardDirs()).split(':');
  assert.deepEqual(merged.slice(0, 4), ['/a', '/b', '/usr/bin', '/c']);
  assert.ok(merged.includes(path.join(os.homedir(), '.local', 'bin')));
  assert.ok(merged.includes('/opt/homebrew/bin'));
  assert.equal(new Set(merged).size, merged.length);
});

test('a removed account is signed out through `claude auth logout` (its Keychain entry) before its folder goes', async () => {
  const root = sandbox();
  process.env.RELAY_LOGOUT_ON_REMOVE = '1'; // what macOS does by itself
  try {
    const store = require(`${SRC}/core/store`);
    const setup = require(`${SRC}/core/setup`);
    const connect = require(`${SRC}/core/connect`);
    const dirs = ['a', 'b'].map((n) => setup.accountDir(n));
    dirs.forEach((d, i) => setup.prepareConfigDir(d) || store.upsert(store.newAccount(['a', 'b'][i], d, `${i}@x.com`)));
    await connect.removeAll({ logins: true });
    const out = fs.readFileSync(path.join(root, 'state', 'logouts.log'), 'utf8').trim().split('\n').sort();
    assert.deepEqual(out, dirs.sort());
    assert.ok(!fs.existsSync(dirs[0]) && !fs.existsSync(dirs[1]));
    assert.ok(fs.existsSync(process.env.RELAY_HUB), 'the main ~/.claude is never touched');
  } finally {
    delete process.env.RELAY_LOGOUT_ON_REMOVE;
  }
});

test('the sh hook\'s raw headers (spaces, a stray %) are accepted, not turned into a 400', async () => {
  const root = sandbox();
  const { createServer } = require(`${SRC}/server`);
  const s = await createServer();
  try {
    const { port, token } = JSON.parse(fs.readFileSync(path.join(root, 'home', 'connect.json'), 'utf8'));
    const post = (headers, body) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'x-relay-token': token, 'content-type': 'application/json', ...headers } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ code: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    const r = await post({ 'x-relay-config-dir': '/Users/Jo Smith/100% done/.claude', 'x-relay-email': 'jo@example.com' },
      { hook_event_name: 'StopFailure', error: 'server_error', session_id: 's', cwd: root });
    assert.equal(r.code, 200, r.body);
    assert.match(r.body, /ignored/);
  } finally {
    s.close();
  }
});

test('stopping a run stops what it started too (its own process group)', { skip: !posix }, async () => {
  const root = sandbox();
  const pidFile = path.join(root, 'grandchild.pid');
  process.env.RELAY_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(__dirname, 'helpers', 'grandchild.js')]);
  const { spawnClaude, killTree } = require(`${SRC}/core/claude`);
  const child = spawnClaude([], { env: { ...process.env, GRANDCHILD_PID_FILE: pidFile }, stdio: 'ignore', group: true });
  const exited = new Promise((r) => child.on('exit', r));
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const g = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(g));
  killTree(child);
  await exited;
  for (let i = 0; i < 40 && alive(g); i++) await new Promise((r) => setTimeout(r, 50));
  const left = alive(g);
  if (left) process.kill(g, 'SIGKILL');
  assert.equal(left, false, 'the grandchild outlived the run');
});

// ---- sign-in folders kept outside ~/.relay ----
test('sign-in folders in an extra root (settings: extraAccountRoots) are Relay\'s to manage, and only those', async () => {
  const root = sandbox();
  const store = require(`${SRC}/core/store`);
  const setup = require(`${SRC}/core/setup`);
  const extra = path.join(root, 'elsewhere', 'accounts');
  store.saveSettings({ extraAccountRoots: [extra, 'not/absolute', 7] });
  const dirs = ['a', 'b'].map((n) => path.join(extra, n));
  dirs.forEach((d) => setup.prepareConfigDir(d));
  assert.deepEqual(store.accountRoots(), [path.join(process.env.RELAY_HOME, 'accounts'), extra], 'only absolute paths count');
  assert.ok(dirs.every((d) => store.ownsConfigDir(d)));
  assert.equal(store.ownsConfigDir(process.env.RELAY_HUB), false, 'never the main ~/.claude');
  assert.equal(store.ownsConfigDir(path.join(root, 'elsewhere')), false);
  setup.removeConfigDir(dirs[1]);
  assert.ok(!fs.existsSync(dirs[1]));
  const adopted = await require(`${SRC}/core/reconcile`).adoptOrphans();
  assert.deepEqual(adopted, ['a'], 'a signed-in folder there is listed again after a lost registry');
  await require(`${SRC}/core/connect`).removeAll({ logins: true });
  assert.ok(!fs.existsSync(extra) && !fs.existsSync(process.env.RELAY_HOME));
  assert.ok(fs.existsSync(process.env.RELAY_HUB));
});

test('a login Claude Code cannot read: "sign in needed" after two tries in a row, and old numbers are not dated as new', async () => {
  const root = sandbox();
  const store = require(`${SRC}/core/store`);
  const usage = require(`${SRC}/core/usage`);
  store.save([store.newAccount('w', path.join(root, 'home', 'accounts', 'w'), 'w@x.com')]);
  const ok = await usage.refresh('w');
  assert.equal(ok.data.session.pct, 12);
  const okAt = ok.okAt;
  process.env.FAKE_LOGGED_OUT = '1';
  try {
    await new Promise((r) => setTimeout(r, 5));
    const once = await usage.refresh('w');
    assert.equal(store.get('w').needsLogin, false, 'one "no" may be the Keychain refusing for a moment');
    assert.equal(once.okAt, okAt);
    const bad = await usage.refresh('w');
    assert.equal(store.get('w').needsLogin, true, 'two in a row: sign in needed');
    assert.equal(bad.okAt, okAt, 'the numbers keep the time they were really read');
    assert.ok(bad.at > okAt);
    assert.equal(bad.data.session.pct, 12);
    assert.deepEqual(usage.stale(0, null), [], 'background rounds skip it');
    assert.deepEqual(usage.stale(0, null, { recheck: true }), ['w'], 'Refresh tries it again');
    delete process.env.FAKE_LOGGED_OUT;
    await usage.refresh('w', { recheck: true });
    assert.equal(store.get('w').needsLogin, false, 'a login that works again comes back by itself');
  } finally {
    delete process.env.FAKE_LOGGED_OUT;
  }
});

// ---- commands workers may run ----
test('permission rules are cleaned: tool names with an optional pattern, nothing that could pass for a flag', () => {
  sandbox();
  const store = require(`${SRC}/core/store`);
  const { rules, bad } = store.cleanAllowedTools(['Bash(python3 *)', ' Bash(ssh CSE_T4 *) ', 'WebFetch', 'mcp__github__get_issue', 'Bash(python3 *)', '',
    '--dangerously-skip-permissions', 'Bash(rm -rf /)\n--x', 'Bash(', 7]);
  assert.deepEqual(rules, ['Bash(python3 *)', 'Bash(ssh CSE_T4 *)', 'WebFetch', 'mcp__github__get_issue']);
  assert.deepEqual(bad, ['--dangerously-skip-permissions', 'Bash(rm -rf /)\n--x', 'Bash(', '7']);
});

test('every worker run gets the rules from Settings as --allowedTools, and Extra args as they are', async () => {
  const root = sandbox();
  const store = require(`${SRC}/core/store`);
  const { Engine } = require(`${SRC}/core/engine`);
  store.save([store.newAccount('w', path.join(root, 'home', 'accounts', 'w'), 'w@x.com')]);
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  store.saveSettings({ allowedTools: ['Bash(python3 *)', 'Bash(bin/claudeidea *)'], extraArgs: '--extra "a b" c' });
  const engine = new Engine();
  await engine.send({ prompt: 'hi', cwd: path.join(root, 'project'), permissionMode: 'acceptEdits', hidden: true });
  assert.equal(engine.status, 'idle', engine.lastError && engine.lastError.message);
  const runs = fs.readFileSync(path.join(root, 'state', 'invocations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(runs.at(-1).allowedTools, ['Bash(python3 *)', 'Bash(bin/claudeidea *)']);
  assert.deepEqual(runs.at(-1).extra, ['a b', 'c']);
});

test('worker accounts get your settings plus the allowed commands in their own settings.json; yours is never touched', () => {
  const root = sandbox();
  const store = require(`${SRC}/core/store`);
  const setup = require(`${SRC}/core/setup`);
  const hub = process.env.RELAY_HUB;
  const mine = { theme: 'dark', permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm *)'] }, hooks: { SessionStart: [] } };
  fs.writeFileSync(path.join(hub, 'settings.json'), JSON.stringify(mine));
  const w = path.join(root, 'home', 'accounts', 'w');
  setup.prepareConfigDir(w);
  store.save([store.newAccount('w', w, 'w@x.com'), store.newAccount('main', hub, 'me@x.com')]);
  store.saveSettings({ allowedTools: ['Bash(python3 *)', 'Bash(git status)'] });
  setup.syncAllAccounts();
  const got = JSON.parse(fs.readFileSync(path.join(w, 'settings.json'), 'utf8'));
  assert.deepEqual(got.permissions.allow, ['Bash(git status)', 'Bash(python3 *)'], 'yours first, then the new ones, no repeats');
  assert.deepEqual(got.permissions.deny, ['Bash(rm *)']);
  assert.equal(got.theme, 'dark');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hub, 'settings.json'), 'utf8')), mine, 'the main login\'s settings stay as they were');
  // an older Relay tool copies your file over the worker's when yours changes: the next round puts the rules back
  fs.copyFileSync(path.join(hub, 'settings.json'), path.join(w, 'settings.json'));
  setup.syncSharedFiles(w);
  assert.ok(JSON.parse(fs.readFileSync(path.join(w, 'settings.json'), 'utf8')).permissions.allow.includes('Bash(python3 *)'));
  store.saveSettings({ allowedTools: [] });
  setup.syncSharedFiles(w);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w, 'settings.json'), 'utf8')).permissions.allow, ['Bash(git status)'], 'a removed rule goes again');
});
