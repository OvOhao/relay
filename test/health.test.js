'use strict';
// Worker health checks: one tiny job per Claude worker and project runs the project's health_checks and reports
// allowed / refused / exit code; workspace trust is read from the account's .claude.json; jobs that name a refused
// command avoid that worker. Driven with the fake Claude CLI (FAKE_HEALTH says what each account refuses).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');
const CHECKS = ['bin/researchctl status', 'python3 -c 1', 'ssh -o BatchMode=yes gpu-box true', 'latexmk -v'];

function sandbox({ names = ['w1', 'w2'], health = {}, trusted = names } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-health-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: '{}', RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]), RELAY_TICK: '0.05', RELAY_SLACK: '0',
    FAKE_HEALTH: JSON.stringify(health),
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT', 'FAKE_TOOLS', 'FAKE_CONTEXT', 'FAKE_HEALTH_NOBLOCK', 'RELAY_HEALTH_EVERY_MS']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(project, '.relay', 'project.json'), JSON.stringify({ health_checks: [CHECKS[0], { name: 'python', cmd: CHECKS[1] }, CHECKS[2], CHECKS[3]] }));
  const store = require(`${SRC}/core/store`);
  const accounts = [['lead', { desktop: true }], ...names.map((n) => [n])];
  store.save(accounts.map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 0 });
  // each account's own Claude Code config, as Claude Code writes it (the trust flag per project folder)
  const setTrust = (n, ok, folder = project) => {
    const dir = path.join(root, 'home', 'accounts', n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${n}@x.com` }, projects: { [folder]: { allowedTools: [], hasTrustDialogAccepted: ok } } }));
  };
  for (const n of names) setTrust(n, trusted.includes(n));
  const invocations = () => {
    const f = path.join(process.env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  return { root, project, store, invocations, setTrust };
}
const H = () => require(`${SRC}/core/health`);
const workers = () => require(`${SRC}/core/workers`);

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

test('command names, and parsing the strict JSON block: a refusal seen in the tool calls wins over what the worker claims', () => {
  const h = H();
  assert.equal(h.commandName('bin/researchctl status'), 'researchctl');
  assert.equal(h.commandName('ssh -o BatchMode=yes gpu-box true'), 'ssh');
  assert.equal(h.commandName('FOO=1 latexmk -v'), 'latexmk');
  assert.equal(h.commandName('python3 -c 1'), 'python3');
  const checks = h.checksOf({ healthChecks: CHECKS.map((c) => ({ name: c, cmd: c })) });
  const block = (results) => `ok\n\n\`\`\`relay-health\n${JSON.stringify({ results })}\n\`\`\``;
  const r = h.parseReport(block([
    { cmd: CHECKS[0], status: 'allowed', exit: 0 }, { cmd: CHECKS[1], status: 'allowed', exit: 0 },
    { cmd: CHECKS[2], status: 'allowed', exit: 255 }, { cmd: CHECKS[3], status: 'refused', exit: null },
  ]), checks);
  assert.equal(r.error, '');
  assert.deepEqual(r.results.map((x) => [x.name, x.status, x.exit]), [['researchctl', 'allowed', 0], ['python3', 'allowed', 0], ['ssh', 'allowed', 255], ['latexmk', 'refused', null]]);
  assert.deepEqual(h.problems({ results: r.results, trust: { trusted: true } }), ['1 refused (latexmk)', '1 failed (ssh exit 255)']);
  // the worker says "allowed", but the tool result was a permission refusal
  const lied = h.parseReport(block([{ cmd: CHECKS[0], status: 'allowed', exit: 0 }]), checks.slice(0, 1),
    [{ name: 'Bash', input: { command: CHECKS[0] }, error: true, errorText: 'Permission to use Bash has been denied.' }]);
  assert.equal(lied.results[0].status, 'refused');
  // no block at all: what the tool calls show, and the reason
  const none = h.parseReport('I ran them.', checks.slice(0, 2), [{ name: 'Bash', input: { command: CHECKS[0] } }]);
  assert.match(none.error, /no relay-health block/);
  assert.deepEqual(none.results.map((x) => x.status), ['allowed', 'not_run']);
  assert.match(h.parseReport('```relay-health\n{oops\n```', checks).error, /could not be read/);
});

