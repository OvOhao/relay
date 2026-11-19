'use strict';
// The tools Relay gives each Claude window. Kept apart, with no dependencies, so the MCP server can read the current
// definitions again after Relay is updated (and tell the window they changed) without being restarted.

const TOOLS = [
  {
    name: 'relay_run',
    description:
      'Hand a substantial, self-contained job to a Relay worker account (a separate Claude login running the official Claude Code), so it uses that account\'s usage instead of this window\'s. ' +
      'The worker CANNOT see this conversation: put everything it needs in `task` and `context`. ' +
      'Use a stable `thread` name per line of work: calling again with the same thread continues it and the worker remembers everything. ' +
      'Returns the worker\'s final report. If it returns NO_WORKER_AVAILABLE or BUSY, tell the user and then decide whether to do the work yourself. ' +
      'relay_run blocks until the job is done (and up to 30 minutes when every worker is busy): use it for one short job. For several jobs at once, or a long one, prefer relay_start + relay_wait, so you can keep talking to the user and take each result as it comes. ' +
      'Every worker ends its report with a ```relay-summary JSON block (status, run_ids, key_files, checks, decisions_needed, next_step); relay_poll / relay_wait show it first. ' +
      'A project can add rules in .relay/project.json (rules_file appended to every worker\'s instructions, protected_paths no job may change, post_checks Relay runs after each job that may change files (a read-only job runs none, or with output_file only on that file): a failure flags the job CHECKS_FAILED, checks cut by the time cap or skipped past 50 files CHECKS_INCOMPLETE; failed and cancelled jobs are checked too; the worker\'s account is free for the next job while they run; require_scope: true refuses a job that may change files without scope, write_paths or output_file, and a scope of "." / cwd / the git root; isolated_hide_paths are hidden from every isolated job). relay_poll, relay_wait and relay_status start with a "Needs action:" line listing every flag to act on; once you have looked into a flag and resolved it (e.g. proven a false positive), record that with relay_ack so it leaves the line. ' +
      'Long-running work (e.g. an experiment on a server): the worker may launch it, verify it runs and PARK the job (RELAY_PARK) instead of watching it; relay_run then returns at once with its report, the wake time and a job id, the worker account is freed, and the job wakes by itself to check and finish (collect it with relay_poll / relay_wait). ' +
      'Long threads: when a thread\'s session nears its context limit (70% by default) or fails with "Prompt is too long", Relay asks it for a handoff note and continues the thread in a new session that gets the note (shown as "handed off (n)"). ' +
      'Worker health: when the task names a command a worker refused at its last health check (relay_health), or the worker has not trusted the project, Relay picks a healthy worker; with none, the job runs with a HEALTH WARNING.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete instructions: the goal, what "done" looks like, how to verify. Self-contained.' },
        cwd: { type: 'string', description: 'Absolute path of the project folder the worker should work in (normally this session\'s working directory).' },
        context: { type: 'string', description: 'Background from this conversation the worker needs: the user\'s goal in their words, decisions already made, constraints, relevant files, what has been tried.' },
        thread: { type: 'string', description: 'Short kebab-case name for this line of work, e.g. "auth-refactor". Reuse it to continue; omit for a one-off.' },
        read_only: { type: 'boolean', description: 'True for investigation or review that must not change any file.' },
        account: { type: 'string', description: 'Optional: run on this worker account (its e-mail or name as relay_status lists it), e.g. to run two jobs on two different accounts at the same time. Omit to let Relay pick: among workers under their own cap (1-3 jobs at once, from how much weekly usage they have left per day until the reset), the one with the fewest running jobs, then the lower tier (1-3, set per worker in Relay\'s panel), then the one whose weekly usage resets soonest. The leader account (this window) only takes jobs while its switch "Leader takes jobs too" is on. A named account is used up to 3 jobs whatever its cap; when it is full the job waits for a slot there (one that is limited or signed out is passed over).' },
        model: { type: 'string', description: 'Optional model for the worker, e.g. "haiku", "sonnet", "opus", "fable" or a full id such as "claude-haiku-5-5" or "claude-fable-5-1". Omit to use the worker account\'s default. Use a smaller model for mechanical work to save usage. For agent "codex": a Codex model id, or omit to use the Codex account\'s own.' },
        effort: {
          type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Optional reasoning effort for the worker (Claude Code\'s --effort). Omit to use the project\'s or account\'s own setting. Applies to this call only, also when continuing a thread.',
        },
        title: { type: 'string', description: 'A 3-8 word label saying what this job is, shown in Relay\'s panel, e.g. "Build promo website". Max 60 characters.' },
        agent: {
          type: 'string', enum: ['claude', 'codex'],
          description: 'Optional: which agent runs the job. "claude" (default) or "codex" (an OpenAI Codex CLI account, a different model family for an independent second opinion). Codex jobs must be read-only (read_only: true): reviews, audits, investigation. They run sandboxed with the home folder unreadable, and fail if the folder changed. A thread stays on the agent it started on.',
        },
        preset: {
          type: 'string',
          description: 'Optional: a task preset from Relay\'s settings, e.g. "security" for security research (vulnerabilities, attacks and defences, prompt injection, red teaming, reward hacking). It gives the worker that work\'s real background in its system prompt. Relay applies a preset by itself when the job matches its keywords, and a preset tied to a project folder (its `projects`) to every job in that folder; pass "none" to stop that.',
        },
        scope: {
          type: 'array', items: { type: 'string' },
          description: 'Optional: the folders this job will change, relative to cwd, e.g. ["ideas/alpha"]. Several jobs run in one folder at once, each on a free worker; two jobs whose scopes overlap run one after the other so they never edit the same files together. Read-only jobs never wait. With require_scope, "." (the whole folder) is refused: list the specific folders.',
        },
        isolated: {
          type: 'boolean',
          description: 'Optional: true for an INDEPENDENT review or audit. The worker gets no project ledger and no other workers\' results (only its own thread\'s history); use a new thread name or omit thread (a thread with non-isolated history is refused). Recorded in the job and ledger. Combine with hide_paths to keep it away from other reviews. Claude: auto memory and the git snapshot are off, and .git and every account\'s memory folder are unreadable (git log fails).',
        },
        hide_paths: {
          type: 'array', items: { type: 'string' },
          description: 'Optional: paths relative to cwd (globs allowed, e.g. "ideas/*/reviews") the worker may not read. Claude: Read deny rules; Codex: denied in its sandbox. After the run Relay checks the tool calls; any access marks the job ISOLATION BREACH (the report is still returned).',
        },
        output_file: {
          type: 'string',
          description: 'Optional: a file relative to cwd Relay writes the worker\'s final report to (Markdown, atomically) after a successful run, also for read_only and Codex jobs. Refused if it leaves cwd, is protected by the project config, or exists (unless overwrite: true). If the worker wrote the file itself with its own tool calls, Relay keeps it and saves the report as <name>.relay-report.md next to it.',
        },
        overwrite: { type: 'boolean', description: 'With output_file: replace the file if it exists.' },
        priority: {
          type: 'string', enum: ['high', 'normal', 'low'],
          description: 'Optional (default "normal"): when jobs wait for a free worker, a freed slot goes to the highest priority, then the job waiting longest, across all windows. Use "high" for work that blocks the user or a gate, "low" for background chores. A parked job keeps its priority when it wakes.',
        },
        write_paths: {
          type: 'array', items: { type: 'string' },
          description: 'Optional: write-limited job. The worker may create or change files ONLY under these paths (relative to cwd, globs allowed); edits elsewhere are refused, and any change outside them (also by a shell command) makes the job FAILED with the list of files (nothing is reverted). Not with read_only; not for Codex (use output_file).',
        },
      },
      required: ['task', 'cwd'],
    },
  },
  {
    name: 'relay_status',
    description: 'Show Relay\'s accounts (which one is this window\'s leader, which are workers, which are Codex workers for agent "codex", how much of their 5-hour and weekly usage is used, who is limited, which worker is next in line and why, how many jobs each runs or has parked), background jobs that are running or parked (with their priority and context handoffs), worker health (refused commands, untrusted workspace) and, if `cwd` is given, the worker threads in that project (with how full their context is).',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Optional absolute project folder.' } } },
  },
  {
    name: 'relay_health',
    description: 'Check that Relay\'s Claude worker accounts can work in a project: for each worker (or the one given) it runs one tiny job (model haiku, effort low, no file edits) that runs each `health_checks` command from the project\'s .relay/project.json and reports allowed / refused / exit code, and it reads whether the account has trusted the project folder. ' +
      'Returns per worker "ok" or what is wrong (e.g. "2 refused (ssh, latexmk), untrusted") with the exact fix for the user; Relay never changes trust or permissions itself. Results are kept (relay_status shows them) and used to keep jobs that need a refused command off that worker. Relay also re-checks by itself at most every 6 h per worker and project. Takes about a minute.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute project folder (its .relay/project.json lists the health_checks).' },
        account: { type: 'string', description: 'Optional: check only this worker account (e-mail or name).' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'relay_ledger',
    description: 'Read the project ledger: everything Relay workers have done in a project folder (summaries, files touched, open issues). Use it to re-orient after your own context was compacted or in a new conversation.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Absolute project folder.' } }, required: ['cwd'] },
  },
];

