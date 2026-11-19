'use strict';
// The pick order: every worker gets one job before any worker gets a second, two
// before any gets a third, never more than 3 at once on one worker. Within a load level: a 5-hour window at 95% or more
// goes after the others, then the earliest weekly reset. Parked jobs hold no slot. An explicit account waits for a slot
// there; a resumed thread's account does not. Also: post checks hold no slot, require_scope, relay_help.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');
const H = 3600;

let lastRelease = null; // a failed assertion must not leave this process's reservations to the next test
function sandbox(names = ['a', 'b', 'c'], plan = {}) {
  if (lastRelease) lastRelease();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-spread-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE]), RELAY_TICK: '0.05', RELAY_SLACK: '0',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_WRITE', 'FAKE_REPORT', 'FAKE_TOOLS']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save([{ ...store.newAccount('lead', path.join(root, 'home', 'accounts', 'lead'), 'lead@x.com'), desktop: true },
    ...names.map((n) => (n.startsWith('cx-') ? { ...store.newAccount(n, path.join(root, 'home', 'codex', n), ''), provider: 'codex', model: 'gpt-test' } : store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`)))]);
  store.saveSettings({ jobsPerWorker: 3 });
  const now = store.nowSec();
  // usage: { name: [5h window %, week resets in s (null = unknown), week % used (default 30)] }
  const setUsage = (u) => {
    const cache = {};
    for (const [n, [pct, wk, weekPct = 30]] of Object.entries(u)) {
      cache[n] = { at: Date.now(), okAt: Date.now(), data: { session: { label: 'Current session', pct, resetsAt: now + 2 * H }, week: { label: 'Current week (all models)', pct: weekPct, resetsAt: wk == null ? null : now + wk }, others: [] } };
    }
    fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.RELAY_HOME, 'usage.json'), JSON.stringify(cache));
  };
  const { Engine } = require(`${SRC}/core/engine`);
  const engines = [];
  // A job's pick that KEEPS its reservation (as a running job would), so picks add up like real jobs.
  const job = ({ pinned = null, preferred = null, max = store.jobsPerWorker(), provider = null } = {}) => {
    const e = new Engine();
    e.filter = (x) => !x.desktop;
    if (provider) e.provider = provider;
    e.maxPerAccount = max;
    if (pinned) e.pinned = pinned;
    engines.push(e);
    const a = e._pick(preferred || pinned);
    return typeof a === 'symbol' ? 'BUSY' : a ? a.name : null;
  };
  const release = () => { for (const e of engines.splice(0)) e._unreserve(); };
  // the last job tries again (a waiting job retries; its ticket keeps its place in line)
  const retry = () => { const a = engines.at(-1)._pick(null); return typeof a === 'symbol' ? 'BUSY' : a ? a.name : null; };
  lastRelease = release;
  // n runs on an account in another window (another live pid: this process's own run files are not counted)
  const memory = require(`${SRC}/core/memory`);
  let seq = 0;
  const busy = (name, n) => { for (let i = 0; i < n; i++) memory.writeRun(`busy-${name}-${seq++}`, { pid: process.ppid, account: name, status: 'running', kind: 'worker' }); };
  const parkedJob = (name) => {
    const jobs = require(`${SRC}/core/jobs`);
    fs.mkdirSync(jobs.dir(), { recursive: true });
    const id = `parked-${name}-${seq++}`;
    fs.writeFileSync(jobs.jobFile(id), JSON.stringify({ id, state: 'parked', account: name, wakeAt: Date.now() + 3600e3, createdAt: Date.now(), request: { task: 'x', cwd: root }, cwd: root }));
  };
  return { root, store, setUsage, job, retry, release, busy, parkedJob, now };
}

test("example: a, b, c and jobs 1..10: one each, then a second each, then a third; nobody over 3; the 10th waits", () => {
  const s = sandbox();
  s.setUsage({ a: [10, 3 * 24 * H], b: [10, 5 * H], c: [10, 30 * H] }); // weekly reset order: b, c, a
  const got = [];
  for (let i = 1; i <= 9; i++) got.push(s.job());
  assert.deepEqual(got.slice(0, 3).sort(), ['a', 'b', 'c'], 'jobs 1-3: one each');
  assert.equal(got[0], 'b', 'the first goes to the earliest weekly reset');
  assert.equal(got[3], 'b', 'the 4th: the earliest reset of a/b/c (all have one)');
  assert.deepEqual(got.slice(4, 6), ['c', 'a'], 'the 5th and 6th: the remaining two, by reset');
  assert.equal(got[6], 'b', 'the 7th starts the third round');
  assert.deepEqual(got, ['b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a']);
  const { activeRuns } = require(`${SRC}/core/engine`);
  const load = activeRuns();
  for (const n of ['a', 'b', 'c']) assert.equal(load.get(n), 3, `${n} runs exactly 3`);
  assert.equal(s.job(), 'BUSY', 'the 10th waits for a free slot');
  s.release();
});

test('the cap is 3 whatever Settings say; 1 and 2 still lower it', () => {
  const s = sandbox(['a']);
  for (const [v, want] of [[5, 3], [10, 3], [0, 3], [2, 2], [1, 1], [3, 3]]) {
    s.store.saveSettings({ jobsPerWorker: v });
    assert.equal(s.store.jobsPerWorker(), want, `jobsPerWorker ${v}`);
  }
  s.store.saveSettings({ jobsPerWorker: 8 });
  s.setUsage({ a: [10, 2 * 24 * H] }); // 70% left over 2 days: 35 %/day, so its own cap is 3 too
  for (let i = 0; i < 3; i++) assert.equal(s.job(), 'a');
  assert.equal(s.job(), 'BUSY', 'a 4th job on one worker waits even though Settings say 8');
  const { statusText } = require(`${SRC}/core/workers`);
  assert.match(statusText(), /a@x\.com \[worker\] ready .*· 3 running, 0 parked · daily spare 35\.0%\/day → cap 3 \(resets .*\) · full: 3 of 3 jobs/);
  s.release();
});

test('parked jobs count 0: a worker with parked jobs gets the next job before one that is running a job', () => {
  const s = sandbox(['a', 'b']);
  s.setUsage({ a: [10, 5 * 24 * H], b: [10, 5 * H] }); // b resets sooner
  s.parkedJob('a');
  s.parkedJob('a');
  s.busy('b', 1);
  assert.equal(s.job(), 'a', 'a has two parked jobs but none running; b runs one');
  const { statusText } = require(`${SRC}/core/workers`);
  s.release();
  const text = statusText();
  assert.match(text, /a@x\.com \[worker\] ready .*· 0 running, 2 parked · daily spare 14\.0%\/day → cap 3 \(resets .*\) · next in line \(fewest jobs; week resets /);
  assert.match(text, /b@x\.com \[worker\] ready .*· 1 running, 0 parked .*· #2 in line \(more jobs than others; week resets /);
});

test('the 95% rule only orders accounts with the same number of jobs', () => {
  const s = sandbox(['a', 'b']);
  s.setUsage({ a: [96, 1 * H], b: [20, 4 * 24 * H] }); // a resets sooner but its 5-hour window is nearly full
  try {
    assert.equal(s.job(), 'b', 'both run nothing: the hot one goes after');
    assert.equal(s.job(), 'a', 'b now runs one, a none: fewest jobs wins over the 95% rule');
    const { statusText } = require(`${SRC}/core/workers`);
    const text = statusText();
    assert.match(text, /b@x\.com \[worker\] ready .*· 1 running, 0 parked .*· next in line \(fewest jobs; week resets /);
    assert.match(text, /a@x\.com \[worker\] ready .*· 1 running, 0 parked .*· #2 in line \(fewest jobs; 5h window at 96%, used after others with as many jobs; week resets /);
    assert.equal(s.job(), 'b', 'one each again: the hot one goes after');
  } finally { s.release(); }
});

test('pinned account: wins while it has a free slot, waits for it when full, is passed over when limited', () => {
  const s = sandbox(['a', 'b']);
  s.setUsage({ a: [10, 5 * 24 * H], b: [10, 5 * H] });
  s.busy('a', 2);
  assert.equal(s.job({ pinned: 'a' }), 'a', 'explicit account with a free slot wins over fewest jobs');
  assert.equal(s.job({ pinned: 'a' }), 'BUSY', 'explicit account full: the job waits for it (b is idle)');
  // a resumed thread's own account (preferred, not pinned): full -> the normal order instead of waiting
  assert.equal(s.job({ preferred: 'a' }), 'b');
  s.release();
  // pinned to an account that is limited: the normal order
  s.store.markLimited('a', s.now + 3 * H, 'usage');
  assert.equal(s.job({ pinned: 'a' }), 'b');
  s.release();
});

test('waiting tickets ahead take the slot the normal order gives them; this run gets the next one', () => {
  const s = sandbox(['a', 'b']);
  s.store.saveSettings({ jobsPerWorker: 1 });
  s.setUsage({ a: [10, 5 * 24 * H], b: [10, 5 * H] }); // b first by reset (a first by registry order)
  const { ticketsDir } = require(`${SRC}/core/engine`);
  fs.mkdirSync(ticketsDir(), { recursive: true });
  fs.writeFileSync(path.join(ticketsDir(), 'ahead.json'), JSON.stringify({ pid: process.ppid, token: 'ahead', priority: 'high', provider: 'claude', at: Date.now() - 1000, beat: Date.now(), accepts: null }));
  assert.equal(s.job(), 'a', 'the high-priority ticket is entitled to b (its pick), so this run gets a');
  assert.equal(s.job(), 'BUSY', 'b stays for the ticket');
  fs.rmSync(path.join(ticketsDir(), 'ahead.json'));
  s.release();
});

// ---- post checks hold no worker slot ----

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
const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('post checks: the worker\'s slot is free while Relay runs them; the job shows "running checks"', async () => {
  const s = sandbox(['a'], { a: ['ok', 'ok'] });
  s.store.saveSettings({ jobsPerWorker: 1 });
  const project = path.join(s.root, 'project');
  fs.mkdirSync(path.join(project, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(project, '.relay', 'project.json'), JSON.stringify({ post_checks: [{ name: 'slow', cmd: 'sleep 2; echo checked' }] }));
  const memory = require(`${SRC}/core/memory`);
  const { activeRuns } = require(`${SRC}/core/engine`);
  const { runWorker } = require(`${SRC}/core/workers`);
  const running = runWorker({ task: 'x', cwd: project, scope: ['notes'] });
  const r = await waitFor(() => memory.listRuns().find((x) => x.phase === 'checks'));
  assert.ok(r, 'a run file marks the checks');
  assert.equal(r.account, null, 'it holds no account');
  assert.equal(r.ranOn, 'a');
  assert.equal(activeRuns().get('a') || 0, 0, 'a counts no job while the checks run');
  assert.equal(s.job({ max: 1 }), 'a', 'with one job per worker, the next job gets a at once');
  s.release();
  const out = await running;
  assert.equal(out.ok, true);
  assert.match(out.text, /- passed: slow/);
  assert.equal(memory.listRuns().filter((x) => x.pid === process.pid).length, 0, 'the run file is gone afterwards');

  // a background job: relay_poll says "running checks" meanwhile, and ends done
  const start = await toolCall('relay_start', { task: 'x', cwd: project, scope: ['notes'] });
  const id = start.text.match(/Started job ([a-z0-9-]+)/)[1];
  const jobs = require(`${SRC}/core/jobs`);
  const seen = await waitFor(() => { const v = jobs.view(jobs.read(id)); return v.state === 'running checks' ? v : null; });
  assert.ok(seen, 'the job view says running checks');
  assert.equal(seen.account, 'a');
  const poll = await toolCall('relay_poll', { job_ids: [id] });
  assert.match(poll.text, /running checks/i);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, /DONE/);
});

// ---- require_scope ----

test('require_scope: a job that may change files needs scope, write_paths or output_file; read-only jobs do not', async () => {
  const s = sandbox(['a'], { a: ['ok', 'ok', 'ok', 'ok'] });
  const project = path.join(s.root, 'project');
  fs.mkdirSync(path.join(project, '.relay'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const cfg = (o) => fs.writeFileSync(path.join(project, '.relay', 'project.json'), JSON.stringify(o));
  cfg({ require_scope: true });
  const { runWorker } = require(`${SRC}/core/workers`);
  const refused = await runWorker({ task: 'change things', cwd: project });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'bad_request');
  assert.match(refused.text, /requires a scope for every job that may change files \(require_scope in .*project\.json\)/);
  assert.match(refused.text, /Nothing was started/);
  const start = await toolCall('relay_start', { task: 'change things', cwd: project });
  assert.equal(start.isError, true, 'relay_start refuses it at once');
  assert.match(start.text, /require_scope/);
  for (const extra of [{ scope: ['src'] }, { readOnly: true }, { writePaths: ['src/**'] }, { outputFile: 'out.md' }]) {
    const r = await runWorker({ task: 'x', cwd: project, ...extra });
    assert.equal(r.ok, true, `${JSON.stringify(extra)} is accepted: ${r.text.slice(0, 200)}`);
  }
  cfg({ require_scope: 'yes' });
  const bad = await runWorker({ task: 'x', cwd: project, scope: ['src'] });
  assert.match(bad.text, /require_scope must be true or false/);
  cfg({ require_scope: false });
  assert.equal((await runWorker({ task: 'x', cwd: project, readOnly: true })).ok, true);
});

// ---- relay_help ----

test('relay_help lists every tool\'s current parameters from tool-defs; relay_status points to it; the skill names it', async () => {
  sandbox(['a']);
  const { TOOLS, helpText } = require(`${SRC}/tool-defs`);
  assert.ok(TOOLS.find((t) => t.name === 'relay_help'));
  const text = helpText();
  for (const name of ['relay_run', 'relay_start', 'relay_wait', 'relay_poll', 'relay_cancel', 'relay_ack', 'relay_health', 'relay_status', 'relay_ledger']) {
    assert.match(text, new RegExp(`^## ${name}$`, 'm'));
    const t = TOOLS.find((x) => x.name === name);
    if (name === 'relay_start') continue; // "the same as relay_run"
    for (const p of Object.keys(t.inputSchema.properties || {})) assert.match(text, new RegExp(`^  - ${p} \\(`, 'm'), `${name}.${p}`);
  }
  for (const p of ['isolated', 'output_file', 'hide_paths', 'write_paths', 'priority']) assert.ok(text.includes(p));
  assert.match(text, /Relay reads every parameter listed here/);
  assert.match(text, /relay_start[\s\S]*The same as relay_run/);
  assert.match(text, /- task \(string, required\)/);
  assert.match(text, /- priority \(string: "high" \| "normal" \| "low"\)/);
  const help = await toolCall('relay_help', {});
  assert.equal(help.isError, undefined);
  assert.equal(help.text, text);
  const status = await toolCall('relay_status', {});
  assert.match(status.text, /Tip: call relay_help for the current parameters/);
  const { SKILL } = require(`${SRC}/core/connect`);
  assert.match(SKILL, /relay_help/);
});

