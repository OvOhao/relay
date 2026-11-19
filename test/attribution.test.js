'use strict';
// Which changes in a shared folder are a job's own: several jobs (from other conversations) write in one project folder
// at the same time, and the before / after snapshot of the folder holds all of their changes. A job's own changes are
// those inside its scope (scope, write_paths, output_file's folder) or to files its own edit tool calls named; the
// rest are concurrent changes by others: not its files, not given to its post checks, not its violations.
// Driven with the fake Claude CLI: two background jobs at once in one folder, each with its own FAKE_WRITE.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox({ git = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-attr-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'),
    RELAY_HUB: path.join(root, 'hub'),
    FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify({}),
    RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_CODEX_CMD: JSON.stringify([process.execPath, FAKE_CODEX]),
    RELAY_TICK: '0.05',
    RELAY_SLACK: '0',
    RELAY_SHARE_SAMPLE_MS: '100',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT', 'FAKE_TOOLS', 'FAKE_WRITE', 'FAKE_CODEX_DELAY_MS', 'FAKE_CODEX_NO_ROLLOUT', 'RELAY_TEST_LS_FILES_FAIL']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  // the git repository's top is one level above the job folder, as in a typical research-repository setup
  const repo = path.join(root, 'repo');
  const project = path.join(repo, 'proj');
  const write = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); fs.writeFileSync(path.join(project, rel), text); };
  write('ideas/a/plan.md', 'plan a');
  write('ideas/b/plan.md', 'plan b');
  write('plans/frozen.md', 'frozen');
  write('src/app.js', 'app');
  if (git) {
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init']);
  }
  const store = require(`${SRC}/core/store`);
  store.save([['lead', { desktop: true }], ['w1'], ['w2'], ['cx1', { provider: 'codex' }]].map(([n, extra = {}]) => {
    const codex = extra.provider === 'codex';
    const dir = path.join(root, 'home', codex ? 'codex' : 'accounts', n);
    if (codex) fs.mkdirSync(dir, { recursive: true });
    return { ...store.newAccount(n, dir, codex ? '' : `${n}@x.com`), ...(codex ? { model: 'gpt-test' } : {}), ...extra };
  }));
  store.saveSettings({ jobsPerWorker: 3 });
  const config = (obj) => { fs.mkdirSync(path.join(project, '.relay'), { recursive: true }); fs.writeFileSync(path.join(project, '.relay', 'project.json'), JSON.stringify(obj)); };
  return { root, repo, project, store, config, write };
}

