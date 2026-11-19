'use strict';
// Fixes from a workflow review: require_scope refuses the whole folder, isolated_hide_paths, an output_file
// the worker wrote itself, post checks on more than 50 files and on unfinished jobs, and the "Needs action" line.
// Driven with the fake Claude CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan = {}, accounts = [['lead', { desktop: true }], ['w1']]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-flow-test-')));
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
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT_CHARS', 'FAKE_REPORT', 'FAKE_POSTSCRIPT', 'FAKE_TOOLS', 'FAKE_WRITE', 'FAKE_CODEX_PREFLIGHT', 'FAKE_CODEX_SIGNED_OUT']) delete process.env[k];
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
  const invocations = () => {
    const f = path.join(process.env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const config = (obj) => { fs.mkdirSync(path.join(project, '.relay'), { recursive: true }); fs.writeFileSync(path.join(project, '.relay', 'project.json'), JSON.stringify(obj)); };
  const write = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); fs.writeFileSync(path.join(project, rel), text); };
  return { root, project, store, invocations, last: () => invocations().at(-1), config, write };
}
const workers = () => require(`${SRC}/core/workers`);
const P = () => require(`${SRC}/core/project`);

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
const jobId = (text) => text.match(/Started job ([a-z0-9-]+)/)[1];


// ---- require_scope: ".", cwd itself and the git root are no scope ----

test('require_scope refuses ".", cwd itself and the git root as a scope entry, and asks for the specific folders', async () => {
  const s = sandbox({ w1: ['ok', 'ok', 'ok'] });
  fs.mkdirSync(path.join(s.project, '.git'));
  fs.mkdirSync(path.join(s.project, 'ideas', 'gamma'), { recursive: true });
  s.config({ require_scope: true });
  for (const scope of [['.'], ['./'], [s.project], ['ideas/gamma', '.'], '.']) {
    const r = await workers().runWorker({ task: 'audit everything', cwd: s.project, scope });
    assert.equal(r.code, 'bad_request', JSON.stringify(scope));
    assert.match(r.text, /is the whole folder \(cwd, the git root\), which names nothing\. List the specific folders/);
  }
  // with output_file or write_paths too: the "." scope is still refused
  const both = await workers().runWorker({ task: 'x', cwd: s.project, scope: ['.'], outputFile: 'out.md' });
  assert.equal(both.code, 'bad_request');
  const start = await toolCall('relay_start', { task: 'x', cwd: s.project, scope: ['.'] });
  assert.equal(start.isError, true);
  assert.match(start.text, /List the specific folders/);
  assert.equal(s.invocations().length, 0, 'nothing started');
  assert.equal((await workers().runWorker({ task: 'x', cwd: s.project, scope: ['ideas/gamma'] })).ok, true);
  // a subfolder of the git root as cwd: "." is that folder, refused the same way
  const sub = path.join(s.project, 'ideas');
  const r = await workers().runWorker({ task: 'x', cwd: sub, scope: ['.'] });
  assert.equal(r.code, 'bad_request');
  assert.match(r.text, /is the whole folder \(cwd\)/);
  // without require_scope "." still means the whole folder
  s.config({});
  assert.equal((await workers().runWorker({ task: 'x', cwd: s.project, scope: ['.'] })).ok, true);
});

// ---- isolated_hide_paths ----

