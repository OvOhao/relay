'use strict';
// One switch that wires Relay into Claude Code, and one that undoes it all:
//   1. hooks in ~/.claude/settings.json   (StopFailure: take over at a limit; SessionStart: who is the leader)
//   2. an MCP server called "relay"       (registered with Claude Code's own `claude mcp add --scope user`)
//   3. a skill ~/.claude/skills/relay     (tells the window's Claude when and how to dispatch)
// Everything is removed again by disconnect() / removeAll(); nothing else on the machine is touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const setup = require('./setup');
const hook = require('./hook');
const platform = require('./platform');
const { spawnClaude, cleanEnv } = require('./claude');

const MARK = '<!-- managed by Relay: removed when you disconnect Relay -->';
const skillDir = () => path.join(setup.hubDir(), 'skills', 'relay');
const skillFile = () => path.join(skillDir(), 'SKILL.md');
const claudeJson = () => (process.env.RELAY_HUB ? path.join(setup.hubDir(), '.claude.json') : path.join(os.homedir(), '.claude.json'));

const SKILL = `---
name: relay
description: Hand substantial, self-contained work (implementing a feature, a refactor, writing tests, debugging, long research) to Relay's worker accounts so it runs on their usage instead of this window's. Use it for big jobs, and whenever the user mentions relay, workers, delegating, or saving usage. Not for quick questions or tiny edits.
---
${MARK}

# Relay: you are the dispatcher

This window's account is the **leader**. Relay has other Claude accounts (**workers**) that run the official Claude Code for you, each with its own usage limits. Your own usage is the scarce thing: spend it on talking with the user, planning and reviewing, and let workers do the heavy lifting with the \`relay_run\` tool.

## When to delegate
- Delegate: building or changing a feature, refactors, writing or fixing tests, debugging, codebase investigation, long research, anything that would take you many tool calls.
- Do not delegate: quick questions, one-line edits, anything that needs a live back-and-forth with the user.
- If the user says "use relay" or "/relay <job>", delegate that job.

## How to hand work over (workers cannot see this conversation)
1. If you don't know who is available, call \`relay_status\` (pass \`cwd\`).
2. Call \`relay_run\` with:
   - **task**: complete and self-contained: the goal, what "done" looks like, how to verify (commands, tests).
   - **context**: what you know from this conversation that the worker doesn't: the user's goal in their own words, decisions already made, constraints and preferences, relevant files and paths, what was already tried.
   - **cwd**: the project folder (this session's working directory).
   - **thread**: a short kebab-case name for this line of work, e.g. \`auth-refactor\`. **Reuse the same thread name to continue that work**: the worker resumes its own session and remembers everything, even if Relay moved it to another account. Use a new name for unrelated work.
   - **read_only**: true for review or investigation.
   - **title**: 3-8 words saying what the job is; Relay shows it as the subtitle of the running job.
   - **preset** (optional): for security work (vulnerability analysis, attacks and defences, exploits in a test environment, prompt injection, red teaming, reward hacking, malware analysis) pass \`"security"\`: the worker then gets that research's real background in its system prompt. Relay also applies it by itself when the job's text matches the preset's keywords. Describe the task plainly and truthfully; a preset gives context, it does not lift any limit.
   - **scope** (optional): the folders the job will change, relative to cwd, e.g. \`["ideas/i025-vla"]\`. Several jobs run in one folder at the same time, each on its own free worker; two jobs whose scopes overlap run one after the other, so they never edit the same files at once. Give it whenever you know where a job writes.
3. When it returns, read the report, check the result cheaply yourself (look at the changed files, run the tests), then tell the user in their language what was done and **which worker account did it**.

## Use every worker
- Split big work into independent jobs (different ideas, papers, modules) and give each its scope.
- Start them together: call \`relay_run\` several times **in the same turn**, one per job. Each goes to a free worker; when every worker is busy, a job waits for the first one to come free.
- Investigation and review jobs should be \`read_only\`: they never wait for other jobs and never block them.

## Memory
- Workers share the user's CLAUDE.md files and project memory with you.
- Relay keeps a project **ledger** of everything workers did. After your context is compacted, or in a new conversation, call \`relay_ledger\` (with \`cwd\`) to recover what happened before you decide what to do next.

## When a worker is not available
- \`NO_WORKER_AVAILABLE\`: every worker is at its limit (the reply says when the first is back). Tell the user in one sentence, then do the work yourself if it is reasonable, or offer to wait.
- \`BUSY\`: every worker stayed busy, or another job kept changing the same files, for the whole waiting time. Retry later or do it yourself.
- If a worker says a command or edit was refused by permissions, tell the user: they can allow more in Relay's settings.

Never put passwords, tokens or other secrets into \`task\` or \`context\`.
`;

