'use strict';
// Provider backends: everything that differs between the agent CLIs Relay can run a worker on.
// Claude Code ('claude') and the OpenAI Codex CLI ('codex', read-only jobs only); the engine, workers, usage readings and login checks pick the backend
// by the account's `provider` (or a thread's), so another CLI can be added as one more module here.
//
// A backend is an object with:
//   id                       provider name stored in accounts.json and threads.json ('claude')
//   buildArgs(opts)          argv for one headless run. opts: { sessionId, model, effort, permissionMode,
//                            allowedTools, deniedTools, appendSystemPrompt, extraArgs, cwd, hidePaths, isolated } (strings /
//                            string arrays; '' or [] = not set; hidePaths: absolute paths the run may not read, for
//                            backends that enforce them in a sandbox). The prompt itself is written to stdin.
//   env(acct, extra)         environment for a process running as that account (host variables stripped)
//   spawn(args, opts)        start the CLI (child_process options, plus `group: true` for its own process group)
//   killTree(child)          stop a run started by spawn, and whatever it started
//   prepare(acct)            sync shared files into the account's config folder before a run
//   parseEvent(ev, acct)     one parsed stdout JSON line -> transcript items for the UI:
//                            { kind: 'init'|'text'|'tool'|'tool_result'|'notice'|'result'|'context', account, ... }
//                            (tool: name, summary, and `input` { file_path, path, pattern, glob, command } when known;
//                            tool_result: id, error, text: a tool call that failed or was refused, and why;
//                            context: tokens (input of the last model call) and/or window (the model's context size))
//   sessionIdFrom(ev)        the session id an event announces, or null
//   limitFromEvent(ev)       structured "this account is out of quota" info carried by an event, or null
//   resultFrom(ev)           the event when it is the run's final result, else null
//   outcome({ sid, result, rejected, stderr, code })
//                            how a finished run ended: { kind: 'done'|'limited'|'auth'|'error', sid, ... }
//                            (limited: resetAt, limitType, text; auth / error: text; error code 'context_limit' when
//                            the session's context is full: Relay hands the thread off to a new session)
//   detectLimit(text)        { limited, resetAt } from free text (the fallback when no structured event came)
//   detectAuth(text)         true when the text says the login is gone
//   readUsage(acct)          Promise<{ data } | { error, authFailed?, timedOut? }>; data = { session, week, others }
//   loginStatus(acct)        Promise<{ loggedIn, email?, subscriptionType?, error? }> (local check, no model call)
// Optional:
//   preflight(acct, { cwd }) Promise<{ ok, code?, text? }>: checked before every run; not ok = nothing is started
//   resumeAcrossAccounts     false when a session cannot move to another account (a failover starts it again)
//   resultFrom(ev, prev)     gets the result so far, so a provisional one can be replaced
//   isolatedEnv()            extra environment for an isolated job's runs (Claude: auto memory off)
//
// A session lives in one provider's format: a thread is only ever continued by an account of the same provider,
// and failover on a limit stays within that provider.

const DEFAULT_PROVIDER = 'claude';

const loaders = {
  claude: () => require('./claude'),
  codex: () => require('./codex'),
};

const PROVIDERS = Object.keys(loaders);

function getBackend(name = DEFAULT_PROVIDER) {
  const id = name || DEFAULT_PROVIDER;
  const load = Object.prototype.hasOwnProperty.call(loaders, id) ? loaders[id] : null;
  if (!load) {
    throw Object.assign(new Error(`Unknown provider "${id}": Relay can run workers on ${PROVIDERS.join(', ')}.`), { code: 'unknown_provider' });
  }
  return load();
}

// The provider of an account or thread record; records written before providers existed are Claude's.
const providerOf = (rec) => (rec && typeof rec.provider === 'string' && rec.provider) || DEFAULT_PROVIDER;

const backendFor = (rec) => getBackend(providerOf(rec));

module.exports = { getBackend, backendFor, providerOf, PROVIDERS, DEFAULT_PROVIDER };