test('isolated_hide_paths: added to hide_paths of every isolated job (not others); outside a sub-folder cwd only denied', async () => {
  const s = sandbox({ w1: ['ok', 'ok', 'ok', 'ok'] });
  fs.mkdirSync(path.join(s.project, '.git'));
  s.write('ideas/gamma/decisions.md', 'leader: submit to venue A');
  s.write('portfolio/report.md', 'portfolio');
  s.config({ isolated_hide_paths: ['portfolio/**', 'ideas/*/decisions.md'] });
  const iso = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, isolated: true, hidePaths: ['reviews'] });
  assert.equal(iso.ok, true, iso.text);
  const inv = s.last();
  assert.match(inv.prompt, /OFF-LIMITS for this job: reviews, portfolio\/\*\*, ideas\/\*\/decisions\.md/);
  const abs = (rel) => `/${path.join(s.project, rel)}`;
  for (const rule of [`Read(${abs('portfolio/**')})`, `Read(${abs('ideas/*/decisions.md')})`]) assert.ok(inv.disallowedTools.includes(rule), rule);
  assert.ok(inv.settings.sandbox.filesystem.denyRead.includes(path.join(s.project, 'ideas/gamma/decisions.md')));
  assert.deepEqual(iso.meta.hidePaths, ['reviews', 'portfolio/**', 'ideas/*/decisions.md']);
  // a breach on them is reported like any hidden path
  process.env.FAKE_TOOLS = JSON.stringify([{ name: 'Bash', input: { command: 'cat ideas/gamma/decisions.md' } }]);
  const breach = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, isolated: true });
  delete process.env.FAKE_TOOLS;
  assert.ok(breach.meta.flags.includes('ISOLATION BREACH'), breach.text);
  // a job that is not isolated: untouched
  const plain = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true });
  assert.ok(!/OFF-LIMITS/.test(s.last().prompt));
  assert.ok(!s.last().disallowedTools.some((r) => r.includes('decisions.md')));
  assert.equal(plain.ok, true);
  // an isolated job in a sub-folder: patterns under it are relative to it; those outside it are only denied
  const sub = path.join(s.project, 'ideas');
  const r = await workers().runWorker({ task: 'review', cwd: sub, readOnly: true, isolated: true });
  assert.equal(r.ok, true, r.text);
  assert.match(s.last().prompt, /OFF-LIMITS for this job: \*\/decisions\.md/);
  assert.ok(s.last().disallowedTools.includes(`Read(${abs('portfolio/**')})`));
  // a bad value is a config error
  s.config({ isolated_hide_paths: ['../x'] });
  assert.match((await workers().runWorker({ task: 'x', cwd: s.project, readOnly: true, isolated: true })).text, /isolated_hide_paths must stay inside/);
  s.config({ isolated_hide_paths: 'portfolio' });
  assert.match((await workers().runWorker({ task: 'x', cwd: s.project, readOnly: true, isolated: true })).text, /isolated_hide_paths must be a list/);
});

test('isolatedHideFor: patterns relative to the config root, seen from cwd', () => {
  const p = P();
  const config = { root: '/r', isolatedHide: ['portfolio/**', 'ideas/*/decisions.md', '**/state', 'ideas/gamma/reviews'] };
  assert.deepEqual(p.isolatedHideFor(config, '/r'), { inCwd: config.isolatedHide, outside: [] });
  assert.deepEqual(p.isolatedHideFor(config, '/r/ideas'), { inCwd: ['*/decisions.md', '**/state', 'gamma/reviews'], outside: ['portfolio/**', '**/state'] });
  assert.deepEqual(p.isolatedHideFor(config, '/r/ideas/gamma'), { inCwd: ['**/state', 'reviews'], outside: ['portfolio/**', 'ideas/*/decisions.md', '**/state'] });
  assert.equal(p.relayReportPath('reviews/g2.md'), 'reviews/g2.relay-report.md');
  assert.equal(p.relayReportPath('report'), 'report.relay-report.md');
});

// ---- output_file the worker wrote itself ----

test('output_file written by the job\'s own tool calls: the worker\'s file stays, Relay\'s report goes next to it; written by someone else: OUTPUT_NOT_SAVED', async () => {
  const s = sandbox({ w1: ['ok', 'ok'] });
  s.config({ post_checks: [{ name: 'audit', cmd: 'echo audited {file}{each:reviews/*.md}' }] });
  process.env.FAKE_WRITE = 'reviews/g2.md';
  process.env.FAKE_TOOLS = JSON.stringify([{ name: 'Write', input: { file_path: path.join(s.project, 'reviews/g2.md') } }]);
  process.env.FAKE_REPORT = 'REVIEW REPORT TEXT';
  const r = await workers().runWorker({ task: 'review', cwd: s.project, scope: ['reviews'], outputFile: 'reviews/g2.md' });
  assert.equal(r.ok, true, r.text);
  assert.ok(!r.meta.flags.includes('OUTPUT_NOT_SAVED'), r.text);
  assert.match(fs.readFileSync(path.join(s.project, 'reviews/g2.md'), 'utf8'), /written by the fake worker/, 'the worker\'s file stays');
  assert.equal(fs.readFileSync(path.join(s.project, 'reviews/g2.relay-report.md'), 'utf8'), 'REVIEW REPORT TEXT\n');
  assert.match(r.text, /the worker wrote reviews\/g2\.md itself \(its own tool calls\), so Relay kept that file and saved its report to reviews\/g2\.relay-report\.md/);
  assert.equal(r.meta.relayReport, 'reviews/g2.relay-report.md');
  assert.deepEqual(r.meta.checks.map((c) => c.file).sort(), ['reviews/g2.md', 'reviews/g2.relay-report.md'], 'both are checked');

  // the file appeared, but no tool call of the job wrote it (a shell command, another job): as before
  process.env.FAKE_WRITE = 'reviews/g3.md';
  delete process.env.FAKE_TOOLS;
  const other = await workers().runWorker({ task: 'review', cwd: s.project, scope: ['reviews'], outputFile: 'reviews/g3.md' });
  delete process.env.FAKE_WRITE;
  delete process.env.FAKE_REPORT;
  assert.ok(other.meta.flags.includes('OUTPUT_NOT_SAVED'), other.text);
  assert.match(other.text, /Report NOT saved to reviews\/g3\.md: the file already exists \(it appeared during the job\)/);
  assert.ok(!fs.existsSync(path.join(s.project, 'reviews/g3.relay-report.md')));
});

