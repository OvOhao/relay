'use strict';
// Workflow rules around a worker run: isolated jobs and hidden paths, output_file, write_paths, the project config
// (.relay/project.json: rules_file, protected_paths, post_checks, health_checks), the structured relay-summary and
// presets by project. Driven with the fake Claude and Codex CLIs.
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

const SUMMARY = '```relay-summary\n{"status": "partial", "run_ids": ["r-17"], "key_files": ["ideas/alpha/plan.md"], "checks": ["freeze check ok"], "decisions_needed": ["pick venue"], "next_step": "run the ablation"}\n```';

// ---- path patterns and the config file ----

test('patterns: globs, folders cover their contents, nothing escapes cwd; expansion also finds ignored files', () => {
  const p = P();
  assert.equal(p.matchPath('ideas/*/runs/**', 'ideas/alpha/runs/r1/out.json'), true);
  assert.equal(p.matchPath('ideas/*/runs', 'ideas/alpha/runs/r1/out.json'), true, 'a folder covers what is inside');
  assert.equal(p.matchPath('ideas/*/runs/**', 'ideas/alpha/notes.md'), false);
  assert.equal(p.matchPath('*.md', 'a/b.md'), false, '* stays within one segment');
  assert.equal(p.matchPath('**/*.md', 'a/b.md'), true);
  assert.equal(p.matchPath('reviews', 'reviews-old/x'), false);
  assert.equal(p.matchPath('a.txt', '../a.txt'), false);
  assert.deepEqual(p.cleanPattern('./reviews/'), { pattern: 'reviews' });
  for (const bad of ['/abs', '../up', 'a/../../b', '', '.', '~/x', 'C:/x']) assert.ok(p.cleanPattern(bad).error, bad);
  const s = sandbox();
  s.write('ideas/alpha/runs/r1/out.json');
  s.write('ideas/beta/runs/r2/deep/x.bin');
  s.write('ideas/beta/plan.md');
  s.write('.gitignore', 'runs/\n');
  const got = p.expandPattern(s.project, 'ideas/*/runs/**').map((f) => path.relative(s.project, f)).sort();
  assert.deepEqual(got, ['ideas/alpha/runs/r1/out.json', 'ideas/beta/runs/r2/deep/x.bin']);
  assert.equal(p.ideaOf('ideas/alpha/reviews/r.md'), 'alpha');
  assert.equal(p.ideaOf('notes/r.md'), '');
});

test('project config: found in cwd or a parent up to the git root (nearest wins), checked, and a bad one refuses the job', async () => {
  const s = sandbox();
  const p = P();
  const sub = path.join(s.project, 'ideas', 'alpha');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(p.loadConfig(sub).config.file, null, 'no config: nothing applies');
  s.config({ protected_paths: ['plans/*.frozen.md', { glob: 'ideas/*/runs/**', append_only: true }], health_checks: ['bin/x health', { name: 'gpu', cmd: 'nvidia-smi' }], post_checks: [{ cmd: 'true' }] });
  assert.equal(p.loadConfig(sub).config.file, null, 'not a git repository: only cwd itself is searched');
  fs.mkdirSync(path.join(s.project, '.git'));
  const c = p.loadConfig(sub).config;
  assert.equal(c.file, path.join(s.project, '.relay', 'project.json'), 'a parent up to the git root');
  assert.equal(c.root, s.project);
  assert.deepEqual(c.protected, [{ pattern: 'plans/*.frozen.md', appendOnly: false }, { pattern: 'ideas/*/runs/**', appendOnly: true }]);
  assert.deepEqual(c.healthChecks.map((h) => h.cmd), ['bin/x health', 'nvidia-smi'], 'health checks are parsed and kept');
  assert.equal(c.postChecks[0].when, 'always');
  assert.equal(c.postChecks[0].timeoutSec, 300);
  fs.mkdirSync(path.join(sub, '.relay'));
  fs.writeFileSync(path.join(sub, '.relay', 'project.json'), '{}');
  assert.equal(p.loadConfig(sub).config.file, path.join(sub, '.relay', 'project.json'), 'the nearest one wins');
  fs.rmSync(path.join(sub, '.relay'), { recursive: true });

  for (const bad of ['{nope', JSON.stringify({ protected_paths: ['../x'] }), JSON.stringify({ post_checks: [{ name: 'x' }] }), JSON.stringify({ post_checks: [{ cmd: 'x', when: 'sometimes' }] })]) {
    fs.writeFileSync(path.join(s.project, '.relay', 'project.json'), bad);
    const r = await workers().runWorker({ task: 'x', cwd: s.project });
    assert.equal(r.code, 'bad_request', bad);
    assert.match(r.text, /could not use the project config .*nothing was started/s);
  }
  assert.equal(s.invocations().length, 0, 'no worker started');
});

