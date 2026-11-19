'use strict';
// Wake timing and missed wakes: every wake records when it was due, when it woke and how late (job record and ledger);
// a sleeping runner notices clock jumps (the computer slept); parked jobs whose wake is overdue are revived from every
// Relay call and from the tray app's minute check (also when the runner is alive but stuck), and show in the Needs
// action line; Settings › preventSleepForWakes holds caffeinate around a wake. Driven through the real tool-call
// process, the detached job runner and the fake Claude CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan, { minuteMs = 200, settings = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0', RELAY_PARK_MINUTE_MS: String(minuteMs), RELAY_PARK_STEP_MS: '100',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'RELAY_MAX_WAKES', 'RELAY_CAFFEINATE', 'RELAY_CLOCK_JUMP_MS', 'RELAY_OVERDUE_GRACE_MS', 'FAKE_TRANSCRIPTS']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save([['lead', { desktop: true }], ['w1']].map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 1, ...settings });
  return { root, project, store };
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
// A process whose command line looks like a job's runner (ps shows "job-runner" and the id), doing nothing: a stuck one.
function fakeRunner(id) {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'job-runner', id], { stdio: 'ignore', detached: true });
  c.unref();
  return c.pid;
}
// A parked job record as the runner leaves it, without starting anything.
function parkedJob(s, { wakeAt, pid = null, extra = {} }) {
  const jobs = require(`${SRC}/core/jobs`);
  const id = `wk${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
  fs.mkdirSync(jobs.dir(), { recursive: true });
  fs.writeFileSync(jobs.jobFile(id), JSON.stringify({
    id, state: 'parked', request: { task: 't', cwd: s.project, thread: '' }, cwd: s.project, project: 'project', title: 'Parked exp', provider: 'claude',
    createdAt: Date.now() - 3600e3, pid, log: path.join(process.env.RELAY_HOME, 'jobs', `${id}.log`), wakes: 0, wakeAt, parkedAt: Date.now() - 3600e3,
    sessionId: null, account: 'w1', report: 'launched', ...extra,
  }));
  return id;
}

test('every wake records when it was due, when it woke and how late, in the job record (wakeLog, lastWake) and the ledger', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] });
  const jobs = require(`${SRC}/core/jobs`);
  const memory = require(`${SRC}/core/memory`);
  const id = jobId((await toolCall('relay_start', { task: 'launch', cwd: s.project, thread: 'exp', title: 'Exp' })).text);
  assert.match((await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
  const due = jobs.read(id).wakeAt;
  const done = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(done.text, /DONE/);
  const rec = jobs.read(id);
  assert.equal(rec.wakeLog.length, 1);
  const w = rec.wakeLog[0];
  assert.equal(w.wake, 1);
  assert.equal(w.wakeAt, due, 'due: the park\'s wake time');
  assert.ok(w.wokeAt >= due && w.lateMs === w.wokeAt - due, JSON.stringify(w));
  assert.ok(w.lateMs < 3000, `on time (${w.lateMs} ms)`);
  assert.ok(w.workerAt >= w.wokeAt && w.waitMs >= 0, 'when a worker took the check');
  assert.equal(w.outcome, 'done');
  assert.deepEqual(rec.lastWake.wokeAt, w.wokeAt);
  assert.match(done.text, /Last scheduled check \(1\): due .*, woken .* \(on time\)/);
  const led = memory.readLedger(s.project).filter((e) => e.jobId === id);
  assert.equal(led.length, 2);
  assert.equal(led[0].wake, undefined, 'the first segment is no wake');
  assert.deepEqual({ n: led[1].wake.n, wakeAt: led[1].wake.wakeAt, wokeAt: led[1].wake.wokeAt, lateMs: led[1].wake.lateMs }, { n: 1, wakeAt: due, wokeAt: w.wokeAt, lateMs: w.lateMs });
  assert.ok(fs.readFileSync(jobs.logFile(id), 'utf8').match(/waking: 1 on w1 code \w+ due \S+, late \d+ s/));
});

test('a runner that was stopped (as by the computer sleeping) notices the clock jump, logs it and keeps it; the late wake shows how late', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, { minuteMs: 300 });
  process.env.RELAY_CLOCK_JUMP_MS = '300';
  const jobs = require(`${SRC}/core/jobs`);
  const id = jobId((await toolCall('relay_start', { task: 'launch', cwd: s.project, title: 'Exp' })).text);
  await until(() => jobs.read(id).state === 'parked' && jobs.read(id).pid && alive(jobs.read(id).pid));
  await sleep(300);
  const rec = jobs.read(id);
  process.kill(rec.pid, 'SIGSTOP'); // no timer runs in it, as while the Mac sleeps
  await sleep(rec.wakeAt - Date.now() + 1500);
  process.kill(rec.pid, 'SIGCONT');
  await until(() => jobs.read(id).state === 'done', 20000);
  const done = jobs.read(id);
  assert.ok(done.sleepGaps && done.sleepGaps.length >= 1, `the gap is kept\n${fs.readFileSync(jobs.logFile(id), 'utf8')}`);
  assert.ok(done.sleepGaps[0].gapMs > 1000);
  assert.ok(done.wakeLog[0].lateMs >= 1000, `late by the time it was stopped (${done.wakeLog[0].lateMs} ms)`);
  assert.match(fs.readFileSync(jobs.logFile(id), 'utf8'), /the computer slept or the clock jumped: \d+ s passed with no timer running/);
  delete process.env.RELAY_CLOCK_JUMP_MS;
});

test('wake overdue: in the Needs action line ("wake overdue by N min") and the job view; not within the grace time', () => {
  const s = sandbox({});
  const jobs = require(`${SRC}/core/jobs`);
  // each with a live runner that has just started (a view revives a parked job without one, which would wake it)
  const pids = [];
  const withRunner = (wakeAt) => {
    const id = parkedJob(s, { wakeAt, extra: { runnerStartedAt: Date.now() } });
    const pid = fakeRunner(id);
    pids.push(pid);
    jobs.update(id, (c) => ({ ...c, pid }));
    return id;
  };
  const late = withRunner(Date.now() - 12 * 60000);
  const soon = withRunner(Date.now() - 60000);
  const future = withRunner(Date.now() + 60000);
  const views = [late, soon, future].map((i) => jobs.view(jobs.read(i)));
  const line = jobs.needsActionLine(views);
  assert.match(line, new RegExp(`Needs action: ${late} "Parked exp": wake overdue by 12 min`));
  assert.doesNotMatch(line, new RegExp(soon));
  assert.doesNotMatch(line, new RegExp(future));
  assert.equal(jobs.needsActionLine([jobs.view(jobs.read(soon))]), '');
  assert.match(jobs.describe(views[0]), /WAKE OVERDUE by 12m/);
  assert.match(jobs.describe(views[0]), /Parked, wake was due .* \(12m\d\ds ago\)/);
  const { statusText } = require(`${SRC}/core/workers`);
  const st = statusText();
  assert.match(st, /Needs action: .*wake overdue by 12 min/);
  assert.match(st, /WAKE OVERDUE by 12 min/);
  for (const id of [late, soon, future]) assert.equal(jobs.read(id).revives, undefined, 'nothing was revived');
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
});

test('revive from a Relay call: a parked job whose runner is gone, and one whose live runner is stuck past the wake time (killed with SIGKILL, replaced); a fresh or not-yet-due runner is left alone', async () => {
  const s = sandbox({ w1: ['ok'] });
  const jobs = require(`${SRC}/core/jobs`);
  const old = Date.now() - 3600e3;
  // runner gone, wake due 10 min ago
  const gone = parkedJob(s, { wakeAt: Date.now() - 10 * 60000, pid: 999999 });
  // runner alive but stuck 10 min past its wake time
  const stuckPid = fakeRunner('placeholder');
  const stuck = parkedJob(s, { wakeAt: Date.now() - 10 * 60000, extra: { runnerStartedAt: old } });
  process.kill(stuckPid, 'SIGKILL');
  const stuckRunner = fakeRunner(stuck);
  jobs.update(stuck, (c) => ({ ...c, pid: stuckRunner }));
  // alive, overdue, but its runner just started (a handover a moment ago): left alone
  const freshRunnerJob = parkedJob(s, { wakeAt: Date.now() - 10 * 60000, extra: { runnerStartedAt: Date.now() } });
  const freshPid = fakeRunner(freshRunnerJob);
  jobs.update(freshRunnerJob, (c) => ({ ...c, pid: freshPid }));
  // alive and not due yet: left alone
  const sleeping = parkedJob(s, { wakeAt: Date.now() + 3600e3, extra: { runnerStartedAt: old } });
  const sleepingPid = fakeRunner(sleeping);
  jobs.update(sleeping, (c) => ({ ...c, pid: sleepingPid }));

  await toolCall('relay_status', {});
  const g = jobs.read(gone);
  assert.equal(g.revives, 1);
  assert.equal(g.lastRevive.by, 'tool call');
  assert.match(g.lastRevive.why, /its runner \(pid 999999\) was gone/);
  assert.match(fs.readFileSync(jobs.logFile(gone), 'utf8'), /revived by tool call: its runner \(pid 999999\) was gone/);
  const k = jobs.read(stuck);
  assert.equal(k.revives, 1, 'the stuck one was replaced');
  assert.match(k.lastRevive.why, new RegExp(`its runner \\(pid ${stuckRunner}\\) was alive but had not woken it 10 min after the wake time; killed and replaced`));
  await until(() => !alive(stuckRunner));
  assert.notEqual(k.pid, stuckRunner);
  assert.notEqual(k.state, 'cancelled', 'SIGKILL, not SIGTERM: the job is not cancelled');
  assert.equal(jobs.read(freshRunnerJob).revives, undefined);
  assert.ok(alive(freshPid));
  assert.equal(jobs.read(sleeping).revives, undefined);
  assert.ok(alive(sleepingPid));
  // just after the computer woke (resumedAt), even an old runner gets the grace time to wake its job itself
  const old2 = parkedJob(s, { wakeAt: Date.now() - 10 * 60000, extra: { runnerStartedAt: old } });
  const old2Pid = fakeRunner(old2);
  jobs.update(old2, (c) => ({ ...c, pid: old2Pid }));
  assert.equal(jobs.reviveParked(process.env, { by: 'tray', resumedAt: Date.now() - 1000 }), 0);
  assert.ok(alive(old2Pid));
  for (const p of [freshPid, sleepingPid, old2Pid]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (const j of [gone, stuck]) await until(() => ['done', 'failed'].includes(jobs.read(j).state), 20000);
});

test('Settings › preventSleepForWakes: caffeinate -i -s -w <runner> from preventSleepMinutes before the wake and during the check; off by default', async () => {
  const caf = path.join(fs.realpathSync(os.tmpdir()), `relay-fake-caffeinate-${process.pid}.js`);
  const callsFile = path.join(fs.realpathSync(os.tmpdir()), `relay-fake-caffeinate-${process.pid}.log`);
  fs.writeFileSync(caf, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nsetInterval(() => {}, 1000);\n`);
  fs.chmodSync(caf, 0o755);
  try {
    // off (default): never started
    process.env.RELAY_CAFFEINATE = caf;
    let s = sandbox({ w1: ['park:5', 'ok'] });
    let jobs = require(`${SRC}/core/jobs`);
    let id = jobId((await toolCall('relay_start', { task: 'launch', cwd: s.project, title: 'Exp' })).text);
    await until(() => jobs.read(id).state === 'done', 20000);
    assert.ok(!fs.existsSync(callsFile), 'not started while the setting is off');

    s = sandbox({ w1: ['park:5', 'ok'] }, { settings: { preventSleepForWakes: true, preventSleepMinutes: 10 } });
    process.env.RELAY_CAFFEINATE = caf;
    jobs = require(`${SRC}/core/jobs`);
    id = jobId((await toolCall('relay_start', { task: 'launch', cwd: s.project, title: 'Exp' })).text);
    await until(() => jobs.read(id).state === 'parked' && jobs.read(id).keepAwake);
    const parked = jobs.read(id);
    assert.equal(parked.keepAwake.phase, 'before wake');
    assert.match((await toolCall('relay_poll', { job_ids: [id] })).text, /Keeping the Mac awake for this job's wake \(caffeinate pid \d+/);
    await until(() => jobs.read(id).state === 'done', 20000);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.length >= 2, JSON.stringify(calls));
    assert.deepEqual(calls[0].slice(0, 3), ['-i', '-s', '-w']);
    assert.equal(calls[0][4], '-t', 'before the wake: bounded');
    assert.ok(calls.some((c) => c.length === 4 && c[0] === '-i'), 'during the check: until it ends');
    const log = fs.readFileSync(jobs.logFile(id), 'utf8');
    assert.match(log, /keeping the Mac awake until the wake \(caffeinate -i -s -w \d+ -t \d+, pid \d+\)/);
    assert.match(log, /keeping the Mac awake during the check/);
    assert.equal(jobs.read(id).keepAwake, null, 'released when the check ended');
    // and the caffeinate processes are gone (stopped, or ended with their runner)
    const { execFileSync } = require('child_process');
    await until(() => !execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).includes(caf), 10000);
  } finally {
    delete process.env.RELAY_CAFFEINATE;
    fs.rmSync(caf, { force: true });
    fs.rmSync(callsFile, { force: true });
  }
});

// Last in this file: the server's minute check keeps running in this test process afterwards.
test('revive from the tray app: its check starts a runner for an overdue parked job without one, and records who did it', async () => {
  const s = sandbox({ w1: ['ok'] });
  const jobs = require(`${SRC}/core/jobs`);
  const id = parkedJob(s, { wakeAt: Date.now() - 5 * 60000, pid: 999998 });
  const { createServer } = require(`${SRC}/server`);
  const srv = await createServer({ shell: { notify: () => {} } });
  try {
    await until(() => jobs.read(id).revives === 1, 10000);
    assert.equal(jobs.read(id).lastRevive.by, 'tray');
    assert.match(fs.readFileSync(jobs.logFile(id), 'utf8'), /revived by tray: its runner \(pid 999998\) was gone/);
    await until(() => ['done', 'failed'].includes(jobs.read(id).state), 20000);
  } finally {
    srv.close?.();
  }
});