// ---- post checks: more than 50 files, unfinished jobs ----

test('post checks: more than 50 matching files is CHECKS_INCOMPLETE (not ok, not CHECKS_FAILED)', async () => {
  const s = sandbox({ w1: ['ok'] });
  s.config({ post_checks: [{ name: 'per file', cmd: 'true {file}{each:notes/*.md}' }] });
  process.env.FAKE_WRITE = Array.from({ length: 53 }, (_, i) => `notes/n${i}.md`).join(',');
  const r = await workers().runWorker({ task: 'write notes', cwd: s.project, scope: ['notes'] });
  delete process.env.FAKE_WRITE;
  assert.equal(r.ok, true);
  assert.deepEqual(r.meta.flags, ['CHECKS_INCOMPLETE']);
  const inc = r.meta.checks.find((c) => c.incomplete);
  assert.equal(inc.ok, false);
  assert.match(r.text, /NOT CHECKED \(too many files\): per file: 3 more matching files were not checked \(at most 50 per check\)/);
  assert.match(r.text, /flagged CHECKS_INCOMPLETE/);
});

test('post checks run on a failed or cancelled job\'s attributed changes too, and flag it', async () => {
  const s = sandbox({ w1: ['crash', 'ok'] });
  s.config({ post_checks: [{ name: 'lint', cmd: 'echo linting {changed_files}; exit 1', when: 'changed:src/**' }], protected_paths: ['runs/**'] });
  process.env.FAKE_WRITE = 'src/half.js';
  const failed = await workers().runWorker({ task: 'x', cwd: s.project, scope: ['src'] });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'failed');
  assert.deepEqual(failed.meta.flags, ['CHECKS_FAILED']);
  assert.match(failed.text, /Post checks on the 1 file this unfinished job changed:/);
  assert.match(failed.text, /FAILED: lint/);
  const memory = require(`${SRC}/core/memory`);
  assert.match(memory.readLedger(s.project).at(-1).summary, /^FAILED \(.*\) \[CHECKS_FAILED\]|^FAILED \[CHECKS_FAILED\]/);

  // cancelled halfway: its changes (one in a protected path) are judged and checked
  process.env.FAKE_WRITE = 'src/more.js,runs/r1/out.json';
  process.env.FAKE_DELAY_MS = '4000';
  const ac = new AbortController();
  const p = workers().runWorker({ task: 'x', cwd: s.project, scope: ['src', 'runs'], signal: ac.signal });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(s.project, 'runs/r1/out.json')); i++) await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  const c = await p;
  delete process.env.FAKE_WRITE;
  delete process.env.FAKE_DELAY_MS;
  assert.equal(c.code, 'cancelled', c.text);
  assert.deepEqual([...c.meta.flags].sort(), ['CHECKS_FAILED', 'PROTECTED PATH CHANGED']);
  assert.match(c.text, /PROTECTED PATH CHANGED .*runs\/r1\/out\.json \(added\)/);
  // a failed job that changed nothing runs no checks
  const s2 = sandbox({ w1: ['crash'] });
  s2.config({ post_checks: [{ name: 'always', cmd: 'echo x' }] });
  const quiet = await workers().runWorker({ task: 'x', cwd: s2.project });
  assert.equal(quiet.code, 'failed');
  assert.ok(!quiet.meta.checks && !(quiet.meta.flags || []).length);
});

// ---- "Needs action" ----