// ---- isolated jobs and hide_paths ----

test('isolated: no ledger in the prompt, Read deny rules for hide_paths and Relay\'s records, threads stay isolated', async () => {
  const s = sandbox({ w1: ['ok'] });
  const memory = require(`${SRC}/core/memory`);
  memory.appendLedger(s.project, { thread: 'reviewer-a', account: 'x', title: 'Venue review A', summary: 'SECRET-CONCLUSION-OF-REVIEWER-A: reject', files: [], ok: true });
  const normal = await workers().runWorker({ task: 'plain job', cwd: s.project, thread: 'plain' });
  assert.equal(normal.ok, true);
  assert.match(s.last().prompt, /SECRET-CONCLUSION-OF-REVIEWER-A/, 'a normal job gets the ledger');

  // the project is a git repository, and the worker account has auto memory from earlier sessions
  fs.mkdirSync(path.join(s.project, '.git'), { recursive: true });
  const memDir = path.join(process.env.RELAY_HOME, 'accounts', 'w1', 'projects', '-some-project', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- leader decided: venue A\n');
  assert.equal(s.invocations()[0].memoryOffEnv, null, 'a normal job keeps auto memory');
  const r = await workers().runWorker({ task: 'review alpha independently', cwd: s.project, readOnly: true, isolated: true, thread: 'venue-b', hidePaths: ['reviews/a.md', 'ideas/*/reviews'] });
  assert.equal(r.ok, true, r.text);
  const inv = s.last();
  assert.ok(!inv.prompt.includes('SECRET-CONCLUSION'), 'no ledger text');
  assert.ok(!inv.prompt.includes('Project ledger'), 'no ledger section');
  assert.match(inv.prompt, /ISOLATED job/);
  assert.match(inv.prompt, /OFF-LIMITS for this job: reviews\/a\.md, ideas\/\*\/reviews/);
  // read-only: default mode with every edit tool denied (not plan mode)
  assert.equal(inv.permissionMode, 'default');
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) assert.ok(inv.disallowedTools.includes(t), `${t} denied`);
  // auto memory off (env switch and settings key), git snapshot off, .git and every account's memory folders denied
  assert.equal(inv.memoryOffEnv, '1');
  assert.equal(inv.settings.autoMemoryEnabled, false);
  assert.equal(inv.settings.includeGitInstructions, false);
  assert.ok(inv.disallowedTools.includes(`Read(/${path.join(s.project, '.git')}/**)`), inv.disallowedTools.join('\n'));
  assert.ok(inv.disallowedTools.includes(`Read(/${path.join(process.env.RELAY_HOME, 'accounts', 'w1', 'projects', '*', 'memory', '**')})`), inv.disallowedTools.join('\n'));
  assert.ok(inv.settings.sandbox.filesystem.denyRead.includes(path.join(s.project, '.git')));
  assert.ok(inv.settings.sandbox.filesystem.denyRead.includes(memDir));
  const abs = (rel) => `/${path.join(s.project, rel)}`;
  for (const rule of [`Read(${abs('reviews/a.md')})`, `Read(${abs('reviews/a.md')}/**)`, `Read(${abs('ideas/*/reviews')})`, `Read(${abs('ideas/*/reviews')}/**)`,
    `Read(/${path.join(process.env.RELAY_HOME, 'projects', '**')})`, `Read(/${path.join(process.env.RELAY_HOME, 'jobs', '**')})`]) {
    assert.ok(inv.disallowedTools.includes(rule), `${rule} in ${inv.disallowedTools}`);
  }
  // Read deny rules do not stop shell commands: the bash sandbox denies reading the same paths (globs expanded)
  assert.equal(normal.ok && s.invocations()[0].settings, null, 'no sandbox for a job without hidden paths');
  const sb = inv.settings && inv.settings.sandbox;
  assert.ok(sb && sb.enabled && sb.failIfUnavailable && sb.allowUnsandboxedCommands === false, JSON.stringify(inv.settings));
  assert.deepEqual(sb.network, { allowedDomains: ['*'] });
  for (const p of [path.join(s.project, 'reviews/a.md'), path.join(process.env.RELAY_HOME, 'projects'), path.join(process.env.RELAY_HOME, 'jobs')]) {
    assert.ok(sb.filesystem.denyRead.includes(p), `${p} in ${sb.filesystem.denyRead}`);
  }
  assert.match(r.text, /· isolated/);
  const entry = memory.readLedger(s.project).at(-1);
  assert.equal(entry.isolated, true);
  assert.deepEqual(entry.hidePaths, ['reviews/a.md', 'ideas/*/reviews']);
  assert.equal(memory.getThread(s.project, 'venue-b').isolated, true);

  // its own isolated thread continues, still without the ledger (not even what others did meanwhile)
  memory.appendLedger(s.project, { thread: 'reviewer-c', account: 'x', title: 'C', summary: 'LATER-CONCLUSION-C', files: [], ok: true });
  const again = await workers().runWorker({ task: 'second pass', cwd: s.project, readOnly: true, isolated: true, thread: 'venue-b' });
  assert.equal(again.ok, true, again.text);
  assert.ok(s.last().resume, 'the same session');
  assert.ok(!s.last().prompt.includes('LATER-CONCLUSION-C') && !/While you were away/.test(s.last().prompt));
  // a thread with non-isolated history cannot be continued as isolated
  const refused = await workers().runWorker({ task: 'x', cwd: s.project, isolated: true, readOnly: true, thread: 'plain' });
  assert.equal(refused.code, 'bad_request');
  assert.match(refused.text, /Thread "plain" already has history from a job that was not isolated/);
  const n = s.invocations().length;
  const badHide = await workers().runWorker({ task: 'x', cwd: s.project, isolated: true, hidePaths: ['../elsewhere'] });
  assert.equal(badHide.code, 'bad_request');
  assert.equal(s.invocations().length, n);
});

