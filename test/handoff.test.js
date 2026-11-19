'use strict';
// Context handoff for long threads: a thread whose session is nearly full (proactive, from the usage the stream
// reports) or that fails with the context-limit error (reactive) continues in a new session that gets a handoff note.
// Driven with the fake Claude CLI (FAKE_CONTEXT reports the context size; RELAY_HANDOFF prompts get a note).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');

function sandbox(plan = {}, { minuteMs = 200 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-handoff-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0', RELAY_PARK_MINUTE_MS: String(minuteMs), RELAY_PARK_STEP_MS: '100',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT', 'FAKE_TOOLS', 'FAKE_CONTEXT', 'FAKE_CONTEXT_WINDOW', 'FAKE_SIDE_WINDOW', 'FAKE_HANDOFF_FAIL', 'RELAY_MAX_WAKES']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save([['lead', { desktop: true }], ['w1']].map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 0 });
  const invocations = () => {
    const f = path.join(process.env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  return { root, project, store, invocations };
}
const workers = () => require(`${SRC}/core/workers`);
const memory = () => require(`${SRC}/core/memory`);

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

test('backend: context size from assistant usage, the window from the result; "Prompt is too long" is a context limit, not a usage limit', () => {
  const be = require(`${SRC}/core/backends/claude`);
  const parse = require(`${SRC}/core/parse`);
  const acct = { name: 'w1' };
  const items = be.parseEvent({ type: 'assistant', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 139000 }, content: [{ type: 'text', text: 'hi' }] } }, acct);
  assert.deepEqual(items[0], { kind: 'context', account: 'w1', tokens: 140005 });
  assert.equal(be.parseEvent({ type: 'assistant', parent_tool_use_id: 'x', message: { usage: { input_tokens: 9 }, content: [] } }, acct).length, 0, 'a sub-agent\'s context is its own');
  const res = be.parseEvent({ type: 'result', is_error: false, modelUsage: { 'claude-x': { contextWindow: 1000000 } } }, acct);
  assert.deepEqual(res[0], { kind: 'context', account: 'w1', window: 1000000, windows: { 'claude-x': 1000000 } });
  // the shape a real 2.1.32x haiku run gave (live probe): the last call's input is 2 + 3164 + 26146; window 1M
  const live = be.parseEvent({ type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 3164, cache_read_input_tokens: 26146, output_tokens: 3 }, content: [] } }, acct);
  assert.deepEqual(live[0], { kind: 'context', account: 'w1', tokens: 29312 });
  const two = be.parseEvent({ type: 'result', is_error: false, modelUsage: { 'claude-haiku-5-5': { inputTokens: 4, contextWindow: 1000000 }, 'claude-small': { contextWindow: 200000 } } }, acct);
  assert.deepEqual(two[0].windows, { 'claude-haiku-5-5': 1000000, 'claude-small': 200000 }, 'each model\'s window: Relay takes the session model\'s');
  assert.equal(parse.looksLikeContextLimit('prompt is too long: 1012345 tokens > 1000000 maximum'), true);
  assert.equal(parse.looksLikeContextLimit('Input is too long for requested model.'), true);
  assert.equal(be.outcome({ sid: 's', result: { is_error: true, result: 'Prompt is too long' } }).code, 'context_limit');
  assert.equal(be.outcome({ sid: 's', result: { is_error: true, result: 'Context limit reached · /compact or /clear to continue' } }).code, 'context_limit');
  assert.equal(be.outcome({ sid: 's', result: { is_error: true, result: "You've hit your session limit · resets 3pm" } }).kind, 'limited');
  assert.equal(parse.looksLikeContextLimit('input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000'), true);
  assert.equal(parse.looksLikeContextLimit('all good'), false);
});

