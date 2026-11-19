'use strict';
// Stand-in for the OpenAI Codex CLI (`codex exec --json`, `exec resume`, `sandbox`, `login status`, `app-server`),
// driven by a per-account script so Relay's Codex backend can be tested without a real login or quota.
//   FAKE_STATE : dir for counters + invocation log (invocations.jsonl; Codex runs have kind "exec" or "sandbox")
//   FAKE_PLAN  : JSON { "<CODEX_HOME folder name>": ["ok", "limit", ...] } (one entry per exec run)
//   FAKE_CODEX_PREFLIGHT=fail : the sandbox canary check fails (exit 10: the canary was readable)
//   FAKE_CODEX_SIGNED_OUT     : comma-separated CODEX_HOME folder names without a login
//   FAKE_CODEX_DELAY_MS       : the review takes this long (after the rollout is written, before it reports)
//   FAKE_CODEX_NO_ROLLOUT     : no rollout file is written (the session's sandbox cannot be verified)
// Behaviours: ok | limit | auth | write (changes a file in the job folder) | filechange (the same, and reports it as a
// Codex file_change event) | badprofile (rollout shows another profile) | badprofile-hang (the same, then never
// finishes) | modelbad | hang
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME || '';
const account = path.basename(home || 'unknown');
const state = process.env.FAKE_STATE;
const log = (o) => fs.appendFileSync(path.join(state, 'invocations.jsonl'), `${JSON.stringify({ account, cwd: process.cwd(), ...o })}\n`);
const signedOut = (process.env.FAKE_CODEX_SIGNED_OUT || '').split(',').includes(account);

if (args[0] === 'login' && args[1] === 'status') {
  if (signedOut) { process.stderr.write('Not logged in\n'); process.exit(1); }
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}

if (args[0] === 'app-server') {
  const rl = require('readline').createInterface({ input: process.stdin });
  const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
  rl.on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id === 1) send({ id: 1, result: { userAgent: 'fake' } });
    if (m.id === 2) {
      if (signedOut) return send({ id: 2, error: { code: -32000, message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } });
      send({ id: 2, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, secondary: null, planType: 'pro', rateLimitReachedType: null } } });
    }
    if (m.id === 3) send({ id: 3, result: { account: signedOut ? null : { type: 'chatgpt', email: `${account}@codex.test`, planType: 'pro' }, requiresOpenaiAuth: true } });
  });
  return;
}

if (args[0] === 'sandbox') {
  const i = args.indexOf('--');
  log({ kind: 'sandbox', args: args.slice(0, i), probe: args.slice(i + 1, i + 3) });
  if (process.env.FAKE_CODEX_PREFLIGHT === 'fail') process.exit(10);
  console.log('RELAY-PREFLIGHT-OK');
  process.exit(0);
}

if (args[0] !== 'exec') { console.error(`fake codex: unexpected ${args.join(' ')}`); process.exit(2); }

