'use strict';
// Background jobs (relay_start / relay_poll / relay_wait / relay_cancel), driven through the real tool-call process
// and the detached job runner, with the fake Claude and Codex CLIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan, accounts = [['lead', { desktop: true }], ['w1'], ['w2']]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-jobs-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'),
    RELAY_HUB: path.join(root, 'hub'),
    FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan),
    RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_CODEX_CMD: JSON.stringify([process.execPath, FAKE_CODEX]),
    RELAY_TICK: '0.05',
    RELAY_SLACK: '0',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT_CHARS', 'FAKE_CODEX_PREFLIGHT', 'FAKE_CODEX_SIGNED_OUT']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.txt'), 'a file to review\n');
  const store = require(`${SRC}/core/store`);
  store.save(accounts.map(([n, extra = {}]) => {
    const codex = extra.provider === 'codex';
    const dir = codex ? path.join(root, 'home', 'codex', n) : path.join(root, 'home', 'accounts', n);
    if (codex) fs.mkdirSync(dir, { recursive: true });
    return { ...store.newAccount(n, dir, codex ? '' : `${n}@x.com`), ...(codex ? { model: 'gpt-test' } : {}), ...extra };
  }));
  store.saveSettings({ jobsPerWorker: 0 });
  return { root, project, store };
}

// One tool call through the real tool-call process (as the MCP server makes it); resolves { text, isError, progress, ms }.
function toolCall(name, args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(SRC, 'tool-call.js')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const progress = [];
    let result = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.progress) progress.push(m.progress);
        if (m.result) result = m.result;
      }
    });
    child.on('error', reject);
    child.on('close', () => (result ? resolve({ ...result, progress, ms: Date.now() - t0 }) : reject(new Error('no result'))));
    child.stdin.write(`${JSON.stringify({ name, args })}\n`);
  });
}
const jobId = (text) => text.match(/Started job ([a-z0-9-]+)/)[1];
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

test('start returns at once and the job outlives the process that started it; poll and wait give the whole report', async () => {
  const s = sandbox({ w1: ['ok'], w2: ['ok'] });
  process.env.FAKE_DELAY_MS = '600';
  process.env.FAKE_REPORT_CHARS = '30000';
  const jobs = require(`${SRC}/core/jobs`);
  const memory = require(`${SRC}/core/memory`);
  const started = await toolCall('relay_start', { task: 'do the thing', cwd: s.project, thread: 'bg-one', title: 'Background one' });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /state queued, thread "bg-one", agent claude/);
  assert.ok(started.ms < 5000, `returned at once (${started.ms} ms), not after the 1.8 s job`);
  const id = jobId(started.text);
  // the tool-call process has exited by now (toolCall resolved on close); the job still runs in its own process
  const rec = jobs.read(id);
  assert.ok(rec.pid && alive(rec.pid), 'the detached runner is alive after the starting process ended');
  assert.equal(rec.request.task, 'do the thing');
  assert.equal(rec.title, 'Background one');

  const early = await toolCall('relay_poll', { job_ids: [id] });
  assert.match(early.text, new RegExp(`Job ${id} · (QUEUED|RUNNING|WAITING FOR WORKER)`));
  // while it runs, the panel's run file is there (the Overview tab shows it like a relay_run job)
  await until(() => memory.listRuns().find((r) => r.pid === rec.pid && r.title === 'Background one'));

  const waited = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.equal(waited.isError, false);
  assert.match(waited.text, /All 1 job finished/);
  assert.match(waited.text, new RegExp(`Job ${id} · DONE · "Background one"`));
  assert.match(waited.text, /account w[12]@x\.com/);
  assert.match(waited.text, /model fake-model/);
  assert.ok(waited.text.includes(`${'r'.repeat(30000)}END-OF-REPORT`), 'the report is never truncated');
  assert.match(waited.text, /worker w[12]@x\.com · model fake-model · thread "bg-one" finished/, 'the report is relay_run\'s own text');

  const done = jobs.read(id);
  assert.equal(done.state, 'done');
  assert.ok(done.report.includes('END-OF-REPORT'));
  assert.ok(done.finishedAt >= done.createdAt);
  assert.equal(memory.getThread(s.project, 'bg-one').stopped, false, 'the thread record is updated as relay_run does');
  assert.match(memory.ledgerText(s.project), /thread "bg-one"/);
  const polled = await toolCall('relay_poll', { cwd: s.project });
  assert.ok(polled.text.includes('END-OF-REPORT'), 'poll by project lists it with its full report');
  await until(() => !alive(rec.pid));
});