// Background jobs: the same job as relay_run, started at once and collected later.
const JOB_IDS = { type: 'array', items: { type: 'string' }, description: 'Job ids returned by relay_start.' };
TOOLS.push(
  {
    name: 'relay_start',
    description:
      'Start a Relay worker job in the background and return at once with its job id. Same parameters, checks and behaviour as relay_run (thread memory, ledger, scope locks, waiting for a free worker, agent "codex" read-only), ' +
      'but you are not blocked: start several jobs (one call each, in the same turn), keep talking to the user, then collect results with relay_wait (or check with relay_poll). ' +
      'Prefer it to relay_run for several jobs in parallel or any long job. The job keeps running if this window closes; its result stays available for 7 days. Invalid requests are refused at once with relay_run\'s message.',
    inputSchema: TOOLS[0].inputSchema,
  },
  {
    name: 'relay_wait',
    description:
      'Wait for background jobs from relay_start. Returns as soon as ANY of them finishes (default) or when ALL have (mode "all"), or after timeout_sec; ' +
      'finished jobs come with their full report (exactly what relay_run would have returned), the others with their state. A timeout does not stop the jobs: call relay_wait again for the rest. ' +
      'A job that PARKS (its worker launched long-running work and will check back at a set time, holding no worker meanwhile) also counts as an event: it is returned once with its report and wake time, unless include_parked is false.',
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: JOB_IDS,
        mode: { type: 'string', enum: ['any', 'all'], description: '"any" (default): return when the first job finishes. "all": wait for every job.' },
        timeout_sec: { type: 'number', description: 'Longest wait in seconds (default 300, max 600).' },
        include_parked: { type: 'boolean', description: 'Default true: a job that newly parked ends the wait (so you learn its ETA). false: keep waiting until jobs really finish.' },
      },
      required: ['job_ids'],
    },
  },
  {
    name: 'relay_poll',
    description:
      'Check background jobs without waiting: per job its state (queued, waiting for worker, waiting for folder, running, running checks, parked, done, failed, cancelled), account, model, priority (and its place in line while waiting for a worker), context handoffs, elapsed time and last progress line, for parked jobs the wake time, number of checks and latest report, and for finished jobs the full report. ' +
      'Give job_ids, or only cwd to list that project\'s recent jobs (e.g. after your context was compacted).',
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: JOB_IDS,
        cwd: { type: 'string', description: 'Absolute project folder: lists its recent jobs when no job_ids are given.' },
      },
    },
  },
  {
    name: 'relay_cancel',
    description: 'Stop background jobs started with relay_start (or parked from relay_run): the worker is stopped, its folder freed, and the ledger notes it was cancelled. A parked job is cancelled without waking. A job on a thread can be continued later with the same thread name.',
    inputSchema: { type: 'object', properties: { job_ids: JOB_IDS }, required: ['job_ids'] },
  },
);