test('isolation breach: a Read or a shell command on a hidden path flags the job in report, job record and ledger; a refused read does not', async () => {
  const s = sandbox({ w1: ['ok'] });
  const memory = require(`${SRC}/core/memory`);
  s.write('reviews/a.md', 'reviewer A says reject');
  process.env.FAKE_TOOLS = JSON.stringify([{ name: 'Read', input: { file_path: 'reviews/b.md' }, error: true }]);
  const clean = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, isolated: true, hidePaths: ['reviews'] });
  assert.equal(clean.ok, true);
  assert.ok(!/ISOLATION BREACH/.test(clean.text), 'a refused read is no breach');
  assert.match(clean.text, /tried to reach hidden paths, and was refused: Read reviews\/b\.md/);
  assert.deepEqual(clean.meta.flags, []);

  process.env.FAKE_TOOLS = JSON.stringify([{ name: 'Bash', input: { command: 'cat reviews/a.md | head' } }]);
  const bash = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, isolated: true, hidePaths: ['reviews/*.md'] });
  assert.equal(bash.ok, true, 'the job still returns its report');
  assert.match(bash.text, /finished · ISOLATION BREACH\./);
  assert.match(bash.text, /\[relay\] ISOLATION BREACH: .*Bash cat reviews\/a\.md \| head \(hidden: reviews\/\*\.md\)/);
  assert.ok(bash.text.includes('Picked up where the last account stopped'), 'the full report is still there');
  const e = memory.readLedger(s.project).at(-1);
  assert.deepEqual(e.flags, ['ISOLATION BREACH']);
  assert.match(e.summary, /^ISOLATION BREACH\. /);
  assert.match(memory.ledgerText(s.project), /isolated · ISOLATION BREACH/);

  // through relay_start: the job record keeps the flag, the breach and the request's isolation
  process.env.FAKE_TOOLS = JSON.stringify([{ name: 'Read', input: { file_path: path.join(s.project, 'reviews', 'a.md') } }]);
  const id = jobId((await toolCall('relay_start', { task: 'review', cwd: s.project, read_only: true, isolated: true, hide_paths: ['reviews'], title: 'Independent review' })).text);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, new RegExp(`## Job ${id} · DONE · ISOLATION BREACH · "Independent review"`));
  assert.match(w.text, / isolated /);
  const jobs = require(`${SRC}/core/jobs`);
  const rec = jobs.read(id);
  assert.deepEqual(rec.flags, ['ISOLATION BREACH']);
  assert.equal(rec.isolated, true);
  assert.deepEqual(rec.hidePaths, ['reviews']);
  assert.equal(rec.breach[0].tool, 'Read');
  assert.equal(rec.request.isolated, true);
  assert.match(workers().statusText(), new RegExp(`Flagged jobs[\\s\\S]*${id} "Independent review" \\(project\\): done, ISOLATION BREACH`));
});