test('wait: any returns with the first finished job, all times out while one is still going; cancel stops it cleanly', async () => {
  const s = sandbox({ w1: ['hang'], w2: ['ok'] });
  const jobs = require(`${SRC}/core/jobs`);
  const memory = require(`${SRC}/core/memory`);
  const a = jobId((await toolCall('relay_start', { task: 'slow one', cwd: s.project, account: 'w1', thread: 'slow', title: 'Slow job' })).text);
  const b = jobId((await toolCall('relay_start', { task: 'quick one', cwd: s.project, account: 'w2', title: 'Quick job' })).text);

  const any = await toolCall('relay_wait', { job_ids: [a, b], timeout_sec: 30 });
  assert.match(any.text, /1 of 2 jobs finished/);
  assert.match(any.text, new RegExp(`Job ${b} · DONE`));
  assert.match(any.text, new RegExp(`Job ${a} · (RUNNING|QUEUED)`));
  assert.ok(any.text.indexOf(`Job ${b}`) < any.text.indexOf(`Job ${a}`), 'finished jobs come first');

  const t0 = Date.now();
  const all = await toolCall('relay_wait', { job_ids: [a, b], mode: 'all', timeout_sec: 2 });
  assert.ok(Date.now() - t0 < 8000);
  assert.match(all.text, /Timed out after 2 s: 1 of 2 finished/);
  assert.ok(all.progress.length >= 1, 'progress while waiting');

  const runner = jobs.read(a).pid;
  await until(() => memory.listRuns().find((r) => r.pid === runner && r.status === 'running'));
  const fakePids = () => fs.readdirSync(path.join(process.env.FAKE_STATE, 'pids')).map(Number).filter(alive);
  assert.ok(fakePids().length >= 1, 'the hanging fake worker runs');
  const c = await toolCall('relay_cancel', { job_ids: [a] });
  assert.match(c.text, new RegExp(`Job ${a}: cancelled`));
  const rec = jobs.read(a);
  assert.equal(rec.state, 'cancelled');
  assert.match(rec.report, /^Cancelled\./);
  assert.match(memory.ledgerText(s.project), /CANCELLED/);
  await until(() => !memory.listRuns().some((r) => r.pid === runner), 5000);
  await until(() => fakePids().length === 0, 5000);
  assert.equal(memory.getThread(s.project, 'slow').stopped, true, 'the session is kept for a resume, as relay_run does');
  const again = await toolCall('relay_cancel', { job_ids: [a] });
  assert.match(again.text, /already cancelled/);
});

