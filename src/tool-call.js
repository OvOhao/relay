'use strict';
// Runs one tool call in a process of its own, started by the MCP server for every call: each call therefore runs
// Relay's code as it is on disk now, so a Claude window that stays open for days still gets every Relay update.
// In:  one JSON line on stdin, { name, args }; later a line "cancel" (the call was cancelled or the window is closing).
// Out: JSON lines on stdout: { progress: "…" } while it works, then { result: { text, isError } }.
// "cancel", the end of stdin (the MCP server is gone) or SIGTERM stop the job cleanly: its worker is stopped, its
// folder and run file freed, and the result says "Cancelled". (A line on stdin works on Windows, where a signal
// would just end the process before it could clean up.)

const memory = require('./core/memory');
const jobs = require('./core/jobs');
const { runWorker, statusText } = require('./core/workers');

async function callTool(name, args, { onProgress = () => {}, signal = null } = {}) {
  if (name === 'relay_status') return { text: `${statusText(args.cwd)}\n\nTip: call relay_help for the current parameters of every Relay tool (a session opened before a Relay update may show old ones; the new ones work anyway).` };
  if (name === 'relay_help') return { text: require('./tool-defs').helpText() };
  if (name === 'relay_ledger') {
    if (!args.cwd) return { text: 'cwd is required.', isError: true };
    const text = memory.ledgerText(args.cwd, { maxChars: 12000 });
    const threads = Object.keys(memory.listThreads(args.cwd));
    return { text: text ? `Threads: ${threads.join(', ') || '(none)'}\n\n${text}` : 'The ledger for this project is empty: no Relay worker has run here yet.' };
  }
  if (name === 'relay_health') {
    const r = await require('./core/health').run({ cwd: args.cwd, account: args.account || '', force: true, onProgress, signal });
    return { text: r.text, isError: !!r.isError };
  }
  if (name === 'relay_run') {
    const req = jobs.workerRequest(args);
    const out = await runWorker({ ...req, signal, onProgress });
    // The worker parked (RELAY_PARK): relay_run answers now, and the job continues as a background job.
    if (out.ok && out.park) return { text: jobs.adoptParked(req, out).text, isError: false };
    return { text: out.text, isError: jobs.isErrorResult(out) };
  }
  // Background jobs: start returns at once; poll, wait and cancel work on the job records (see core/jobs.js).
  if (name === 'relay_start') { const r = await jobs.start(args); return { text: r.text, isError: !!r.isError }; }
  if (name === 'relay_poll') return jobs.poll(args);
  if (name === 'relay_wait') return jobs.wait(args, { onProgress, signal });
  if (name === 'relay_cancel') return jobs.cancel(args);
  if (name === 'relay_ack') return jobs.ack(args);
  if (name === 'relay_wake') { const r = jobs.wake(args); return { text: r.text, isError: !!r.isError }; }
  return { text: `Unknown tool: ${name}`, isError: true };
}

const out = (msg, done) => process.stdout.write(`${JSON.stringify(msg)}\n`, done);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
process.on('uncaughtException', (e) => process.stderr.write(`[relay-call] ${(e && e.stack) || e}\n`));

async function run(line) {
  let result;
  // Parked jobs must wake even if their runner died (a restart, a crash): any Relay call starts a missing one.
  // parked jobs whose runner is gone, or stuck past the wake time (jobs.reviveOne)
  try { jobs.reviveParked(process.env, { by: 'tool call' }); } catch { /* never blocks a tool call */ }
  try {
    const { name, args } = JSON.parse(line);
    result = await callTool(name, args || {}, { onProgress: (l) => out({ progress: l }), signal: controller.signal });
  } catch (e) {
    result = { text: `Relay error: ${(e && e.message) || e}`, isError: true };
  }
  memory.releaseAll();
  // On a pipe, stdout is written asynchronously: exiting right after write() drops whatever the pipe has not taken yet
  // (a result over about 64 KB arrived cut, and the MCP server saw no answer). Exit only once it is all written.
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 60000); // a reader that never reads: give up rather than hang forever
    out({ result }, () => { clearTimeout(t); resolve(); });
  });
  process.exit(0);
}

let started = false;
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!started) { started = true; run(line); } else if (line.trim() === 'cancel') controller.abort();
});
rl.on('close', () => { if (started) controller.abort(); else process.exit(0); }); // the MCP server is gone