const resume = args[1] === 'resume' ? args[args.length - 2] : null;
const cfg = (key) => { for (let k = 0; k < args.length - 1; k++) if (args[k] === '-c' && args[k + 1].startsWith(`${key}=`)) return args[k + 1].slice(key.length + 1); return null; };
const plan = JSON.parse(process.env.FAKE_PLAN || '{}')[account] || ['ok'];
const counter = path.join(state, `${account}.n`);
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const behaviour = plan[Math.min(n, plan.length - 1)];

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const sid = resume || `019a${Math.random().toString(16).slice(2, 10)}-fake-${account}`;
  const mi = args.indexOf('-m');
  const ci = args.indexOf('-C');
  log({ kind: 'exec', behaviour, resume, prompt, model: mi >= 0 ? args[mi + 1] : null, effort: cfg('model_reasoning_effort'), developer: cfg('developer_instructions'), dashC: ci >= 0 ? args[ci + 1] : null, args });
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: 'thread.started', thread_id: sid });

  // the rollout file, as Codex keeps it: one turn_context per turn, with the profile it really applied
  const dir = path.join(home, 'sessions', '2026', '11', '17');
  fs.mkdirSync(dir, { recursive: true });
  // like codex-cli 0.153.4: an explicit -s/--sandbox flag overrides default_permissions (no active profile)
  const sFlag = args.includes('-s') || args.includes('--sandbox');
  const active = sFlag ? null : cfg('default_permissions') === '"relay-review"' && !behaviour.startsWith('badprofile') ? { id: 'relay-review' } : { id: ':workspace' };
  const entries = [{ path: { type: 'path', path: os.homedir() }, access: 'deny' }, { path: { type: 'path', path: process.cwd() }, access: behaviour.startsWith('badprofile') ? 'write' : 'read' }];
  // codex-cli 0.170.0 also lists :minimal as a special path and adds a read entry of its own, for its per-run helper
  // folder under CODEX_HOME/tmp/arg0-macos (the folder is empty again after the run).
  entries.push({ path: { type: 'special', value: { kind: 'minimal' } }, access: 'read' }, { path: { type: 'path', path: path.join(home, 'tmp', 'arg0-macos', 'codex-arg0Fake') }, access: 'read' });
  const model = mi >= 0 ? args[mi + 1] : null;
  const turnId = `019a${Math.random().toString(16).slice(2, 10)}-turn`;
  const turnContext = { turn_id: turnId, root_turn_id: turnId, cwd: process.cwd(), approval_policy: 'never', active_permission_profile: active, file_system_sandbox_policy: { kind: 'restricted', entries }, permission_profile: { type: 'managed', file_system: { type: 'restricted', entries } }, sandbox_policy: { type: 'read-only' }, model, effort: cfg('model_reasoning_effort') };
  // 0.170.0 rollouts carry more record types around the turn_context (Relay reads only turn_context); a new session
  // starts with session_meta and world_state, every turn gets thread_settings_applied and token_usage_record.
  const records = [
    ...(resume ? [] : [{ type: 'session_meta', payload: { session_id: sid, cwd: process.cwd() } }, { type: 'world_state', payload: { full: true, state: { collaboration_mode: { mode: 'default', model } } } }]),
    { type: 'turn_context', payload: turnContext },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: sid, thread_settings: { model, approval_policy: 'never', permission_profile: turnContext.permission_profile } } },
    { type: 'token_usage_record', payload: { thread_id: sid, turn_id: turnId, session_id: sid } },
  ];
  if (!process.env.FAKE_CODEX_NO_ROLLOUT) fs.appendFileSync(path.join(dir, `rollout-2026-11-17T00-00-00-${sid}.jsonl`), records.map((r) => `${JSON.stringify(r)}\n`).join(''));

  out({ type: 'turn.started' });
  if (behaviour === 'limit') {
    out({ type: 'error', message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:02 PM." });
    out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:02 PM." } });
    process.exit(1);
  }
  if (behaviour === 'auth') {
    out({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' });
    out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } });
    process.exit(1);
  }
  if (behaviour === 'modelbad') {
    out({ type: 'turn.failed', error: { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}' } });
    process.exit(1);
  }
  if (behaviour === 'hang' || behaviour === 'badprofile-hang') { setInterval(() => {}, 1000); return; }
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CODEX_DELAY_MS || 0)));
  if (behaviour === 'write' || behaviour === 'filechange') fs.writeFileSync(path.join(process.cwd(), 'codex-wrote.txt'), 'a read-only job must not do this');
  if (behaviour === 'filechange') out({ type: 'item.completed', item: { id: 'item_fc', type: 'file_change', changes: [{ path: path.join(process.cwd(), 'codex-wrote.txt'), kind: 'add' }], status: 'completed' } });
  out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: "/bin/zsh -lc 'rg --files'", aggregated_output: '', exit_code: null, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: "/bin/zsh -lc 'rg --files'", aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `Review by ${account}: no problems found.${resume ? ' (resumed)' : ''}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
});
