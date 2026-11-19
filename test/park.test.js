'use strict';
// Park / wake: a worker that launched long-running work ends with RELAY_PARK; the job frees its account, sleeps and
// resumes the same session at the wake time. Driven through the real tool-call process and detached job runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan, accounts = [['lead', { desktop: true }], ['w1']], { minuteMs = 200 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-park-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0', RELAY_PARK_MINUTE_MS: String(minuteMs), RELAY_PARK_STEP_MS: '100',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT_CHARS', 'RELAY_MAX_WAKES']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save(accounts.map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 1 });
  const invocations = () => {
    const f = path.join(process.env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  return { root, project, store, invocations };
}

function toolCall(name, args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
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
    child.on('close', () => (result ? resolve({ ...result, ms: Date.now() - t0 }) : reject(new Error('no result'))));
    child.stdin.write(`${JSON.stringify({ name, args })}\n`);
  });
}
const jobId = (text) => text.match(/(?:Started job|job id) ([a-z0-9-]+)/)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(100);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('park line: clamped to 5..1440 minutes, malformed lines are recognised, other text is not a park', () => {
  const park = require(`${SRC}/core/park`);
  assert.deepEqual(park.parseParkLine('did things\nRELAY_PARK: 30 | check out.txt').park.minutes, 30);
  assert.equal(park.parseParkLine('x\nRELAY_PARK: 2 | soon').park.minutes, 5);
  assert.equal(park.parseParkLine('x\nRELAY_PARK: 2 | soon').park.asked, 2);
  assert.equal(park.parseParkLine('x\nRELAY_PARK: 99999 | later').park.minutes, 1440);
  assert.equal(park.parseParkLine('x\n**RELAY_PARK: 45 min | tail log**').park.check, 'tail log');
  assert.ok(park.parseParkLine('x\nRELAY_PARK: soon-ish').malformed);
  assert.ok(park.parseParkLine('x\nRELAY_PARK: 0 | now').malformed);
  assert.ok(park.parseParkLine('x\nRELAY_PARK: 20 |').malformed);
  assert.equal(park.parseParkLine('RELAY_PARK: 20 | x\nand then more text'), null, 'only the very last line counts');
  assert.equal(park.parseParkLine('a normal report'), null);
  assert.equal(park.stripParkLine('report\n\nRELAY_PARK: 20 | x\n'), 'report');
  assert.match(park.wakePrompt(3), /^Scheduled check \(wake 3 of the job\)/);
  const { buildPrompt } = require(`${SRC}/core/workers`);
  assert.match(buildPrompt({ task: 't' }), /RELAY_PARK: <minutes> \| <what to check on wake>/);
  assert.match(buildPrompt({ task: 't', resumed: true }), /RELAY_PARK/);
});

test('park → account released → wake → park again → wake → finish, all in one session', async () => {
  const s = sandbox({ w1: ['park:5', 'park:7', 'ok'] });
  const jobs = require(`${SRC}/core/jobs`);
  const memory = require(`${SRC}/core/memory`);
  const id = jobId((await toolCall('relay_start', { task: 'launch the experiment', cwd: s.project, thread: 'exp', title: 'Run exp' })).text);

  const first = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(first.text, new RegExp(`Job ${id} · PARKED`), first.text);
  assert.match(first.text, /1 parked/);
  assert.match(first.text, /Parked until .*scheduled checks so far: 0 of at most 48\. On wake it checks: check whether out\.txt says done/);
  assert.match(first.text, /Latest report:[\s\S]*Launched the experiment/);
  const rec = jobs.read(id);
  assert.equal(rec.state, 'parked');
  assert.ok(rec.wakeAt > rec.parkedAt && rec.wakeAt - rec.parkedAt <= 5 * 200 + 500);
  assert.ok(rec.sessionId);
  // nothing runs while it is parked: no run file holds w1
  assert.ok(!memory.listRuns().some((r) => r.account === 'w1') || jobs.read(id).state !== 'parked');

  const second = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(second.text, /PARKED/, 'it parked again after the first wake');
  assert.equal(jobs.read(id).wakes, 1);
  const third = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(third.text, /All 1 job finished/);
  assert.match(third.text, new RegExp(`Job ${id} · DONE`));
  assert.match(third.text, /Finished after 2 scheduled checks/);
  assert.match(third.text, /wake 2 finished/);

  const inv = s.invocations();
  assert.equal(inv.length, 3);
  assert.equal(inv[1].resume, rec.sessionId, 'the wake resumes the same session');
  assert.equal(inv[2].resume, rec.sessionId);
  assert.match(inv[1].prompt, /^Scheduled check \(wake 1 of the job\)/);
  assert.match(inv[2].prompt, /^Scheduled check \(wake 2 of the job\)/);
  const done = jobs.read(id);
  assert.deepEqual(done.history.map((h) => h.state), ['parked', 'parked', 'done'], 'every segment report is kept');
  const ledger = memory.readLedger(s.project);
  assert.equal(ledger.length, 3, 'one ledger entry per segment');
  assert.match(ledger[0].summary, /^PARKED until/);
  await until(() => !alive(done.pid));
});

