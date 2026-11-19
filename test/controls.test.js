'use strict';
// The panel controls, end to end through the real tool-call process, the detached job runner, the
// panel's server and the fake Claude CLI:
//   - the leader as a worker (its switch "Leader takes jobs too"), and the dispatch dialog's API (POST /api/jobs/start:
//     the same checks as relay_start, refusals returned as the error);
//   - "Check progress" on a worker card and relay_wake: parked jobs wake NOW through the normal wake path, the wake is
//     marked manual, the short report goes into the record, relay_poll and a notification;
//   - background jobs wait for a worker or their folder as long as it takes (only relay_run gives up after its limit);
//   - the panel state: tiers, the leader switch, WAKE OVERDUE, and the new settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan, accounts = [['lead', { desktop: true }], ['w1']], { minuteMs = 60000, settings = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-controls-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0', RELAY_PARK_MINUTE_MS: String(minuteMs), RELAY_PARK_STEP_MS: '100', RELAY_BUSY_POLL_MS: '100',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT', 'RELAY_QUEUE_WAIT_SEC', 'RELAY_BG_WAIT_SEC', 'RELAY_MAX_WAKES']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save(accounts.map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 3, ...settings });
  const invocations = () => {
    try { return fs.readFileSync(path.join(process.env.FAKE_STATE, 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { root, project, store, invocations };
}

function toolCall(name, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SRC, 'tool-call.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
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
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The panel's server with a captured notify; api(path, body) posts like the panel does.
async function panel() {
  const notes = [];
  const { createServer } = require(`${SRC}/server`);
  const srv = await createServer({ shell: { notify: (n) => notes.push(n) } });
  const token = new URL(srv.url).searchParams.get('t');
  const api = async (p, body) => {
    const res = await fetch(`${srv.origin}${p}`, body === undefined ? { headers: { cookie: `relay=${token}` } } : { method: 'POST', headers: { cookie: `relay=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    return { status: res.status, ...data };
  };
  return { srv, api, notes, close: () => srv.close?.() };
}

/* ---------- 1. the leader as a worker ---------- */

test('the leader takes jobs only with its switch on: named while off is refused; with no other worker the reply says so', async () => {
  const s = sandbox({ lead: ['ok'] }, [['lead', { desktop: true }]]);
  let r = await toolCall('relay_run', { task: 'x', cwd: s.project });
  assert.match(r.text, /NO_WORKER_AVAILABLE: .*leader account \(this window\) does not take jobs .*"Leader takes jobs too"/);
  s.store.saveSettings({});
  s.store.save([...s.store.load(), { ...s.store.newAccount('w1', path.join(s.root, 'home', 'accounts', 'w1'), 'w1@x.com') }]);
  r = await toolCall('relay_run', { task: 'x', cwd: s.project, account: 'lead@x.com' });
  assert.equal(r.isError, true);
  assert.match(r.text, /lead@x\.com is the leader account \(this window\) and does not take jobs.*Nothing was started/);
  assert.equal(s.invocations().length, 0);
  s.store.update('lead', { takesJobs: true });
  r = await toolCall('relay_run', { task: 'x', cwd: s.project, account: 'lead@x.com' });
  assert.match(r.text, /\[relay\] worker lead@x\.com .*finished/);
  assert.equal(s.invocations()[0].account, 'lead');
});

/* ---------- 1b. the dispatch dialog ---------- */

test('the dispatch dialog starts a background job like relay_start; refusals come back as the error; relay_poll (cwd) finds it', async () => {
  const s = sandbox({ w1: ['ok', 'ok'], lead: ['ok'] });
  fs.mkdirSync(path.join(s.project, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(s.project, '.relay', 'project.json'), JSON.stringify({ require_scope: true }));
  const p = await panel();
  try {
    let r = await p.api('/api/jobs/start', { task: '', cwd: s.project });
    assert.equal(r.status, 400);
    assert.match(r.error, /needs a task/);
    r = await p.api('/api/jobs/start', { task: 'x', cwd: path.join(s.project, 'nope') });
    assert.match(r.error, /cwd must be an existing absolute folder/);
    r = await p.api('/api/jobs/start', { task: 'x', cwd: s.project });
    assert.match(r.error, /requires a scope/, 'require_scope, not read-only');
    const info = await p.api('/api/project-info', { cwd: s.project });
    assert.equal(info.requireScope, true);
    assert.equal((await p.api('/api/project-info', { cwd: path.join(s.project, 'nope') })).exists, false);
    r = await p.api('/api/jobs/start', { task: 'x', cwd: s.project, read_only: true, account: 'lead' });
    assert.match(r.error, /leader account .* does not take jobs/);

    // scope as the dialog sends it (comma separated); every other field passes through
    r = await p.api('/api/jobs/start', { task: 'Write the parser', cwd: s.project, scope: 'src, docs', thread: 'parser', title: 'Parser', model: 'haiku', effort: 'low', priority: 'high', agent: 'claude', account: '' });
    assert.equal(r.status, 200, r.error);
    const jobs = require(`${SRC}/core/jobs`);
    const rec = jobs.read(r.id);
    assert.equal(rec.via, 'panel');
    assert.deepEqual(rec.request.scope, ['src', 'docs']);
    assert.equal(rec.request.thread, 'parser');
    assert.equal(rec.priority, 'high');
    await until(() => jobs.read(r.id).state === 'done');
    const inv = s.invocations().find((x) => /Write the parser/.test(x.prompt));
    assert.equal(inv.model, 'haiku');
    assert.equal(inv.effort, 'low');
    const poll = await toolCall('relay_poll', { cwd: s.project });
    assert.match(poll.text, new RegExp(`## Job ${r.id} · DONE .*"Parser"`));
    assert.match(poll.text, /dispatched from the panel/);
    // the folder now shows among the dialog's recent folders (from the ledger)
    assert.ok((await p.api('/api/projects', {})).folders.includes(s.project));

    // the leader as a target once its switch is on
    assert.equal((await p.api('/api/accounts/takes-jobs', { name: 'lead', on: true })).takesJobs, true);
    r = await p.api('/api/jobs/start', { task: 'x', cwd: s.project, read_only: true, account: 'lead' });
    assert.equal(r.status, 200, r.error);
    await until(() => jobs.read(r.id).state === 'done');
    assert.equal(jobs.read(r.id).account, 'lead');
  } finally {
    p.close();
  }
});

/* ---------- 3. check progress / relay_wake ---------- */

test('relay_wake: a parked job wakes now through the normal wake path, marked manual; the short report lands in the record and relay_poll', async () => {
  const s = sandbox({ w1: ['park:60', 'ok'] }, [['lead', { desktop: true }], ['w1']], { minuteMs: 60000 });
  process.env.FAKE_REPORT = 'Progress: epoch 7 of 10, loss 0.31; about 20 min left.\n\nDetails: the run is healthy.';
  const jobs = require(`${SRC}/core/jobs`);
  try {
    const id = jobId((await toolCall('relay_start', { task: 'launch', cwd: s.project, title: 'Train' })).text);
    await until(() => jobs.read(id).state === 'parked' && jobs.read(id).pid && alive(jobs.read(id).pid));
    const sleeper = jobs.read(id).pid;
    const scheduled = jobs.read(id).wakeAt;
    assert.ok(scheduled - Date.now() > 30 * 60000, 'parked for an hour');

    // refused from a worker session; an account without parked jobs says so
    const worker = await toolCall('relay_wake', { account: 'w1' }, { ...process.env, RELAY_TAKEOVER: '1' });
    assert.equal(worker.isError, true);
    assert.match(worker.text, /refused: this is a Relay worker session/);
    assert.match((await toolCall('relay_wake', { account: 'lead@x.com' })).text, /lead@x\.com has no parked jobs: nothing to wake/);
    assert.match((await toolCall('relay_wake', {})).text, /needs job_ids .* or account/);

    const r = await toolCall('relay_wake', { account: 'w1@x.com' });
    assert.match(r.text, new RegExp(`Job ${id} "Train": woken now for a progress check`));
    await until(() => jobs.read(id).state === 'done');
    assert.equal(alive(sleeper), false, 'the sleeping runner was replaced');
    const done = jobs.read(id);
    const w = done.wakeLog[done.wakeLog.length - 1];
    assert.equal(w.manual, true);
    assert.equal(w.kind, 'manual check');
    assert.equal(w.scheduledAt, scheduled);
    assert.ok(w.lateMs < 10000, 'due now, not at the scheduled time');
    const mc = done.manualChecks[done.manualChecks.length - 1];
    assert.equal(mc.state, 'done');
    assert.equal(mc.outcome, 'finished');
    assert.equal(mc.short, 'epoch 7 of 10, loss 0.31; about 20 min left.');
    assert.equal(mc.account, 'w1');
    // the wake prompt asked for the progress line; the session was the job's own
    const wakeInv = s.invocations().filter((x) => x.account === 'w1').pop();
    assert.match(wakeInv.prompt, /Progress check requested by the user now \(wake 1 of the job\)/);
    assert.match(wakeInv.prompt, /Start your reply with one line "Progress:/);
    assert.ok(wakeInv.resume, 'the same session was resumed');
    const poll = await toolCall('relay_poll', { job_ids: [id] });
    assert.match(poll.text, /Manual progress check \(wake 1, asked for by .*, finished .*\): epoch 7 of 10, loss 0\.31/);
    assert.match(poll.text, /Last check \(1\): a manual progress check/);
    assert.match(poll.text, /Details: the run is healthy\./, 'the full report');
    // a finished job cannot be woken
    assert.match((await toolCall('relay_wake', { job_ids: [id] })).text, /not woken: already done/);
  } finally {
    delete process.env.FAKE_REPORT;
  }
});

test('"Check progress" on a worker card: wakes its parked jobs, the card shows the check, a notification carries the short report; none parked: says so', async () => {
  const s = sandbox({ w1: ['park:60', 'park:90'], w2: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['w2']], { minuteMs: 60000 });
  const jobs = require(`${SRC}/core/jobs`);
  const p = await panel();
  try {
    const id = jobId((await toolCall('relay_start', { task: 'launch', cwd: s.project, title: 'Sim', account: 'w1' })).text);
    await until(() => jobs.read(id).state === 'parked' && alive(jobs.read(id).pid));
    assert.deepEqual(await p.api('/api/accounts/check-progress', { name: 'w2' }), { status: 200, ok: true, woken: [], none: true });
    const r = await p.api('/api/accounts/check-progress', { name: 'w1' });
    assert.deepEqual(r.woken, [id]);
    // it parks again (the worker's choice): the check is done, the job is parked with a new wake time
    const n = await until(() => p.notes.find((x) => x.kind === 'job' && x.id === id && x.check));
    assert.equal(n.check.outcome, 'parked again');
    assert.match(n.check.short, /Launched the experiment \(pid 4242\), verified it runs/);
    const rec = jobs.read(id);
    assert.equal(rec.state, 'parked');
    assert.equal(rec.wakeLog[rec.wakeLog.length - 1].by, 'the Relay panel');
    const state = await p.api('/api/state');
    const w1 = state.accounts.find((a) => a.name === 'w1');
    assert.equal(w1.checks[0].id, id);
    assert.equal(w1.checks[0].state, 'done');
    assert.match(w1.checks[0].short, /Launched the experiment/);
    const rep = await p.api('/api/jobs/report', { id });
    assert.match(rep.report, /RELAY_PARK|Launched the experiment/);
    await toolCall('relay_cancel', { job_ids: [id] });
  } finally {
    p.close();
  }
});

/* ---------- 4. background jobs keep waiting ---------- */

test('a background job waits for a free worker past relay_run\'s limit and runs when one frees; relay_run still answers BUSY', async () => {
  const s = sandbox({ w1: ['ok', 'ok', 'ok'] }, [['lead', { desktop: true }], ['w1']], { settings: { jobsPerWorker: 1 } });
  process.env.RELAY_QUEUE_WAIT_SEC = '1';
  process.env.FAKE_DELAY_MS = '1500'; // a run takes about 3 x this
  const jobs = require(`${SRC}/core/jobs`);
  try {
    const a = jobId((await toolCall('relay_start', { task: 'first', cwd: s.project, read_only: true })).text);
    await until(() => s.invocations().length === 1);
    const b = jobId((await toolCall('relay_start', { task: 'second', cwd: s.project, read_only: true })).text);
    const sync = await toolCall('relay_run', { task: 'third', cwd: s.project, read_only: true });
    assert.match(sync.text, /^BUSY: every worker is still busy/);
    const v = await until(() => { const x = jobs.view(jobs.read(b)); return x.queuePos === 1 && x; }, 5000);
    assert.equal(v.state, 'waiting for worker', 'still waiting after relay_run gave up');
    assert.match((await toolCall('relay_poll', { job_ids: [b] })).text, /#1 in line for a worker/);
    await until(() => jobs.read(a).state === 'done' && jobs.read(b).state === 'done', 30000);
    assert.equal(jobs.read(b).code, 'done');
  } finally {
    delete process.env.RELAY_QUEUE_WAIT_SEC;
    delete process.env.FAKE_DELAY_MS;
  }
});

test('a background job waits for its folder past relay_run\'s limit; Settings\' backgroundMaxWaitMin bounds it', async () => {
  const s = sandbox({ w1: ['ok', 'ok', 'ok', 'ok'] });
  process.env.RELAY_QUEUE_WAIT_SEC = '1';
  process.env.FAKE_DELAY_MS = '1500';
  const jobs = require(`${SRC}/core/jobs`);
  try {
    const a = jobId((await toolCall('relay_start', { task: 'first', cwd: s.project, scope: ['src'] })).text);
    await until(() => s.invocations().length === 1);
    const b = jobId((await toolCall('relay_start', { task: 'second', cwd: s.project, scope: ['src'] })).text);
    const sync = await toolCall('relay_run', { task: 'third', cwd: s.project, scope: ['src/x'] });
    assert.match(sync.text, /^BUSY: another Relay worker .* after waiting 1 s/);
    assert.equal(jobs.view(jobs.read(b)).state, 'waiting for folder');
    await until(() => jobs.read(a).state === 'done' && jobs.read(b).state === 'done', 30000);

    // with a maximum wait for background jobs: BUSY after it
    process.env.RELAY_BG_WAIT_SEC = '1';
    const c = jobId((await toolCall('relay_start', { task: 'fourth', cwd: s.project, scope: ['src'] })).text);
    await until(() => s.invocations().length === 3);
    const d = jobId((await toolCall('relay_start', { task: 'fifth', cwd: s.project, scope: ['src'] })).text);
    await until(() => jobs.read(d).state === 'failed', 15000);
    assert.equal(jobs.read(d).code, 'busy');
    await until(() => jobs.read(c).state === 'done', 15000);
  } finally {
    for (const k of ['RELAY_QUEUE_WAIT_SEC', 'FAKE_DELAY_MS', 'RELAY_BG_WAIT_SEC']) delete process.env[k];
  }
  const store = require(`${SRC}/core/store`);
  assert.equal(store.backgroundWaitSec({ backgroundMaxWaitMin: 0 }), Infinity);
  assert.equal(store.backgroundWaitSec({ backgroundMaxWaitMin: 5 }), 300);
  assert.equal(store.backgroundWaitSec({}), Infinity);
});

/* ---------- the panel state and settings ---------- */

test('panel state: tiers, the leader switch, WAKE OVERDUE on parked jobs; tier and settings are checked', async () => {
  const s = sandbox({}, [['lead', { desktop: true }], ['w1'], ['w2', { tier: 2 }]]);
  const jobs = require(`${SRC}/core/jobs`);
  // a parked job whose wake is 10 minutes overdue (no session: written straight into the record)
  fs.mkdirSync(jobs.dir(), { recursive: true });
  const rec = { id: 'over-due1', state: 'parked', request: { task: 'x', cwd: s.project }, cwd: s.project, project: 'project', title: 'Late one', account: 'w1', wakeAt: Date.now() - 10 * 60000, createdAt: Date.now() - 3600e3, pid: null };
  fs.writeFileSync(jobs.jobFile(rec.id), JSON.stringify(rec));
  const p = await panel();
  try {
    const state = await p.api('/api/state');
    fs.rmSync(jobs.jobFile(rec.id), { force: true }); // before the tray's revive could start a runner for it
    const by = (n) => state.accounts.find((a) => a.name === n);
    assert.deepEqual([by('lead').worker, by('lead').takesJobs, by('w1').worker, by('w1').tier, by('w2').tier], [false, false, true, 1, 2]);
    assert.ok(by('w1').parked[0].overdueMin >= 9, 'WAKE OVERDUE');
    assert.equal(state.canPickFolder, false, 'no folder picker outside the app');
    assert.equal((await p.api('/api/pick-folder', {})).status, 400);

    assert.equal((await p.api('/api/accounts/tier', { name: 'w1', tier: 3 })).tier, 3);
    assert.equal(s.store.get('w1').tier, 3);
    assert.equal((await p.api('/api/accounts/tier', { name: 'w1', tier: 4 })).status, 400);
    assert.equal((await p.api('/api/accounts/takes-jobs', { name: 'lead', on: true })).takesJobs, true);
    assert.equal(s.store.get('lead').takesJobs, true, 'stored on the account in accounts.json');
    const after = await p.api('/api/state');
    assert.equal(after.accounts.find((a) => a.name === 'lead').worker, true);

    const set = await p.api('/api/settings', { preventSleepForWakes: true, preventSleepMinutes: 15, backgroundMaxWaitMin: 60 });
    assert.deepEqual([set.preventSleepForWakes, set.preventSleepMinutes, set.backgroundMaxWaitMin], [true, 15, 60]);
    assert.equal((await p.api('/api/settings', { preventSleepMinutes: 500 })).status, 400);
    assert.equal((await p.api('/api/settings', { backgroundMaxWaitMin: -1 })).status, 400);
    assert.equal(s.store.loadSettings().preventSleepForWakes, true);
  } finally {
    p.close();
  }
});

test('the short report: the worker\'s "Progress:" line, else its first plain paragraph', () => {
  const { shortReport } = require(`${SRC}/core/jobs`);
  assert.equal(shortReport('## Status\n\nProgress: 3 of 5 seeds done.\n\nMore.'), '3 of 5 seeds done.');
  assert.equal(shortReport('**Progress:** **half** way'), 'half way');
  assert.equal(shortReport('进度：已完成一半'), '已完成一半');
  assert.equal(shortReport('# Report\n\nThe build finished; tests pass.\n\n```relay-summary\n{"status":"done"}\n```\nRELAY_PARK: 30 | check'), 'The build finished; tests pass.');
  assert.ok(shortReport('x'.repeat(1000)).length <= 220);
});