// relay_ack: a tool of its own (a new name, so sessions opened before it existed see it too).
TOOLS.push({
  name: 'relay_ack',
  description:
    'Record that you looked into flags Relay raised on background jobs (CHECKS_FAILED, CHECKS_INCOMPLETE, ISOLATION BREACH, PROTECTED PATH CHANGED, WRITE_PATHS_VIOLATED, READ_ONLY_VIOLATED, OUTPUT_NOT_SAVED, too_many_wakes, guard_violation, "K in protected paths") and resolved them, e.g. proved a false positive. ' +
    'The acknowledgement is append-only: who (this window\'s account), when, which flags and your resolution go into the job record and the project ledger. ' +
    'Resolved flags leave the "Needs action:" line of relay_poll / relay_wait / relay_status and the panel\'s warning badge, but stay visible, marked "resolved: <reason>", in relay_poll, the job detail and relay_status\'s "Flagged jobs". ' +
    'An ack covers only what was raised before it: the same flag raised again by a later segment or wake of the job needs action again. Only the leader window can ack; Relay worker sessions are refused. Never ack a flag you have not checked.',
  inputSchema: {
    type: 'object',
    properties: {
      job_ids: { type: 'array', items: { type: 'string' }, description: 'The flagged jobs (ids from relay_start / the Needs action line).' },
      resolution: { type: 'string', description: 'Required: what you found and why no further action is needed, e.g. "false positive: concurrent changes by other jobs, see job k3x9p2q1-4f7a". Up to 1000 characters.' },
      flags: { type: 'array', items: { type: 'string' }, description: 'Optional: only these flags, e.g. ["CHECKS_FAILED"] ("in protected paths" for the K-in-protected-paths item). Default: every flag of each job that still needs action.' },
    },
    required: ['job_ids', 'resolution'],
  },
});