test('a parked job is no load: another job runs on the only worker meanwhile (one job per worker)', async () => {
  const s = sandbox({ w1: ['park:5', 'ok', 'ok'] }, undefined, { minuteMs: 1000 });
  const jobs = require(`${SRC}/core/jobs`);
  const a = jobId((await toolCall('relay_start', { task: 'long one', cwd: s.project, title: 'Long' })).text);
  assert.match((await toolCall('relay_wait', { job_ids: [a], timeout_sec: 30 })).text, /PARKED/);
  const t0 = Date.now();
  const b = await toolCall('relay_run', { task: 'quick one', cwd: s.project });
  assert.match(b.text, /finished/);
  assert.ok(Date.now() - t0 < 4000, 'no waiting for a free worker');
  assert.equal(jobs.read(a).state, 'parked', 'the parked job was still parked while the other ran');
  const st = await toolCall('relay_status', {});
  assert.match(st.text, /w1@x\.com \[worker\].*1 parked/, st.text);
  assert.match((await toolCall('relay_wait', { job_ids: [a], timeout_sec: 30, include_parked: false })).text, /DONE/);
});

test('a malformed park line is ignored: the job ends normally and says so', async () => {
  const s = sandbox({ w1: ['parkbad'] });
  const id = jobId((await toolCall('relay_start', { task: 'x', cwd: s.project })).text);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, /DONE/);
  assert.match(w.text, /looked like a RELAY_PARK request but could not be read/);
  assert.equal(s.invocations().length, 1);
});

test('at most RELAY_MAX_WAKES scheduled checks, then the job fails with a clear message; its post checks run at that last check', async () => {
  const s = sandbox({ w1: ['park:5'] });
  process.env.RELAY_MAX_WAKES = '2';
  // a post check that always runs (and fails): only the final segment runs it (earlier parks do not)
  fs.mkdirSync(path.join(s.project, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(s.project, '.relay', 'project.json'), JSON.stringify({ post_checks: [{ name: 'final check', cmd: 'echo FINAL-CHECK-RAN; exit 3' }] }));
  const jobs = require(`${SRC}/core/jobs`);
  const id = jobId((await toolCall('relay_start', { task: 'x', cwd: s.project })).text);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30, include_parked: false });
  assert.match(w.text, new RegExp(`Job ${id} · FAILED`), w.text);
  assert.match(w.text, /parked again after 2 scheduled checks/);
  assert.equal(s.invocations().length, 3);
  const rec = jobs.read(id);
  assert.equal(rec.code, 'too_many_wakes');
  assert.deepEqual([...rec.flags].sort(), ['CHECKS_FAILED', 'too_many_wakes']);
  assert.equal(rec.checks.length, 1, 'checked once, at the last wake');
  assert.match(w.text, /FINAL-CHECK-RAN/);
  assert.match(w.text.split('\n')[0], new RegExp(`^Needs action: ${id} .*CHECKS_FAILED, too_many_wakes`), 'one line at the top');
  delete process.env.RELAY_MAX_WAKES;
});

test('the runner dies while parked: the next Relay call starts a new one, and the job still wakes and finishes', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, undefined, { minuteMs: 600 });
  const jobs = require(`${SRC}/core/jobs`);
  const id = jobId((await toolCall('relay_start', { task: 'x', cwd: s.project })).text);
  assert.match((await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
  const old = jobs.read(id).pid;
  process.kill(old, 'SIGKILL');
  await until(() => !alive(old));
  assert.equal(jobs.runnerAlive(jobs.read(id)), false);
  await toolCall('relay_status', {}); // any relay call revives it
  const now = jobs.read(id);
  assert.notEqual(now.pid, old);
  assert.ok(alive(now.pid), 'a new runner sleeps for it');
  assert.equal(now.revives, 1);
  // a second reviver does not start a second runner
  assert.equal(jobs.reviveParked(), 0);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, /DONE/);
  assert.equal(s.invocations().length, 2);
  assert.equal(s.invocations()[1].resume, s.invocations()[0].resume || jobs.read(id).sessionId);
});