test('breach scan: a hidden path named only to exclude it from a search is not a breach; reading it still is', () => {
  const cwd = '/tmp/proj';
  const scan = (command) => P().scanBreach([{ name: 'Bash', input: { command } }], { cwd, hidePaths: ['secret', 'notes/hidden.md'] }).breaches.length;
  // what a real haiku reviewer ran in a live probe
  assert.equal(scan('grep -r TOKEN . --exclude-dir=secret --exclude=hidden.md'), 0);
  assert.equal(scan("rg TOKEN -g '!secret/**' -g '!notes/hidden.md'"), 0);
  assert.equal(scan('find . -not -path "./secret/*" -name "*.md"'), 0);
  assert.equal(scan('grep --exclude-dir secret -r TOKEN .'), 0);
  assert.equal(scan('cat secret/secret.txt'), 1);
  assert.equal(scan('grep -r TOKEN . --exclude-dir=secret notes/hidden.md'), 1, 'an exclusion does not hide a separate read');
  assert.equal(scan('cat /tmp/proj/notes/hidden.md'), 1);
});

test('hide_paths for Codex: deny entries in the sandbox profile (globs expanded), and the same breach check', async () => {
  const s = sandbox({ cx1: ['ok'] }, [['lead', { desktop: true }], ['cx1', { provider: 'codex' }]]);
  s.write('reviews/a.md');
  s.write('reviews/b.md');
  const r = await workers().runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true, isolated: true, hidePaths: ['reviews/*.md', 'secret'] });
  assert.equal(r.ok, true, r.text);
  const exec = s.invocations().filter((i) => i.kind === 'exec').at(-1);
  const perms = exec.args.find((x) => x.startsWith('permissions='));
  for (const f of ['reviews/a.md', 'reviews/b.md', 'secret']) assert.ok(perms.includes(`${JSON.stringify(path.join(s.project, f))}="deny"`), f);
  assert.ok(perms.includes(`${JSON.stringify(s.project)}="read"`), 'the folder itself stays readable');
  assert.ok(!exec.prompt.includes('Project ledger') && /ISOLATED job/.test(exec.prompt));
  assert.match(r.text, /Sandbox: verified/);
  // the fake's command was "rg --files": not a hidden path
  assert.deepEqual(r.meta.flags, []);
});

// ---- output_file ----

test('output_file: Relay writes the report for a read-only job; refuses an existing file, a path outside cwd or a protected one; overwrite replaces', async () => {
  const s = sandbox({ w1: ['ok'], cx1: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', { provider: 'codex' }]]);
  process.env.FAKE_REPORT = `# Review of alpha\n\nLooks fine.\n\n${SUMMARY}`;
  const r = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, outputFile: 'ideas/alpha/reviews/venue.md' });
  assert.equal(r.ok, true, r.text);
  const f = path.join(s.project, 'ideas', 'alpha', 'reviews', 'venue.md');
  assert.equal(fs.readFileSync(f, 'utf8'), `${process.env.FAKE_REPORT}\n`, 'the final report, as written');
  assert.match(r.text, /Report saved by Relay to ideas\/alpha\/reviews\/venue\.md/);
  assert.match(s.last().prompt, /Relay saves your final report to ideas\/alpha\/reviews\/venue\.md itself/);
  assert.equal(r.meta.outputSaved, 'ideas/alpha/reviews/venue.md');
  assert.ok(!fs.readdirSync(path.dirname(f)).some((n) => n.endsWith('.tmp')), 'no temp file left');

  const n = s.invocations().length;
  const exists = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, outputFile: 'ideas/alpha/reviews/venue.md' });
  assert.equal(exists.code, 'bad_request');
  assert.match(exists.text, /already exists; pass overwrite: true/);
  for (const bad of ['../outside.md', '/tmp/x.md', 'reviews/*.md', '.git/x', 'ideas/alpha/reviews']) {
    const x = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, outputFile: bad });
    assert.equal(x.code, 'bad_request', bad);
  }
  s.config({ protected_paths: ['plans/**'] });
  const prot = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, outputFile: 'plans/review.md' });
  assert.match(prot.text, /protected path in the project config \(plans\/\*\*\)/);
  const start = await toolCall('relay_start', { task: 'review', cwd: s.project, read_only: true, output_file: 'ideas/alpha/reviews/venue.md' });
  assert.equal(start.isError, true, 'relay_start refuses it the same way');
  assert.equal(s.invocations().length, n, 'nothing was started');

  process.env.FAKE_REPORT = 'second version';
  const over = await workers().runWorker({ task: 'review', cwd: s.project, readOnly: true, outputFile: 'ideas/alpha/reviews/venue.md', overwrite: true });
  assert.equal(over.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'second version\n');

  // a Codex (read-only, sandboxed) job: Relay writes the file after the read-only guard
  const cx = await workers().runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true, outputFile: 'reviews/codex.md' });
  assert.equal(cx.ok, true, cx.text);
  assert.match(fs.readFileSync(path.join(s.project, 'reviews', 'codex.md'), 'utf8'), /Review by cx1: no problems found/);
  assert.match(cx.text, /job folder unchanged/);
});

