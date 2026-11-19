'use strict';
// The folder file lists behind change attribution and the Codex read-only guard (core/project.js listFiles /
// snapshot / compareSnapshots): git ls-files normally; when it fails, a walk that leaves out ignored files and stops
// at a time budget; two lists made differently are never compared file by file (no flood of fake changes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const P = () => require(path.join(__dirname, '..', 'src', 'core', 'project'));

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fp-test-')));
  const w = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('.gitignore', '.venv/\n.pytest_cache/\n*.log\n');
  w('src/a.py', 'a');
  w('ideas/i1/plan.md', 'plan');
  for (let i = 0; i < 30; i++) w(`.venv/lib/pkg${i}/mod.py`, 'ignored');
  w('.pytest_cache/README.md', 'ignored');
  w('run.log', 'ignored');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init']);
  w('notes/untracked.md', 'new, not ignored');
  const flag = path.join(path.dirname(root), `${path.basename(root)}-lsfail`);
  process.env.RELAY_TEST_LS_FILES_FAIL = flag;
  return { root, w, flag, fail: (n = 'always') => fs.writeFileSync(flag, String(n)), ok: () => fs.rmSync(flag, { force: true }) };
}

test('git mode lists tracked and untracked files, never ignored ones; the walk fallback leaves ignored ones out too', async () => {
  const r = repo();
  const git = await P().listFiles(r.root);
  assert.equal(git.mode, 'git');
  const walk = await P().listFiles(r.root, { walkOnly: true });
  assert.equal(walk.mode, 'walk');
  assert.equal(walk.truncated, false);
  const sorted = (x) => [...x].sort();
  assert.deepEqual(sorted(walk.names), sorted(git.names), 'the walk lists what git lists');
  assert.ok(!walk.names.some((n) => n.startsWith('.venv/') || n.startsWith('.pytest_cache/') || n === 'run.log'), walk.names.join(','));
  assert.ok(walk.names.includes('notes/untracked.md') && walk.names.includes('.gitignore'));

  // not a git project: every file, no cap
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fp-plain-')));
  for (let i = 0; i < 5; i++) { fs.mkdirSync(path.join(plain, `.venv/d${i}`), { recursive: true }); fs.writeFileSync(path.join(plain, `.venv/d${i}/f`), 'x'); }
  const p = await P().listFiles(plain);
  assert.equal(p.mode, 'walk');
  assert.equal(p.names.length, 5);
  assert.equal(p.errors.length, 0, 'not a repository is not a git failure');
});

test('the walk stops at its time budget and says it is truncated (no file-count cap)', async () => {
  const r = repo();
  const w = await P().walkFiles(r.root, { budgetMs: -1 });
  assert.equal(w.truncated, true);
  assert.match(w.why, /stopped at its .* time budget/);
});

test('a git failure is retried, logged with its reason, and a walk on one side is never diffed file by file against git on the other', async () => {
  const r = repo();
  const p = P();
  const before = await p.snapshot(r.root, null);
  assert.equal(before.info.mode, 'git');
  r.w('src/a.py', 'changed by the job');

  // after: git fails once, the retry works: a normal comparison
  r.fail(1);
  const logs = [];
  const once = await p.compareSnapshots(r.root, null, before, { log: (m) => logs.push(m) });
  assert.equal(once.unverifiable, '');
  assert.deepEqual(once.changes.map((c) => [path.relative(r.root, c.abs), c.kind]), [['src/a.py', 'changed']]);
  assert.match(logs[0], /git ls-files failed in .*: exit 128: simulated git ls-files failure \(test\) \(\d+\.\d s\)/);

  // after: git fails twice (walk), then once more when retaken in git mode: UNVERIFIABLE, no changes listed
  r.fail(3);
  const bad = await p.compareSnapshots(r.root, null, before, { log: () => {} });
  assert.deepEqual(bad.changes, []);
  assert.match(bad.unverifiable, /^before the job: git ls-files; after it: git ls-files failed \(exit 128: simulated/);

  // after: git fails twice (walk), the git retake works: compared in git mode
  r.fail(2);
  const retaken = await p.compareSnapshots(r.root, null, before, { log: () => {} });
  assert.equal(retaken.unverifiable, '');
  assert.deepEqual(retaken.changes.map((c) => path.relative(r.root, c.abs)), ['src/a.py'], 'no .venv / .pytest_cache "added"');

  // before made by the walk (git failed then), after by git: the after side is retaken as a walk, and compared
  r.fail(2);
  const walkBefore = await p.snapshot(r.root, null, { log: () => {} });
  assert.equal(walkBefore.info.mode, 'walk');
  r.ok();
  r.w('ideas/i1/plan.md', 'edited');
  const mixed = await p.compareSnapshots(r.root, null, walkBefore, { log: () => {} });
  assert.equal(mixed.unverifiable, '');
  assert.deepEqual(mixed.changes.map((c) => path.relative(r.root, c.abs)), ['ideas/i1/plan.md']);

  // a truncated before list can never be compared
  const truncated = await p.snapshot(r.root, null, { walkOnly: true });
  truncated.info = { ...truncated.info, truncated: true, why: 'the walk stopped at its 60 s time budget (12 files so far)' };
  const t = await p.compareSnapshots(r.root, null, truncated, { log: () => {} });
  assert.deepEqual(t.changes, []);
  assert.match(t.unverifiable, /before the job: a directory walk that is incomplete \(the walk stopped at its 60 s time budget/);
  r.ok();
});