test('proactive: a thread over 70% of its window is handed off before the next call; the chain of sessions is kept', async () => {
  const s = sandbox({ w1: ['ok'] });
  process.env.FAKE_CONTEXT = '150000'; // 75% of the 200k window the fake reports
  const first = await workers().runWorker({ task: 'build the parser', cwd: s.project, thread: 'long' });
  assert.equal(first.ok, true, first.text);
  const t1 = memory().getThread(s.project, 'long');
  assert.deepEqual([t1.context.tokens, t1.context.window, t1.context.sessionId], [150000, 200000, first.sessionId]);
  const sessA = first.sessionId;

  process.env.FAKE_CONTEXT = '20000';
  const second = await workers().runWorker({ task: 'now add error recovery', cwd: s.project, thread: 'long' });
  assert.equal(second.ok, true, second.text);
  const inv = s.invocations();
  assert.deepEqual(inv.map((i) => i.behaviour), ['ok', 'handoff', 'ok']);
  assert.equal(inv[1].resume, sessA, 'the note is asked from the old session');
  assert.equal(inv[1].permissionMode, 'default', 'the note call changes nothing: default mode (not plan) ...');
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) assert.ok(inv[1].disallowedTools.includes(t), `... with ${t} denied`);
  assert.match(inv[1].prompt, /^RELAY_HANDOFF/);
  assert.equal(inv[2].resume, null, 'the work continues in a NEW session');
  assert.match(inv[2].prompt, /## Handoff from this thread's previous session \(handoff 1\)/);
  assert.match(inv[2].prompt, new RegExp(`FAKE HANDOFF NOTE from ${sessA}`), 'the note is in the new session\'s first prompt');
  assert.match(inv[2].prompt, /## Task\nnow add error recovery/, 'together with the new task');
  assert.match(inv[2].prompt, /You are a worker agent dispatched by Relay/, 'a full first prompt, not a follow-up');
  assert.notEqual(second.sessionId, sessA);
  assert.match(second.text, /handed off \(1\)/);
  assert.match(second.text, /Context handoff 1 \(the session was at 75% \(150k of 200k tokens\) of its context window\): the old session wrote a handoff note/);

  const t2 = memory().getThread(s.project, 'long');
  assert.equal(t2.sessionId, second.sessionId);
  assert.equal(t2.handoffs, 1);
  assert.equal(t2.sessions.length, 1);
  assert.equal(t2.sessions[0].id, sessA);
  assert.equal(t2.sessions[0].reason, 'proactive');
  assert.equal(t2.sessions[0].tokens, 150000);
  assert.ok(t2.sessions[0].note.startsWith(path.join(process.env.RELAY_HOME, '.relay-handoff')), 'the note lives under Relay\'s home');
  assert.ok(t2.sessions[0].note.endsWith(`${path.sep}long-1.md`));
  assert.match(fs.readFileSync(t2.sessions[0].note, 'utf8'), /FAKE HANDOFF NOTE/);
  assert.ok(!fs.existsSync(path.join(s.project, '.relay-handoff')), 'nothing is written into the project');
  assert.equal(t2.context.tokens, 20000);

  // below the threshold: the new session simply continues
  const third = await workers().runWorker({ task: 'small fix', cwd: s.project, thread: 'long' });
  assert.equal(s.invocations().at(-1).resume, second.sessionId);
  assert.doesNotMatch(third.text, /Context handoff/);

  // over it again: a second handoff, the chain grows
  process.env.FAKE_CONTEXT = '160000';
  await workers().runWorker({ task: 'more', cwd: s.project, thread: 'long' });
  process.env.FAKE_CONTEXT = '1000';
  const fifth = await workers().runWorker({ task: 'last', cwd: s.project, thread: 'long' });
  const t3 = memory().getThread(s.project, 'long');
  assert.equal(t3.handoffs, 2);
  assert.deepEqual(t3.sessions.map((x) => x.id), [sessA, second.sessionId]);
  assert.ok(fs.existsSync(path.join(path.dirname(t2.sessions[0].note), 'long-2.md')));
  assert.match(fifth.text, /handed off \(2\)/);
  const status = workers().statusText(s.project);
  assert.match(status, /"long" \([^)]*\) · handed off \(2\) · context 1%/);
});

test('the threshold is a setting; the window comes from the stream when it says so', async () => {
  const s = sandbox({ w1: ['ok'] });
  s.store.saveSettings({ handoffAt: 0.9 });
  process.env.FAKE_CONTEXT = '150000';
  await workers().runWorker({ task: 'a', cwd: s.project, thread: 't' });
  await workers().runWorker({ task: 'b', cwd: s.project, thread: 't' });
  assert.deepEqual(s.invocations().map((i) => i.behaviour), ['ok', 'ok'], '75% is under 90%: no handoff');
  process.env.FAKE_CONTEXT_WINDOW = '160000'; // a smaller model window: 150k is now 94%
  await workers().runWorker({ task: 'c', cwd: s.project, thread: 't' });
  await workers().runWorker({ task: 'd', cwd: s.project, thread: 't' });
  assert.deepEqual(s.invocations().map((i) => i.behaviour), ['ok', 'ok', 'ok', 'handoff', 'ok']);
});

