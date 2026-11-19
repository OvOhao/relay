'use strict';
// Job priority: when jobs wait for a free worker, a freed slot goes to the highest priority, then the oldest waiting
// job, across processes (tickets under the pick lock). A parked job keeps its priority when it wakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const FAKE = path.join(__dirname, 'fake-claude.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

function sandbox({ plan = {}, delay = 200, minuteMs = 600, names = ['w1'] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-prio-')));
  const env = {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), FAKE_DELAY_MS: String(delay), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0', RELAY_BUSY_POLL_MS: '100', RELAY_PARK_MINUTE_MS: String(minuteMs), RELAY_PARK_STEP_MS: '100',
  };
  for (const d of [env.FAKE_STATE, env.RELAY_HUB]) fs.mkdirSync(d, { recursive: true });
  Object.assign(process.env, env);
  for (const k of ['RELAY_TAKEOVER', 'FAKE_CONTEXT', 'FAKE_REPORT', 'FAKE_TOOLS']) delete process.env[k];
  const store = require(`${SRC}/core/store`);
  store.save([['lead', { desktop: true }], ...names.map((n) => [n, {}])].map(([n, extra]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 1 });
  const folder = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
  const invocations = () => {
    const f = path.join(env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const memory = require(`${SRC}/core/memory`);
  // w1's one slot taken by another window's job (a live run file of this test process)
  const block = () => memory.writeRun('blocker', { account: 'w1', status: 'running', kind: 'worker', title: 'blocker', updatedAt: Date.now() });
  const unblock = () => memory.removeRun('blocker');
  const tickets = () => require(`${SRC}/core/engine`).liveTickets();
  return { root, env, store, folder, invocations, block, unblock, tickets };
}

function windowProc(s, cfg) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'helpers', 'conc-run.js'), JSON.stringify({ env: s.env, ...cfg })], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').filter(Boolean).pop())); } catch { resolve({ ok: false, code: 'no_output', text: out.slice(-300) }); }
    });
  });
}
function toolCall(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SRC, 'tool-call.js')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    let result = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.result) result = m.result;
      }
    });
    child.on('error', reject);
    child.on('close', () => (result ? resolve(result) : reject(new Error('no result'))));
    child.stdin.write(`${JSON.stringify({ name, args })}\n`);
  });
}
const taskOf = (inv) => (/## Task\n(\S+)/.exec(inv.prompt) || [])[1];

test('priority values: high, normal (default), low; anything else is refused', async () => {
  const s = sandbox();
  const { runWorker } = require(`${SRC}/core/workers`);
  const bad = await runWorker({ task: 'x', cwd: s.folder('p'), priority: 'urgent', validateOnly: true });
  assert.equal(bad.code, 'bad_request');
  assert.match(bad.text, /priority must be one of high, normal, low/);
  assert.equal((await runWorker({ task: 'x', cwd: s.folder('p'), validateOnly: true })).priority, 'normal');
  assert.equal((await runWorker({ task: 'x', cwd: s.folder('p'), priority: 'HIGH', validateOnly: true })).priority, 'high');
  const r = await toolCall('relay_start', { task: 'x', cwd: s.folder('p'), priority: 'urgent' });
  assert.equal(r.isError, true);
});

test('waiting jobs in four processes: a freed slot goes to the highest priority, ties by age; a later job never jumps the line', async () => {
  const s = sandbox();
  s.block();
  const jobs = [['low-1', 'low'], ['normal-1', 'normal'], ['high-1', 'high'], ['normal-2', '']];
  const running = [];
  for (const [k, [task, priority]] of jobs.entries()) {
    running.push(windowProc(s, { task, priority, cwd: s.folder(task) }));
    await until(() => s.tickets().length === k + 1); // each is waiting (in age order) before the next arrives
  }
  const t = s.tickets();
  assert.deepEqual(t.map((x) => x.priority), ['high', 'normal', 'normal', 'low'], 'the line: priority, then age');
  // the waiting jobs' run files say their place in line
  const memory = require(`${SRC}/core/memory`);
  await until(() => memory.listRuns().some((r) => r.title === 'low-1' && /#4 in line \(priority low\)/.test(r.lastLine || '')));
  s.unblock();
  const results = await Promise.all(running);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.deepEqual(s.invocations().map(taskOf), ['high-1', 'normal-1', 'normal-2', 'low-1']);
  assert.equal(s.tickets().length, 0, 'no ticket is left behind');
});

test('a job arriving while others wait queues behind them even when it tries the moment a slot frees', async () => {
  const s = sandbox({ delay: 400 });
  s.block();
  // the waiting job only tries every 3 s, so the late one surely tries first after the slot frees
  const first = windowProc(s, { task: 'waiting-normal', cwd: s.folder('a'), env: { ...s.env, RELAY_BUSY_POLL_MS: '3000' } });
  await until(() => s.tickets().length === 1);
  s.unblock(); // the slot is free; a new LOW job tries at once, but the normal one waiting is entitled to it
  const late = windowProc(s, { task: 'late-low', priority: 'low', cwd: s.folder('b') });
  const r = await Promise.all([first, late]);
  assert.ok(r.every((x) => x.ok));
  assert.deepEqual(s.invocations().map(taskOf), ['waiting-normal', 'late-low']);
});

test('a parked job keeps its priority when it wakes: it goes before an older normal job waiting for the worker', async () => {
  const s = sandbox({ plan: { w1: ['park:5', 'ok', 'ok'] }, delay: 100, minuteMs: 800 });
  // the high job's runner tries for a worker only every 2 s, the normal one every 100 ms: only the queue rule puts it first
  process.env.RELAY_BUSY_POLL_MS = '2000';
  const started = await toolCall('relay_start', { task: 'launch-high', cwd: s.folder('h'), priority: 'high', title: 'High park' });
  process.env.RELAY_BUSY_POLL_MS = '100';
  assert.match(started.text, /priority high/);
  const id = started.text.match(/Started job ([a-z0-9-]+)/)[1];
  const parked = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(parked.text, /PARKED/);
  assert.match(parked.text, /priority high/);
  const jobs = require(`${SRC}/core/jobs`);
  const sid = jobs.read(id).sessionId;
  s.block();
  const n = await toolCall('relay_start', { task: 'older-normal', cwd: s.folder('n') });
  const nid = n.text.match(/Started job ([a-z0-9-]+)/)[1];
  await until(() => s.tickets().length === 1); // the normal job waits first...
  await until(() => s.tickets().length === 2); // ...then the parked job wakes and waits too
  assert.deepEqual(s.tickets().map((t) => t.priority), ['high', 'normal']);
  // its place in line moves back once the high-priority wake is waiting too (refreshed at each try, every 100 ms here)
  const poll = await until(async () => { const p = await toolCall('relay_poll', { job_ids: [nid] }); return /#2 in line/.test(p.text) && p; });
  assert.match(poll.text, /WAITING FOR WORKER/);
  assert.match(poll.text, /priority normal \(#2 in line for a worker\)/);
  s.unblock();
  await toolCall('relay_wait', { job_ids: [id, nid], mode: 'all', timeout_sec: 30 });
  const inv = s.invocations();
  assert.equal(inv.length, 3);
  assert.equal(inv[1].resume, sid, 'the high-priority wake got the slot first');
  assert.equal(taskOf(inv[2]), 'older-normal');
  const status = await toolCall('relay_status', {});
  assert.doesNotMatch(status.text, /Background jobs/, 'both finished');
  assert.equal(jobs.read(id).priority, 'high');
});

test('a waiting job only holds back the slots it could use: a free account it does not accept stays open to others', () => {
  const s = sandbox({ names: ['w1', 'w2'] });
  s.block(); // w1 full
  const { Engine } = require(`${SRC}/core/engine`);
  const dir = require(`${SRC}/core/engine`).ticketsDir();
  fs.mkdirSync(dir, { recursive: true });
  const ticket = (token, accepts) => fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify({ pid: process.pid, token, priority: 'high', provider: 'claude', at: Date.now() - 5000, beat: Date.now(), accepts }));
  const pick = () => { const e = new Engine(); e.filter = (x) => !x.desktop; e.maxPerAccount = 1; const a = e._pick(null); e._unreserve(); return typeof a === 'symbol' ? 'BUSY' : a && a.name; };
  ticket('t-only-w1', ['w1']); // a high job that may only run on w1 (e.g. it avoids w2 after a health check)
  assert.equal(pick(), 'w2', 'w2 is free and the job ahead cannot use it');
  ticket('t-any', ['w1', 'w2']); // another high job ahead that could take w2
  assert.equal(pick(), 'BUSY', 'now w2 belongs to the job ahead');
  assert.equal(s.tickets().length, 2, 'the BUSY pick left no ticket of its own after giving up');
});
