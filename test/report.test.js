'use strict';
// Which text is the worker's report: a short note written after the report (a background task's notification woke
// the worker) must not replace it. Unit tests of pickReport, then one run with the fake Claude CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const SRC = path.join(__dirname, '..', 'src');
const SUMMARY = '```relay-summary\n{"status": "done", "run_ids": [], "key_files": ["a.txt"], "checks": [], "decisions_needed": [], "next_step": ""}\n```';
const text = (t) => ({ kind: 'text', text: t });
const tool = { kind: 'tool', text: '' };

function sandbox(plan = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-report-test-')));
  Object.assign(process.env, {
    RELAY_HOME: path.join(root, 'home'), RELAY_HUB: path.join(root, 'hub'), FAKE_STATE: path.join(root, 'state'),
    FAKE_PLAN: JSON.stringify(plan), RELAY_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE]),
    RELAY_TICK: '0.05', RELAY_SLACK: '0',
  });
  for (const k of ['RELAY_TAKEOVER', 'FAKE_DELAY_MS', 'FAKE_REPORT_CHARS', 'FAKE_REPORT', 'FAKE_POSTSCRIPT', 'FAKE_TOOLS', 'FAKE_WRITE', 'FAKE_CONTEXT']) delete process.env[k];
  fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });
  fs.mkdirSync(process.env.RELAY_HUB, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = require(`${SRC}/core/store`);
  store.save([['lead', { desktop: true }], ['w1']].map(([n, extra = {}]) => ({ ...store.newAccount(n, path.join(root, 'home', 'accounts', n), `${n}@x.com`), ...extra })));
  store.saveSettings({ jobsPerWorker: 0 });
  return { root, project };
}
const workers = () => require(`${SRC}/core/workers`);

test('pickReport: one final text is the report, as before; narration before a tool call is not a report', () => {
  const { pickReport } = workers();
  assert.deepEqual(pickReport([]), { text: '', main: '', postscript: [] });
  assert.equal(pickReport([text('Let me look.'), tool, text('All done: fixed it.')]).text, 'All done: fixed it.');
  // a run that ended on a tool call (no text ended a turn): the last text, as before
  assert.equal(pickReport([text('Reading the files first, then a long explanation of the plan.'), tool]).text, 'Reading the files first, then a long explanation of the plan.');
});

test('pickReport: the text with the relay-summary block is the report; later texts follow under Postscript', () => {
  const { pickReport } = workers();
  const report = `# Review\n\nLong findings here.\n\n${SUMMARY}`;
  const r = pickReport([text('Let me look.'), tool, text(report), tool, text('Background job finished; its log is clean.')]);
  assert.equal(r.main, report);
  assert.deepEqual(r.postscript, ['Background job finished; its log is clean.']);
  assert.match(r.text, /^# Review[\s\S]*relay-summary[\s\S]*\n## Postscript\n[\s\S]*Background job finished; its log is clean\.$/);
  // the last block wins when several texts carry one (a corrected report)
  const second = `Corrected report.\n\n${SUMMARY}`;
  assert.equal(pickReport([text(report), text(second), text('ps')]).main, second);
});

test('pickReport: without a summary block, the longest text that ended a turn is the report', () => {
  const { pickReport } = workers();
  const report = 'Did the work. '.repeat(30).trim();
  const r = pickReport([text('A long narration before a tool call, longer than anything else in this run by far. '.repeat(10)), tool, text(report), text('Task notification: done.'), tool, text('PS: ok.')]);
  assert.equal(r.main, report);
  assert.deepEqual(r.postscript, ['Task notification: done.', 'PS: ok.']);
  // the item order a real `claude -p` 2.1.32x run gave (live probe): report, result, notification turn, result
  const res = { kind: 'result', text: '' };
  const live = pickReport([tool, text('REPORT-MAIN line one, with the findings.'), res, text('PS: background task finished.'), res]);
  assert.equal(live.main, 'REPORT-MAIN line one, with the findings.');
  assert.deepEqual(live.postscript, ['PS: background task finished.']);
});

test('a postscript after the report (background-task notification) no longer replaces it; summary, ledger and output_file keep the report', async () => {
  const s = sandbox({ w1: ['ok'] });
  const report = `# Findings\n\nThe parser is fine; three edge cases listed below.\n\n${SUMMARY}`;
  process.env.FAKE_REPORT = report;
  process.env.FAKE_POSTSCRIPT = 'The background build finished OK.';
  const r = await workers().runWorker({ task: 'review the parser', cwd: s.project, outputFile: 'review.md' });
  assert.equal(r.ok, true, r.text);
  assert.ok(r.report.startsWith(report), r.report);
  assert.match(r.report, /## Postscript[\s\S]*The background build finished OK\.$/);
  assert.equal(r.meta.relaySummary.status, 'done', 'the summary block is found in the report');
  assert.match(fs.readFileSync(path.join(s.project, 'review.md'), 'utf8'), /^# Findings[\s\S]*The background build finished OK\./);
  const ledger = require(`${SRC}/core/memory`).ledgerText(s.project, {});
  assert.match(ledger, /The parser is fine/);
});

test('a park line at the end of the report still parks the job when a postscript follows it', async () => {
  const s = sandbox({ w1: ['ok'] });
  process.env.FAKE_REPORT = 'Launched the run (pid 7). Logs: /tmp/x.log.\n\nRELAY_PARK: 30 | check /tmp/x.log';
  process.env.FAKE_POSTSCRIPT = 'Note: the warm-up task finished.';
  const r = await workers().runWorker({ task: 'launch it', cwd: s.project });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.park && r.park.minutes, 30);
  assert.doesNotMatch(r.report, /RELAY_PARK/);
  assert.match(r.report, /Launched the run[\s\S]*## Postscript[\s\S]*warm-up task finished/);
});