test('relay_start refuses exactly what relay_run refuses, with the same text; a Codex job must be read-only', async () => {
  const s = sandbox({ cx1: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', { provider: 'codex' }]]);
  const cases = [
    { task: 'x', cwd: 'relative/path' },
    { task: '', cwd: s.project },
    { task: 'x', cwd: s.project, effort: 'turbo' },
    { task: 'x', cwd: s.project, model: 'bad model!' },
    { task: 'x', cwd: s.project, agent: 'gemini' },
    { task: 'x', cwd: s.project, scope: ['../outside'] },
    { task: 'review', cwd: s.project, agent: 'codex' },
    { task: 'review', cwd: s.project, agent: 'codex', read_only: true, model: 'opus' },
  ];
  for (const args of cases) {
    const run = await toolCall('relay_run', args);
    const start = await toolCall('relay_start', args);
    assert.equal(start.text, run.text, JSON.stringify(args));
    assert.equal(start.isError, run.isError);
  }
  const jobs = require(`${SRC}/core/jobs`);
  assert.deepEqual(jobs.list(), [], 'no job was recorded');

  const ok = await toolCall('relay_start', { task: 'review a.txt', cwd: s.project, agent: 'codex', read_only: true, thread: 'audit' });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /agent codex/);
  const w = await toolCall('relay_wait', { job_ids: [jobId(ok.text)], timeout_sec: 30 });
  assert.match(w.text, /DONE/);
  assert.match(w.text, /Codex worker cx1 · model gpt-test/);
  assert.match(w.text, /job folder unchanged/);
  assert.match(w.text, /Sandbox: verified/);
});

test('job records: kept for 7 days then pruned; a runner that died is reported as failed; unknown ids are said', async () => {
  const s = sandbox({});
  const jobs = require(`${SRC}/core/jobs`);
  const fslock = require(`${SRC}/core/fslock`);
  fs.mkdirSync(jobs.dir(), { recursive: true });
  const day = 86400e3;
  const mk = (id, extra) => fslock.writeJson(jobs.jobFile(id), { id, state: 'done', request: { task: 't', thread: '' }, cwd: s.project, createdAt: Date.now() - 9 * day, ...extra });
  mk('old-1', { finishedAt: Date.now() - 8 * day, report: 'old' });
  fs.writeFileSync(jobs.logFile('old-1'), 'log');
  mk('recent-1', { finishedAt: Date.now() - 6 * day, report: 'recent report' });
  mk('dead-1', { state: 'queued', pid: 999999, createdAt: Date.now() - 60000 });
  const p = await toolCall('relay_poll', { cwd: s.project });
  assert.ok(!fs.existsSync(jobs.jobFile('old-1')) && !fs.existsSync(jobs.logFile('old-1')), 'pruned with its log');
  assert.ok(fs.existsSync(jobs.jobFile('recent-1')));
  assert.match(p.text, /Job recent-1 · DONE[\s\S]*recent report/);
  assert.match(p.text, /Job dead-1 · FAILED/);
  assert.match(p.text, /background process ended without a result/);
  assert.equal(jobs.read('dead-1').code, 'runner_died');
  const u = await toolCall('relay_poll', { job_ids: ['nope-1234'] });
  assert.equal(u.isError, true);
  assert.match(u.text, /no such job/);
  const nothing = await toolCall('relay_poll', {});
  assert.match(nothing.text, /Give job_ids, or cwd/);
});

test('relay_status and relay_poll show the same live state: a record still "queued" whose run file runs is running', async (t) => {
  const s = sandbox({});
  const jobs = require(`${SRC}/core/jobs`);
  const memory = require(`${SRC}/core/memory`);
  const fslock = require(`${SRC}/core/fslock`);
  fs.mkdirSync(jobs.dir(), { recursive: true });
  // Each job's runner is a live process of its own (the run file is matched to the job by its pid).
  const kids = [0, 1, 2, 3].map(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }));
  t.after(() => kids.forEach((k) => k.kill('SIGKILL')));
  const mk = (id, pid, title) => fslock.writeJson(jobs.jobFile(id), { id, state: 'queued', pid, title, project: 'project', request: { task: 't', thread: '' }, cwd: s.project, createdAt: Date.now() - 60000 });
  mk('live-run1', kids[0].pid, 'runs now');
  mk('live-wait', kids[1].pid, 'waits for a worker');
  mk('live-chks', kids[2].pid, 'runs its checks');
  mk('live-none', kids[3].pid, 'no run file yet');
  memory.writeRun('r-run1', { pid: kids[0].pid, status: 'running', account: 'w1', lastLine: 'editing a.txt', updatedAt: Date.now() });
  memory.writeRun('r-wait', { pid: kids[1].pid, status: 'waiting', lastLine: 'Waiting for a free worker', queuePos: 2, updatedAt: Date.now() });
  memory.writeRun('r-chks', { pid: kids[2].pid, status: 'running', phase: 'checks', ranOn: 'w2', updatedAt: Date.now() });

  const st = await toolCall('relay_status', {});
  assert.match(st.text, /live-run1 "runs now" \(project\): running on w1@x\.com/);
  assert.match(st.text, /live-wait "waits for a worker" \(project\): waiting for worker \(#2 in line\)/);
  assert.match(st.text, /live-chks "runs its checks" \(project\): running checks on w2@x\.com/);
  assert.match(st.text, /live-none "no run file yet" \(project\): queued/);
  assert.doesNotMatch(st.text, /live-run1[^\n]*: queued/);

  const p = await toolCall('relay_poll', { job_ids: ['live-run1', 'live-wait', 'live-chks', 'live-none'] });
  assert.match(p.text, /Job live-run1 · RUNNING[^\n]*\n[^\n]*account w1@x\.com/);
  assert.match(p.text, /Last progress: editing a\.txt/);
  assert.match(p.text, /Job live-wait · WAITING FOR WORKER/);
  assert.match(p.text, /Job live-chks · RUNNING CHECKS[^\n]*\n[^\n]*account w2@x\.com/);
  assert.match(p.text, /Job live-none · QUEUED/);
  // the records themselves are untouched: the state is derived, not stored
  assert.equal(jobs.read('live-run1').state, 'queued');
});

test('a 700 KB job record: relay_poll and relay_wait return; the worker report in full, Relay checks shortened', async () => {
  const s = sandbox({});
  const jobs = require(`${SRC}/core/jobs`);
  const project = require(`${SRC}/core/project`);
  const fslock = require(`${SRC}/core/fslock`);
  fs.mkdirSync(jobs.dir(), { recursive: true });
  // The worker's own report: 40 KB, every line numbered, so any cut shows.
  const worker = Array.from({ length: 800 }, (_, i) => `worker line ${String(i).padStart(4, '0')} ${'w'.repeat(30)}`).join('\n') + '\nEND OF WORKER REPORT';
  const out = (i) => Array.from({ length: 40 }, (_, k) => `check ${i} output line ${k} ${'o'.repeat(40)}`).join('\n');
  const checks = Array.from({ length: 300 }, (_, i) => (i % 25 === 3
    ? { name: 'audit numbers', file: `ideas/f${i}.md`, cmd: `audit ${'x'.repeat(250)}`, code: 1, ok: false, tail: out(i), ms: 10 }
    : { name: i % 2 ? 'audit numbers' : 'freeze check', file: `ideas/f${i}.md`, cmd: `audit ${'x'.repeat(250)}`, code: 0, ok: true, tail: out(i), ms: 10 }));
  checks.push({ name: 'runs verify', file: null, skipped: '9 more matching files were not checked' });
  const tail = 'Files touched: a.txt';
  const report = `${worker}\n\n${project.checksText(checks)}\n\nNote: other jobs ran here.\n\n${tail}`;
  fslock.writeJson(jobs.jobFile('big-1'), { id: 'big-1', state: 'done', title: 'big', request: { task: 't', thread: '' }, cwd: s.project, createdAt: Date.now() - 60000, finishedAt: Date.now(), report, checks });
  assert.ok(fs.statSync(jobs.jobFile('big-1')).size > 700e3, `record is ${fs.statSync(jobs.jobFile('big-1')).size} bytes`);

  for (const call of [() => toolCall('relay_poll', { job_ids: ['big-1'] }), () => toolCall('relay_wait', { job_ids: ['big-1'], timeout_sec: 5 })]) {
    const r = await call();
    assert.ok(r && typeof r.text === 'string' && !/without an answer/.test(r.text), 'an answer came back');
    assert.ok(r.text.includes(worker), 'the worker report is there in full');
    assert.match(r.text, /Note: other jobs ran here\.\n\nFiles touched: a\.txt/, 'what follows the checks is kept');
    const sec = r.text.slice(r.text.indexOf('## Relay checks'), r.text.indexOf('\n\nNote: other jobs'));
    assert.ok(sec.length <= 8500, `checks section ${sec.length} chars`);
    assert.match(sec, /301 checks: 2\d\d passed, 12 FAILED, 1 skipped/);
    assert.ok(sec.includes(jobs.jobFile('big-1')), 'says where the full record is');
    for (const c of checks.filter((x) => !x.ok || x.skipped)) assert.ok(sec.includes(`${c.skipped ? 'skipped' : 'FAILED'}: ${c.name}${c.file ? ` (${c.file})` : ''}`), `status line of ${c.file || c.name}`);
    assert.match(sec, /- passed: freeze check \(144 checks\)/);
    assert.match(sec, /- passed: audit numbers \(144 checks\)/);
    assert.match(sec, /check 3 output line 39/, 'the last lines of a failed output');
  }
  // The record keeps everything.
  assert.equal(jobs.read('big-1').report, report);
});

test('the tool-call process writes a result of several hundred KB in full before it exits', async () => {
  const s = sandbox({});
  const jobs = require(`${SRC}/core/jobs`);
  const fslock = require(`${SRC}/core/fslock`);
  fs.mkdirSync(jobs.dir(), { recursive: true });
  // No checks section: nothing is shortened, so the whole 400 KB report must come through the pipe.
  const report = Array.from({ length: 8000 }, (_, i) => `line ${i} ${'r'.repeat(40)}`).join('\n') + '\nTHE END';
  fslock.writeJson(jobs.jobFile('huge-1'), { id: 'huge-1', state: 'done', title: 'huge', request: { task: 't', thread: '' }, cwd: s.project, createdAt: Date.now() - 1000, finishedAt: Date.now(), report });
  const r = await toolCall('relay_poll', { job_ids: ['huge-1'] });
  assert.ok(r.text.includes(report), `the whole report arrived (${r.text.length} chars)`);
});

test('a finished job tells the Relay app, which shows a notification; no app running is fine', async () => {
  const s = sandbox({ w1: ['ok'] }, [['lead', { desktop: true }], ['w1']]);
  const jobs = require(`${SRC}/core/jobs`);
  // no app: no connect.json, the job still finishes
  const quiet = jobId((await toolCall('relay_start', { task: 'quiet', cwd: s.project })).text);
  assert.match((await toolCall('relay_wait', { job_ids: [quiet], timeout_sec: 30 })).text, /DONE/);

  // the real app server: the runner's POST becomes shell.notify with title, account and outcome
  const notes = [];
  const { createServer } = require(`${SRC}/server`);
  const srv = await createServer({ shell: { notify: (n) => notes.push(n) } });
  try {
    const id = jobId((await toolCall('relay_start', { task: 'tell me', cwd: s.project, title: 'Notify me' })).text);
    assert.match((await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 })).text, /DONE/);
    const n = await until(() => notes.find((x) => x.kind === 'job' && x.id === id));
    assert.equal(n.title, 'Notify me');
    assert.equal(n.account, 'w1@x.com');
    assert.equal(n.ok, true);
    assert.equal(n.project, 'project');
    const { port } = JSON.parse(fs.readFileSync(path.join(process.env.RELAY_HOME, 'connect.json'), 'utf8'));
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/job', method: 'POST', headers: { 'x-relay-token': 'wrong' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end('{}');
    });
    assert.equal(status, 403, 'only Relay\'s own processes may notify');
    assert.equal(await jobs.notifyFinished({ id: 'x', state: 'failed' }), true);
  } finally {
    srv.close?.();
    srv.server?.close?.();
  }
});