// relay_wake: a tool of its own (a new name, so sessions opened before it existed see it too).
TOOLS.push({
  name: 'relay_wake',
  description:
    'Wake parked background jobs NOW for a progress check, instead of at their scheduled time (the same as the "Check progress" button on a worker\'s card in Relay\'s panel). ' +
    'Give job_ids, or account to wake every job parked on that worker. Each job resumes its own session through the normal wake path (a fresh runner, the session carried to the worker that takes it, the wake prompt asking for a one-line "Progress:" first); the wake is marked "manual check" in the job\'s wake log, ' +
    'and when the check ends the tray app shows a notification with the short report, and the report goes into the job record (relay_poll / relay_wait show it). The job then finishes or parks again as the worker decides. ' +
    'Returns at once; collect the reports with relay_wait on the same ids. Says so when the worker has no parked jobs. Only the leader window can wake jobs; Relay worker sessions are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      job_ids: { type: 'array', items: { type: 'string' }, description: 'Parked jobs to wake now (ids from relay_start / relay_status).' },
      account: { type: 'string', description: 'Or: a worker account (its e-mail or name as relay_status lists it): wakes every job parked on it.' },
    },
  },
});

// relay_help: a tool with a new name, so a Claude session opened before an update sees it (sessions keep their first
// copy of the tools they already had, but are told about new ones). It lists every tool's current parameters, generated
// from the definitions above.
TOOLS.push({
  name: 'relay_help',
  description:
    'Show the CURRENT parameters of every Relay tool (relay_run, relay_start, relay_wait, relay_poll, relay_cancel, relay_ack, relay_wake, relay_health, relay_status, relay_ledger) with their descriptions. ' +
    'Call it when your tool list may be out of date: a session opened before a Relay update keeps the tool descriptions it started with, but Relay accepts every parameter listed here even if your tool list does not show it.',
  inputSchema: { type: 'object', properties: {} },
});

