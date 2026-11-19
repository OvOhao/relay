'use strict';
// Every wake of a parked job runs the code on disk at wake time: the sleeping runner hands the job to a fresh runner
// process (jobs.handOver) at the wake time and as soon as src/ changes, and exits. Driven through the real tool-call
// process and detached job runners; the "promotion" is an edit to a copy of src/ that the job runs from.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const REPO = path.join(__dirname, '..');

function sandbox(plan, { minuteMs = 200, copy = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-handover-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0', RELAY_PARK_MINUTE_MS: String(minuteMs), RELAY_PARK_STEP_MS: '100', RELAY_CODE_SETTLE_MS: '200',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT_CHARS', 'RELAY_MAX_WAKES']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  // A copy of the app the job runs from, so the test can change "the code on disk" under a sleeping runner.
  let src = path.join(REPO, 'src');
  if (copy) {
    const app = path.join(root, 'app');
    fs.cpSync(path.join(REPO, 'src'), path.join(app, 'src'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(app, 'package.json'));
    src = path.join(app, 'src');
  }
  const store = require(`${REPO}/src/core/store`);
  store.save([['lead', { desktop: true }], ['w1']].map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 1 });
  const invocations = () => {
    const f = path.join(process.env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const edit = (rel, from, to) => {
    const f = path.join(src, rel);
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(s.includes(from), `${rel} contains ${from}`);
    fs.writeFileSync(f, s.replace(from, to));
  };
  return { root, project, src, store, invocations, edit, toolCall: (name, args) => toolCall(src, name, args) };
}

function toolCall(src, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(src, 'tool-call.js')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
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
    await sleep(50);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const logOf = (jobs, id) => { try { return fs.readFileSync(jobs.logFile(id), 'utf8'); } catch { return ''; } };
const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;

test('a parked job whose code changes while it sleeps wakes on the new code', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, { minuteMs: 1000, copy: true });
  const jobs = require(`${REPO}/src/core/jobs`);
  const id = jobId((await s.toolCall('relay_start', { task: 'launch', cwd: s.project })).text);
  assert.match((await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
  const parked = jobs.read(id);
  const v1 = jobs.codeHash(s.src);
  assert.equal(parked.runnerCode, v1, 'the runner records the code it runs');
  const firstRunner = parked.pid;

  // "promote" a new version while the runner sleeps: the runner writes a version marker into the record at the wake,
  // and the wake prompt is worded differently
  s.edit('job-runner.js', 'wokeOnCode: BOOT_CODE,', "wokeOnCode: BOOT_CODE, versionMark: 'v2',");
  s.edit('core/park.js', '`Scheduled check (wake ${n} of the job)', '`Scheduled check v2 (wake ${n} of the job)');
  const v2 = jobs.codeHash(s.src);
  assert.notEqual(v2, v1);

  // the sleeping runner notices the change long before the wake time and hands over to a fresh runner
  await until(() => jobs.read(id).runnerCode === v2 && jobs.read(id).pid !== firstRunner, 4000);
  assert.equal(jobs.read(id).state, 'parked', 'still parked: the change does not wake the job early');
  await until(() => !alive(firstRunner), 4000);

  const w = await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, /DONE/, w.text);
  const done = jobs.read(id);
  assert.equal(done.versionMark, 'v2', 'the wake ran the new job-runner.js');
  assert.equal(done.wokeOnCode, v2);
  assert.equal(done.wakes, 1);
  assert.ok(done.handovers >= 2, `handed over on the change and again at the wake (${done.handovers})`);
  const inv = s.invocations();
  assert.equal(inv.length, 2);
  assert.match(inv[1].prompt, /^Scheduled check v2 \(wake 1 of the job\)/, 'the wake prompt comes from the new park.js');
  const log = logOf(jobs, id);
  assert.match(log, /handing over to a fresh runner .*the code on disk changed while parked/);
  assert.match(log, /handing over to a fresh runner .*wake time/);
  assert.equal(count(log, /waking: 1/), 1);
});

test('exactly one runner wakes the job while the sleeping runner hands over and revivers and extra runners race it', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, { minuteMs: 300 });
  const jobs = require(`${REPO}/src/core/jobs`);
  const id = jobId((await s.toolCall('relay_start', { task: 'launch', cwd: s.project })).text);
  assert.match((await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
  const { wakeAt } = jobs.read(id);

  // around the wake time: the revive path fires all the time, and more runners are started directly
  let stop = false;
  let revived = 0;
  const hammer = (async () => {
    while (!stop) {
      try { revived += jobs.reviveParked(); } catch { /* the lock was busy: next round */ }
      await sleep(5);
    }
  })();
  const extra = [];
  for (const dt of [-100, -20, 0, 20, 60, 150, 300]) {
    extra.push(sleep(Math.max(0, wakeAt + dt - Date.now())).then(() => jobs.spawnRunner(id)));
  }
  const w = await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  await Promise.all(extra);
  stop = true;
  await hammer;
  assert.match(w.text, /DONE/, w.text);

  const done = jobs.read(id);
  assert.equal(s.invocations().length, 2, 'one first segment and exactly one wake');
  assert.equal(done.wakes, 1);
  assert.deepEqual(done.history.map((h) => h.state), ['parked', 'done']);
  assert.equal(revived, 0, 'a reviver never saw the job without a live runner');
  assert.ok(done.handovers >= 1);
  const log = logOf(jobs, id);
  assert.equal(count(log, /waking: 1/), 1, log);
  assert.match(log, /handing over to a fresh runner .*wake time/);
  assert.ok(count(log, /another runner has this job|already done|the record is done/) >= 1, 'the extra runners left');
});

test('a fresh runner that crashes right after the handover is revived, and the job still wakes once and finishes', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, { minuteMs: 2000, copy: true });
  const jobs = require(`${REPO}/src/core/jobs`);
  const id = jobId((await s.toolCall('relay_start', { task: 'launch', cwd: s.project })).text);
  assert.match((await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
  const sleeper = jobs.read(id).pid;

  // the new code makes the next runner die at once (once): the change also makes the sleeper hand over to it
  const flag = path.join(s.root, 'crash-once');
  fs.writeFileSync(flag, '1');
  s.edit('job-runner.js', "'use strict';\n", `'use strict';\nif (require('fs').existsSync(${JSON.stringify(flag)})) { require('fs').rmSync(${JSON.stringify(flag)}); process.exit(1); }\n`);

  await until(() => !fs.existsSync(flag) && !alive(sleeper), 5000);
  const orphan = jobs.read(id);
  assert.equal(orphan.state, 'parked');
  assert.notEqual(orphan.pid, sleeper, 'the record names the fresh runner');
  await until(() => !alive(orphan.pid), 3000);
  assert.equal(jobs.runnerAlive(orphan), false, 'nobody runs the job now');

  await s.toolCall('relay_status', {}); // any Relay call revives it
  const revived = jobs.read(id);
  assert.equal(revived.revives, 1);
  assert.ok(alive(revived.pid), 'a new runner sleeps for it');

  const w = await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, /DONE/, w.text);
  const done = jobs.read(id);
  assert.equal(done.wakes, 1);
  assert.equal(s.invocations().length, 2);
  assert.equal(done.wokeOnCode, jobs.codeHash(s.src));
  assert.equal(count(logOf(jobs, id), /waking: 1/), 1);
});

test('a runner whose wake time already passed when it starts wakes the job itself, without another handover', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] }, { minuteMs: 60000 });
  const jobs = require(`${REPO}/src/core/jobs`);
  const id = jobId((await s.toolCall('relay_start', { task: 'x', cwd: s.project })).text);
  assert.match((await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /PARKED/);
  const pid = jobs.read(id).pid;
  process.kill(pid, 'SIGKILL');
  await until(() => !alive(pid));
  jobs.update(id, (cur) => ({ ...cur, wakeAt: Date.now() - 1000 }));
  const w = await s.toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, /DONE/);
  assert.equal(jobs.read(id).handovers || 0, 0);
  assert.equal(count(logOf(jobs, id), /waking: 1/), 1);
});
