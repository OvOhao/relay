'use strict';
// The Claude Code backend: a worker is a headless `claude -p --output-format stream-json` run, scoped to one account
// by CLAUDE_CONFIG_DIR. Locating and spawning the binary lives in ../claude.js (also used by login, connect and the
// CLI); this module is what the engine, usage readings and login checks need from it. Interface: see ./index.js.

const setup = require('../setup');
const { spawnClaude, accountEnv, killTree, authStatus } = require('../claude');
const { looksLikeLimit, looksLikeAuthError, looksLikeContextLimit, looksLikeMissingSession, parseReset } = require('../parse');

const id = 'claude';

// hidePaths (absolute; hide_paths and an isolated job's Relay records): Read deny rules (set by the caller) only stop the
// file tools, so the run also gets Claude Code's bash sandbox with these paths in filesystem.denyRead. Live probe
// (2.1.32x): with it, `grep -r`, `ls` and `git status` get "Operation not permitted" on them; without it `grep -r .`
// printed hidden files. The sandbox fails closed (failIfUnavailable), commands may not leave it, and HTTP(S) stays open
// through its proxy (allowedDomains "*"); raw TCP such as ssh, and writes outside the job folder, do not work there.
// isolated (an isolated job): Claude Code's auto memory off (autoMemoryEnabled: false, "Claude will not read from or
// write to the auto-memory directory"; the account's MEMORY.md otherwise lands in the system prompt) and its git
// snapshot off (includeGitInstructions: false also skips the "gitStatus" block with recent commit subjects). Both keys
// are in the settings schema bundled with Claude Code 2.1.323; ISOLATED_ENV sets the env switch for auto memory too.
const ISOLATED_SETTINGS = { autoMemoryEnabled: false, includeGitInstructions: false };
const ISOLATED_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
function sandboxSettings(hidePaths, { isolated = false } = {}) {
  return {
    ...(isolated ? ISOLATED_SETTINGS : {}),
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      filesystem: { denyRead: [...new Set(hidePaths)] },
      network: { allowedDomains: ['*'] },
    },
  };
}

function buildArgs({ sessionId, model, effort, permissionMode, allowedTools = [], deniedTools = [], appendSystemPrompt = '', extraArgs = [], hidePaths = [], isolated = false } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools); // the rules from Settings, one value each
  if (deniedTools.length) args.push('--disallowedTools', ...deniedTools); // and the ones workers may never use
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt); // a task preset's background
  if ((hidePaths && hidePaths.length) || isolated) args.push('--settings', JSON.stringify(sandboxSettings(hidePaths || [], { isolated })));
  args.push(...extraArgs);
  return args;
}

const env = (acct, extra = {}) => accountEnv(acct, extra);
const isolatedEnv = () => ({ ...ISOLATED_ENV });
const spawn = (args, opts) => spawnClaude(args, opts);
const prepare = (acct) => setup.syncSharedFiles(acct.configDir);
// Before a resume: the session's newest copy (any account's sign-in folder, or ~/.claude) is carried into this
// account's own projects folder, under Claude Code's folder name for the cwd (core/sessions.js). Returns carry()'s answer.
const carrySession = (acct, sessionId, { cwd } = {}) => {
  const sessions = require('../sessions');
  return sessions.carry(acct.configDir, sessionId, { cwd, configDirs: sessions.claudeConfigDirs() });
};

const resultText = (c) => String(typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '').slice(0, 300);

function toolSummary(input = {}) {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.description || '';
  return String(v || JSON.stringify(input)).slice(0, 160);
}

// The parts of a tool call's input that say what it touched (paths, patterns, the shell command), never file contents:
// Relay checks them after the run (hide_paths). Each value is cut at 4000 characters.
const INPUT_KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'glob', 'command'];
function toolInput(input = {}) {
  const out = {};
  for (const k of INPUT_KEYS) if (typeof input[k] === 'string' && input[k]) out[k] = input[k].slice(0, 4000);
  return out;
}

// How full the session's context is: the input of the last model call (new input + cache writes + cache reads), from
// an assistant message's usage. Sub-agent messages (parent_tool_use_id) have their own context and are skipped.
function contextTokens(u) {
  if (!u || typeof u !== 'object') return null;
  const n = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((s, k) => s + (Number(u[k]) || 0), 0);
  return n > 0 ? n : null;
}
// The model's context window, when the stream says it (the result's modelUsage: { "<model>": { contextWindow } }).
function contextWindowOf(ev) {
  const all = ev && ev.modelUsage && typeof ev.modelUsage === 'object' ? Object.values(ev.modelUsage) : [];
  const w = all.map((m) => Number(m && m.contextWindow) || 0).filter((x) => x > 0);
  return w.length ? Math.max(...w) : null;
}

