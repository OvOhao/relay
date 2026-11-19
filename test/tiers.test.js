'use strict';
// Worker tiers (Accounts panel: 1 / 2 / 3, 1 = most preferred, the default) and the leader as a worker (its switch
// "Leader takes jobs too"). Pick order: a free slot under the account's cap -> fewest running jobs -> lower tier ->
// a 5-hour window at 95% or more last within that -> earliest weekly reset -> least recently used -> registry order.
// Example: a, b at tier 1 and c at tier 2 get jobs a, b, c, a, b, c.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');
const H = 3600;

function sandbox(accounts, { usage = {}, jobsPerWorker = 3 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tier-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: '{}', RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE]), RELAY_TICK: '0.05', RELAY_SLACK: '0',
  });
  delete process.env.RELAY_TAKEOVER;
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save(accounts.map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker });
  // usage: { name: [5h %, week %] }; every weekly window resets in 150 h (so the reset never decides here)
  const now = store.nowSec();
  const cache = {};
  for (const [n, [s5, wk]] of Object.entries(usage)) {
    cache[n] = { at: Date.now(), okAt: Date.now(), data: { session: { label: 'Current session', pct: s5, resetsAt: now + 2 * H }, week: { label: 'Current week (all models)', pct: wk, resetsAt: now + 150 * H }, others: [] } };
  }
  fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.RELAY_HOME, 'usage.json'), JSON.stringify(cache));
  const { Engine } = require(`${SRC}/core/engine`);
  const engines = [];
  // one job's pick, keeping its reservation (a running job), as several jobs started one after another would
  const pick = (pref = null, pinned = null) => {
    const e = new Engine();
    e.filter = store.isWorker;
    e.maxPerAccount = store.jobsPerWorker();
    if (pinned) e.pinned = pinned;
    engines.push(e);
    const a = e._pick(pinned || pref);
    if (a && typeof a === 'object') return a.name;
    e._unreserve();
    return a ? 'BUSY' : null;
  };
  const release = () => { for (const e of engines.splice(0)) e._unreserve(); };
  return { root, project, store, pick, release };
}

const ALL = { a: [10, 30], b: [10, 30], c: [10, 30] }; // daily spare 11 %/day: cap 3 each

test('the user\'s example: a and b at tier 1, c at tier 2 -> jobs go a, b, c, a, b, c', (t) => {
  const s = sandbox([['lead', { desktop: true }], ['a'], ['b'], ['c', { tier: 2 }]], { usage: ALL });
  t.after(s.release);
  const got = [];
  for (let i = 0; i < 6; i++) got.push(s.pick());
  assert.deepEqual(got, ['a', 'b', 'c', 'a', 'b', 'c']);
  // with only two jobs, c gets nothing
  s.release();
  assert.deepEqual([s.pick(), s.pick()], ['a', 'b']);
});

test('tier 3 goes after tier 2; the default tier is 1; an unknown tier counts as 1', (t) => {
  const s = sandbox([['a', { tier: 3 }], ['b', { tier: 2 }], ['c'], ['d', { tier: 'x' }]], { usage: { ...ALL, d: [10, 30] } });
  t.after(s.release);
  assert.deepEqual([s.pick(), s.pick(), s.pick(), s.pick()], ['c', 'd', 'b', 'a']);
  assert.equal(s.store.tierOf({}), 1);
  assert.equal(s.store.cleanTier('2'), 2);
  assert.equal(s.store.cleanTier(4), null);
});

test('caps still come first: a tier-2 worker with a cap of 1 gets one job, then the tier-1 workers fill up; all full: BUSY', (t) => {
  // c: week 90% used, resets in 150 h -> daily spare 1.6 %/day -> cap 1
  const s = sandbox([['a'], ['b'], ['c', { tier: 2 }]], { usage: { a: [10, 30], b: [10, 30], c: [10, 90] } });
  t.after(s.release);
  const got = [];
  for (let i = 0; i < 8; i++) got.push(s.pick());
  assert.deepEqual(got, ['a', 'b', 'c', 'a', 'b', 'a', 'b', 'BUSY']);
});

test('a limited or signed-out worker is passed over whatever its tier; jobs per worker (Settings) caps every tier', (t) => {
  const now = Date.now() / 1000;
  const s = sandbox([['a', { blockedUntil: now + 3 * H, blockedReason: 'five_hour' }], ['b'], ['c', { tier: 2 }], ['d', { needsLogin: true }]], { usage: ALL, jobsPerWorker: 2 });
  t.after(s.release);
  const got = [];
  for (let i = 0; i < 5; i++) got.push(s.pick());
  assert.deepEqual(got, ['b', 'c', 'b', 'c', 'BUSY']);
});

test('within a tier a 5-hour window at 95% or more goes last; across tiers the tier decides first', (t) => {
  const s = sandbox([['a'], ['b'], ['c', { tier: 2 }]], { usage: { a: [97, 30], b: [10, 30], c: [5, 30] } });
  t.after(s.release);
  assert.deepEqual([s.pick(), s.pick(), s.pick()], ['b', 'a', 'c']);
});

test('an explicit account and a thread\'s own worker still win over the tiers', (t) => {
  const s = sandbox([['a'], ['b'], ['c', { tier: 3 }]], { usage: ALL });
  t.after(s.release);
  assert.equal(s.pick(null, 'c'), 'c', 'pinned');
  s.release();
  assert.equal(s.pick('c'), 'c', 'the account the thread\'s session lives on, while it has room');
  assert.equal(s.pick(), 'a');
});

test('the leader takes jobs only with its switch on, with its own tier and cap', (t) => {
  const s = sandbox([['lead', { desktop: true }], ['a', { tier: 2 }]], { usage: { lead: [10, 30], a: [10, 30] } });
  t.after(s.release);
  assert.deepEqual([s.pick(), s.pick()], ['a', 'a'], 'switch off: never the leader');
  s.release();
  s.store.update('lead', { takesJobs: true });
  assert.equal(s.store.isWorker(s.store.get('lead')), true);
  assert.deepEqual([s.pick(), s.pick(), s.pick()], ['lead', 'a', 'lead'], 'switch on: tier 1 leader before tier 2 a');
  s.release();
  s.store.update('lead', { tier: 3 });
  assert.deepEqual([s.pick(), s.pick()], ['a', 'lead']);
});

test('relay_status shows each worker\'s tier, the leader\'s switch, and the tier as the reason when it decides', (t) => {
  const s = sandbox([['lead', { desktop: true }], ['a'], ['c', { tier: 2 }]], { usage: { a: [10, 30], c: [10, 30] } });
  t.after(s.release);
  const { statusText } = require(`${SRC}/core/workers`);
  let text = statusText();
  assert.match(text, /lead@x\.com \[LEADER: this window, does not take jobs \(switch "Leader takes jobs too" off\)\] ready$/m);
  assert.match(text, /a@x\.com \[worker\] ready .*next in line \(fewest jobs; tier 1 before tier 2; .*· tier 1$/m);
  assert.match(text, /c@x\.com \[worker\] ready .*#2 in line .*· tier 2$/m);
  s.store.update('lead', { takesJobs: true, tier: 3 });
  text = statusText();
  assert.match(text, /lead@x\.com \[LEADER: this window; also takes jobs \(switch "Leader takes jobs too" on\)\] ready .*0 running, 0 parked .*· tier 3$/m);
});
