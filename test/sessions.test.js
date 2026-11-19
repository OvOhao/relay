'use strict';
// Thread loss across accounts: a session is kept in the sign-in folder (CLAUDE_CONFIG_DIR) it ran under. Accounts
// whose `projects` folder is a symlink to ~/.claude/projects share their sessions; an account with a real `projects`
// folder of its own does not, and resuming a thread there failed with "No conversation found". Relay now carries the session (transcript + session folder) to the resuming account first, verified;
// waits for an account that has it when it cannot be copied; and hands the thread over to a new session (a note built
// from the thread's reports) when the session is gone, instead of failing.
// Driven with the fake Claude CLI in FAKE_TRANSCRIPTS mode: it keeps transcripts where Claude Code does and fails a
// --resume of a session that is not in its own account's projects folder, with the real CLI's message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');
const sessions = require(`${SRC}/core/sessions`);

// w1 and w2 share the hub's projects folder (symlinks, as Relay prepares them); w3 has a real one of its own.
function sandbox(plan = {}, { cwdName = 'project' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sessions-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0', FAKE_TRANSCRIPTS: '1', RELAY_BUSY_POLL_MS: '50',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT', 'FAKE_TOOLS', 'FAKE_CONTEXT', 'FAKE_CONTEXT_WINDOW', 'FAKE_HANDOFF_FAIL', 'RELAY_SESSION_WAIT_SEC']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(path.join(process.env.RELAY_HUB, 'projects'), { recursive: true });
  const project = path.join(root, cwdName);
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  const dirs = {};
  for (const n of ['w1', 'w2', 'w3']) {
    dirs[n] = path.join(root, 'home', 'accounts', n);
    fs.mkdirSync(dirs[n], { recursive: true });
    if (n === 'w3') fs.mkdirSync(path.join(dirs[n], 'projects'));
    else fs.symlinkSync(path.join(process.env.RELAY_HUB, 'projects'), path.join(dirs[n], 'projects'));
  }
  store.save([['lead', { desktop: true }], ['w1'], ['w2'], ['w3']].map(([n, extra = {}]) => ({ ...store.newAccount(n, dirs[n] || path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 0 });
  const invocations = () => {
    const f = path.join(process.env.FAKE_STATE, 'invocations.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const transcript = (acct, sid, cwd = project) => path.join(dirs[acct], 'projects', sessions.projectFolderName(cwd), `${sid}.jsonl`);
  return { root, project, store, dirs, invocations, transcript };
}
const workers = () => require(`${SRC}/core/workers`);
const memory = () => require(`${SRC}/core/memory`);

test('Claude Code\'s project folder name: non-alphanumerics to "-", over 200 characters cut and "-<hash>" (its string hash, base 36)', () => {
  assert.equal(sessions.projectFolderName('/Users/me/Projects/My project/research'), '-Users-me-Projects-My-project-research');
  assert.equal(sessions.strHash('hello'), 99162322, 'the 32-bit string hash (Java\'s hashCode)');
  assert.equal(sessions.strHash('a'.repeat(30)) | 0, sessions.strHash('a'.repeat(30)), 'stays a 32-bit integer');
  const long = `/tmp/${'x'.repeat(250)}`;
  const name = sessions.projectFolderName(long);
  assert.equal(name, `-tmp-${'x'.repeat(195)}-${Math.abs(sessions.strHash(long)).toString(36)}`);
  assert.equal(sessions.projectFolderName(`/tmp/${'x'.repeat(195)}`).length, 200, 'exactly 200: kept whole');
});

test('carry: the newest copy (transcript + session folder) goes into the target account under the cwd\'s folder, verified; a shared folder needs no copy', () => {
  const { project, dirs } = sandbox({}, { cwdName: `p ${'y'.repeat(230)}` });
  const all = Object.values(dirs).concat(process.env.RELAY_HUB);
  const name = sessions.projectFolderName(project);
  const hubFolder = path.join(process.env.RELAY_HUB, 'projects', name);
  fs.mkdirSync(path.join(hubFolder, 's-1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(hubFolder, 's-1', 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(hubFolder, 's-1.jsonl'), 'line1\nline2\n');
  fs.writeFileSync(path.join(hubFolder, 's-1', 'subagents', 'agent-a.jsonl'), 'sub');
  fs.writeFileSync(path.join(hubFolder, 's-1', 'tool-results', 'big.txt'), 'out'.repeat(1000));

  assert.deepEqual(sessions.carry(dirs.w2, 's-1', { cwd: project, configDirs: all }), { ok: true, copied: false }, 'w2 shares the hub folder');
  const r = sessions.carry(dirs.w3, 's-1', { cwd: project, configDirs: all });
  assert.equal(r.ok, true);
  assert.equal(r.copied, true);
  assert.equal(r.files, 2, 'subagents and tool-results came along');
  const w3Folder = path.join(dirs.w3, 'projects', name);
  assert.equal(fs.readFileSync(path.join(w3Folder, 's-1.jsonl'), 'utf8'), 'line1\nline2\n');
  assert.equal(fs.readFileSync(path.join(w3Folder, 's-1', 'tool-results', 'big.txt'), 'utf8').length, 3000);
  assert.ok(name.length > 200 && /-[0-9a-z]+$/.test(name), 'a long cwd: the hashed folder name');
  assert.equal(sessions.carry(dirs.w3, 's-1', { cwd: project, configDirs: all }).copied, false, 'already there: no second copy');
  assert.equal(fs.readdirSync(w3Folder).filter((f) => f.endsWith('.tmp')).length, 0, 'no temporary files left');

  // the session then ran on w3 (its copy grew): moving back to w1 carries w3's copy into the hub
  fs.appendFileSync(path.join(w3Folder, 's-1.jsonl'), 'line3 on w3\n');
  const back = sessions.carry(dirs.w1, 's-1', { cwd: project, configDirs: all });
  assert.equal(back.copied, true);
  assert.match(fs.readFileSync(path.join(hubFolder, 's-1.jsonl'), 'utf8'), /line3 on w3/);

  // written under another project folder (started from another cwd): still found, and put under this cwd's name
  fs.mkdirSync(path.join(process.env.RELAY_HUB, 'projects', '-elsewhere'), { recursive: true });
  fs.writeFileSync(path.join(process.env.RELAY_HUB, 'projects', '-elsewhere', 's-2.jsonl'), 'other\n');
  assert.equal(sessions.carry(dirs.w3, 's-2', { cwd: project, configDirs: all }).copied, true);
  assert.ok(fs.existsSync(path.join(w3Folder, 's-2.jsonl')));

  const none = sessions.carry(dirs.w3, 's-none', { cwd: project, configDirs: all });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'session_missing');
  assert.equal(sessions.carry(dirs.w3, '../../etc', { cwd: project, configDirs: all }).code, 'session_missing', 'not a session id: never a path');
});

test('a thread continued on an account with its own projects folder resumes the same session (it is carried first); and back again', async () => {
  const { project, invocations, transcript } = sandbox();
  const a = await workers().runWorker({ task: 'turn 1: remember TOKEN-7', cwd: project, thread: 't', account: 'w1' });
  assert.equal(a.ok, true, a.text);
  const sid = a.sessionId;
  assert.ok(fs.existsSync(transcript('w1', sid)));
  assert.ok(!fs.existsSync(transcript('w3', sid)), 'w3 does not see the hub');

  const b = await workers().runWorker({ task: 'turn 2: what was the token?', cwd: project, thread: 't', account: 'w3' });
  assert.equal(b.ok, true, b.text);
  assert.equal(b.sessionId, sid, 'the same session');
  assert.equal(b.accountName, 'w3');
  assert.doesNotMatch(b.text, /No conversation found|handoff/i);
  assert.match(b.text, /The session moved to w3: Relay copied it there first/);
  const inv = invocations();
  assert.equal(inv.filter((i) => i.behaviour === 'missing-session').length, 0, 'the CLI never failed to find it');
  assert.equal(inv[inv.length - 1].resume, sid);
  assert.equal(fs.readFileSync(transcript('w3', sid), 'utf8').trim().split('\n').length, 2, 'turn 1 carried over, turn 2 appended');

  const c = await workers().runWorker({ task: 'turn 3', cwd: project, thread: 't', account: 'w2' });
  assert.equal(c.ok, true, c.text);
  assert.equal(c.sessionId, sid, 'and back to a hub account: the same session, with turn 2 in it');
  assert.equal(fs.readFileSync(transcript('w2', sid), 'utf8').trim().split('\n').length, 3);
  const led = memory().readLedger(project).filter((e) => e.thread === 't');
  assert.ok(led[1].carried && led[1].carried[0].account === 'w3', 'the ledger notes the move');
});

test('failover on a usage limit to an account with its own projects folder: the same session continues there', async () => {
  const { project, invocations, store } = sandbox({ w1: ['ok', 'limit:3600'], w2: ['limit:3600'], w3: ['ok'] });
  const a = await workers().runWorker({ task: 'turn 1', cwd: project, thread: 'f', account: 'w1' });
  assert.equal(a.ok, true, a.text);
  const b = await workers().runWorker({ task: 'turn 2', cwd: project, thread: 'f' });
  assert.equal(b.ok, true, b.text);
  assert.equal(b.accountName, 'w3');
  assert.equal(b.sessionId, a.sessionId);
  assert.equal(invocations().filter((i) => i.behaviour === 'missing-session').length, 0);
  assert.ok(store.get('w1').blockedUntil > Date.now() / 1000);
});

test('a session that is gone everywhere: the thread is handed over to a new session with a note Relay builds; the job does not fail', async () => {
  const { project, invocations, transcript } = sandbox();
  const a = await workers().runWorker({ task: 'turn 1: build the parser', cwd: project, thread: 'g', account: 'w1' });
  assert.equal(a.ok, true, a.text);
  fs.rmSync(transcript('w1', a.sessionId));
  const b = await workers().runWorker({ task: 'turn 2: add tests', cwd: project, thread: 'g', account: 'w3' });
  assert.equal(b.ok, true, b.text);
  assert.notEqual(b.sessionId, a.sessionId, 'a new session');
  assert.match(b.text, /Session handoff 1: the thread's session could not be resumed on any account/);
  const inv = invocations();
  assert.equal(inv.filter((i) => i.behaviour === 'missing-session').length, 1, 'the CLI said so once; Relay found no copy to carry, so it handed over at once');
  const last = inv[inv.length - 1];
  assert.equal(last.resume, null);
  assert.match(last.prompt, /Handoff from this thread's previous session/);
  assert.match(last.prompt, /could not be found on any account/);
  assert.match(last.prompt, /turn 2: add tests/);
  const th = memory().getThread(project, 'g');
  assert.equal(th.sessionId, b.sessionId);
  assert.equal(th.handoffs, 1);
  assert.equal(th.sessions[0].reason, 'lost');
  assert.equal(th.sessions[0].noteBy, 'relay');
});

test('a session that cannot be copied waits for an account that has it (bounded); past the wait it is handed over instead', async () => {
  const { project, transcript, dirs, store } = sandbox();
  const a = await workers().runWorker({ task: 'turn 1', cwd: project, thread: 'h', account: 'w1' });
  assert.equal(a.ok, true, a.text);
  // w3 cannot take a copy: a folder sits where the transcript would go (the rename onto it fails)
  const w3Folder = path.dirname(transcript('w3', a.sessionId));
  fs.mkdirSync(transcript('w3', a.sessionId), { recursive: true });
  try {
    // w1 and w2 (which have it) are limited for a moment: the run waits for them rather than losing the session
    const until = Math.floor(Date.now() / 1000) + 2;
    store.markLimited('w1', until, 'usage');
    store.markLimited('w2', until, 'usage');
    process.env.RELAY_SESSION_WAIT_SEC = '60';
    const b = await workers().runWorker({ task: 'turn 2', cwd: project, thread: 'h' });
    assert.equal(b.ok, true, b.text);
    assert.equal(b.sessionId, a.sessionId, 'the same session');
    assert.ok(['w1', 'w2'].includes(b.accountName), `ran on an account that has it, not ${b.accountName}`);

    // limited for longer than the wait: handed over to a new session on w3 instead of failing
    const later = Math.floor(Date.now() / 1000) + 3600;
    store.markLimited('w1', later, 'usage');
    store.markLimited('w2', later, 'usage');
    process.env.RELAY_SESSION_WAIT_SEC = '1';
    const c = await workers().runWorker({ task: 'turn 3', cwd: project, thread: 'h' });
    assert.equal(c.ok, true, c.text);
    assert.equal(c.accountName, 'w3');
    assert.notEqual(c.sessionId, a.sessionId);
    assert.match(c.text, /Session handoff 1/);
  } finally {
    delete process.env.RELAY_SESSION_WAIT_SEC;
    void dirs;
    void w3Folder;
  }
});

test('"No conversation found" is its own outcome (session_missing), never a usage or context limit', () => {
  const be = require(`${SRC}/core/backends/claude`);
  const o = be.outcome({ sid: 's', result: { is_error: true, result: 'No conversation found with session ID: 44ea251b-77eb-4c1d-8cc2-1e7f4b1bae3b' } });
  assert.equal(o.kind, 'error');
  assert.equal(o.code, 'session_missing');
  assert.equal(be.outcome({ sid: 's', stderr: 'No conversation found with session ID: x', code: 1 }).code, 'session_missing');
});