// ---- each worker's cap from its weekly quota ----
const D = 24 * H;

test("example: A (86% used, resets in 4.5 days) cap 1; B (81%, 1.7 days) cap 3; A never gets a 2nd job while B has room", () => {
  const s = sandbox(['A', 'B']);
  s.setUsage({ A: [10, 4.5 * D, 86], B: [10, 1.7 * D, 81] });
  const { dailyCap } = require(`${SRC}/core/engine`);
  const cache = JSON.parse(fs.readFileSync(path.join(process.env.RELAY_HOME, 'usage.json'), 'utf8'));
  const a = dailyCap(cache.A.data, s.now, 3);
  const b = dailyCap(cache.B.data, s.now, 3);
  assert.equal(a.cap, 1);
  assert.equal(Math.round(a.spare * 10) / 10, 3.1);
  assert.equal(b.cap, 3);
  assert.equal(Math.round(b.spare * 10) / 10, 11.2);
  assert.deepEqual([s.job(), s.job(), s.job(), s.job(), s.job()], ['B', 'A', 'B', 'B', 'BUSY'],
    'B first (sooner reset), A its one job (fewest), then B up to its 3; A never a second');
  // B's first job finishes (the panel's case): the next job goes to B again, not to A
  s.release();
  s.busy('A', 1);
  s.busy('B', 1);
  assert.equal(s.job(), 'B', 'A is at its cap of 1 even though both run one');
  const { statusText } = require(`${SRC}/core/workers`);
  const text = statusText();
  assert.match(text, /A@x\.com \[worker\] ready .*· 1 running, 0 parked · daily spare 3\.1%\/day → cap 1 \(resets .*\) · full: 1 of 1 jobs/);
  assert.match(text, /B@x\.com \[worker\] ready .*· 2 running, 0 parked · daily spare 11\.2%\/day → cap 3 \(resets .*\) · next in line \(only free worker; /);
});

test('cap thresholds at 5 and 10 %/day, the 0.25-day floor, the Settings maximum, a reading from before the reset', () => {
  const { dailyCap } = require(`${SRC}/core/engine`);
  const now = 1_800_000_000;
  const u = (pct, inSec) => ({ week: { pct, resetsAt: now + inSec } });
  const cap = (pct, inSec, max = 3) => dailyCap(u(pct, inSec), now, max).cap;
  assert.equal(cap(80, 2 * D), 3, '20 / 2 days = 10 %/day');
  assert.equal(cap(80.02, 2 * D), 2, '9.99 %/day');
  assert.equal(cap(90, 2 * D), 2, '5 %/day');
  assert.equal(cap(90.02, 2 * D), 1, '4.99 %/day');
  assert.equal(cap(94, 1 * H), 3, '6% left within an hour: 6 / 0.25 day = 24 %/day');
  assert.equal(cap(10, 2 * D, 2), 2, 'never above Settings');
  assert.equal(cap(10, 2 * D, 1), 1);
  assert.equal(cap(95, 2 * D), 0, '95% used');
  assert.equal(dailyCap({ week: { pct: 99, resetsAt: now - H } }, now, 3).cap, 3, 'reset an hour ago: a new week');
  assert.equal(dailyCap(null, now, 3).cap, 2, 'no reading');
  assert.equal(dailyCap({ week: { pct: 40, resetsAt: null } }, now, 3).cap, 2, 'no reset time');
});

test('a week at 95% or more: no job while another worker has room; one when every other is at its cap', () => {
  const s = sandbox(['A', 'B']);
  s.setUsage({ A: [10, 1 * D, 96], B: [10, 2 * D, 30] });
  assert.deepEqual([s.job(), s.job(), s.job()], ['B', 'B', 'B'], 'A runs nothing while B has room');
  const { statusText } = require(`${SRC}/core/workers`);
  assert.match(statusText(), /A@x\.com \[worker\] ready .*· 0 running, 0 parked · week 96% used → cap 1 \(every other worker is full\) · next in line/);
  assert.equal(s.job(), 'A', 'every other worker is full: A takes one');
  assert.equal(s.job(), 'BUSY', 'and only one');
  s.release();
  assert.match(statusText(), /A@x\.com \[worker\] ready .*· week 96% used → cap 0 \(takes one only when every other worker is full\) · full: 0 of 0 jobs/);
});

test('unknown usage counts as cap 2', () => {
  const s = sandbox(['A', 'B']);
  s.setUsage({ B: [10, 1 * D, 95] }); // B is week-full; A has no reading at all
  assert.deepEqual([s.job(), s.job()], ['A', 'A']);
  assert.equal(s.job(), 'B', 'A at its cap of 2: the week-full B takes one');
  assert.equal(s.job(), 'BUSY');
  const { statusText } = require(`${SRC}/core/workers`);
  assert.match(statusText(), /A@x\.com \[worker\] ready · 2 running, 0 parked · usage unknown → cap 2 · full: 2 of 2 jobs/);
  s.release();
});

test('Codex accounts follow the same caps among the Codex accounts', () => {
  const s = sandbox(['cx-A', 'cx-B', 'c']);
  s.setUsage({ 'cx-A': [10, 4.5 * D, 86], 'cx-B': [10, 1.7 * D, 81], c: [10, 1 * D, 10] });
  const got = [1, 2, 3, 4, 5].map(() => s.job({ provider: 'codex' }));
  assert.deepEqual(got, ['cx-B', 'cx-A', 'cx-B', 'cx-B', 'BUSY'], 'the Claude worker is never used for a Codex job');
  s.release();
});

test('caps are worked out again at every pick: a usage reading changes them', () => {
  const s = sandbox(['A']);
  s.setUsage({ A: [10, 3 * D, 30] }); // 23 %/day: cap 3
  assert.deepEqual([s.job(), s.job()], ['A', 'A']);
  s.setUsage({ A: [10, 4.5 * D, 86] }); // a new reading: 3.1 %/day, cap 1, and it already runs 2
  assert.equal(s.job(), 'BUSY');
  s.setUsage({ A: [10, 4.5 * D, 50] }); // 11.1 %/day: cap 3 again
  assert.equal(s.retry(), 'A', 'the waiting job gets A at its next try');
  s.release();
});

test('a resumed thread\'s account only wins under its own cap; a pinned account goes up to 3 whatever its cap', () => {
  const s = sandbox(['A', 'B']);
  s.setUsage({ A: [10, 4.5 * D, 86], B: [10, 5 * D, 30] }); // A cap 1; B cap 3 (and resets later than A)
  s.busy('A', 1);
  assert.equal(s.job({ preferred: 'A' }), 'B', 'the thread\'s account A is at its cap of 1: the thread moves');
  s.release();
  assert.equal(s.job({ pinned: 'A' }), 'A', 'an explicit account is the caller\'s choice: up to 3');
  assert.equal(s.job({ pinned: 'A' }), 'A');
  assert.equal(s.job({ pinned: 'A' }), 'BUSY', 'A runs 3: the pinned job waits');
  s.release();
  const fresh = sandbox(['A', 'B']);
  fresh.setUsage({ A: [10, 1 * D, 30], B: [10, 2 * D, 30] });
  assert.equal(fresh.job({ preferred: 'A' }), 'A', 'under its cap the thread stays on its account');
  fresh.release();
});
