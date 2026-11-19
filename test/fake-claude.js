'use strict';
// Stand-in for `claude -p --output-format stream-json`, driven by a per-account script so the
// failover logic can be tested without burning real quota.
//   FAKE_STATE : dir for counters + invocation log
//   FAKE_PLAN  : JSON { "<accountDirName>": ["ok", "limit:3600", ...] }  (one entry per invocation)
// Behaviours: ok | limit:<secs> | limit-text:<secs> | context-limit | too-long | auth | hang | crash
// Prompts Relay sends by itself use no plan entry:
//   RELAY_HANDOFF…       a handoff note ("FAKE HANDOFF NOTE …"), or the context-limit error with FAKE_HANDOFF_FAIL=1
//   RELAY_HEALTH_CHECK…  runs the numbered commands as Bash calls; FAKE_HEALTH { "<account>": { "<cmd>": "allowed:<exit>" | "refused" } }
// FAKE_CONTEXT: tokens in the session's context (every assistant message reports it; FAKE_CONTEXT_WINDOW: the window)

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
// What a run was given after --allowedTools (its values run until the next flag), and the arguments after a "--extra" marker.
const flagValues = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const out = []; for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k++) out.push(args[k]); return out; };
const allowedArgs = () => flagValues('--allowedTools');
const extraArgsSeen = () => { const i = args.indexOf('--extra'); return i < 0 ? null : args.slice(i + 1); };
// FAKE_SIGNED_OUT: login folders (by name) that have no login, as if it was never made or was removed (the demo)
if ((process.env.FAKE_SIGNED_OUT || '').split(',').includes(path.basename(process.env.CLAUDE_CONFIG_DIR || ''))) process.env.FAKE_LOGGED_OUT = '1';
if (args[0] === 'auth') {
  if (args[1] === 'logout') { // record which login folder was signed out (macOS: Claude Code drops its Keychain entry)
    if (process.env.FAKE_STATE) fs.appendFileSync(path.join(process.env.FAKE_STATE, 'logouts.log'), `${process.env.CLAUDE_CONFIG_DIR || ''}\n`);
    process.exit(0);
  } else if (args[1] === 'login') {
    // pretend the browser sign-in takes a few seconds
    if (process.env.RELAY_URL_FILE) fs.writeFileSync(process.env.RELAY_URL_FILE, 'https://claude.ai/oauth/authorize?demo=1\n');
    setTimeout(() => process.exit(0), Number(process.env.FAKE_LOGIN_MS || 3000));
  } else {
    console.log(JSON.stringify(process.env.FAKE_LOGGED_OUT
      ? { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' } // a computer where only the desktop app is signed in
      : { loggedIn: true, email: 'fake@example.com', subscriptionType: 'max' }));
    process.exit(0);
  }
  return;
}

if (args.includes('/usage') && process.env.FAKE_USAGE_HANG) { setInterval(() => {}, 1000); return; } // a reading that never ends
if (args.includes('/usage') && process.env.FAKE_LOGGED_OUT) { // a folder without a login: a cost summary, no numbers
  console.log(JSON.stringify({ result: 'Total cost:            $0.0000\nTotal duration (API):  0s\nUsage:                 ' }));
  process.exit(0);
}
// FAKE_USAGE: { "<login folder name>": [session %, hours to its reset, week %, hours to its reset] } (the demo)
const demoUsage = process.env.FAKE_USAGE && JSON.parse(process.env.FAKE_USAGE)[path.basename(process.env.CLAUDE_CONFIG_DIR || '')];
if (args.includes('/usage') && demoUsage) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = (hrs) => {
    const d = new Date(Date.now() + hrs * 3600e3);
    return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${d.getHours() % 12 || 12}${d.getHours() >= 12 ? 'pm' : 'am'} (${tz})`;
  };
  const [s, sh, w, wh] = demoUsage;
  console.log(JSON.stringify({ result: ['You are currently using your subscription', '', `Current session: ${s}% used · resets ${at(sh)}`, `Current week (all models): ${w}% used · resets ${at(wh)}`].join('\n') }));
  process.exit(0);
}
if (args.includes('/usage')) { // the official usage panel, as printed by a recent Claude Code
  const lines = [
    'You are currently using your subscription', '',
    'Current session: 12% used · resets Oct 8, 5pm (Australia/Sydney)',
    'Current week (all models): 20% used · resets Oct 14, 4pm (Australia/Sydney)',
    'Current week (Fable): 0% used · resets Oct 14, 4pm (Australia/Sydney)',
  ];
  console.log(JSON.stringify({ result: lines.join('\n') }));
  process.exit(0);
}
if (args[0] === 'mcp') { // `claude mcp add|remove|get ...` writes into <config dir>/.claude.json
  const cfg = path.join(process.env.CLAUDE_CONFIG_DIR || '.', '.claude.json');
  const j = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')) : {};
  j.mcpServers = j.mcpServers || {};
  if (args[1] === 'add') {
    const name = args.find((a, i) => i > 1 && !a.startsWith('-') && args[i - 1] !== '--scope' && args[i - 1] !== '-s');
    const dash = args.indexOf('--');
    j.mcpServers[name] = { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env: args.includes('-e') ? { raw: args[args.indexOf('-e') + 1] } : {} };
  } else if (args[1] === 'remove') {
    delete j.mcpServers[args.find((a, i) => i > 1 && !a.startsWith('-') && args[i - 1] !== '--scope' && args[i - 1] !== '-s')];
  }
  fs.writeFileSync(cfg, JSON.stringify(j));
  process.exit(0);
}

if (process.env.FAKE_ENV_DUMP) fs.appendFileSync(process.env.FAKE_ENV_DUMP, `${Object.keys(process.env).join('\n')}\n`);

const account = path.basename(process.env.CLAUDE_CONFIG_DIR || 'unknown');
const state = process.env.FAKE_STATE;
try { fs.mkdirSync(path.join(state, 'pids'), { recursive: true }); fs.writeFileSync(path.join(state, 'pids', String(process.pid)), ''); } catch { /* lets tests see which fake workers are still alive */ }
const plan = JSON.parse(process.env.FAKE_PLAN || '{}')[account] || ['ok'];
const counter = path.join(state, `${account}.n`);
// the plan entry for this invocation (Relay's own handoff and health prompts take none)
const nextBehaviour = () => {
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  return plan[Math.min(n, plan.length - 1)];
};

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = Number(process.env.FAKE_DELAY_MS || 0);
process.stdin.on('end', async () => {
  const ri = args.indexOf('--resume');
  const resume = ri >= 0 ? args[ri + 1] : null;
  const sid = resume || `sess-${Math.random().toString(36).slice(2, 8)}`;
  const mi = args.indexOf('--model');
  // FAKE_TRANSCRIPTS=1: sessions live where Claude Code keeps them, <config dir>/projects/<folder for cwd>/<id>.jsonl
  // (the folder name as Claude Code 2.1.32x makes it: non-alphanumerics to "-", over 200 characters cut + "-<hash>").
  // --resume of a session that is not there fails as the real CLI does; every run appends one line to its transcript.
  if (process.env.FAKE_TRANSCRIPTS) {
    const name = (c) => { const n = c.replace(/[^a-zA-Z0-9]/g, '-'); if (n.length <= 200) return n; let h = 0; for (let i = 0; i < c.length; i++) h = ((h << 5) - h + c.charCodeAt(i)) | 0; return `${n.slice(0, 200)}-${Math.abs(h).toString(36)}`; };
    const file = path.join(process.env.CLAUDE_CONFIG_DIR || '.', 'projects', name(process.cwd()), `${sid}.jsonl`);
    if (resume && !fs.existsSync(file)) {
      fs.appendFileSync(path.join(state, 'invocations.jsonl'), `${JSON.stringify({ account, behaviour: 'missing-session', resume, prompt })}\n`);
      console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}` }));
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ account, prompt: prompt.slice(0, 200) })}\n`);
    fs.mkdirSync(path.join(path.dirname(file), sid, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(file), sid, 'tool-results', `${account}.txt`), 'saved output');
  }
  const special = /^RELAY_HANDOFF/.test(prompt) ? 'handoff' : /^RELAY_HEALTH_CHECK/.test(prompt) ? 'health' : null;
  const behaviour = special || nextBehaviour();
  fs.appendFileSync(path.join(state, 'invocations.jsonl'), `${JSON.stringify({ account, behaviour, resume, prompt, model: mi >= 0 ? args[mi + 1] : null, effort: args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null, allowedTools: allowedArgs(), disallowedTools: flagValues('--disallowedTools'), permissionMode: args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : null, extra: extraArgsSeen(), appendSystem: args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : null, settings: args.includes('--settings') ? JSON.parse(args[args.indexOf('--settings') + 1]) : null, memoryOffEnv: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || null })}\n`);

  const ctxTokens = Number(process.env.FAKE_CONTEXT || 0);
  const usage = ctxTokens ? { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: ctxTokens - 10, output_tokens: 50 } : undefined;
  const out = (o) => {
    if (o.type === 'assistant' && usage) o = { ...o, message: { ...o.message, usage } };
    if (o.type === 'result' && ctxTokens) o = { ...o, modelUsage: { ...(process.env.FAKE_SIDE_WINDOW ? { 'side-model': { inputTokens: 3, contextWindow: Number(process.env.FAKE_SIDE_WINDOW) } } : {}), 'fake-model': { inputTokens: 10, contextWindow: Number(process.env.FAKE_CONTEXT_WINDOW || 200000) } } }; // FAKE_SIDE_WINDOW: a second model in the run
    console.log(JSON.stringify({ session_id: sid, ...o }));
  };
  out({ type: 'system', subtype: 'init', model: 'fake-model' });
  if (behaviour === 'handoff') {
    if (process.env.FAKE_HANDOFF_FAIL) { out({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long' }); process.exit(1); }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `FAKE HANDOFF NOTE from ${sid}\n## Goal\nfinish the parser\n## Next step\nrun the tests` }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'note', duration_ms: 5, num_turns: 1 });
    return;
  }
  if (behaviour === 'health') {
    const want = (JSON.parse(process.env.FAKE_HEALTH || '{}')[account]) || {};
    const cmds = prompt.split('\n').map((l) => /^\d+\. (.*)$/.exec(l)).filter(Boolean).map((m) => m[1]);
    const results = [];
    for (const [k, cmd] of cmds.entries()) {
      const how = want[cmd] || 'allowed:0';
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_h${k}`, name: 'Bash', input: { command: cmd } }] } });
      if (how === 'refused') out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_h${k}`, is_error: true, content: 'This command requires approval' }] } });
      // "claims-allowed": the worker says allowed although the call was refused (Relay must believe the tool result)
      if (how === 'claims-allowed') out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_h${k}`, is_error: true, content: 'Permission to use Bash has been denied.' }] } });
      results.push({ cmd, status: how === 'refused' ? 'refused' : 'allowed', exit: how === 'refused' ? null : how === 'claims-allowed' ? 0 : Number(how.split(':')[1] || 0) });
    }
    const block = process.env.FAKE_HEALTH_NOBLOCK ? 'done' : `Checked.\n\n\`\`\`relay-health\n${JSON.stringify({ results })}\n\`\`\``;
    out({ type: 'assistant', message: { content: [{ type: 'text', text: block }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'health', duration_ms: 5, num_turns: 1 });
    return;
  }
  await sleep(DELAY);
  const [kind, arg] = behaviour.split(':');
  const result = (is_error, text) => out({ type: 'result', subtype: 'success', is_error, result: text, duration_ms: 5, num_turns: 1 });

  if (kind === 'ok') {
    // FAKE_WRITE: comma-separated paths (relative to the job folder) the fake worker writes, as a shell command would
    for (const w of (process.env.FAKE_WRITE || '').split(',').filter(Boolean)) {
      fs.mkdirSync(path.dirname(path.join(process.cwd(), w)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), w), `written by the fake worker ${Date.now()}`);
    }
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/parser.ts' } }] } });
    // FAKE_TOOLS: [{ name, input, error }] tool calls to report (error: the call's result says it was refused)
    for (const [k, t] of JSON.parse(process.env.FAKE_TOOLS || '[]').entries()) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${k}`, name: t.name, input: t.input || {} }] } });
      if (t.error) out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${k}`, is_error: true, content: 'Permission to read this file has been denied.' }] } });
    }
    await sleep(DELAY);
    // FAKE_REPORT_CHARS: a long final report (tests check it reaches the dispatcher whole)
    if (process.env.FAKE_REPORT_CHARS) out({ type: 'assistant', message: { content: [{ type: 'text', text: `${'r'.repeat(Number(process.env.FAKE_REPORT_CHARS))}END-OF-REPORT` }] } });
    else if (process.env.FAKE_REPORT) out({ type: 'assistant', message: { content: [{ type: 'text', text: process.env.FAKE_REPORT }] } });
    else out({ type: 'assistant', message: { content: [{ type: 'text', text: `Picked up where the last account stopped. I split **parseExpr** into two passes and updated \`src/parser.ts\`.

Next I will run the tests.` }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/parser.ts' } }] } });
    // FAKE_POSTSCRIPT: a background task finishes after the report; as the real CLI does (2.1.32x), the same process
    // ends that turn, gets a task notification and runs one more turn (init, a tool call, a short note, result)
    if (process.env.FAKE_REPORT && process.env.FAKE_POSTSCRIPT) {
      result(false, process.env.FAKE_REPORT);
      out({ type: 'system', subtype: 'task_notification' });
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model' });
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_ps', name: 'Bash', input: { command: 'cat /tmp/bg.log' } }] } });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: process.env.FAKE_POSTSCRIPT }] } });
    }
    await sleep(DELAY);
    result(false, `done by ${account}`);
  } else if (kind === 'park' || kind === 'parkbad') {
    // a worker that launched long-running work and parks: its report ends with RELAY_PARK (or a malformed one)
    const last = kind === 'park' ? `RELAY_PARK: ${arg || 5} | check whether out.txt says done` : 'RELAY_PARK: soon-ish, check later';
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'nohup ./experiment.sh &' } }] } });
    await sleep(DELAY);
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `Launched the experiment (pid 4242), verified it runs. Logs: /tmp/exp.log. Status: tail /tmp/exp.log.\n\n${last}` }] } });
    result(false, `parked by ${account}`);
  } else if (kind === 'limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Date.now() / 1000 + Number(arg), rateLimitType: 'five_hour' } });
    result(true, "You've hit your session limit · resets 3pm");
    process.exit(1);
  } else if (kind === 'limit-text') {
    result(true, `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + Number(arg)}`);
    process.exit(1);
  } else if (kind === 'context-limit') {
    result(true, 'Context limit reached · /compact or /clear to continue');
    process.exit(1);
  } else if (kind === 'too-long') { // what Claude Code says when a session's context is full
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it, reading more files...' }] } });
    result(true, 'Prompt is too long');
    process.exit(1);
  } else if (kind === 'auth') {
    result(true, 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid."}}');
    process.exit(1);
  } else if (kind === 'hang') {
    setInterval(() => {}, 1000);
  } else if (kind === 'crash') {
    // FAKE_WRITE: what it changed before it crashed (a half-done job)
    for (const w of (process.env.FAKE_WRITE || '').split(',').filter(Boolean)) {
      fs.mkdirSync(path.dirname(path.join(process.cwd(), w)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), w), `half written by the fake worker ${Date.now()}`);
    }
    process.exit(3);
  }
});