test('Needs action: one line at the top of relay_poll, relay_wait and relay_status lists every flag that needs the leader', async () => {
  const s = sandbox({});
  const jobs = require(`${SRC}/core/jobs`);
  fs.mkdirSync(jobs.dir(), { recursive: true });
  const now = Date.now();
  const rec = (id, extra) => fs.writeFileSync(jobs.jobFile(id), JSON.stringify({ id, cwd: s.project, project: 'project', title: `job ${id}`, createdAt: now - 1000, finishedAt: now, request: { task: 'x' }, report: 'r', ...extra }));
  rec('aaaa-1', { state: 'done', flags: ['CHECKS_INCOMPLETE', 'OUTPUT_NOT_SAVED'], concurrentProtected: 2 });
  rec('aaaa-2', { state: 'failed', code: 'guard_violation', flags: [] });
  rec('aaaa-3', { state: 'done', flags: [], concurrentProtected: 0 });
  assert.deepEqual(jobs.needsAction(jobs.read('aaaa-1')), ['CHECKS_INCOMPLETE', 'OUTPUT_NOT_SAVED', '2 in protected paths']);
  const poll = jobs.poll({ job_ids: ['aaaa-1', 'aaaa-2', 'aaaa-3'] });
  const first = poll.text.split('\n')[0];
  assert.equal(first, 'Needs action: aaaa-1 "job aaaa-1": CHECKS_INCOMPLETE, OUTPUT_NOT_SAVED, 2 in protected paths; aaaa-2 "job aaaa-2": guard_violation. (Resolved one? relay_ack records it.)');
  const wait = await jobs.wait({ job_ids: ['aaaa-1', 'aaaa-3'], timeout_sec: 1 });
  assert.match(wait.text.split('\n')[0], /^Needs action: aaaa-1 /);
  assert.ok(!jobs.poll({ job_ids: ['aaaa-3'] }).text.includes('Needs action'), 'nothing to act on: no line');
  // many newer jobs without flags do not push the flagged ones out of the status line
  for (let i = 0; i < 25; i++) rec(`bbbb-${i}`, { state: 'done', flags: [], finishedAt: now + 1000 + i });
  const status = workers().statusText(s.project);
  assert.match(status.split('\n')[0], /^Needs action: .*aaaa-1.*aaaa-2/);
});

// ---- read-only Claude jobs: default mode, told read-only, a change is flagged ----

test('read-only: told it is read-only; a change to the folder (an allowed shell command) is flagged READ_ONLY_VIOLATED, not while others wrote there', async () => {
  const s = sandbox({ w1: ['ok', 'ok'] });
  process.env.FAKE_WRITE = 'scratch.py';
  const r = await workers().runWorker({ task: 'investigate', cwd: s.project, readOnly: true });
  delete process.env.FAKE_WRITE;
  assert.equal(r.ok, true);
  assert.match(s.last().prompt, /This job is READ-ONLY: do not create, change or delete any file/);
  assert.equal(s.last().permissionMode, 'default');
  assert.deepEqual(r.meta.flags, ['READ_ONLY_VIOLATED']);
  assert.match(r.text, /\[relay\] READ_ONLY_VIOLATED: this read-only job changed the folder .*scratch\.py \(added\)/);
  assert.deepEqual(r.meta.readOnlyChanges, [{ path: 'scratch.py', kind: 'added' }]);
  const clean = await workers().runWorker({ task: 'investigate', cwd: s.project, readOnly: true });
  assert.deepEqual(clean.meta.flags, []);
});

// ---- isolated jobs: other sessions' transcripts denied, own large tool outputs readable; Codex: git data denied ----

test('isolated Claude job: other sessions\' transcripts and subagent folders of every account are denied; tool-results are not', async () => {
  const s = sandbox({ w1: ['ok'] });
  const r = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, isolated: true });
  assert.equal(r.ok, true, r.text);
  const inv = s.last();
  const acct = path.join(process.env.RELAY_HOME, 'accounts', 'w1', 'projects');
  for (const rule of [`Read(/${acct}/*/*.jsonl)`, `Read(/${acct}/*/*/subagents)`, `Read(/${acct}/*/*/subagents/**)`, `Read(/${path.join(os.homedir(), '.claude', 'projects')}/*/*.jsonl)`]) {
    assert.ok(inv.disallowedTools.includes(rule), rule);
  }
  assert.ok(!inv.disallowedTools.some((x) => /tool-results/.test(x) || x === `Read(/${acct}/**)`), 'the job\'s own large tool outputs stay readable');
  const deny = inv.settings.sandbox.filesystem.denyRead;
  assert.ok(deny.includes(`${acct}/*/*.jsonl`) && deny.includes(`${acct}/*/*/subagents`), deny.join('\n'));
  // a job that is not isolated: none of it
  s.store.saveSettings({ jobsPerWorker: 0 });
  process.env.FAKE_PLAN = JSON.stringify({ w1: ['ok', 'ok'] });
  await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true });
  assert.ok(!s.last().disallowedTools.some((x) => x.includes('.jsonl')));
});

