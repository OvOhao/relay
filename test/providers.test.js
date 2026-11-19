'use strict';
// Provider backends: the registry, defaults for records saved before providers existed, and failover that never
// hands a session to an account of another provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan, accounts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'),
    RELAY_HUB: path.join(root, 'hub'),
    FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan),
    RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE]),
    RELAY_TICK: '0.05',
    RELAY_SLACK: '0',
  });
  delete process.env.RELAY_TAKEOVER;
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save(accounts.map(([n, extra]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 0 });
  const invocations = () => {
    const f = path.join(process.env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  return { store, root, project: path.join(root, 'project'), invocations };
}

test('backend registry: claude is known, an unknown provider is a clear error', () => {
  const { getBackend, backendFor, PROVIDERS } = require(`${SRC}/core/backends`);
  assert.deepEqual(PROVIDERS, ['claude', 'codex']);
  const claude = getBackend('claude');
  assert.equal(claude.id, 'claude');
  assert.equal(getBackend(), claude, 'no name = the default provider');
  for (const m of ['buildArgs', 'env', 'spawn', 'killTree', 'prepare', 'parseEvent', 'sessionIdFrom', 'limitFromEvent', 'resultFrom', 'outcome', 'detectLimit', 'detectAuth', 'readUsage', 'loginStatus']) {
    assert.equal(typeof claude[m], 'function', `claude backend has ${m}()`);
  }
  assert.throws(() => getBackend('nope'), (e) => e.code === 'unknown_provider' && /Unknown provider "nope"/.test(e.message) && /claude/.test(e.message));
  assert.throws(() => getBackend('toString'), /Unknown provider/, 'no prototype names');
  assert.equal(backendFor({ provider: 'codex' }).id, 'codex');
  assert.throws(() => backendFor({ provider: 'otherprov' }), /Unknown provider "otherprov"/);
});

test('claude backend: command line and event handling are what the engine used to do inline', () => {
  const claude = require(`${SRC}/core/backends`).getBackend('claude');
  assert.deepEqual(claude.buildArgs({}), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(
    claude.buildArgs({ sessionId: 's1', model: 'haiku', effort: 'high', permissionMode: 'plan', allowedTools: ['Bash(ls)'], deniedTools: ['WebFetch'], appendSystemPrompt: 'bg', extraArgs: ['--x'] }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--model', 'haiku', '--effort', 'high', '--resume', 's1',
      '--allowedTools', 'Bash(ls)', '--disallowedTools', 'WebFetch', '--append-system-prompt', 'bg', '--x'],
  );
  const acct = { name: 'w' };
  assert.equal(claude.sessionIdFrom({ type: 'system', subtype: 'init', session_id: 'abc' }), 'abc');
  assert.equal(claude.sessionIdFrom({ type: 'assistant' }), null);
  assert.deepEqual(claude.parseEvent({ type: 'system', subtype: 'init', model: 'm' }, acct), [{ kind: 'init', account: 'w', model: 'm' }]);
  const info = { status: 'rejected', resetsAt: 123, rateLimitType: 'five_hour' };
  assert.equal(claude.limitFromEvent({ type: 'rate_limit_event', rate_limit_info: info }), info);
  assert.equal(claude.limitFromEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), null);
  assert.deepEqual(claude.outcome({ sid: 's', result: null, rejected: info, stderr: '' }), { kind: 'limited', sid: 's', resetAt: 123, limitType: 'five_hour', text: '' });
  assert.equal(claude.outcome({ sid: 's', result: { is_error: false }, rejected: null }).kind, 'done');
  assert.equal(claude.outcome({ sid: 's', result: { is_error: true, result: 'Not logged in · Please run /login' } }).kind, 'auth');
  assert.equal(claude.outcome({ sid: 's', result: null, stderr: '', code: 3 }).text, 'claude exited with code 3');
  assert.equal(claude.detectLimit("You've hit your session limit · resets 3pm").limited, true);
  assert.equal(claude.detectAuth('authentication_error'), true);
});

test('records saved before providers existed are Claude\'s: accounts and threads', () => {
  const s = sandbox({}, [['w1']]);
  const { providerOf } = require(`${SRC}/core/backends`);
  assert.equal(s.store.newAccount('x', '/tmp/x').provider, 'claude', 'new accounts say so');
  // an accounts.json written by an older Relay: no provider field, and loading it does not rewrite it
  const file = path.join(process.env.RELAY_HOME, 'accounts.json');
  const old = [{ name: 'old', configDir: path.join(s.root, 'home', 'accounts', 'old'), email: '', plan: '', blockedUntil: 0, blockedReason: '', needsLogin: false, lastUsed: 0, desktop: false }];
  fs.writeFileSync(file, JSON.stringify(old));
  const loaded = s.store.load();
  assert.equal(loaded[0].provider, undefined);
  assert.equal(providerOf(loaded[0]), 'claude');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old, 'the file is left as it was');
  assert.equal(providerOf(null), 'claude');
  assert.equal(providerOf({ provider: '' }), 'claude');
  assert.equal(providerOf({ provider: 'codex' }), 'codex');
});

test('a thread saved without a provider resumes on Claude, and a new thread records its provider', async () => {
  const s = sandbox({ w1: ['ok', 'ok'] }, [['lead', { desktop: true }], ['w1']]);
  const memory = require(`${SRC}/core/memory`);
  const { runWorker } = require(`${SRC}/core/workers`);
  const first = await runWorker({ task: 'one', cwd: s.project, thread: 't' });
  assert.equal(first.ok, true);
  assert.equal(memory.getThread(s.project, 't').provider, 'claude');
  // as an older Relay would have saved it
  const f = path.join(memory.projectDir(s.project), 'threads.json');
  const all = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete all.t.provider;
  fs.writeFileSync(f, JSON.stringify(all));
  const second = await runWorker({ task: 'two', cwd: s.project, thread: 't' });
  assert.equal(second.ok, true);
  assert.equal(s.invocations()[1].resume, first.sessionId, 'it resumed the same Claude session');
  assert.equal(memory.getThread(s.project, 't').provider, 'claude');
});

test('failover on a limit never moves a session to an account of another provider', async () => {
  // 'other' is ready, least used and listed first, but runs a different CLI: it must never be picked.
  const s = sandbox({ w1: ['limit:2', 'ok'], other: ['ok'] }, [['other', { provider: 'otherprov' }], ['w1']]);
  const { Engine } = require(`${SRC}/core/engine`);
  const engine = new Engine();
  await engine.send({ prompt: 'job' });
  assert.equal(engine.status, 'idle');
  const used = s.invocations().map((i) => i.account);
  assert.deepEqual(used, ['w1', 'w1'], 'it waited for w1 to reset instead of switching provider');
  assert.ok(!used.includes('other'));
  assert.equal(engine.account, 'w1');
});

test('worker runs: another provider\'s account is neither picked nor a failover target', async () => {
  const s = sandbox({ w1: ['limit:3600'], other: ['ok'] }, [['lead', { desktop: true }], ['other', { provider: 'otherprov' }], ['w1']]);
  const { runWorker } = require(`${SRC}/core/workers`);
  const r = await runWorker({ task: 'job', cwd: s.project, account: 'other' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'workers_limited', 'its only Claude worker is limited: it reports instead of using the other provider');
  assert.deepEqual(s.invocations().map((i) => i.account), ['w1']);

  s.store.save(s.store.load().filter((a) => a.name !== 'w1'));
  const none = await runWorker({ task: 'job', cwd: s.project });
  assert.equal(none.code, 'no_workers', 'an account of another provider does not count as a Claude worker');
  assert.deepEqual(s.invocations().map((i) => i.account), ['w1']);
});

test('a thread recorded on an unknown provider is never resumed by a Claude account', async () => {
  const s = sandbox({ w1: ['ok'] }, [['lead', { desktop: true }], ['w1']]);
  const memory = require(`${SRC}/core/memory`);
  memory.putThread(s.project, 'x', { sessionId: 'foreign-session', account: 'gone', provider: 'otherprov', title: 'x' });
  const { runWorker } = require(`${SRC}/core/workers`);
  const r = await runWorker({ task: 'more', cwd: s.project, thread: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_workers');
  assert.deepEqual(s.invocations(), [], 'nothing was started');
});
