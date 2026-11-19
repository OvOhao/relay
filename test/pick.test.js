'use strict';
// Which worker a job goes to: the fewest running jobs first (see spread.test.js), then the weekly usage that resets
// soonest ("use it or lose it"), unknown resets last, a 5-hour window at 95% or more after others with as many jobs;
// an explicit account still wins. Plus several jobs at once
// on one account, and the Fable model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');
const H = 3600;

function sandbox(names = ['a', 'b', 'c'], plan = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pick-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE]), RELAY_TICK: '0.05', RELAY_SLACK: '0',
  });
  delete process.env.RELAY_TAKEOVER;
  delete process.env.FAKE_DELAY_MS;
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save([{ ...store.newAccount('lead', path.join(root, 'home', 'accounts', 'lead'), 'lead@x.com'), desktop: true },
    ...names.map((n) => store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`))]);
  const now = store.nowSec();
  // usage: { name: [session %, week resets in s (null = unknown)] }
  const setUsage = (u) => {
    const cache = {};
    for (const [n, [pct, wk]] of Object.entries(u)) {
      cache[n] = { at: Date.now(), okAt: Date.now(), data: { session: { label: 'Current session', pct, resetsAt: now + 2 * H }, week: { label: 'Current week (all models)', pct: 30, resetsAt: wk == null ? null : now + wk }, others: [] } };
    }
    fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.RELAY_HOME, 'usage.json'), JSON.stringify(cache));
  };
  // one pick, as a job would make it; the reservation is given back so picks in a test do not add up
  const engine = (max = 3) => {
    const { Engine } = require(`${SRC}/core/engine`);
    const e = new Engine();
    e.filter = (x) => !x.desktop;
    e.maxPerAccount = max;
    return { _pick: (pref) => { const a = e._pick(pref); e._unreserve(); return a; } };
  };
  // n runs on an account, as another window's run files (another live pid: this process's own are not counted)
  const memory = require(`${SRC}/core/memory`);
  let seq = 0;
  const busy = (name, n) => { for (let i = 0; i < n; i++) memory.writeRun(`busy-${name}-${seq++}`, { pid: process.ppid, account: name, status: 'running', kind: 'worker' }); };
  return { root, store, setUsage, engine, busy, now };
}

test('at the same load the weekly window that resets soonest is used first; fewer running jobs come before it', () => {
  const s = sandbox();
  s.setUsage({ a: [10, 3 * 24 * H], b: [10, 5 * H], c: [10, 30 * H] });
  assert.equal(s.engine()._pick(null).name, 'b', 'nobody runs anything: the soonest reset');
  s.busy('b', 1); // b runs one: the others run none, so they come first
  assert.equal(s.engine()._pick(null).name, 'c');
  s.busy('c', 1);
  s.busy('a', 1); // one each again: the soonest reset
  assert.equal(s.engine()._pick(null).name, 'b');
});

test('unknown reset times go after known ones; a reading from before the reset still tells the next one', () => {
  const s = sandbox();
  s.setUsage({ a: [10, null], b: [10, 6 * 24 * H], c: [10, -1 * H] }); // c reset an hour ago: next one in ~7 days - 1 h
  const { pickOrder } = require(`${SRC}/core/engine`);
  const order = pickOrder(s.store.load().filter((x) => !x.desktop)).map((o) => o.x.name);
  assert.deepEqual(order, ['b', 'c', 'a']);
  assert.equal(s.engine()._pick(null).name, 'b');
  s.setUsage({}); // nothing known at all: the old order (fewest runs, least recently used, registry)
  s.busy('a', 1);
  assert.equal(s.engine()._pick(null).name, 'c', 'b and c run nothing; b was just used, c never');
});

test('a 5-hour window at 95% or more is used last while another account is free; explicit choice still wins', () => {
  const s = sandbox(['a', 'b']);
  s.setUsage({ a: [96, 1 * H], b: [20, 4 * 24 * H] });
  assert.equal(s.engine()._pick(null).name, 'b', 'a resets sooner but its 5-hour window is nearly full');
  assert.equal(s.engine()._pick('a').name, 'a', 'explicit account (or a resumed session) keeps winning');
  s.busy('b', 3); // b full: a is the only free one, so it is used after all
  assert.equal(s.engine()._pick(null).name, 'a');
});

test('relay_status says who is next in line and why, with running and parked counts', () => {
  const s = sandbox(['a', 'b']);
  s.setUsage({ a: [10, 3 * 24 * H], b: [10, 5 * H] });
  s.busy('a', 1);
  const { statusText } = require(`${SRC}/core/workers`);
  const text = statusText();
  assert.match(text, /b@x\.com \[worker\] ready .*· 0 running, 0 parked · daily spare 280\.0%\/day → cap 3 \(resets .*\) · next in line \(fewest jobs; week resets /);
  assert.match(text, /a@x\.com \[worker\] ready .*· 1 running, 0 parked .*#2 in line/);
});

test('three jobs at once on one account: separate sessions, all run side by side, none waits', async () => {
  const s = sandbox(['a'], { a: ['ok', 'ok', 'ok'] });
  process.env.FAKE_DELAY_MS = '700';
  s.store.saveSettings({ jobsPerWorker: 3 });
  s.setUsage({ a: [10, 2 * 24 * H] }); // 35 %/day to spare: its own cap is 3 (unknown usage would give 2)
  const { runWorker } = require(`${SRC}/core/workers`);
  const dirs = [0, 1, 2].map((i) => { const d = path.join(s.root, `p${i}`); fs.mkdirSync(d); return d; });
  const t0 = Date.now();
  const outs = await Promise.all(dirs.map((cwd, i) => runWorker({ task: `job ${i}`, cwd, thread: `t${i}` })));
  const ms = Date.now() - t0;
  assert.deepEqual(outs.map((o) => o.code), ['done', 'done', 'done']);
  assert.deepEqual(outs.map((o) => o.accountName), ['a', 'a', 'a']);
  assert.equal(new Set(outs.map((o) => o.sessionId)).size, 3, 'three separate sessions');
  assert.ok(ms < 2 * 3 * 700, `ran concurrently (${ms} ms), not one after another`);
  const memory = require(`${SRC}/core/memory`);
  assert.equal(memory.listRuns().filter((r) => r.pid === process.pid).length, 0, 'every run file was removed');
  delete process.env.FAKE_DELAY_MS;
});

test('jobsPerWorker: 3 for a new install, a settings file saved before the setting existed keeps 1', () => {
  const s = sandbox(['a']);
  const file = path.join(process.env.RELAY_HOME, 'settings.json');
  fs.rmSync(file, { force: true });
  assert.equal(s.store.loadSettings().jobsPerWorker, 3);
  fs.writeFileSync(file, JSON.stringify({ permissionMode: 'auto' }));
  assert.equal(s.store.loadSettings().jobsPerWorker, 1);
  s.store.saveSettings({ language: 'zh' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).jobsPerWorker, 1, 'saving another setting keeps it at 1');
  s.store.saveSettings({ jobsPerWorker: 2 });
  assert.equal(s.store.loadSettings().jobsPerWorker, 2);
});

test('Fable: accepted as a model, offered in the panel in both languages, named in the tool description', () => {
  const store = require(`${SRC}/core/store`);
  assert.equal(store.cleanModel('fable'), 'fable');
  assert.equal(store.cleanModel('claude-fable-5-1'), 'claude-fable-5-1');
  assert.equal(require(`${SRC}/core/backends`).getBackend('codex').isClaudeModel('fable'), true);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  assert.match(ui, /const MODEL_CHOICES = \['haiku', 'sonnet', 'opus', 'fable'\]/);
  assert.equal((ui.match(/model_fable_d:/g) || []).length, 2, 'described in English and Chinese');
  const { TOOLS } = require(`${SRC}/tool-defs`);
  for (const n of ['relay_run', 'relay_start']) assert.match(TOOLS.find((t) => t.name === n).inputSchema.properties.model.description, /"fable"/);
});