test('workspace trust is read from the account\'s .claude.json (the folder or a parent), never changed', () => {
  const s = sandbox({ names: ['w1', 'w2', 'w3'], trusted: ['w1'] });
  const h = H();
  const acct = (n) => s.store.get(n);
  assert.equal(h.trustOf(acct('w1'), s.project).trusted, true);
  const no = h.trustOf(acct('w2'), s.project);
  assert.deepEqual([no.trusted, no.known], [false, true]);
  assert.match(no.fix, new RegExp(`projects\\["${s.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\]\\.hasTrustDialogAccepted to true in .*w2.*\\.claude\\.json`));
  s.setTrust('w3', true, path.dirname(s.project)); // trusted for a parent folder: covers the project too
  assert.equal(h.trustOf(acct('w3'), s.project).trusted, true);
  fs.rmSync(path.join(acct('w3').configDir, '.claude.json'));
  assert.deepEqual([h.trustOf(acct('w3'), s.project).trusted, h.trustOf(acct('w3'), s.project).known], [false, false]);
  const before = fs.readFileSync(path.join(acct('w2').configDir, '.claude.json'), 'utf8');
  h.trustOf(acct('w2'), s.project);
  assert.equal(fs.readFileSync(path.join(acct('w2').configDir, '.claude.json'), 'utf8'), before);
});

test('relay_health: one haiku/low job per worker runs the listed commands; results, trust and exact fixes; relay_status shows them', async () => {
  const s = sandbox({ health: { w2: { [CHECKS[2]]: 'refused', [CHECKS[3]]: 'refused' } }, trusted: ['w1'] });
  const r = await toolCall('relay_health', { cwd: s.project });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Worker health for .*: 4 health_checks/);
  assert.match(r.text, /w1@x\.com: health: ok, checked \d\d:\d\d/);
  assert.match(r.text, /w2@x\.com: health: 2 refused \(ssh, latexmk\), untrusted, checked \d\d:\d\d/);
  assert.match(r.text, /REFUSED ssh -o BatchMode=yes gpu-box true/);
  assert.match(r.text, /ok {6}bin\/researchctl status \(exit 0\)/);
  assert.match(r.text, /Fix: add "Bash\(ssh -o BatchMode=yes gpu-box true\)", "Bash\(latexmk -v\)" to Relay's Settings › Allowed commands/);
  assert.match(r.text, /w2@x\.com: workspace not trusted .* Fix: set projects\[".*"\]\.hasTrustDialogAccepted to true/);
  assert.match(r.text, /Relay does not change trust or permissions itself/);
  const inv = s.invocations();
  assert.equal(inv.length, 2);
  for (const i of inv) {
    assert.equal(i.behaviour, 'health');
    assert.equal(i.model, 'haiku');
    assert.equal(i.effort, 'low');
    assert.equal(i.resume, null);
    for (const t of ['Edit', 'Write']) assert.ok(i.disallowedTools.includes(t), 'no file edits');
    assert.ok(i.disallowedTools.some((d) => d.startsWith('Read(/') && d.includes(`${path.sep}projects${path.sep}**`)), 'no reading Relay\'s records');
    for (const c of CHECKS) assert.ok(i.prompt.includes(`. ${c}`), 'every listed command is in the prompt');
  }
  assert.deepEqual(inv.map((i) => i.account).sort(), ['w1', 'w2']);
  // stored under Relay's home, read by relay_status
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.RELAY_HOME, 'health.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 2);
  const status = await toolCall('relay_status', { cwd: s.project });
  assert.match(status.text, /Worker health in .*:\n {2}- w1@x\.com: health: ok, checked \d\d:\d\d\n {2}- w2@x\.com: health: 2 refused \(ssh, latexmk\), untrusted/);
  // one account only
  await toolCall('relay_health', { cwd: s.project, account: 'w1@x.com' });
  assert.equal(s.invocations().length, 3);
  assert.equal(s.invocations()[2].account, 'w1');
  assert.match((await toolCall('relay_health', { cwd: s.project, account: 'nobody' })).text, /No signed-in Claude worker account "nobody"/);
  assert.equal((await toolCall('relay_health', { cwd: '' })).isError, true);
});

