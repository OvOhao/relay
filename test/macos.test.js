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

test('open at login is a LaunchAgent that starts Relay hidden, packaged or from source', () => {
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

test('PATH for an app opened from Finder: the login shell first, then what was there, then the install folders, no repeats', () => {
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

// ---- Baton -> Relay ----
function legacySandbox() {
  const root = sandbox();
  const legacy = path.join(root, 'baton-home');
  process.env.RELAY_LEGACY_HOME = legacy;
  const store = require(`${SRC}/core/store`);
  const setup = require(`${SRC}/core/setup`);
  const dirs = ['lead', 'w1'].map((n) => path.join(legacy, 'accounts', n));
  dirs.forEach((d) => setup.prepareConfigDir(d));
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'accounts.json'), JSON.stringify(dirs.map((d, i) => ({ ...store.newAccount(['lead', 'w1'][i], d, `${i}@x.com`), desktop: i === 0 }))));
  fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ language: 'zh', startAtLogin: true }));
  fs.mkdirSync(path.join(legacy, 'projects', 'p-1'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'projects', 'p-1', 'ledger.jsonl'), '{}\n');
  return { root, legacy, dirs, store };
}

test('first start as Relay: ~/.baton moves to ~/.relay, the sign-in folders stay where their logins are', () => {
  const { legacy, dirs, store } = legacySandbox();
  try {
    const { migrateHome } = require(`${SRC}/core/migrate`);
    const r = migrateHome();
    assert.deepEqual(r.moved.sort(), ['accounts.json', 'projects', 'settings.json']);
    const home = process.env.RELAY_HOME;
    assert.ok(fs.existsSync(path.join(home, 'projects', 'p-1', 'ledger.jsonl')));
    assert.ok(fs.existsSync(dirs[0]) && fs.existsSync(dirs[1]), 'sign-in folders are not moved');
    assert.ok(!fs.existsSync(path.join(home, 'accounts')));
    assert.deepEqual(store.load().map((a) => a.configDir), dirs, 'accounts still point at their folders');
    assert.equal(store.loadSettings().language, 'zh');
    assert.ok(dirs.every((d) => store.ownsConfigDir(d)), 'the kept folders are still Relay\'s to manage');
    assert.equal(store.ownsConfigDir(process.env.RELAY_HUB), false, 'never the main ~/.claude');
    assert.deepEqual(migrateHome().moved, [], 'only once');
  } finally {
    delete process.env.RELAY_LEGACY_HOME;
  }
});

test('an account kept from Baton can still be removed, and Remove Relay with sign-ins clears ~/.baton too', async () => {
  const { legacy, dirs, store } = legacySandbox();
  try {
    require(`${SRC}/core/migrate`).migrateHome();
    const setup = require(`${SRC}/core/setup`);
    setup.removeConfigDir(dirs[1]); // refused before: "not inside the accounts folder"
    assert.ok(!fs.existsSync(dirs[1]));
    await require(`${SRC}/core/connect`).removeAll({ logins: true });
    assert.ok(!fs.existsSync(legacy) && !fs.existsSync(process.env.RELAY_HOME));
    assert.ok(fs.existsSync(process.env.RELAY_HUB));
  } finally {
    delete process.env.RELAY_LEGACY_HOME;
  }
});

test('Claude Code wired up as Baton is rewired as Relay: old tool, skill and hooks out, new ones in, other hooks kept', async () => {
  const root = sandbox();
  const hub = process.env.RELAY_HUB;
  const other = { hooks: [{ type: 'command', command: 'echo mine' }] };
  const oldHook = (m) => ({ ...m, hooks: [{ type: 'command', command: 'sh "/Users/x/.baton/bin/baton-hook.sh"', timeout: 10 }] });
  fs.writeFileSync(path.join(hub, 'settings.json'), JSON.stringify({ hooks: { StopFailure: [other, oldHook({ matcher: 'rate_limit' })], SessionStart: [oldHook({})] } }));
  fs.writeFileSync(path.join(hub, 'settings.json.baton-backup'), '{}');
  fs.writeFileSync(path.join(hub, '.claude.json'), JSON.stringify({ mcpServers: { baton: { command: 'x' }, keep: { command: 'y' } } }));
  fs.mkdirSync(path.join(hub, 'skills', 'baton'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'skills', 'baton', 'SKILL.md'), '---\nname: baton\n---\n<!-- managed by Baton: removed when you disconnect Baton -->\n');
  fs.mkdirSync(path.join(hub, 'skills', 'mine'), { recursive: true });

  const connect = require(`${SRC}/core/connect`);
  assert.equal(connect.legacyStatus().any, true);
  const st = await connect.migrateLegacyWiring();
  assert.equal(st.all, true);
  assert.equal(connect.legacyStatus().any, false);
  const settings = JSON.parse(fs.readFileSync(path.join(hub, 'settings.json'), 'utf8'));
  const cmds = (ev) => settings.hooks[ev].flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepEqual(cmds('StopFailure').filter((c) => !c.includes('relay-hook')), ['echo mine']);
  assert.ok(cmds('SessionStart').every((c) => c.includes('relay-hook')));
  const mcp = JSON.parse(fs.readFileSync(path.join(hub, '.claude.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ['keep', 'relay']);
  assert.ok(!fs.existsSync(path.join(hub, 'skills', 'baton')) && fs.existsSync(path.join(hub, 'skills', 'mine')));
  assert.ok(fs.existsSync(path.join(hub, 'skills', 'relay', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(hub, 'settings.json.relay-backup')));
  assert.equal(await connect.migrateLegacyWiring(), null, 'nothing to do the second time');
  void root;
});

test('the open-at-login agent from Baton is replaced by Relay\'s', () => {
  const root = sandbox();
  process.env.RELAY_LAUNCH_AGENTS_DIR = path.join(root, 'LaunchAgents');
  try {
    const p = require(`${SRC}/core/platform`);
    fs.mkdirSync(process.env.RELAY_LAUNCH_AGENTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.RELAY_LAUNCH_AGENTS_DIR, 'dev.baton.app.plist'), '<plist/>');
    assert.equal(p.removeLegacyAutoStart(), true);
    assert.equal(p.removeLegacyAutoStart(), false);
    assert.match(p.agentPlist({ packaged: true, execPath: '/Applications/Relay.app/Contents/MacOS/Relay' }), /dev\.relay\.app[\s\S]*\/Applications\/Relay\.app/);
  } finally {
    delete process.env.RELAY_LAUNCH_AGENTS_DIR;
  }
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