// ---- write_paths ----

test('write_paths: default permission mode with Edit/Write allow rules; a change outside fails the job and lists it; Codex refuses', async () => {
  const s = sandbox({ w1: ['ok'], cx1: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', { provider: 'codex' }]]);
  s.store.saveSettings({ allowedTools: ['Bash(npm test)'] });
  process.env.FAKE_WRITE = 'notes/n1.md';
  const r = await workers().runWorker({ task: 'write notes', cwd: s.project, writePaths: ['notes'] });
  assert.equal(r.ok, true, r.text);
  const inv = s.last();
  assert.equal(inv.permissionMode, 'default');
  const abs = `/${path.join(s.project, 'notes')}`;
  assert.deepEqual(inv.allowedTools.filter((r) => !r.includes('/tool-results/')), ['Bash(npm test)', `Edit(${abs})`, `Edit(${abs}/**)`, `Write(${abs})`, `Write(${abs}/**)`]);
  assert.ok(inv.allowedTools.some((r) => r.endsWith('/*/tool-results/**)')), 'its own saved tool outputs are readable');
  assert.match(inv.prompt, /You may create or change files ONLY under: notes/);

  process.env.FAKE_WRITE = 'notes/n2.md,src/hack.js,a.txt';
  process.env.FAKE_REPORT = `Wrote the notes.\n\n${SUMMARY}`;
  const bad = await workers().runWorker({ task: 'write notes', cwd: s.project, writePaths: ['notes'], thread: 'w' });
  delete process.env.FAKE_REPORT;
  assert.equal(bad.meta.relaySummary && bad.meta.relaySummary.status, 'partial', 'a failed job keeps the worker\'s summary');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'write_violation');
  assert.match(bad.text, /FAILED · WRITE_PATHS_VIOLATED: files changed outside write_paths \(notes\): a\.txt \(changed\), src\/hack\.js \(added\)/);
  assert.match(bad.text, /Nothing was reverted/);
  assert.ok(fs.existsSync(path.join(s.project, 'src', 'hack.js')), 'nothing reverted');
  const memory = require(`${SRC}/core/memory`);
  assert.match(memory.readLedger(s.project).at(-1).summary, /^FAILED \(WRITE_PATHS_VIOLATED\)/);
  assert.equal(memory.readLedger(s.project).at(-1).relaySummary.next_step, 'run the ablation');
  assert.deepEqual(bad.meta.violations.map((v) => v.path), ['a.txt', 'src/hack.js']);

  // through a job: the record says failed with the flag
  process.env.FAKE_WRITE = 'other.md';
  const id = jobId((await toolCall('relay_start', { task: 'write', cwd: s.project, write_paths: ['notes'] })).text);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, new RegExp(`Job ${id} · FAILED · WRITE_PATHS_VIOLATED`));
  assert.match(w.text, /write only notes/);
  assert.equal(require(`${SRC}/core/jobs`).read(id).code, 'write_violation');

  const cx = await workers().runWorker({ task: 'x', cwd: s.project, agent: 'codex', readOnly: true, writePaths: ['notes'] });
  assert.equal(cx.code, 'bad_request');
  assert.match(cx.text, /write_paths is not available for agent "codex".*output_file/);
  const ro = await workers().runWorker({ task: 'x', cwd: s.project, readOnly: true, writePaths: ['notes'] });
  assert.match(ro.text, /write_paths and read_only exclude each other/);
});

// ---- protected paths ----