// A tool call in its own process with its own environment (each fake worker writes what its job's FAKE_WRITE says).
function toolCall(name, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SRC, 'tool-call.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
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
const jobId = (text) => text.match(/Started job ([a-z0-9-]+)/)[1];
const jobs = () => require(`${SRC}/core/jobs`);
const memory = () => require(`${SRC}/core/memory`);
const P = () => require(`${SRC}/core/project`);
const show = (r) => JSON.stringify(r && { state: r.state, code: r.code, lastLine: r.lastLine, report: r.report, error: r.error });

// Starts the jobs at once (each fake worker waits, writes, waits, reports: their runs overlap), waits for all of them.
async function together(s, specs) {
  const ids = await Promise.all(specs.map(({ args, env }) => toolCall('relay_start', { cwd: s.project, ...args }, { FAKE_DELAY_MS: '1500', ...env }).then((r) => jobId(r.text))));
  const w = await toolCall('relay_wait', { job_ids: ids, timeout_sec: 60, mode: 'all' });
  return { ids, text: w.text, rec: ids.map((id) => jobs().read(id)) };
}

test('helpers: own area from scope / write_paths / output_file, own edit calls, git status paths from the repository top', () => {
  const p = P();
  const cwd = '/x/proj';
  assert.equal(p.ownArea({ cwd }), null, 'no scope: no area (the whole folder is the job\'s)');
  const area = p.ownArea({ cwd, scopes: ['/x/proj/ideas/a'], writePaths: ['notes/*.md'], outputFile: 'reviews/r.md' });
  assert.ok(p.inArea(area, '/x/proj/ideas/a/x/y.md'));
  assert.ok(p.inArea(area, '/x/proj/notes/n.md'));
  assert.ok(p.inArea(area, '/x/proj/reviews/other.md'), 'the output_file\'s folder');
  assert.ok(!p.inArea(area, '/x/proj/ideas/ab/x.md'));
  assert.ok(!p.inArea(area, '/x/proj/notes/deep/n.md'));
  const top = p.ownArea({ cwd, outputFile: 'REPORT.md' });
  assert.ok(p.inArea(top, '/x/proj/REPORT.md') && !p.inArea(top, '/x/proj/other.md'), 'an output_file in cwd adds only itself');
  const own = p.ownEditedFiles([
    { name: 'Edit', input: { file_path: '/x/proj/src/a.js' } }, { name: 'Write', input: { file_path: 'src/b.js' } },
    { name: 'NotebookEdit', input: { notebook_path: '/x/proj/n.ipynb' } }, { name: 'Edit', input: { file_path: '/x/proj/refused.js' }, error: true },
    { name: 'Bash', input: { command: 'touch /x/proj/sh.js' } },
  ], { cwd });
  assert.deepEqual([...own].sort(), ['/x/proj/n.ipynb', '/x/proj/src/a.js', '/x/proj/src/b.js']);
  const { mine, others } = p.attributeChanges([{ abs: '/x/proj/src/a.js' }, { abs: '/x/proj/ideas/a/1' }, { abs: '/x/proj/ideas/b/2' }], { area, own });
  assert.deepEqual(mine.map((c) => c.abs), ['/x/proj/src/a.js', '/x/proj/ideas/a/1']);
  assert.deepEqual(others.map((c) => c.abs), ['/x/proj/ideas/b/2']);
  assert.equal(p.attributeChanges(others, { area: null }).mine.length, 1, 'no area: everything is the job\'s');
  // a worker reports paths under the real path of a symlinked cwd
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-attr-link-')));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  assert.equal(p.cwdForm(link, path.join(real, 'a', 'b.js')), path.join(link, 'a', 'b.js'));
  fs.rmSync(link);
});

test('two jobs at once in one folder, disjoint scopes: each sees only its own files, post checks run only on its own, no false violations', async () => {
  const s = sandbox({ git: true });
  s.config({
    require_scope: true,
    protected_paths: ['plans/**'],
    post_checks: [
      { name: 'audit numbers', cmd: '{each:ideas/*/notes/*.md} echo audit {file} --idea {idea}' },
      { name: 'changed', cmd: 'echo CHANGED: {changed_files}' },
    ],
  });
  const { ids, rec } = await together(s, [
    { args: { task: 'notes for a', scope: ['ideas/a'], thread: 'ta' }, env: { FAKE_WRITE: 'ideas/a/notes/x.md' } },
    { args: { task: 'notes for b', scope: ['ideas/b'], thread: 'tb' }, env: { FAKE_WRITE: 'ideas/b/notes/y.md' } },
  ]);
  const [a, b] = rec;
  for (const [r, mineRel, theirsRel, idea] of [[a, 'ideas/a/notes/x.md', 'ideas/b/notes/y.md', 'a'], [b, 'ideas/b/notes/y.md', 'ideas/a/notes/x.md', 'b']]) {
    assert.equal(r.state, 'done', show(r));
    assert.deepEqual(r.flags || [], [], `no flags: ${r.report}`);
    const audits = r.checks.filter((c) => c.name === 'audit numbers');
    assert.deepEqual(audits.map((c) => c.file), [mineRel], 'the audit ran on its own file only');
    assert.match(audits[0].tail, new RegExp(`--idea ${idea}$`));
    const changed = r.checks.find((c) => c.name === 'changed').tail;
    assert.equal(changed, `CHANGED: ${mineRel}`);
    assert.ok(!r.report.includes(`audit ${theirsRel}`));
    // files touched: its own git status line (an untracked folder), never the other job's
    assert.ok(r.files.some((f) => f.includes(`ideas/${idea}/notes`)), JSON.stringify(r.files));
    assert.ok(!r.files.some((f) => f.includes(theirsRel.split('/').slice(0, 2).join('/'))), JSON.stringify(r.files));
    // the other job's change is counted once, as a concurrent change, and kept apart in the record
    assert.equal(r.concurrentChanges, 1);
    assert.deepEqual(r.concurrentSample, [theirsRel]);
    assert.match(r.report, /Note: concurrent changes elsewhere in the folder: 1 file \(not attributed: outside this job's scope and not edited by its own tool calls; other jobs ran here at the same time: "t[ab]"\)/);
  }
  const ledger = memory().readLedger(s.project);
  for (const t of ['ta', 'tb']) {
    const e = ledger.filter((x) => x.thread === t).at(-1);
    assert.equal(e.concurrentChanges, 1);
    assert.ok(!e.files.some((f) => f.includes(t === 'ta' ? 'ideas/b' : 'ideas/a')));
  }
  assert.match(memory().ledgerText(s.project), /Concurrent changes by other jobs \(not attributed to this one\): 1 file/);
  assert.equal(ids.length, 2);
});

test('a job that edits outside its write_paths with its own Edit call still fails; a concurrent job\'s change is not blamed on it', async () => {
  const s = sandbox();
  const { rec } = await together(s, [
    {
      args: { task: 'notes', write_paths: ['notes'], thread: 'wp' },
      env: { FAKE_WRITE: 'notes/n.md,src/own.js', FAKE_TOOLS: JSON.stringify([{ name: 'Edit', input: { file_path: 'src/own.js' } }]) },
    },
    { args: { task: 'other', scope: ['ideas/b'], thread: 'other' }, env: { FAKE_WRITE: 'ideas/b/z.md' } },
  ]);
  const [wp, other] = rec;
  assert.equal(wp.code, 'write_violation', show(wp));
  assert.deepEqual(wp.violations.map((v) => v.path), ['src/own.js'], 'only its own edit, not ideas/b/z.md');
  assert.match(wp.report, /files changed outside write_paths \(notes\): src\/own\.js \(added\)\./);
  assert.match(wp.report, /only changes inside this job's scope or to files its own edit tool calls named were counted/);
  assert.equal(wp.concurrentChanges, 1);
  assert.equal(other.state, 'done', show(other));
  assert.deepEqual(other.flags || [], []);
});

test('a protected path changed by another job is not attributed; the job that changed it inside its scope fails', async () => {
  const s = sandbox();
  s.config({ protected_paths: ['plans/**'], post_checks: [{ name: 'changed', cmd: 'echo CHANGED: {changed_files}' }] });
  const { rec } = await together(s, [
    { args: { task: 'notes for a', scope: ['ideas/a'], thread: 'ta' }, env: { FAKE_WRITE: 'ideas/a/x.md' } },
    { args: { task: 'touch plans', scope: ['plans'], thread: 'tp' }, env: { FAKE_WRITE: 'plans/frozen.md' } },
  ]);
  const [a, p] = rec;
  assert.equal(a.state, 'done', show(a));
  assert.deepEqual(a.flags || [], [], a.report);
  assert.match(a.report, /concurrent changes elsewhere in the folder: 1 file \(not attributed: .*; 1 in protected paths;/);
  assert.equal(a.checks[0].tail, 'CHANGED: ideas/a/x.md');
  assert.equal(p.code, 'protected_changed', show(p));
  assert.deepEqual(p.violations.map((v) => v.path), ['plans/frozen.md']);
});

test('a read-only job (no scope) runs no post checks and says other jobs ran in the folder at the same time', async () => {
  const s = sandbox();
  s.config({ post_checks: [{ name: 'changed', cmd: 'echo CHANGED: {changed_files}' }] });
  const { rec } = await together(s, [
    { args: { task: 'review', read_only: true, thread: 'ro' }, env: {} },
    { args: { task: 'notes for a', scope: ['ideas/a'], thread: 'ta' }, env: { FAKE_WRITE: 'ideas/a/x.md' } },
  ]);
  const [ro, a] = rec;
  assert.equal(ro.state, 'done', show(ro));
  assert.match(ro.report, /Note: other jobs ran in this folder at the same time \("ta"\)\. This job has no scope, so the changed files listed here may include theirs\./);
  assert.equal(ro.checks, undefined, 'a read-only job changes nothing: no post checks');
  assert.match(ro.report, /Post checks: not run \(a read-only job changes no files; with output_file they run on that file\)\./);
  assert.ok(!/## Relay checks/.test(ro.report));
  assert.equal(a.checks[0].tail, 'CHANGED: ideas/a/x.md', 'the writing job\'s own checks still run');
  assert.deepEqual(ro.sharedWith, ['ta']);
  assert.equal(ro.concurrentChanges, undefined);
  // the read-only job writes nothing, so it does not count as sharing for the writing job
  assert.equal(a.state, 'done', show(a));
  assert.equal(a.sharedWith, undefined);
  assert.ok(!/concurrent changes elsewhere/.test(a.report));
});

// ---- the read-only guard of Codex jobs ----
// A Codex review takes a while (FAKE_CODEX_DELAY_MS); a Claude job with a scope writes in the same folder meanwhile.
const review = (env = {}) => ({ args: { task: 'review', agent: 'codex', read_only: true, thread: 'cx' }, env: { FAKE_CODEX_DELAY_MS: '4500', ...env } });
const writer = { args: { task: 'notes for a', scope: ['ideas/a'], thread: 'ta' }, env: { FAKE_WRITE: 'ideas/a/x.md' } };

test('codex guard: another job writing in the folder while the verified read-only review runs is a note, not a failure', async () => {
  const s = sandbox({ git: true });
  const { rec } = await together(s, [review(), writer]);
  const [cx, a] = rec;
  assert.equal(cx.state, 'done', show(cx));
  assert.deepEqual(cx.flags || [], []);
  assert.match(cx.report, /Note: concurrent changes elsewhere in the folder: 1 \(not attributed: the Codex session ran under the read-only profile on every turn \(verified: profile "relay-review".*\), and other jobs ran here at the same time: "ta"\)\. The read-only guard did not fail this job for them/);
  assert.match(cx.report, /Read-only guard: passed: the folder changed only by other jobs running here at the same time \(1; this session verified read-only\)/);
  assert.equal(cx.concurrentChanges, 1);
  assert.deepEqual(cx.concurrentSample, ['added ideas/a/x.md']);
  assert.deepEqual(cx.sharedWith, ['ta']);
  assert.ok(!(cx.files || []).some((f) => f.includes('ideas/a')), `not its files: ${JSON.stringify(cx.files)}`);
  assert.equal(a.state, 'done', show(a));
  assert.equal(a.sharedWith, undefined, 'a read-only review does not count as a writer for the other job');
});

test('codex guard: a folder change with no other job running still fails the review', async () => {
  const s = sandbox();
  const { rec } = await together(s, [review({ FAKE_PLAN: JSON.stringify({ cx1: ['write'] }), FAKE_CODEX_DELAY_MS: '0' })]);
  assert.equal(rec[0].code, 'guard_violation', show(rec[0]));
  assert.match(rec[0].report, /FAILED the read-only guard: the job folder changed during a read-only Codex job: added codex-wrote\.txt/);
});

test('codex guard: an unverifiable session profile, or a Codex file-change event, fails it even with another job writing at the same time', async () => {
  const s = sandbox();
  const nr = await together(s, [review({ FAKE_CODEX_NO_ROLLOUT: '1' }), writer]);
  assert.equal(nr.rec[0].code, 'guard_violation', show(nr.rec[0]));
  assert.match(nr.rec[0].report, /added ideas\/a\/x\.md \(other jobs ran here at the same time, but the session's read-only profile could not be verified: session rollout file not found\)/);
  assert.equal(nr.rec[1].state, 'done', show(nr.rec[1]));

  fs.rmSync(path.join(s.project, 'ideas/a/x.md'));
  const fc = await together(s, [review({ FAKE_PLAN: JSON.stringify({ cx1: ['filechange'] }) }), { ...writer, args: { ...writer.args, thread: 'tb' } }]);
  assert.equal(fc.rec[0].code, 'guard_violation', show(fc.rec[0]));
  assert.match(fc.rec[0].report, /the worker changed files itself \(Codex file changes\): .*codex-wrote\.txt/);
});

// ---- which files post checks get, and their time cap ----

test('read-only jobs with output_file (Claude and Codex) check only that file; a Codex review without it runs none', async () => {
  const s = sandbox();
  s.config({ post_checks: [{ name: 'changed', cmd: 'echo CHANGED: {changed_files}' }] });
  const { rec } = await together(s, [
    { args: { task: 'review', read_only: true, thread: 'ro', output_file: 'reviews/ro.md' }, env: { FAKE_DELAY_MS: '1500' } },
    { args: { task: 'review', agent: 'codex', read_only: true, thread: 'cxo', output_file: 'reviews/cx.md' }, env: { FAKE_CODEX_DELAY_MS: '4500' } },
    review(),
    writer,
  ]);
  const [ro, cxo, cx] = rec;
  assert.equal(ro.state, 'done', show(ro));
  assert.deepEqual(ro.checks.map((c) => c.tail), ['CHANGED: reviews/ro.md'], 'only its report file, not ideas/a/x.md');
  assert.equal(cxo.state, 'done', show(cxo));
  assert.deepEqual(cxo.checks.map((c) => c.tail), ['CHANGED: reviews/cx.md']);
  assert.equal(cx.state, 'done', show(cx));
  assert.equal(cx.checks, undefined);
  assert.match(cx.report, /Post checks: not run \(a read-only job changes no files/);
  assert.match(cx.report, /Read-only guard: passed/, 'the guard still runs');
});

test('a writing job without scope while other jobs write in the folder: post checks only on files its own edit calls named', async () => {
  const s = sandbox();
  s.config({ post_checks: [{ name: 'changed', cmd: 'echo CHANGED: {changed_files}' }] });
  const { rec } = await together(s, [
    { args: { task: 'edit', thread: 'free' }, env: { FAKE_WRITE: 'mine.md,shell.md', FAKE_TOOLS: JSON.stringify([{ name: 'Write', input: { file_path: 'mine.md' } }]) } },
    writer,
  ]);
  const [free] = rec;
  assert.equal(free.state, 'done', show(free));
  assert.deepEqual(free.checks.map((c) => c.tail), ['CHANGED: mine.md'], 'not the shell-made shell.md, not the other job\'s ideas/a/x.md');
  assert.match(free.report, /This job has no scope, so the changed files listed here may include theirs\. Its post checks ran only on the 1 file its own edit tool calls named; 2 other changed files in the folder were not checked \(not attributed to it\)\./);
  assert.deepEqual(free.flags || [], []);

  // alone in the folder: every change is still checked, as before
  const alone = await together(s, [{ args: { task: 'edit', thread: 'alone' }, env: { FAKE_WRITE: 'shell2.md' } }]);
  assert.deepEqual(alone.rec[0].checks.map((c) => c.tail), ['CHANGED: shell2.md']);
});

test('post checks time cap (postChecksMaxSec): the check it cuts is stopped, the rest are not run, the job is CHECKS_INCOMPLETE', async () => {
  const s = sandbox();
  s.store.saveSettings({ postChecksMaxSec: 1.5 });
  s.config({ post_checks: [{ name: 'quick', cmd: 'echo ok' }, { name: 'long', cmd: 'echo started; sleep 20' }, { name: 'after', cmd: 'echo never' }, { name: 'per idea', cmd: '{each:ideas/**} echo {idea}' }] });
  process.env.FAKE_WRITE = 'ideas/a/x.md';
  const t0 = Date.now();
  const r = await require(`${SRC}/core/workers`).runWorker({ task: 'x', cwd: s.project, scope: ['ideas/a'] });
  delete process.env.FAKE_WRITE;
  assert.ok(Date.now() - t0 < 12000, 'the cap stopped the long check');
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(r.meta.flags, ['CHECKS_INCOMPLETE'], 'not CHECKS_FAILED');
  assert.deepEqual(r.meta.checks.map((c) => [c.name, !!c.capped, !!c.notRun, c.ok]), [['quick', false, false, true], ['long', true, false, true], ['after', true, true, true], ['per idea', true, true, true]]);
  assert.match(r.text, /- passed: quick/);
  assert.match(r.text, /- stopped \(time cap, after \d+ s\): long/);
  assert.match(r.text, /- not run \(time cap\): after/);
  assert.match(r.text, /- not run \(time cap\): per idea \(a\)/);
  assert.match(r.text, /Post checks hit Relay's time cap \(postChecksMaxSec, 1\.5 s for all of a job's checks\): 1 stopped, 2 not run\. The job is flagged CHECKS_INCOMPLETE \(not CHECKS_FAILED\)/);
  assert.equal(s.store.postChecksMaxSec({}), 900, 'default');
});

// ---- when the folder's file list cannot be made the same way before and after the job ----
// The fake worker creates the flag file (outside the job folder) during its run: from then on `git ls-files` fails,
// so the after side would be a walk while the before side was git.

test('an unverifiable folder comparison: no flood of changes; write_paths and protected checks use the job\'s own edit calls and say so', async () => {
  const s = sandbox({ git: true });
  s.config({ protected_paths: ['plans/**'], post_checks: [{ name: 'changed', cmd: 'echo CHANGED: {changed_files}' }] });
  process.env.RELAY_TEST_LS_FILES_FAIL = path.join(s.repo, 'lsfail');
  process.env.FAKE_WRITE = '../lsfail,notes/n.md,src/own.js,src/shell.js';
  process.env.FAKE_TOOLS = JSON.stringify([{ name: 'Edit', input: { file_path: 'src/own.js' } }, { name: 'Write', input: { file_path: 'notes/n.md' } }]);
  const r = await require(`${SRC}/core/workers`).runWorker({ task: 'notes', cwd: s.project, writePaths: ['notes'] });
  delete process.env.FAKE_WRITE;
  delete process.env.FAKE_TOOLS;
  assert.equal(r.code, 'write_violation', r.text);
  assert.deepEqual(r.meta.violations.map((v) => v.path), ['src/own.js'], 'its own Edit outside write_paths; nothing else listed');
  assert.match(r.text, /Note: the folder comparison is UNVERIFIABLE \(before the job: git ls-files; after it: git ls-files failed \(exit 128: simulated git ls-files failure \(test\)/);
  assert.match(r.text, /Protected-path and write_paths checks and the post checks used only the 2 files this job's own edit tool calls named; changes made by shell commands could not be checked\./);
  assert.equal(r.meta.folderCompare.status, 'unverifiable');
  assert.ok(r.meta.folderLog.some((l) => /git ls-files failed in .*simulated/.test(l)), JSON.stringify(r.meta.folderLog));

  // a job that stays inside write_paths: done, its post checks on its own edited file only
  fs.rmSync(path.join(s.repo, 'lsfail'));
  process.env.FAKE_WRITE = '../lsfail,notes/m.md,src/shell2.js';
  process.env.FAKE_TOOLS = JSON.stringify([{ name: 'Write', input: { file_path: 'notes/m.md' } }]);
  const ok = await require(`${SRC}/core/workers`).runWorker({ task: 'notes', cwd: s.project, writePaths: ['notes'] });
  delete process.env.FAKE_WRITE;
  delete process.env.FAKE_TOOLS;
  assert.equal(ok.ok, true, ok.text);
  assert.deepEqual(ok.meta.checks.map((c) => c.tail), ['CHANGED: notes/m.md']);
  assert.match(ok.text, /the folder comparison is UNVERIFIABLE/);
  fs.rmSync(path.join(s.repo, 'lsfail'), { force: true });
});

test('codex guard with an unverifiable folder comparison: passes only on a verified session, and says so', async () => {
  const s = sandbox({ git: true });
  process.env.RELAY_TEST_LS_FILES_FAIL = path.join(s.repo, 'lsfail');
  const lsWriter = { ...writer, env: { FAKE_WRITE: 'ideas/a/x.md,../lsfail' } };
  const v = await together(s, [review(), lsWriter]);
  assert.equal(v.rec[0].state, 'done', show(v.rec[0]));
  assert.match(v.rec[0].report, /Read-only guard: UNVERIFIABLE folder comparison \(before the job: git ls-files; after it: git ls-files failed .*\); passed on the session check alone \(verified read-only on every turn, no file changes of its own\)/);
  assert.equal(v.rec[0].folderCompare.status, 'unverifiable');

  fs.rmSync(path.join(s.repo, 'lsfail'));
  const nr = review({ FAKE_CODEX_NO_ROLLOUT: '1' });
  const u = await together(s, [{ ...nr, args: { ...nr.args, thread: 'cx-new' } }, { ...lsWriter, args: { ...lsWriter.args, thread: 'tb' } }]);
  assert.equal(u.rec[0].code, 'guard_violation', show(u.rec[0]));
  assert.match(u.rec[0].report, /the folder comparison is UNVERIFIABLE \(.*\) and the session's read-only profile could not be verified either \(session rollout file not found\)/);
  fs.rmSync(path.join(s.repo, 'lsfail'), { force: true });
});