// How Relay chooses a worker (also in docs/handoff-and-priority.md).
const WORKER_RULE = 'Which worker gets a job: each worker has its own cap of jobs at once from its weekly quota. Daily spare = ' +
  '(100 - weekly % used) / days until its weekly reset (at least 0.25): 10 %/day or more -> 3 jobs, 5 to 10 -> 2, below 5 -> 1; ' +
  'a week at 95% or more -> 0 (it takes one job only when every other ready worker is at its cap); usage unknown -> 2; never above ' +
  'Settings > Jobs per worker (at most 3). Among the workers under their cap Relay takes the one with the fewest running jobs (parked ' +
  'jobs do not count), so every worker gets one before any gets a second; at the same load the lower tier first (each worker has a tier ' +
  '1, 2 or 3 in Relay\'s panel, 1 = most preferred and the default: with a and b at tier 1 and c at tier 2 jobs go a, b, c, a, b, c), ' +
  'then within a tier a 5-hour window at 95% or more goes after the others, then the earliest weekly reset, the least recently used. ' +
  'The leader account (this window) takes jobs like a worker only while its switch "Leader takes jobs too" is on. ' +
  'Background jobs (relay_start, parked wakes, jobs started from the panel) wait for a free worker or their folder as long as it takes ' +
  '(Settings: backgroundMaxWaitMin), showing their place in line; only relay_run gives up with BUSY after 30 minutes. A thread continues on its own worker only while that ' +
  'worker is under its cap; an explicit `account` is used up to 3 jobs whatever its cap, and the job waits when it is full. ' +
  'relay_status shows each worker\'s tier, daily spare, cap and place in line.';

const HELP_ORDER = ['relay_run', 'relay_start', 'relay_wait', 'relay_poll', 'relay_cancel', 'relay_ack', 'relay_wake', 'relay_health', 'relay_status', 'relay_ledger'];
function typeOf(p) {
  if (!p) return 'any';
  if (p.type === 'array') return `list of ${(p.items && p.items.type) || 'any'}`;
  return Array.isArray(p.enum) ? `${p.type}: ${p.enum.map((e) => JSON.stringify(e)).join(' | ')}` : p.type || 'any';
}
function paramLines(schema) {
  const props = (schema && schema.properties) || {};
  const req = new Set((schema && schema.required) || []);
  const names = Object.keys(props);
  if (!names.length) return ['  (no parameters)'];
  return names.map((n) => `  - ${n} (${typeOf(props[n])}${req.has(n) ? ', required' : ''}): ${props[n].description || ''}`.trimEnd());
}
// The text relay_help returns: built from TOOLS as they are on disk now.
function helpText() {
  const out = [
    'Relay tools: current parameters.',
    '',
    'If this session was opened before Relay was updated, its tool list may show older descriptions and miss newer parameters ' +
      '(for example isolated, output_file, overwrite, hide_paths, write_paths, priority). Pass them anyway: Relay reads every parameter listed here ' +
      'whatever your tool list shows (checked live: a session opened before the update passed isolated and priority and both took effect).',
    '',
    WORKER_RULE,
  ];
  for (const name of HELP_ORDER) {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) continue;
    out.push('', `## ${t.name}`, t.description, '', 'Parameters:');
    if (t.name === 'relay_start' && t.inputSchema === TOOLS[0].inputSchema) out.push('  The same as relay_run (above): every relay_run parameter works here too.');
    else out.push(...paramLines(t.inputSchema));
  }
  return out.join('\n');
}

module.exports = { TOOLS, helpText };
