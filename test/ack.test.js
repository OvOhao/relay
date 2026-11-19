'use strict';
// relay_ack: the leader records that it resolved a job's flags. Acked flags leave the "Needs action" line and the
// panel's warning badge but stay visible, marked resolved, in relay_poll and relay_status; a flag raised again by a
// later segment is not covered; worker sessions cannot ack.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ack-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'),
    RELAY_HUB: path.join(root, 'hub'),
    FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan),
    RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05',
    RELAY_SLACK: '0',
  });
  for (const k of ['RELAY_TAKEOVER', 'CLAUDE_CODE_USER_EMAIL', 'FAKE_DELAY_MS', 'FAKE_REPORT', 'FAKE_TOOLS', 'FAKE_WRITE']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save([['lead', { desktop: true }], ['w1']].map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 0 });
  const jobs = require(`${SRC}/core/jobs`);
  fs.mkdirSync(jobs.dir(), { recursive: true });
  const now = Date.now();
  const rec = (id, extra) => fs.writeFileSync(jobs.jobFile(id), JSON.stringify({ id, cwd: project, project: 'project', title: `job ${id}`, createdAt: now - 1000, finishedAt: now, request: { task: 'x', thread: 't' }, report: 'r', ...extra }));
  return { root, project, jobs, rec, now };
}
const memory = () => require(`${SRC}/core/memory`);
const workers = () => require(`${SRC}/core/workers`);

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