// Each model's window ({ "<model>": n }): a run can use more than one model (e.g. a small one for side tasks), and the
// session's own model (the init event's, e.g. "claude-haiku-5-5", which is also its modelUsage key) is what counts.
function contextWindows(ev) {
  const out = {};
  for (const [m, u] of Object.entries((ev && ev.modelUsage && typeof ev.modelUsage === 'object' && ev.modelUsage) || {})) if (Number(u && u.contextWindow) > 0) out[m] = Number(u.contextWindow);
  return out;
}

// Raw stream-json event -> the few transcript items the UI cares about.
function parseEvent(ev, acct) {
  const account = acct.name;
  if (ev.type === 'system' && ev.subtype === 'init') return [{ kind: 'init', account, model: ev.model }];
  if (ev.type === 'assistant') {
    const tokens = ev.parent_tool_use_id ? null : contextTokens(ev.message?.usage);
    const ctx = tokens ? [{ kind: 'context', account, tokens }] : [];
    return ctx.concat((ev.message?.content || []).flatMap((b) => {
      if (b.type === 'text' && b.text?.trim()) return [{ kind: 'text', account, text: b.text }];
      if (b.type === 'tool_use') return [{ kind: 'tool', account, name: b.name, summary: toolSummary(b.input), id: b.id || null, input: toolInput(b.input) }];
      return [];
    }));
  }
  // A tool call that failed or was refused (e.g. by a deny rule): its tool_result says is_error, and the start of its
  // text says why (health checks tell "refused" from "ran and failed" by it).
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    return ev.message.content.filter((b) => b && b.type === 'tool_result' && b.is_error).map((b) => ({ kind: 'tool_result', account, id: b.tool_use_id || null, error: true, text: resultText(b.content) }));
  }
  if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'allowed_warning') {
    const i = ev.rate_limit_info;
    const pct = i.utilization != null ? ` (${Math.round(i.utilization * 100)}% used)` : '';
    return [{ kind: 'notice', level: 'info', code: 'near_limit', params: { account, pct: i.utilization != null ? Math.round(i.utilization * 100) : null }, text: `${account} is close to its ${i.rateLimitType || 'usage'} limit${pct}` }];
  }
  if (ev.type === 'result') {
    const window = contextWindowOf(ev);
    return [...(window ? [{ kind: 'context', account, window, windows: contextWindows(ev) }] : []), { kind: 'result', account, ok: !ev.is_error, durationMs: ev.duration_ms, turns: ev.num_turns }];
  }
  return [];
}

const sessionIdFrom = (ev) => (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) || null;
const limitFromEvent = (ev) => (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected' ? ev.rate_limit_info : null);
const resultFrom = (ev) => (ev.type === 'result' ? ev : null);

const detectLimit = (text) => {
  const limited = looksLikeLimit(text || '');
  return { limited, resetAt: limited ? parseReset(text || '') : null };
};
const detectAuth = (text) => looksLikeAuthError(text || '');

function outcome({ sid, result, rejected, stderr = '', code }) {
  const text = (result && result.result) || stderr.trim();
  if (result && !result.is_error) return { kind: 'done', sid, result };
  if (rejected || looksLikeLimit(text || '')) {
    return { kind: 'limited', sid, resetAt: rejected?.resetsAt || parseReset(text || ''), limitType: rejected?.rateLimitType, text };
  }
  if (detectAuth(text)) return { kind: 'auth', sid, text };
  if (looksLikeContextLimit(text)) return { kind: 'error', code: 'context_limit', sid, text };
  if (looksLikeMissingSession(text)) return { kind: 'error', code: 'session_missing', sid, text };
  return { kind: 'error', sid, text: text || `claude exited with code ${code}` };
}

// `claude -p /usage` (see ../usage.js, which also caches and interprets the readings). Required late: usage.js
// itself picks backends through ./index.js.
const readUsage = (acct, timeoutMs) => require('../usage').fetchUsage(acct, timeoutMs);
const loginStatus = (acct, timeoutMs) => authStatus(acct, timeoutMs);

module.exports = {
  id, buildArgs, sandboxSettings, carrySession, ISOLATED_SETTINGS, ISOLATED_ENV, isolatedEnv, env, spawn, killTree, prepare, parseEvent, sessionIdFrom, limitFromEvent, resultFrom, outcome,
  detectLimit, detectAuth, readUsage, loginStatus, toolSummary, toolInput, contextTokens, contextWindowOf, contextWindows,
};
