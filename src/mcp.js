#!/usr/bin/env node
'use strict';
// Relay's MCP server (stdio). Claude Code starts one per session; it gives the window's Claude three tools so it can
// hand big jobs to worker accounts. Newline-delimited JSON-RPC 2.0, no dependencies. stdout carries protocol messages
// only: all logging goes to stderr.
// This process only speaks the protocol: every tool call runs in a new process of its own (tool-call.js), so it always
// runs Relay's current code, and the tool definitions are read again when they change on disk (the window is told).

const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const store = require('./core/store');

const VERSION = require('../package.json').version;
const DEFS = path.join(__dirname, 'tool-defs.js');
const CALL = path.join(__dirname, 'tool-call.js');

// The current tool definitions, read again whenever the file changes.
let defsSeen = 0;
function tools() {
  try { defsSeen = fs.statSync(DEFS).mtimeMs; } catch { /* keep the last time */ }
  delete require.cache[require.resolve(DEFS)];
  return require(DEFS).TOOLS;
}
let listed = false;
function toolsChanged() {
  try { return listed && fs.statSync(DEFS).mtimeMs !== defsSeen; } catch { return false; }
}

const log = (...a) => process.stderr.write(`[relay-mcp] ${a.join(' ')}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

// Tell the running Relay who this window is signed in as (the desktop app puts the e-mail, not a secret,
// in the session environment). That is how Relay notices the leader changed when you switch accounts.
function reportIdentity() {
  // An unexpanded "${VAR}" placeholder (the variable is not set outside the desktop app) is not an identity.
  const real = (v) => (v && !String(v).includes('${') ? String(v) : '');
  const email = real(process.env.CLAUDE_CODE_USER_EMAIL);
  if (!email || process.env.RELAY_TAKEOVER) return;
  try {
    const { port, token } = JSON.parse(fs.readFileSync(path.join(store.home(), 'connect.json'), 'utf8'));
    const req = http.request({ host: '127.0.0.1', port, path: '/ident', method: 'POST', timeout: 3000, headers: { 'x-relay-token': token, 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify({ email, uuid: real(process.env.CLAUDE_CODE_ACCOUNT_UUID), entrypoint: real(process.env.CLAUDE_CODE_ENTRYPOINT) }));
  } catch { /* Relay is not running: nothing to tell */ }
}

// Jobs this window is running, by JSON-RPC request id: a cancel or the window closing stops exactly these.
const inflight = new Map(); // id -> { child, done }

// One tool call, in its own process; resolves { text, isError }.
function callTool(name, args, progressToken, id) {
  reportIdentity();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [CALL], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    } catch (e) {
      return resolve({ text: `Relay error: ${e.message}`, isError: true });
    }
    if (id !== undefined && inflight.has(id)) inflight.get(id).child = child;
    let result = null;
    let n = 0;
    let last = 0;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.result) result = m.result;
      else if (m.progress && progressToken != null && Date.now() - last >= 1500) {
        last = Date.now();
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ++n, message: m.progress } });
      }
    });
    child.on('error', (e) => resolve({ text: `Relay error: ${e.message}`, isError: true }));
    child.on('close', (code) => resolve(result || { text: `Relay error: the tool process ended (code ${code}) without an answer.`, isError: true }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ name, args }));
  });
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      reportIdentity();
      return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'relay', version: VERSION } });
    case 'ping':
      return reply({});
    case 'tools/list':
      listed = true;
      return reply({ tools: tools() });
    case 'tools/call': {
      // Relay was updated since the window read the tools: tell it to read them again (this call runs the new code).
      if (toolsChanged()) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      const job = { child: null, done: null };
      if (id !== undefined) inflight.set(id, job);
      const work = (async () => {
        try {
          const r = await callTool(params.name, params.arguments || {}, params._meta?.progressToken, id);
          return reply({ content: [{ type: 'text', text: r.text }], isError: !!r.isError });
        } catch (e) {
          log('tool error:', e.stack || e.message);
          return reply({ content: [{ type: 'text', text: `Relay error: ${e.message}` }], isError: true });
        } finally {
          if (inflight.get(id) === job) inflight.delete(id);
        }
      })();
      job.done = work;
      return work;
    }
    case 'notifications/cancelled': {
      // The window stopped this call: its process stops its worker (the whole process tree), frees its folder and
      // run file, and answers the call itself with a short "Cancelled." once everything is cleaned up.
      const job = inflight.get(params.requestId);
      if (job) { log('cancelled request', params.requestId, params.reason || ''); job.child?.kill('SIGTERM'); }
      return undefined;
    }
    default:
      if (method && method.startsWith('notifications/')) return undefined;
      return fail(-32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return log('ignoring unparseable line'); }
  handle(msg).catch((e) => log('handler crashed:', e.message));
});
// The window is closing (stdin ends) or this process is told to stop: stop every job it runs, wait briefly for
// their workers to be killed and their locks and run files to be released, then exit. Nothing may outlive the
// window: an orphan worker would keep running on an account and keep the folder locked.
let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  const jobs = [...inflight.values()];
  for (const j of jobs) j.child?.kill('SIGTERM'); // each stops its worker and frees its folder, then exits
  const settle = Promise.allSettled(jobs.map((j) => j.done));
  await Promise.race([settle, new Promise((r) => setTimeout(r, 8000).unref())]);
  for (const j of jobs) { try { j.child?.kill('SIGKILL'); } catch { /* gone */ } } // still not done: no leftovers
  process.exit(code);
}
rl.on('close', () => shutdown(0));
// The last safety net: a stray error (a status file another process held open, a progress message to a window
// that just closed, ...) is logged and the tool keeps serving. Dying here would drop every job this window runs
// and the window would show Relay as disconnected.
process.on('uncaughtException', (e) => log('uncaught exception (kept running):', (e && e.stack) || e));
process.on('unhandledRejection', (e) => log('unhandled rejection (kept running):', (e && e.stack) || e));
process.on('SIGTERM', () => shutdown(143));
process.on('SIGINT', () => shutdown(130));
// Last resort when the process ends some other way: tell what is left to stop (each frees its own locks).
process.on('exit', () => { for (const j of inflight.values()) { try { j.child?.kill('SIGTERM'); } catch { /* gone */ } } });