test('relay_ack: acked flags leave Needs action but stay visible, marked resolved; recorded in the job and the ledger', async () => {
  const { project, jobs, rec } = sandbox();
  rec('ack1-1', { state: 'done', flags: ['CHECKS_FAILED', 'PROTECTED PATH CHANGED'], concurrentProtected: 2 });
  rec('ack1-2', { state: 'failed', code: 'guard_violation', flags: [] });
  const reason = 'false positive: concurrent changes by other jobs, see job k3x9p2q1-4f7a';

  const r = await toolCall('relay_ack', { job_ids: ['ack1-1'], resolution: reason }, { ...process.env, CLAUDE_CODE_USER_EMAIL: 'lead@x.com' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Job ack1-1 "job ack1-1": resolved CHECKS_FAILED, PROTECTED PATH CHANGED, 2 in protected paths \(by lead@x\.com\)\. Nothing left to act on\./);

  const job = jobs.read('ack1-1');
  assert.equal(job.acks.length, 1);
  assert.equal(job.acks[0].by, 'lead@x.com');
  assert.equal(job.acks[0].resolution, reason);
  assert.deepEqual(job.acks[0].flags, ['CHECKS_FAILED', 'PROTECTED PATH CHANGED', '2 in protected paths']);
  assert.deepEqual(jobs.needsAction(job), []);
  assert.deepEqual(job.flags, ['CHECKS_FAILED', 'PROTECTED PATH CHANGED'], 'the flags themselves stay');

  // relay_poll: the other job still needs action; the acked one is shown, marked resolved
  const poll = jobs.poll({ job_ids: ['ack1-1', 'ack1-2'] });
  assert.match(poll.text.split('\n')[0], /^Needs action: ack1-2 "job ack1-2": guard_violation\./);
  assert.ok(!poll.text.split('\n')[0].includes('ack1-1'));
  assert.match(poll.text, /## Job ack1-1 · DONE · CHECKS_FAILED \(resolved\) · PROTECTED PATH CHANGED \(resolved\)/);
  assert.ok(poll.text.includes(`CHECKS_FAILED: resolved: ${reason} (relay_ack by lead@x.com,`));
  assert.ok(poll.text.includes('2 in protected paths: resolved: '));
  assert.ok(!jobs.poll({ job_ids: ['ack1-1'] }).text.includes('Needs action'), 'nothing open: no line');

  // relay_status: no Needs action for it; "Flagged jobs" lists it with a resolved marker
  const status = workers().statusText(project);
  assert.ok(!/^Needs action: .*ack1-1/.test(status.split('\n')[0]), status.split('\n')[0]);
  assert.match(status.split('\n')[0], /^Needs action: ack1-2 /);
  const line = status.split('\n').find((l) => l.includes('ack1-1 "job ack1-1"'));
  assert.match(line, /done, CHECKS_FAILED \(resolved: false positive: concurrent changes.*\), PROTECTED PATH CHANGED \(resolved: .*\[resolved\]$/);

  // ledger: an append-only entry; not a run in the panel's Recent list; readable for the leader and workers
  const entry = memory().readLedger(project).find((e) => e.kind === 'ack');
  assert.equal(entry.jobId, 'ack1-1');
  assert.equal(entry.account, 'lead@x.com');
  assert.deepEqual(entry.ackFlags, ['CHECKS_FAILED', 'PROTECTED PATH CHANGED', '2 in protected paths']);
  assert.match(memory().ledgerText(project), /flags resolved by the leader \(relay_ack\) · lead@x\.com\nTask: Flags resolved on job ack1-1 "job ack1-1"\nResult: RESOLVED CHECKS_FAILED, PROTECTED PATH CHANGED, 2 in protected paths: false positive/);
  assert.ok(!memory().recentRuns().some((x) => /Flags resolved/.test(x.title)));

  // nothing open any more: a second ack without flags says so; naming a flag records a new resolution (append-only)
  const again = jobs.ack({ job_ids: ['ack1-1'], resolution: 'again' }, { env: {} });
  assert.equal(again.isError, true);
  assert.match(again.text, /nothing open to acknowledge \(already resolved: CHECKS_FAILED \(resolved: false positive/);
  const named = jobs.ack({ job_ids: ['ack1-1'], resolution: 'real cause found: see job x', flags: ['checks_failed'] }, { env: { CLAUDE_CODE_USER_EMAIL: 'lead@x.com' } });
  assert.ok(!named.isError, named.text);
  const after = jobs.read('ack1-1');
  assert.equal(after.acks.length, 2);
  assert.equal(after.acks[0].resolution, reason, 'earlier acks are kept');
  assert.equal(jobs.ackOf(after, 'CHECKS_FAILED').resolution, 'real cause found: see job x');
  assert.equal(jobs.ackOf(after, 'PROTECTED PATH CHANGED').resolution, reason);
});

test('relay_ack: only the named flags; unknown flags and missing resolution refused; the protected-paths alias', () => {
  const { jobs, rec } = sandbox();
  rec('ack2-1', { state: 'done', flags: ['CHECKS_INCOMPLETE', 'OUTPUT_NOT_SAVED'], concurrentProtected: 3 });
  const env = { CLAUDE_CODE_USER_EMAIL: 'lead@x.com' };

  const noReason = jobs.ack({ job_ids: ['ack2-1'], resolution: '  ' }, { env });
  assert.equal(noReason.isError, true);
  assert.match(noReason.text, /needs a resolution/);
  assert.equal(jobs.ack({ resolution: 'x' }, { env }).isError, true);

  const unknown = jobs.ack({ job_ids: ['ack2-1'], resolution: 'x', flags: ['ISOLATION BREACH'] }, { env });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /no flag "ISOLATION BREACH" on this job \(its flags: CHECKS_INCOMPLETE, OUTPUT_NOT_SAVED, 3 in protected paths\)/);
  assert.equal(jobs.read('ack2-1').acks, undefined, 'nothing recorded');

  const some = jobs.ack({ job_ids: ['ack2-1', 'nope-1'], resolution: 'checked by hand', flags: ['checks incomplete', 'in protected paths'] }, { env });
  assert.ok(!some.isError, 'one of two worked');
  assert.match(some.text, /resolved CHECKS_INCOMPLETE, 3 in protected paths .*Still needs action: OUTPUT_NOT_SAVED\./);
  assert.match(some.text, /Job nope-1: no such job/);
  assert.deepEqual(jobs.needsAction(jobs.read('ack2-1')), ['OUTPUT_NOT_SAVED']);
  assert.match(jobs.needsActionLine([jobs.read('ack2-1')]), /^Needs action: ack2-1 "job ack2-1": OUTPUT_NOT_SAVED\./);
});

test('relay_ack: a Relay worker session (RELAY_TAKEOVER set) is refused, also through the tool call', async () => {
  const { jobs, rec } = sandbox();
  rec('ack3-1', { state: 'done', flags: ['CHECKS_FAILED'] });
  const direct = jobs.ack({ job_ids: ['ack3-1'], resolution: 'mine is fine' }, { env: { RELAY_TAKEOVER: '1' } });
  assert.equal(direct.isError, true);
  assert.match(direct.text, /refused: this is a Relay worker session/);
  const viaTool = await toolCall('relay_ack', { job_ids: ['ack3-1'], resolution: 'mine is fine' }, { ...process.env, RELAY_TAKEOVER: '1' });
  assert.equal(viaTool.isError, true);
  assert.equal(jobs.read('ack3-1').acks, undefined);
  assert.deepEqual(jobs.needsAction(jobs.read('ack3-1')), ['CHECKS_FAILED']);
  assert.equal(memory().readLedger(jobs.read('ack3-1').cwd).filter((e) => e.kind === 'ack').length, 0);
});

test('relay_ack: the same flag raised again by a later segment or wake needs action again; other acked flags stay resolved', () => {
  const { jobs, rec, now } = sandbox();
  // segment 1 raised CHECKS_FAILED and OUTPUT_NOT_SAVED (withMeta stamps when)
  rec('ack4-1', { state: 'parked', flags: [] });
  let cur = jobs.withMeta(jobs.read('ack4-1'), { meta: { flags: ['CHECKS_FAILED', 'OUTPUT_NOT_SAVED'] } }, now - 5000);
  fs.writeFileSync(jobs.jobFile('ack4-1'), JSON.stringify(cur));
  const a = jobs.ack({ job_ids: ['ack4-1'], resolution: 'flaky check, re-ran it by hand: passes' }, { env: { CLAUDE_CODE_USER_EMAIL: 'lead@x.com' }, now: now - 4000 });
  assert.ok(!a.isError, a.text);
  assert.deepEqual(jobs.needsAction(jobs.read('ack4-1')), []);
  // a wake raises CHECKS_FAILED again (and concurrent changes in protected paths)
  cur = jobs.withMeta(jobs.read('ack4-1'), { meta: { flags: ['CHECKS_FAILED'], concurrentProtected: 1 } }, now - 1000);
  assert.deepEqual(cur.flags, ['CHECKS_FAILED', 'OUTPUT_NOT_SAVED']);
  assert.deepEqual(jobs.needsAction(cur), ['CHECKS_FAILED', '1 in protected paths']);
  assert.ok(jobs.ackOf(cur, 'OUTPUT_NOT_SAVED'), 'not raised again: still resolved');
  fs.writeFileSync(jobs.jobFile('ack4-1'), JSON.stringify({ ...cur, state: 'done' }));
  assert.match(jobs.poll({ job_ids: ['ack4-1'] }).text, /^Needs action: ack4-1 "job ack4-1": CHECKS_FAILED, 1 in protected paths\./);
  assert.match(jobs.poll({ job_ids: ['ack4-1'] }).text, /## Job ack4-1 · DONE · CHECKS_FAILED · OUTPUT_NOT_SAVED \(resolved\)/);
  // a code-only item (guard_violation) raised by a segment is stamped too
  const g = jobs.withMeta({ id: 'x', flags: [] }, { code: 'guard_violation' }, 123);
  assert.deepEqual(g.flagAt, { guard_violation: 123 });
  // a record from before acks existed (no flagAt): any ack covers its flags
  rec('ack4-2', { state: 'done', flags: ['CHECKS_FAILED'] });
  jobs.ack({ job_ids: ['ack4-2'], resolution: 'old one, checked' }, { env: {} });
  assert.deepEqual(jobs.needsAction(jobs.read('ack4-2')), []);
  assert.match(jobs.read('ack4-2').acks[0].by, /^the leader window|last window seen/);
});

test('ledger entries of a background job carry its id; the panel list keeps flags and skips acks', async () => {
  const { project } = sandbox({ w1: ['ok'] });
  const out = await workers().runWorker({ task: 'do it', cwd: project, jobId: 'abcd-1234' });
  assert.ok(out.ok, out.text);
  const e = memory().readLedger(project).at(-1);
  assert.equal(e.jobId, 'abcd-1234');
  memory().appendLedger(project, { title: 'flagged run', ok: true, flags: ['CHECKS_FAILED'], jobId: 'abcd-1234' });
  memory().appendLedger(project, { kind: 'ack', title: 'Flags resolved on job abcd-1234', ok: true, jobId: 'abcd-1234' });
  const recent = memory().recentRuns();
  assert.equal(recent[0].title, 'flagged run');
  assert.deepEqual(recent[0].flags, ['CHECKS_FAILED']);
  assert.equal(recent[0].jobId, 'abcd-1234');
  assert.ok(!recent.some((r) => /Flags resolved/.test(r.title)));
});