test('reactive: a call that fails with "Prompt is too long" is handed off and run again in a new session', async () => {
  const s = sandbox({ w1: ['ok', 'too-long', 'ok'] });
  const first = await workers().runWorker({ task: 'step one', cwd: s.project, thread: 'r' });
  const out = await workers().runWorker({ task: 'step two', cwd: s.project, thread: 'r' });
  assert.equal(out.ok, true, out.text);
  const inv = s.invocations();
  assert.deepEqual(inv.map((i) => i.behaviour), ['ok', 'too-long', 'handoff', 'ok']);
  assert.equal(inv[1].resume, first.sessionId);
  assert.equal(inv[2].resume, first.sessionId);
  assert.equal(inv[3].resume, null);
  assert.match(inv[3].prompt, /FAKE HANDOFF NOTE/);
  assert.match(inv[3].prompt, /## Task\nstep two/);
  assert.match(out.text, /Context handoff 1 \(the session ran out of context during the run\)/);
  const t = memory().getThread(s.project, 'r');
  assert.equal(t.sessions[0].reason, 'reactive');
  assert.equal(t.sessions[0].noteBy, 'worker');
});

test('reactive, and the old session cannot write a note: Relay builds one from the thread\'s reports and ledger', async () => {
  const s = sandbox({ w1: ['ok', 'too-long', 'ok'] });
  await workers().runWorker({ task: 'step one', cwd: s.project, thread: 'r', title: 'Parser step one' });
  process.env.FAKE_HANDOFF_FAIL = '1';
  const out = await workers().runWorker({ task: 'step two', cwd: s.project, thread: 'r' });
  assert.equal(out.ok, true, out.text);
  const inv = s.invocations();
  assert.deepEqual(inv.map((i) => i.behaviour), ['ok', 'too-long', 'handoff', 'ok']);
  const p = inv[3].prompt;
  assert.match(p, /# Handoff note \(built by Relay: the previous session could not write one\)/);
  assert.match(p, /## Last result Relay recorded for this thread\n.*split \*\*parseExpr\*\*/, 'the thread\'s stored report');
  assert.match(p, /## Ledger entries of this thread/);
  assert.match(p, /Working on it, reading more files/, 'and what the failed run said last');
  assert.match(out.text, /the old session could not write a note, so Relay built one/);
  assert.equal(memory().getThread(s.project, 'r').sessions[0].noteBy, 'relay');
});

test('a parked job whose session is full is handed off at its wake; poll shows "handed off (1)"', async () => {
  const s = sandbox({ w1: ['park:5', 'ok'] });
  process.env.FAKE_CONTEXT = '180000';
  const jobs = require(`${SRC}/core/jobs`);
  const started = await toolCall('relay_start', { task: 'launch the long run', cwd: s.project, title: 'Long run' });
  const id = started.text.match(/Started job ([a-z0-9-]+)/)[1];
  const parked = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(parked.text, /PARKED/, parked.text);
  const rec = jobs.read(id);
  assert.equal(rec.context.tokens, 180000);
  const done = await toolCall('relay_wait', { job_ids: [id], timeout_sec: 30 });
  assert.match(done.text, new RegExp(`Job ${id} · DONE`), done.text);
  assert.match(done.text, /handed off \(1\)/);
  const inv = s.invocations();
  assert.deepEqual(inv.map((i) => i.behaviour), ['park:5', 'handoff', 'ok']);
  assert.equal(inv[1].resume, rec.sessionId);
  assert.equal(inv[2].resume, null);
  assert.match(inv[2].prompt, /FAKE HANDOFF NOTE/);
  assert.match(inv[2].prompt, /Scheduled check \(wake 1 of the job\)/, 'the new session gets the scheduled check');
  assert.match(inv[2].prompt, /launch the long run/, 'and the job\'s original task');
  const fin = jobs.read(id);
  assert.equal(fin.handoffs, 1);
  assert.equal(fin.sessions[0].id, rec.sessionId);
  assert.ok(fin.sessions[0].note.endsWith(`job-${id}-1.md`));
  const poll = await toolCall('relay_poll', { job_ids: [id] });
  assert.match(poll.text, /handed off \(1\)/);
});

test('the context window is the session model\'s, not a larger one another model in the run reported', async () => {
  const s = sandbox({ w1: ['ok'] });
  process.env.FAKE_CONTEXT = '150000';
  process.env.FAKE_SIDE_WINDOW = '1000000';
  const r = await workers().runWorker({ task: 'build the parser', cwd: s.project, thread: 'win' });
  assert.equal(r.ok, true, r.text);
  const t = memory().getThread(s.project, 'win');
  assert.equal(t.context.window, 200000, JSON.stringify(t.context));
  assert.equal(t.context.tokens, 150000);
});
