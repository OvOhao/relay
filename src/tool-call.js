'use strict';
// Runs one tool call in a process of its own, started by the MCP server for every call: each call therefore runs
// Relay's code as it is on disk now, so a Claude window that stays open for days still gets every Relay update.
// In:  one JSON line on stdin, { name, args }; later a line "cancel" (the call was cancelled or the window is closing).
// Out: JSON lines on stdout: { progress: "…" } while it works, then { result: { text, isError } }.
// "cancel", the end of stdin (the MCP server is gone) or SIGTERM stop the job cleanly: its worker is stopped, its
// folder and run file freed, and the result says "Cancelled". (A line on stdin works on Windows, where a signal
// would just end the process before it could clean up.)

const memory = require('./core/memory');
const { runWorker, statusText } = require('./core/workers');

async function callTool(name, args, { onProgress = () => {}, signal = null } = {}) {
  if (name === 'relay_status') return { text: statusText(args.cwd) };
  if (name === 'relay_ledger') {
    if (!args.cwd) return { text: 'cwd is required.', isError: true };
    const text = memory.ledgerText(args.cwd, { maxChars: 12000 });
    const threads = Object.keys(memory.listThreads(args.cwd));
    return { text: text ? `Threads: ${threads.join(', ') || '(none)'}\n\n${text}` : 'The ledger for this project is empty: no Relay worker has run here yet.' };
  }
  if (name === 'relay_run') {
    const out = await runWorker({
      task: args.task, cwd: args.cwd, context: args.context, thread: args.thread ? String(args.thread).trim() : '', readOnly: !!args.read_only, model: args.model ? String(args.model).trim() : '',
      title: args.title ? String(args.title) : '', account: args.account ? String(args.account).trim() : '', scope: args.scope ?? null,
      preset: args.preset ? String(args.preset).trim() : '',
      signal,
      onProgress,
    });
    return { text: out.text, isError: !out.ok && !['no_workers', 'workers_limited', 'busy', 'cancelled'].includes(out.code) };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
process.on('uncaughtException', (e) => process.stderr.write(`[relay-call] ${(e && e.stack) || e}\n`));

async function run(line) {
  let result;
  try {
    const { name, args } = JSON.parse(line);
    result = await callTool(name, args || {}, { onProgress: (l) => out({ progress: l }), signal: controller.signal });
  } catch (e) {
    result = { text: `Relay error: ${(e && e.message) || e}`, isError: true };
  }
  out({ result });
  memory.releaseAll();
  process.exit(0);
}

let started = false;
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!started) { started = true; run(line); } else if (line.trim() === 'cancel') controller.abort();
});
rl.on('close', () => { if (started) controller.abort(); else process.exit(0); }); // the MCP server is gone