test('protected_paths: deny rules for writing jobs, a change fails the job (append-only folders may get new files), write_paths into one is refused', async () => {
  const s = sandbox({ w1: ['ok'] });
  s.write('plans/alpha.frozen.md', 'frozen plan');
  s.write('ideas/alpha/runs/r1.json', '{}');
  s.write('.gitignore', 'runs/\n');
  s.config({ protected_paths: ['plans/*.frozen.md', { glob: 'ideas/*/runs/**', append_only: true }] });
  process.env.FAKE_WRITE = 'ideas/alpha/runs/r2.json,ideas/alpha/notes.md';
  const ok = await workers().runWorker({ task: 'analyse', cwd: s.project });
  assert.equal(ok.ok, true, ok.text);
  const inv = s.last();
  const plan = `/${path.join(s.project, 'plans/*.frozen.md')}`;
  for (const rule of [`Edit(${plan})`, `Write(${plan})`]) assert.ok(inv.disallowedTools.includes(rule), rule);
  assert.ok(!inv.disallowedTools.some((r) => r.includes('runs')), 'append-only: no deny rule, checked afterwards');
  assert.match(inv.prompt, /never change, move or delete: plans\/\*\.frozen\.md, ideas\/\*\/runs\/\*\* \(new files may be added\)/);

  process.env.FAKE_WRITE = 'plans/alpha.frozen.md';
  const frozen = await workers().runWorker({ task: 'analyse', cwd: s.project });
  assert.equal(frozen.code, 'protected_changed');
  assert.match(frozen.text, /FAILED · PROTECTED PATH CHANGED: PROTECTED PATH CHANGED \(project config .*\): plans\/alpha\.frozen\.md \(changed\)/);
  process.env.FAKE_WRITE = 'ideas/alpha/runs/r1.json';
  const runEdit = await workers().runWorker({ task: 'analyse', cwd: s.project });
  assert.equal(runEdit.code, 'protected_changed', 'an existing run record changed (even though git ignores runs/)');
  assert.match(runEdit.text, /ideas\/alpha\/runs\/r1\.json \(changed\)/);

  delete process.env.FAKE_WRITE;
  const ro = await workers().runWorker({ task: 'look', cwd: s.project, readOnly: true });
  assert.ok(!s.last().disallowedTools || !s.last().disallowedTools.some((r) => r.includes('frozen')), 'read-only jobs need no write deny rules');
  assert.equal(ro.ok, true);
  const wp = await workers().runWorker({ task: 'x', cwd: s.project, writePaths: ['plans/alpha.frozen.md'] });
  assert.match(wp.text, /write_paths plans\/alpha\.frozen\.md is protected/);
});

// ---- rules_file ----