test('isolated Codex job: the git root\'s .git (and a worktree\'s git folders) are denied in its profile; the job folder stays readable', () => {
  const codex = require(`${SRC}/core/backends/codex`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-git-')));
  const main = path.join(root, 'main');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  const profile = (opts) => codex.buildArgs({ model: 'gpt-x', permissionMode: 'plan', ...opts }).find((a) => a.startsWith('permissions='));
  const iso = profile({ cwd: path.join(wt, 'sub'), isolated: true });
  for (const d of [path.join(wt, '.git'), path.join(main, '.git', 'worktrees', 'wt'), path.join(main, '.git')]) assert.ok(iso.includes(`${JSON.stringify(d)}="deny"`), `${d} denied`);
  assert.ok(iso.includes(`${JSON.stringify(path.join(wt, 'sub'))}="read"`), 'the job folder stays readable');
  assert.ok(!profile({ cwd: path.join(wt, 'sub') }).includes('.git'), 'not isolated: unchanged');
  // a resumed run gets the same
  assert.ok(codex.buildArgs({ model: 'gpt-x', permissionMode: 'plan', cwd: path.join(wt, 'sub'), isolated: true, sessionId: 's1' }).find((a) => a.startsWith('permissions=')).includes(`${JSON.stringify(path.join(main, '.git'))}="deny"`));
});

test('isolated Claude job: other sessions\' folders (tool-results...) that exist at start are denied; other projects whole; its own new or continued session stays readable', async () => {
  const s = sandbox({ w1: ['ok', 'ok'] });
  const projects = path.join(process.env.RELAY_HOME, 'accounts', 'w1', 'projects');
  const own = path.join(projects, P().ccProjectName(s.project));
  const other = path.join(projects, '-somewhere-else');
  for (const d of [path.join(own, 'sess-old', 'tool-results'), path.join(own, 'memory'), path.join(other, 'sess-x', 'tool-results')]) fs.mkdirSync(d, { recursive: true });
  // a second account whose "projects" is a symlink to the first one's (as with ~/.claude/projects): real paths, once
  const w2 = path.join(process.env.RELAY_HOME, 'accounts', 'w2');
  fs.mkdirSync(w2, { recursive: true });
  fs.symlinkSync(projects, path.join(w2, 'projects'));
  s.store.save([...s.store.load(), { ...s.store.newAccount('w2', w2, 'w2@x.com') }]);
  const r = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, isolated: true, thread: 'iso', account: 'w1' });
  assert.equal(r.ok, true, r.text);
  const inv = s.last();
  assert.ok(inv.disallowedTools.includes(`Read(/${path.join(own, 'sess-old')}/**)`), 'an existing session folder of its own project');
  assert.ok(inv.disallowedTools.includes(`Read(/${other}/**)`), 'another project folder, whole');
  assert.ok(!inv.disallowedTools.includes(`Read(/${own}/**)`), 'not its own project folder as a whole');
  assert.ok(inv.allowedTools.includes(`Read(/${own}/*/tool-results/**)`), 'its own saved tool outputs: a Read allow rule (deny rules still win)');
  assert.equal(inv.disallowedTools.filter((x) => x.includes('sess-old')).length, 1, 'symlinked accounts: listed once (real path)');
  const deny = inv.settings.sandbox.filesystem.denyRead;
  assert.ok(deny.includes(path.join(own, 'sess-old')) && deny.includes(other) && !deny.includes(own));
  // continuing the thread: the session it resumes stays readable
  const sid = require(`${SRC}/core/memory`).getThread(s.project, 'iso').sessionId;
  fs.mkdirSync(path.join(own, sid, 'tool-results'), { recursive: true });
  await workers().runWorker({ task: 'more', cwd: s.project, readOnly: true, isolated: true, thread: 'iso', account: 'w1' });
  assert.ok(s.last().resume === sid);
  assert.ok(!s.last().disallowedTools.some((x) => x.includes(sid)), 'its own resumed session folder is not denied');
  assert.ok(s.last().disallowedTools.includes(`Read(/${path.join(own, 'sess-old')}/**)`));
});

test('isOwnProjectFolder follows Claude Code\'s folder names, also cut at 200 characters with a hash', () => {
  const p = P();
  assert.equal(p.ccProjectName('/Users/a b/x_y.z'), '-Users-a-b-x-y-z');
  assert.equal(p.isOwnProjectFolder('-Users-a-b-x-y-z', '/Users/a b/x_y.z'), true);
  assert.equal(p.isOwnProjectFolder('-Users-a-b-x-y-z-sub', '/Users/a b/x_y.z'), false);
  const long = `/${'d'.repeat(250)}`;
  assert.equal(p.isOwnProjectFolder(`-${'d'.repeat(199)}-abc123`, long), true);
  assert.equal(p.isOwnProjectFolder(`-${'d'.repeat(199)}`, long), false);
});