function runClaude(args) {
  return new Promise((resolve) => {
    const env = cleanEnv();
    if (process.env.RELAY_HUB) env.CLAUDE_CONFIG_DIR = setup.hubDir();
    let out = '';
    let child;
    try {
      child = spawnClaude(args, { env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function mcpEntry() {
  const env = {
    // the desktop app puts the signed-in e-mail (not a secret) in the session; pass it through to the tool
    CLAUDE_CODE_USER_EMAIL: '${CLAUDE_CODE_USER_EMAIL}',
    CLAUDE_CODE_ACCOUNT_UUID: '${CLAUDE_CODE_ACCOUNT_UUID}',
    CLAUDE_CODE_ENTRYPOINT: '${CLAUDE_CODE_ENTRYPOINT}',
  };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'; // the Relay app doubles as the Node runtime
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('RELAY_')) env[k] = v; // dev/test overrides only
  return { command: process.execPath, args: [path.join(__dirname, '..', 'mcp.js')], env };
}

function mcpRegistered() {
  try {
    return !!JSON.parse(fs.readFileSync(claudeJson(), 'utf8')).mcpServers?.relay;
  } catch {
    return false;
  }
}

function skillInstalled() {
  try {
    return fs.readFileSync(skillFile(), 'utf8').includes(MARK);
  } catch {
    return false;
  }
}

function status() {
  const h = hook.status();
  const s = { hook: h.installed, skill: skillInstalled(), mcp: mcpRegistered(), settingsPath: h.settingsPath };
  return { ...s, all: s.hook && s.skill && s.mcp };
}

async function install() {
  hook.install();
  fs.mkdirSync(skillDir(), { recursive: true });
  fs.writeFileSync(skillFile(), SKILL);

  await runClaude(['mcp', 'remove', 'relay', '--scope', 'user']); // idempotent: ignore "not found"
  const e = mcpEntry();
  const envArgs = Object.entries(e.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = await runClaude(['mcp', 'add', '--scope', 'user', 'relay', ...envArgs, '--', e.command, ...e.args]);
  if (r.code !== 0 || !mcpRegistered()) {
    throw new Error(`Could not register Relay's tool with Claude Code: ${r.out.trim().slice(0, 300) || `exit ${r.code}`}`);
  }
  return status();
}

async function uninstall() {
  await runClaude(['mcp', 'remove', 'relay', '--scope', 'user']);
  if (skillInstalled()) fs.rmSync(skillDir(), { recursive: true, force: true });
  hook.uninstall();
  return status();
}

// "Remove Relay": undo the wiring and clear what only the wiring needed. The saved account sign-ins are the part
// that is painful to lose (each one means a browser login), so they stay unless `logins` is explicitly true;
// then every login folder, browser profile and note Relay made is deleted too.
// (Unlinking the shared junctions first means nothing in your own ~/.claude is ever deleted.)
async function removeAll({ logins = false } = {}) {
  await uninstall();
  fs.rmSync(`${hook.settingsPath()}.relay-backup`, { force: true });
  try { platform.removeAutoStart(); } catch { /* not there */ }
  if (!logins) {
    for (const f of ['bin', 'connect.json', 'events.log', 'events.log.old', 'usage.json']) {
      fs.rmSync(path.join(store.home(), f), { recursive: true, force: true });
    }
    return { logins: false };
  }
  for (const accountsRoot of store.accountRoots()) { // Relay's own, and any extra folders of sign-ins
    let names = [];
    try { names = fs.readdirSync(accountsRoot); } catch { /* nothing created yet */ }
    for (const n of names) {
      const dir = path.join(accountsRoot, n);
      await platform.forgetLogin(store.newAccount(n, dir)); // macOS: drop its Keychain entry through Claude Code itself
      setup.removeConfigDir(dir);
    }
  }
  for (const extra of store.accountRoots().slice(1)) { try { fs.rmdirSync(extra); } catch { /* not empty, or gone */ } }
  fs.rmSync(store.home(), { recursive: true, force: true });
  return { logins: true };
}

// A newer Relay may tell the window's Claude more (or differently) how to hand work over: keep an installed skill current.
function refreshSkill() {
  try { if (skillInstalled() && fs.readFileSync(skillFile(), 'utf8') !== SKILL) fs.writeFileSync(skillFile(), SKILL); } catch { /* next start */ }
}

module.exports = { install, uninstall, removeAll, status, refreshSkill, SKILL };