test('rules_file: appended to every worker\'s system prompt (Claude and Codex); over 20 KB it is cut and the report says so', async () => {
  const s = sandbox({ w1: ['ok'], cx1: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', { provider: 'codex' }]]);
  s.write('RULES.md', '# Project rules\nNever edit frozen plans. Use bin/researchctl for runs.\n');
  s.config({ rules_file: 'RULES.md' });
  s.store.saveSettings({ presets: [{ id: 'research', name: 'Research', text: 'PRESET-TEXT', keywords: ['venue'], auto: true }] });
  const r = await workers().runWorker({ task: 'venue review', cwd: s.project, readOnly: true });
  assert.equal(r.ok, true);
  const sys = s.last().appendSystem;
  assert.match(sys, /^PRESET-TEXT\n\n---\n\nProject rules for this folder \(from RULES\.md/);
  assert.match(sys, /Never edit frozen plans\./);
  assert.ok(!/Note: the project rules/.test(r.text));
  const cx = await workers().runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true });
  assert.equal(cx.ok, true, cx.text);
  assert.match(s.invocations().filter((i) => i.kind === 'exec').at(-1).developer, /Never edit frozen plans/);

  s.write('RULES.md', `${'r'.repeat(30 * 1024)}TAIL-NOT-SHOWN`);
  const big = await workers().runWorker({ task: 'x', cwd: s.project, readOnly: true });
  const sys2 = s.last().appendSystem;
  assert.ok(!sys2.includes('TAIL-NOT-SHOWN'));
  assert.ok(sys2.length < 21 * 1024, `${sys2.length}`);
  assert.match(sys2, /the rules file is 30 KB; only its first 20 KB are shown here/);
  assert.match(big.text, /Note: the project rules file .*RULES\.md is 30 KB; only its first 20 KB were given to the worker/);

  s.config({ rules_file: 'MISSING.md' });
  const missing = await workers().runWorker({ task: 'x', cwd: s.project, readOnly: true });
  assert.equal(missing.ok, true);
  assert.match(missing.text, /names rules_file .*MISSING\.md, which could not be read \(not found\)/);
});

// ---- post checks ----

test('post_checks: {each:} with {file} and {idea}, {changed_files}, when changed:<glob>; a failure flags CHECKS_FAILED, the job stays done', async () => {
  const s = sandbox({ w1: ['ok'] });
  s.config({
    post_checks: [
      { name: 'audit numbers', cmd: '{each:ideas/*/reviews/*.md} echo audit {file} --idea {idea}' },
      { name: 'changed', cmd: 'echo CHANGED: {changed_files}' },
      { name: 'freeze check', cmd: 'echo frozen-ok; exit 3', when: 'changed:plans/**' },
      { name: 'never', cmd: 'echo should-not-run', when: 'changed:nothing/**' },
      { name: 'per idea', cmd: '{each:ideas/**} echo verify {idea}' },
    ],
  });
  process.env.FAKE_WRITE = 'ideas/alpha/reviews/r.md,ideas/beta/reviews/s.md,plans/p.md,notes.txt';
  const r = await workers().runWorker({ task: 'write', cwd: s.project });
  assert.equal(r.ok, true, 'state stays done');
  assert.match(r.text, /finished · CHECKS_FAILED\./);
  assert.match(r.text, /## Relay checks/);
  assert.match(r.text, /- passed: audit numbers \(ideas\/alpha\/reviews\/r\.md\): exit 0/);
  assert.match(r.text, /audit ideas\/alpha\/reviews\/r\.md --idea alpha/);
  assert.match(r.text, /audit ideas\/beta\/reviews\/s\.md --idea beta/);
  assert.match(r.text, /CHANGED: ideas\/alpha\/reviews\/r\.md ideas\/beta\/reviews\/s\.md notes\.txt plans\/p\.md/);
  assert.match(r.text, /- FAILED: freeze check: exit 3/);
  assert.match(r.text, /frozen-ok/, 'the last lines of its output');
  assert.match(r.text, /- skipped: never: no changed file matches nothing\/\*\*/);
  assert.equal(r.meta.checks.filter((c) => c.name === 'per idea').map((c) => c.tail).join(','), 'verify alpha,verify beta', 'one run per idea, not per file');
  assert.ok(!r.text.includes('should-not-run'));
  assert.deepEqual(r.meta.flags, ['CHECKS_FAILED']);
  const freeze = r.meta.checks.find((c) => c.name === 'freeze check');
  assert.equal(freeze.code, 3);
  const memory = require(`${SRC}/core/memory`);
  assert.deepEqual(memory.readLedger(s.project).at(-1).flags, ['CHECKS_FAILED']);
  assert.match(memory.ledgerText(s.project), /· CHECKS_FAILED/);

  // a check that runs too long is stopped and counts as failed
  s.config({ post_checks: [{ name: 'slow', cmd: 'sleep 20', timeout_sec: 0.5 }] });
  delete process.env.FAKE_WRITE;
  const t0 = Date.now();
  const slow = await workers().runWorker({ task: 'x', cwd: s.project, scope: ['notes'] });
  assert.ok(Date.now() - t0 < 10000);
  assert.match(slow.text, /- FAILED: slow: timed out/);

  // through a job: the flag is in the record and in relay_poll's header
  s.config({ post_checks: [{ name: 'fails', cmd: 'exit 1' }] });
  const id = jobId((await toolCall('relay_start', { task: 'x', cwd: s.project, scope: ['notes'] })).text);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(w.text, new RegExp(`Job ${id} · DONE · CHECKS_FAILED`));
  const rec = require(`${SRC}/core/jobs`).read(id);
  assert.equal(rec.state, 'done');
  assert.deepEqual(rec.flags, ['CHECKS_FAILED']);
  assert.equal(rec.checks[0].code, 1);
});

// ---- the structured summary ----

test('relay-summary: asked for in every prompt, parsed tolerantly, kept in record and ledger, shown first by poll and wait', async () => {
  const p = P();
  const good = p.parseSummary(`Report.\n\n${SUMMARY}\n`);
  assert.equal(good.note, null);
  assert.deepEqual(good.summary, { status: 'partial', run_ids: ['r-17'], key_files: ['ideas/alpha/plan.md'], checks: ['freeze check ok'], decisions_needed: ['pick venue'], next_step: 'run the ablation' });
  assert.equal(p.parseSummary('no block').summary, null);
  assert.match(p.parseSummary('no block').note, /no relay-summary block/);
  assert.match(p.parseSummary('```relay-summary\n{"status": done}\n```').note, /not valid JSON/);
  assert.match(p.parseSummary('```relay-summary\n[1]\n```').note, /not a JSON object/);
  const odd = p.parseSummary('  ```relay-summary\n  {"status": "Whatever", "run_ids": "r1", "checks": [{"a": 1}]}\n  ```');
  assert.equal(odd.summary.status, null);
  assert.deepEqual(odd.summary.run_ids, ['r1']);
  assert.deepEqual(odd.summary.checks, ['{"a":1}']);
  assert.match(odd.note, /not one of done, partial, blocked, failed/);
  assert.match(p.summaryLine(good.summary), /^Summary: PARTIAL · runs: r-17 · key files: ideas\/alpha\/plan\.md · checks: freeze check ok · decisions needed: pick venue · next: run the ablation$/);

  const s = sandbox({ w1: ['ok'] });
  const memory = require(`${SRC}/core/memory`);
  process.env.FAKE_REPORT = `Did the analysis.\n\n${SUMMARY}`;
  const r = await workers().runWorker({ task: 'analyse', cwd: s.project, thread: 'an' });
  assert.match(s.last().prompt, /```relay-summary\n {2}\{"status": "done\|partial\|blocked\|failed", "run_ids": \[\]/);
  assert.ok(s.last().prompt.indexOf('relay-summary') < s.last().prompt.indexOf('Long-running work'), 'asked for before the park instructions');
  assert.ok(r.text.includes(SUMMARY), 'the report itself is unchanged');
  assert.deepEqual(r.meta.relaySummary, good.summary);
  const e = memory.readLedger(s.project).at(-1);
  assert.deepEqual(e.relaySummary, good.summary);
  assert.ok(!e.summary.includes('relay-summary'), 'the ledger\'s text summary leaves the block out');
  assert.match(memory.ledgerText(s.project), /Status: partial · next: run the ablation · decisions needed: pick venue/);
  await workers().runWorker({ task: 'follow-up', cwd: s.project, thread: 'an' });
  assert.match(s.last().prompt, /relay-summary/, 'also on a resumed thread');

  const id = jobId((await toolCall('relay_start', { task: 'analyse', cwd: s.project, title: 'Analysis' })).text);
  const w = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  const lines = w.text.split('\n');
  const head = lines.findIndex((l) => l.startsWith(`## Job ${id}`));
  assert.match(lines[head + 2], /^Summary: PARTIAL · runs: r-17/, 'right below the header');
  assert.deepEqual(require(`${SRC}/core/jobs`).read(id).relaySummary, good.summary);

  process.env.FAKE_REPORT = 'Just text, no block.';
  const id2 = jobId((await toolCall('relay_start', { task: 'analyse', cwd: s.project })).text);
  const w2 = await toolCall('relay_wait', { job_ids: [id2], timeout_sec: 30 });
  assert.match(w2.text, /Summary: none \(the worker gave no relay-summary block\)\./);
  assert.match(w2.text, /Note: the worker gave no relay-summary block \(Relay has no structured summary for this job\)\./);
  const rec = require(`${SRC}/core/jobs`).read(id2);
  assert.equal(rec.relaySummary, null);
  assert.match(rec.summaryNote, /no relay-summary block/);
});

// ---- presets by project ----

test('presets by project: applied to every job inside the folder, together with a keyword preset; shown in the header', async () => {
  const s = sandbox({ w1: ['ok'] });
  const other = path.join(s.root, 'other');
  fs.mkdirSync(path.join(s.project, 'ideas', 'alpha'), { recursive: true });
  fs.mkdirSync(other);
  s.store.saveSettings({
    presets: [
      { id: 'research', name: 'Research repo', text: 'PROJECT-PRESET', keywords: [], auto: false, projects: [s.project] },
      { id: 'security', name: 'Security', text: 'SECURITY-PRESET', keywords: ['jailbreak'], auto: true },
    ],
  });
  const store = s.store;
  assert.deepEqual(store.cleanPresets(store.loadSettings().presets).presets[0].projects, [s.project]);
  assert.match(store.cleanPresets([{ id: 'x', text: 't', projects: ['relative/dir'] }]).bad, /projects must be absolute/);

  const r = await workers().runWorker({ task: 'plain work', cwd: path.join(s.project, 'ideas', 'alpha') });
  assert.equal(s.last().appendSystem, 'PROJECT-PRESET');
  assert.match(r.text, /· preset "research"/);
  const both = await workers().runWorker({ task: 'study jailbreak defences', cwd: s.project });
  assert.equal(s.last().appendSystem, 'PROJECT-PRESET\n\n---\n\nSECURITY-PRESET');
  assert.match(both.text, /· presets "research", "security"/);
  await workers().runWorker({ task: 'plain work', cwd: other });
  assert.equal(s.last().appendSystem, null, 'not outside the folder');
  const sibling = path.join(s.root, 'project-two');
  fs.mkdirSync(sibling);
  await workers().runWorker({ task: 'plain work', cwd: sibling });
  assert.equal(s.last().appendSystem, null, 'a folder whose name only starts the same is not inside');
  await workers().runWorker({ task: 'plain work', cwd: s.project, preset: 'none' });
  assert.equal(s.last().appendSystem, null, '"none" turns presets off');
});