test('at most every 6 hours per account and project unless asked; no relay-health block is a failed check', async () => {
  const s = sandbox();
  const h = H();
  await h.runDue({ cwds: [s.project] });
  assert.equal(s.invocations().length, 2);
  await h.runDue({ cwds: [s.project] });
  assert.equal(s.invocations().length, 2, 'fresh results are not checked again');
  await h.run({ cwd: s.project, force: true });
  assert.equal(s.invocations().length, 4, 'relay_health (on demand) always checks');
  process.env.RELAY_HEALTH_EVERY_MS = '1';
  process.env.FAKE_HEALTH_NOBLOCK = '1';
  await h.runDue({ cwds: [s.project] });
  assert.equal(s.invocations().length, 6, 'older than the interval: checked again');
  const rec = h.latest('w1', s.project);
  assert.equal(rec.error, '', 'the tool calls still show what ran');
  assert.deepEqual(rec.results.map((r) => r.status), ['allowed', 'allowed', 'allowed', 'allowed']);
});

test('worker choice: a job naming a refused command avoids that worker; an untrusted one is avoided; with none healthy it runs with a warning', async () => {
  const s = sandbox({ health: { w1: { [CHECKS[2]]: 'refused' } } });
  await H().run({ cwd: s.project });
  // w1 is first in line (registry order, both used just now: make w2 the least recently used one)
  s.store.update('w1', { lastUsed: 0 });
  s.store.update('w2', { lastUsed: Date.now() / 1000 });
  const ssh = await workers().runWorker({ task: 'Run the ablation on gpu-box over ssh and collect the logs.', cwd: s.project });
  assert.equal(ssh.accountName, 'w2', 'w1 refused ssh at its last check');
  assert.match(ssh.text, /\[relay\] health: not on w1@x\.com \(refused ssh\)/);
  // a job that needs no refused command may use w1 (which account it then gets also depends on the usage readings
  // the first job's background refresh writes, so only the choice itself is checked)
  const cfg = require(`${SRC}/core/project`).loadConfig(s.project).config;
  const plainChoice = H().choose({ cwd: s.project, config: cfg, text: 'Tidy the README.', workers: s.store.load().filter((a) => !a.desktop) });
  assert.deepEqual([[...plainChoice.avoid], plainChoice.warning, plainChoice.needed], [[], '', []]);
  const plain = await workers().runWorker({ task: 'Tidy the README.', cwd: s.project });
  assert.doesNotMatch(plain.text, /health:|HEALTH WARNING/);

  // w2 untrusted: avoided for every job in this project
  s.setTrust('w2', false);
  await H().run({ cwd: s.project });
  s.store.update('w1', { lastUsed: Date.now() / 1000 });
  s.store.update('w2', { lastUsed: 0 });
  const t = await workers().runWorker({ task: 'Tidy the README again.', cwd: s.project });
  assert.equal(t.accountName, 'w1');
  assert.match(t.text, /not on w2@x\.com \(workspace untrusted\)/);

  // every worker refuses latexmk: the job still runs, with a warning in its header (also for relay_start / relay_poll)
  process.env.FAKE_HEALTH = JSON.stringify({ w1: { [CHECKS[3]]: 'refused' }, w2: { [CHECKS[3]]: 'refused' } });
  s.setTrust('w2', true);
  await H().run({ cwd: s.project });
  const tex = await workers().runWorker({ task: 'Build the paper with latexmk.', cwd: s.project });
  assert.equal(tex.ok, true);
  assert.match(tex.text, /\[relay\] HEALTH WARNING: every worker failed its last health check for this job: w1@x\.com refused latexmk; w2@x\.com refused latexmk\. It runs anyway/);
  assert.match(tex.text, /Bash\(latexmk -v\)/, 'with the fix');
  const started = await toolCall('relay_start', { task: 'Build the paper with latexmk.', cwd: s.project });
  assert.match(started.text, /HEALTH WARNING/);
  const id = started.text.match(/Started job ([a-z0-9-]+)/)[1];
  const done = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(done.text, new RegExp(`## Job ${id} · DONE[^\\n]*\\n[^\\n]*\\nHEALTH WARNING`), done.text);
  // an account asked for explicitly is kept, with a warning
  process.env.FAKE_HEALTH = JSON.stringify({ w1: { [CHECKS[2]]: 'refused' } });
  await H().run({ cwd: s.project });
  const pinned = await workers().runWorker({ task: 'ssh into gpu-box', cwd: s.project, account: 'w1@x.com' });
  assert.equal(pinned.accountName, 'w1');
  assert.match(pinned.text, /HEALTH WARNING: the account asked for \(w1@x\.com\) failed its last health check/);
});
