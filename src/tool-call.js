'use strict';
// Runs one tool call in a process of its own, started by the MCP server for every call: each call therefore runs
// Relay's code as it is on disk now, so a Claude window that stays open for days still gets every Relay update.
// In:  one JSON line on stdin, { name, args }.
// Out: JSON lines on stdout: { progress: "…" } while it works, then { result: { text, isError } }.
// SIGTERM (the call was cancelled or the window is closing) stops the job cleanly: its worker is stopped, its folder
// and run file freed, and the result says "Cancelled". It also stops by itself if the MCP server is gone.

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
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) controller.abort(); }, 2000).unref(); // the MCP server died
process.on('uncaughtException', (e) => process.stderr.write(`[relay-call] ${(e && e.stack) || e}\n`));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let result;
  try {
    const { name, args } = JSON.parse(input);
    result = await callTool(name, args || {}, { onProgress: (line) => out({ progress: line }), signal: controller.signal });
  } catch (e) {
    result = { text: `Relay error: ${(e && e.message) || e}`, isError: true };
  }
  out({ result });
  memory.releaseAll();
  process.exit(0);
});