test('a parked job whose wake time passed while nothing ran wakes as soon as a runner exists', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, undefined, { minuteMs: 60000 });
  const jobs = require(`${SRC}/core/jobs`);
  const id = jobId((await toolCall('relay_start', { task: 'x', cwd: s.project })).text);
  assert.match((await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
  const pid = jobs.read(id).pid;
  process.kill(pid, 'SIGKILL'); // "the Mac was off"
  await until(() => !alive(pid));
  jobs.update(id, (cur) => ({ ...cur, wakeAt: Date.now() - 3600e3 }));
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 }); // the call revives it, the wait sees it finish
  assert.match(w.text, /DONE/);
});

test('relay_run whose worker parks returns at once and continues as a background job; cancel stops a parked job', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, undefined, { minuteMs: 300 });
  const jobs = require(`${SRC}/core/jobs`);
  const r = await toolCall('relay_run', { task: 'launch it', cwd: s.project, thread: 'exp2', title: 'Exp two' });
  assert.equal(r.isError, false);
  assert.match(r.text, /worker w1@x\.com · model fake-model · thread "exp2" parked\./);
  assert.match(r.text, /PARKED until .*, job id [a-z0-9-]+; collect with relay_poll\/relay_wait/);
  assert.doesNotMatch(r.text, /^RELAY_PARK:/m, 'the park line itself is not shown');
  const id = jobId(r.text);
  const rec = jobs.read(id);
  assert.equal(rec.state, 'parked');
  assert.equal(rec.title, 'Exp two');
  // relay_run already showed this park: a wait does not return for it again, it returns when it finishes
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, /DONE/);
  assert.equal(s.invocations()[1].resume, rec.sessionId);

  // cancel while parked: no wake
  const s2 = sandbox({ w1: ['park:5', 'ok'] }, undefined, { minuteMs: 60000 });
  const id2 = jobId((await toolCall('relay_start', { task: 'x', cwd: s2.project, thread: 't2' })).text);
  assert.match((await toolCall('relay_wait', { job_ids: [id2], timeout_sec: 30 })).text, /PARKED/);
  const c = await toolCall('relay_cancel', { job_ids: [id2] });
  assert.match(c.text, new RegExp(`Job ${id2}: cancelled`));
  assert.equal(jobs.read(id2).state, 'cancelled');
  assert.match(jobs.read(id2).report, /Cancelled while parked/);
  await sleep(500);
  assert.equal(s2.invocations().length, 1, 'it never woke');
  assert.equal(require(`${SRC}/core/memory`).getThread(s2.project, 't2').stopped, true);
});

test('the panel state lists, per account, the jobs it runs now and its parked jobs; a park notifies the app', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, [['lead', { desktop: true }], ['w1'], ['w2']], { minuteMs: 60000 });
  s.store.saveSettings({ jobsPerWorker: 3 });
  const memory = require(`${SRC}/core/memory`);
  const notes = [];
  const { createServer } = require(`${SRC}/server`);
  const srv = await createServer({ shell: { notify: (n) => notes.push(n) } });
  try {
    const id = jobId((await toolCall('relay_start', { task: 'x', cwd: s.project, title: 'Long exp', account: 'w1' })).text);
    assert.match((await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
    const n = await until(() => notes.find((x) => x.kind === 'job' && x.id === id && x.state === 'parked'));
    assert.ok(n.wakeAt > Date.now(), 'the notification carries the wake time');
    for (let i = 0; i < 2; i++) memory.writeRun(`ui-${i}`, { pid: process.ppid, account: 'w2', status: 'running', title: `Job ${i}`, project: 'p', kind: 'worker' });
    const token = new URL(srv.url).searchParams.get('t');
    const state = await (await fetch(`${srv.origin}/api/state`, { headers: { cookie: `relay=${token}` } })).json();
    const w1 = state.accounts.find((a) => a.name === 'w1');
    const w2 = state.accounts.find((a) => a.name === 'w2');
    assert.deepEqual(w1.parked.map((j) => [j.id, j.title]), [[id, 'Long exp']]);
    assert.equal(w1.work.length, 0);
    assert.equal(w1.active, false, 'a parked job does not make its account look busy');
    assert.deepEqual(w2.work.map((j) => j.title).sort(), ['Job 0', 'Job 1']);
    assert.equal(w2.active, true);
    await toolCall('relay_cancel', { job_ids: [id] });
  } finally {
    srv.close?.();
  }
});
