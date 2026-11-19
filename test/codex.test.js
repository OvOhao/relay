'use strict';
// The Codex backend (read-only jobs): command lines, events, the canary preflight, the read-only guard, failover only
// between Codex accounts, and Codex homes kept away from everything that handles Claude sign-in folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan, accounts) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-test-')));
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
  delete process.env.RELAY_TAKEOVER;
  delete process.env.FAKE_CODEX_PREFLIGHT;
  delete process.env.FAKE_CODEX_SIGNED_OUT;
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.txt'), 'some file to review\n');
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
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
  return { store, root, project, invocations, execs: () => invocations().filter((i) => i.kind === 'exec'), checks: () => invocations().filter((i) => i.kind === 'sandbox') };
}
const codexBackend = () => require(`${SRC}/core/backends`).getBackend('codex');
const CX = { provider: 'codex' };

test('codex command line: model required, effort, preset text, read-only profile, resume in the job folder', () => {
  sandbox({}, []);
  const codex = codexBackend();
  const cwd = path.join(os.tmpdir(), 'job');
  assert.throws(() => codex.buildArgs({ model: '', permissionMode: 'plan', cwd }), (e) => e.code === 'codex_model_required');
  assert.throws(() => codex.buildArgs({ model: 'gpt-x', permissionMode: 'acceptEdits', cwd }), (e) => e.code === 'codex_read_only');
  assert.throws(() => codex.buildArgs({ model: 'opus', permissionMode: 'plan', cwd }), (e) => e.code === 'codex_model');

  const a = codex.buildArgs({ model: 'gpt-x', effort: 'high', permissionMode: 'plan', appendSystemPrompt: 'Security "research"\nline 2', cwd });
  assert.deepEqual(a.slice(0, 4), ['exec', '--json', '-m', 'gpt-x']);
  assert.ok(a.includes('model_reasoning_effort="high"'));
  assert.ok(a.includes('developer_instructions="Security \\"research\\"\\nline 2"'), 'the preset goes in as a TOML string');
  assert.deepEqual(a.slice(-3), ['-C', cwd, '-'], 'new run: the job folder, prompt on stdin');
  assert.ok(!a.includes('-s') && !a.includes('--sandbox'), 'no -s: it overrides the permission profile');
  for (const f of ['plugins', 'apps', 'browser_use', 'computer_use']) assert.ok(a.join(' ').includes(`--disable ${f}`), `${f} off`);
  for (const f of ['--ignore-user-config', '--ignore-rules', 'mcp_servers={}', 'approval_policy="never"', 'sandbox_mode="read-only"', 'default_permissions="relay-review"', 'shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null"}']) assert.ok(a.includes(f), f);
  assert.ok(!a.some((x) => /dangerously/.test(x)), 'never a bypass flag');
  const perms = a.find((x) => x.startsWith('permissions='));
  assert.ok(perms.includes(`${JSON.stringify(os.homedir())}="deny"`), 'home denied');
  assert.ok(perms.includes(`${JSON.stringify(cwd)}="read"`), 'the job folder readable');
  assert.ok(!perms.includes('"write"'), 'nothing writable');

  const r = codex.buildArgs({ sessionId: 'sess-1', model: 'gpt-x', effort: 'low', permissionMode: 'plan', cwd });
  assert.deepEqual(r.slice(0, 3), ['exec', 'resume', '--json']);
  assert.deepEqual(r.slice(-2), ['sess-1', '-']);
  assert.ok(!r.includes('-C') && !r.includes('-s'), 'resume accepts neither -C nor -s');
  assert.ok(r.includes('model_reasoning_effort="low"') && r.includes('gpt-x') && r.includes('sandbox_mode="read-only"'), 'model, effort and sandbox passed again');
  assert.equal(r.find((x) => x.startsWith('permissions=')), perms, 'the same profile on resume');

  const e = codex.env({ configDir: '/x/codex-home' }, { RELAY_TAKEOVER: '1' });
  assert.equal(e.CODEX_HOME, '/x/codex-home');
  assert.equal(e.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.ok(!Object.keys(e).some((k) => /^(OPENAI_|ANTHROPIC_|CLAUDE_CONFIG_DIR$)/.test(k)));
  assert.ok(codex.unsafeCwd(os.homedir()), 'home itself is refused');
  assert.ok(codex.unsafeCwd(path.join(os.homedir(), '.ssh')), 'a credential folder is refused');
  assert.ok(codex.unsafeCwd(process.env.RELAY_HOME), 'Relay\'s own folder is refused');
  assert.equal(codex.unsafeCwd(cwd), null);
});

test('codex events become transcript items; results, limits and auth failures are told apart', () => {
  const codex = codexBackend();
  const acct = { name: 'cx' };
  const ctx = { model: 'gpt-x' };
  const p = (ev) => codex.parseEvent(ev, acct, ctx);
  assert.equal(codex.sessionIdFrom({ type: 'thread.started', thread_id: 't-1' }), 't-1');
  assert.deepEqual(p({ type: 'thread.started', thread_id: 't-1' }), [{ kind: 'init', account: 'cx', model: 'gpt-x' }]);
  const cmd = { id: 'i0', type: 'command_execution', command: 'rg --files' };
  assert.deepEqual(p({ type: 'item.started', item: cmd }), [{ kind: 'tool', account: 'cx', name: 'Bash', summary: 'rg --files', input: { command: 'rg --files' } }]);
  assert.deepEqual(p({ type: 'item.completed', item: cmd }), [], 'one tool item per command');
  assert.deepEqual(p({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'The report.' } }), [{ kind: 'text', account: 'cx', text: 'The report.' }]);
  assert.deepEqual(p({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/p/a.txt', kind: 'add' }] } }), [{ kind: 'tool', account: 'cx', name: 'Edit', summary: '/p/a.txt', input: { file_path: '/p/a.txt' } }]);
  assert.equal(p({ type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', server: 's', tool: 't', arguments: {} } })[0].name, 'mcp__s__t');
  assert.equal(p({ type: 'item.completed', item: { id: 'i4', type: 'error', message: 'Model metadata not found' } })[0].kind, 'notice');
  assert.deepEqual(p({ type: 'turn.completed', usage: {} }), [{ kind: 'result', account: 'cx', ok: true }]);
  assert.deepEqual(p({ type: 'unknown.future' }), []);

  // an `error` stands in for the result until the turn ends, and never replaces a finished turn
  const prov = codex.resultFrom({ type: 'error', message: 'Reconnecting... 1/5' }, null);
  assert.equal(prov.provisional, true);
  const done = codex.resultFrom({ type: 'turn.completed', usage: {} }, prov);
  assert.equal(done.ok, true);
  assert.equal(codex.resultFrom({ type: 'error', message: 'late' }, done), null);
  assert.equal(codex.outcome({ sid: 's', result: done }).kind, 'done');

  const lim = codex.outcome({ sid: 's', result: { ok: false, message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 15th, 2026 5:02 PM." } });
  assert.equal(lim.kind, 'limited');
  assert.equal(lim.resetAt, new Date(2026, 10, 15, 17, 2).getTime() / 1000);
  assert.equal(codex.outcome({ sid: 's', result: { ok: false, message: 'Quota exceeded. Check your plan and billing details.' } }).kind, 'limited');
  const today = codex.parseCodexReset('or try again at 5:02 PM.', new Date(2026, 10, 15, 9, 0).getTime());
  assert.equal(today, new Date(2026, 10, 15, 17, 2).getTime() / 1000);
  assert.equal(codex.outcome({ sid: 's', result: { ok: false, message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } }).kind, 'auth');
  assert.equal(codex.outcome({ sid: 's', result: { ok: false, message: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.' } }).kind, 'auth');
  const bad = codex.outcome({ sid: 's', result: { ok: false, message: '{"error":{"code":"model_not_found"}}' } });
  assert.equal(bad.kind, 'error', 'a model the account cannot use is a configuration error, not a reason to switch accounts');
  assert.equal(codex.outcome({ sid: null, result: null, stderr: '', code: 2 }).text, 'codex exited with code 2');

  const u = codex.rowsFromRateLimits({ primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1794722566 }, secondary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1794700000 }, planType: 'pro' });
  assert.deepEqual([u.week.pct, u.week.resetsAt, u.session.pct], [60, 1794722566, 5]);
  assert.equal(codex.rowsFromRateLimits({ primary: { usedPercent: 60, windowDurationMins: 10080 }, secondary: null }).session, null, 'Pro: a weekly window only');
});

test('agent "codex" refuses a job that is not read-only, and a Claude thread cannot move to Codex', async () => {
  const s = sandbox({}, [['lead', { desktop: true }], ['w1'], ['cx1', CX]]);
  const { runWorker } = require(`${SRC}/core/workers`);
  const r = await runWorker({ task: 'review', cwd: s.project, agent: 'codex' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  assert.match(r.text, /read-only/);
  const m = await runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true, model: 'opus' });
  assert.equal(m.code, 'bad_request');
  assert.match(m.text, /Claude model/);
  const x = await runWorker({ task: 'x', cwd: s.project, agent: 'gemini', readOnly: true });
  assert.equal(x.code, 'bad_request');
  assert.deepEqual(s.invocations(), [], 'nothing was started');

  const first = await runWorker({ task: 'one', cwd: s.project, thread: 'claude-line' });
  assert.equal(first.ok, true);
  const moved = await runWorker({ task: 'two', cwd: s.project, thread: 'claude-line', agent: 'codex', readOnly: true });
  assert.equal(moved.code, 'bad_request');
  assert.match(moved.text, /runs on claude/);
  assert.equal(s.execs().length, 0);
});

test('a read-only codex job: preflight with the same profile, report, verified sandbox; then a resume', async () => {
  const s = sandbox({ cx1: ['ok', 'ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', CX]]);
  const { runWorker, statusText } = require(`${SRC}/core/workers`);
  const memory = require(`${SRC}/core/memory`);
  const r = await runWorker({ task: 'review a.txt', cwd: s.project, agent: 'codex', readOnly: true, thread: 'audit', effort: 'medium', preset: 'security' });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Review by cx1: no problems found/);
  assert.match(r.text, /Codex worker cx1 · model gpt-test/);
  assert.match(r.text, /job folder unchanged/);
  assert.match(r.text, /Sandbox: verified/);
  assert.match(r.text, /Preflight canary check: passed/);
  assert.equal(r.sandbox.status, 'ok');
  const [check] = s.checks();
  const [run] = s.execs();
  assert.ok(check, 'the canary check ran');
  assert.equal(check.cwd, s.project);
  const prof = (args) => args.find((x) => x.startsWith('permissions='));
  assert.equal(prof(check.args), prof(run.args), 'the check used exactly the profile of the run');
  assert.ok(check.args.includes('-P') && check.args.includes('relay-review'));
  assert.equal(run.model, 'gpt-test', 'the account\'s model');
  assert.equal(run.effort, '"medium"');
  assert.match(run.developer, /Security research/, 'the preset text as developer instructions');
  assert.equal(run.dashC, s.project);
  assert.equal(memory.getThread(s.project, 'audit').provider, 'codex');
  assert.match(memory.ledgerText(s.project), /cx1 \(codex gpt-test\)/);
  assert.match(statusText(), /cx1 \[codex worker, read-only jobs only/);

  const again = await runWorker({ task: 'and the other file?', cwd: s.project, readOnly: true, thread: 'audit' });
  assert.equal(again.ok, true, again.text);
  assert.match(again.text, /\(resumed\)/);
  const second = s.execs()[1];
  assert.equal(second.resume, r.sessionId, 'the same Codex session');
  assert.equal(second.cwd, s.project, 'resume started in the original folder');
  assert.equal(second.model, 'gpt-test', 'model passed again');
  assert.equal(prof(second.args), prof(run.args), 'profile passed again');
  assert.equal(s.checks().length, 2, 'a preflight before the resume too');
  assert.equal(s.invocations().filter((i) => !i.kind).length, 0, 'no Claude worker ran');
});

test('a failed canary check refuses the job and starts nothing', async () => {
  const s = sandbox({ cx1: ['ok'] }, [['lead', { desktop: true }], ['cx1', CX]]);
  process.env.FAKE_CODEX_PREFLIGHT = 'fail';
  try {
    const { runWorker } = require(`${SRC}/core/workers`);
    const memory = require(`${SRC}/core/memory`);
    const r = await runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'codex_sandbox_unsafe');
    assert.match(r.text, /canary file under ~\/\.relay was readable/);
    assert.equal(s.checks().length, 1);
    assert.equal(s.execs().length, 0, 'no Codex run was started');
    assert.match(memory.ledgerText(s.project), /FAILED \(codex_sandbox_unsafe\)/);
  } finally {
    delete process.env.FAKE_CODEX_PREFLIGHT;
  }
});

test('the read-only guard: a file changed in the job folder, or another profile in the rollout, fails the job', async () => {
  const s = sandbox({ cx1: ['write', 'badprofile'] }, [['lead', { desktop: true }], ['cx1', CX]]);
  const { runWorker } = require(`${SRC}/core/workers`);
  const memory = require(`${SRC}/core/memory`);
  const r = await runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true, thread: 'g' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'guard_violation');
  assert.match(r.text, /added codex-wrote\.txt/);
  assert.match(memory.ledgerText(s.project), /FAILED \(guard_violation\)/);

  fs.rmSync(path.join(s.project, 'codex-wrote.txt'));
  const p = await runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true });
  assert.equal(p.code, 'guard_violation');
  assert.match(p.text, /(did not run under|not running under) the required sandbox|did not run under the expected sandbox/);
  assert.match(p.text, /permission profile ":workspace".*writable/);
});

test('the rollout check reads both rollout formats: codex-cli 0.153.4 and 0.170.0', () => {
  const s = sandbox({}, [['cx1', CX]]);
  const codex = codexBackend();
  const acct = s.store.get('cx1');
  const day = path.join(acct.configDir, 'sessions', '2026', '11', '18');
  fs.mkdirSync(day, { recursive: true });
  const h = os.homedir();
  const P = (p, access) => ({ path: { type: 'path', path: p }, access });
  const write = (sid, recs) => fs.writeFileSync(path.join(day, `rollout-2026-11-18T09-36-26-${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // 0.153.4: turn_context with file_system_sandbox_policy only
  write('old-1', [{ type: 'turn_context', payload: { active_permission_profile: { id: 'relay-review' }, file_system_sandbox_policy: { kind: 'restricted', entries: [P(h, 'deny'), P(s.project, 'read')] }, sandbox_policy: { type: 'read-only' } } }]);
  assert.equal(codex.verifyRun(acct, 'old-1').status, 'ok');
  // 0.170.0 (real shape, 2026-11-18): more record types, permission_profile next to file_system_sandbox_policy, a
  // special :minimal entry and Codex's own read entry for its helper folder under CODEX_HOME/tmp/arg0-macos
  const entries = [P(h, 'deny'), P(path.join(h, '.local', 'bin'), 'read'), P(s.project, 'read'), { path: { type: 'special', value: { kind: 'minimal' } }, access: 'read' }, P(path.join(acct.configDir, 'tmp', 'arg0-macos', 'codex-arg0To9KRB'), 'read')];
  const ctx = (extra = {}) => ({ type: 'turn_context', payload: { turn_id: 't', cwd: s.project, approval_policy: 'never', active_permission_profile: { id: 'relay-review' }, file_system_sandbox_policy: { kind: 'restricted', entries }, permission_profile: { type: 'managed', file_system: { type: 'restricted', entries } }, sandbox_policy: { type: 'read-only' }, model: 'gpt-6.2-astra', effort: 'low', ...extra } });
  const around = [{ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { permission_profile: { type: 'managed' } } } }, { type: 'token_usage_record', payload: { turn_id: 't' } }];
  write('new-1', [{ type: 'session_meta', payload: { session_id: 'new-1' } }, { type: 'world_state', payload: { full: true } }, ctx(), ...around, ctx(), ...around]);
  const v = codex.verifyRun(acct, 'new-1');
  assert.equal(v.status, 'ok', v.text);
  assert.equal(v.turns, 2);
  // a later turn without the profile is still caught in the new format
  write('new-2', [ctx(), ...around, ctx({ active_permission_profile: null }), ...around]);
  assert.equal(codex.verifyRun(acct, 'new-2').status, 'violation');
  assert.match(codex.verifyRun(acct, 'new-2').text, /turn 2: permission profile null/);
});

test('a run whose session starts without the profile is stopped at once, before it can do anything', async () => {
  const s = sandbox({ cx1: ['badprofile-hang'] }, [['lead', { desktop: true }], ['cx1', CX]]);
  const { runWorker } = require(`${SRC}/core/workers`);
  const t0 = Date.now();
  const r = await runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true });
  assert.ok(Date.now() - t0 < 10000, 'stopped right away, not when the run ends');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'guard_violation');
  assert.match(r.text, /Stopped at the start: the session is not running under the required sandbox/);
});

test('codex failover: a limited Codex account hands over only to another Codex account, starting fresh there', async () => {
  const s = sandbox({ cx1: ['limit'], cx2: ['ok'], w1: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', CX], ['cx2', CX]]);
  const { runWorker } = require(`${SRC}/core/workers`);
  const r = await runWorker({ task: 'review', cwd: s.project, agent: 'codex', readOnly: true, account: 'cx1' });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(s.execs().map((i) => i.account), ['cx1', 'cx2']);
  assert.equal(s.execs()[1].resume, null, 'a Codex session cannot move between homes: a fresh start');
  assert.match(s.execs()[1].prompt, /## Task\nreview/, 'with the original prompt');
  assert.equal(s.invocations().filter((i) => !i.kind).length, 0, 'the Claude worker was never used');
  const cx1 = s.store.get('cx1');
  assert.ok(cx1.blockedUntil > Date.now() / 1000, 'cx1 is parked until its reset');

  // and an auth failure flags the account and moves on the same way
  const t = sandbox({ cx1: ['auth'], cx2: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', CX], ['cx2', CX]]);
  const r2 = await runWorker({ task: 'review', cwd: t.project, agent: 'codex', readOnly: true, account: 'cx1' });
  assert.equal(r2.ok, true, r2.text);
  assert.equal(t.store.get('cx1').needsLogin, true);
  assert.deepEqual(t.execs().map((i) => i.account), ['cx1', 'cx2']);

  // with no Codex account left, a Claude account is still never used for a codex job
  const u = sandbox({ cx1: ['limit'], w1: ['ok'] }, [['lead', { desktop: true }], ['w1'], ['cx1', CX]]);
  const r3 = await runWorker({ task: 'review', cwd: u.project, agent: 'codex', readOnly: true });
  assert.equal(r3.code, 'workers_limited');
  assert.equal(u.invocations().filter((i) => !i.kind).length, 0);
});

test('Codex usage and login: app-server rate limits become the panel\'s week row; login status is local', async () => {
  const s = sandbox({}, [['cx1', CX], ['cx2', CX]]);
  process.env.FAKE_CODEX_SIGNED_OUT = 'cx2';
  try {
    const usage = require(`${SRC}/core/usage`);
    const codex = codexBackend();
    const got = await usage.refresh('cx1');
    assert.equal(got.data.week.pct, 40);
    assert.equal(got.data.session, null);
    assert.equal(s.store.get('cx1').plan, 'pro');
    assert.deepEqual(await codex.loginStatus(s.store.get('cx1')), { loggedIn: true });
    assert.deepEqual(await codex.loginStatus(s.store.get('cx2')), { loggedIn: false });
    const bad = await codex.readUsage(s.store.get('cx2'));
    assert.ok(bad.error && bad.authFailed);
  } finally {
    delete process.env.FAKE_CODEX_SIGNED_OUT;
  }
});

test('Codex homes: never adopted or probed as Claude folders, never synced, never deleted', async () => {
  const s = sandbox({}, [['lead', { desktop: true }], ['cx1', CX]]);
  const home = process.env.RELAY_HOME;
  const codexRoot = path.join(home, 'codex');
  fs.mkdirSync(path.join(codexRoot, 'uni'), { recursive: true }); // a Codex home nobody registered yet
  fs.mkdirSync(path.join(home, 'accounts', 'orphan'), { recursive: true }); // a real Claude orphan: the control
  const outside = path.join(s.root, 'elsewhere-codex');
  fs.mkdirSync(outside);
  s.store.upsert({ ...s.store.newAccount('cx-out', outside), provider: 'codex', model: 'gpt-test' });
  s.store.saveSettings({ extraAccountRoots: [codexRoot, s.root] }); // even listed as extra roots by hand

  const { adoptOrphans } = require(`${SRC}/core/reconcile`);
  const adopted = await adoptOrphans();
  assert.ok(adopted.includes('orphan'), 'the Claude orphan is adopted');
  for (const n of ['uni', 'cx1', 'codex', 'elsewhere-codex', 'home']) assert.ok(!adopted.includes(n), `${n} is not adopted`);
  assert.ok(!s.store.accountRoots().includes(codexRoot));

  assert.equal(s.store.ownsConfigDir(path.join(codexRoot, 'cx1')), false);
  assert.equal(s.store.ownsConfigDir(path.join(codexRoot, 'uni')), false);
  assert.equal(s.store.ownsConfigDir(outside), false);
  const setup = require(`${SRC}/core/setup`);
  assert.throws(() => setup.removeConfigDir(path.join(codexRoot, 'cx1')), /refusing to delete/);
  setup.syncAllAccounts();
  assert.deepEqual(fs.readdirSync(path.join(codexRoot, 'cx1')), [], 'no Claude settings copied into a Codex home');

  const connect = require(`${SRC}/core/connect`);
  await connect.removeAll({ logins: true });
  assert.ok(fs.existsSync(path.join(codexRoot, 'cx1')) && fs.existsSync(path.join(codexRoot, 'uni')), 'remove-all --logins keeps Codex homes');
  assert.ok(fs.existsSync(outside));
  assert.ok(!fs.existsSync(path.join(home, 'accounts')), 'Claude sign-in folders are removed as before');
});

test('registering a Codex account: an existing home outside the Claude accounts folder and a Codex model', async () => {
  const s = sandbox({}, [['lead', { desktop: true }]]);
  const codex = codexBackend();
  const dir = path.join(process.env.RELAY_HOME, 'codex', 'pro');
  await assert.rejects(codex.register({ name: 'pro', codexHome: dir, model: 'gpt-x' }), /not found/);
  fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(codex.register({ name: 'pro', codexHome: dir, model: '' }), /needs a model/);
  await assert.rejects(codex.register({ name: 'pro', codexHome: dir, model: 'sonnet' }), /Claude model/);
  const inAccounts = path.join(process.env.RELAY_HOME, 'accounts', 'cx');
  fs.mkdirSync(inAccounts, { recursive: true });
  await assert.rejects(codex.register({ name: 'cx', codexHome: inAccounts, model: 'gpt-x' }), /accounts folder/);
  await assert.rejects(codex.register({ name: 'mine', codexHome: path.join(os.homedir(), '.codex'), model: 'gpt-x' }), /your own Codex|not found/);
  const r = await codex.register({ name: 'pro', codexHome: dir, model: 'gpt-x' });
  assert.deepEqual([r.name, r.loggedIn], ['pro', true]);
  const a = s.store.get('pro');
  assert.deepEqual([a.provider, a.model, a.configDir, a.needsLogin], ['codex', 'gpt-x', dir, false]);
  await assert.rejects(codex.register({ name: 'pro2', codexHome: dir, model: 'gpt-x' }), /already registered/);
});
