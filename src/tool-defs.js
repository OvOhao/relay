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
      'Returns the worker\'s final report. If it returns NO_WORKER_AVAILABLE or BUSY, tell the user and then decide whether to do the work yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete instructions: the goal, what "done" looks like, how to verify. Self-contained.' },
        cwd: { type: 'string', description: 'Absolute path of the project folder the worker should work in (normally this session\'s working directory).' },
        context: { type: 'string', description: 'Background from this conversation the worker needs: the user\'s goal in their words, decisions already made, constraints, relevant files, what has been tried.' },
        thread: { type: 'string', description: 'Short kebab-case name for this line of work, e.g. "auth-refactor". Reuse it to continue; omit for a one-off.' },
        read_only: { type: 'boolean', description: 'True for investigation or review that must not change any file.' },
        account: { type: 'string', description: 'Optional: run on this worker account (its e-mail or name as relay_status lists it), e.g. to run two jobs on two different accounts at the same time. Omit to let Relay pick the least busy worker.' },
        model: { type: 'string', description: 'Optional model for the worker, e.g. "haiku", "sonnet", "opus" or a full id such as "claude-haiku-5-5". Omit to use the worker account\'s default. Use a smaller model for mechanical work to save usage.' },
        title: { type: 'string', description: 'A 3-8 word label saying what this job is, shown in Relay\'s panel, e.g. "Build promo website". Max 60 characters.' },
        scope: {
          type: 'array', items: { type: 'string' },
          description: 'The folders this job will change, relative to cwd, e.g. ["ideas/i025-vla"]. Jobs whose scopes do not overlap run at the same time on different workers; omit it to reserve the whole folder (then other jobs in it wait). Read-only jobs never wait.',
        },
      },
      required: ['task', 'cwd'],
    },
  },
  {
    name: 'relay_status',
    description: 'Show Relay\'s accounts (which one is this window\'s leader, which are workers, how much of their 5-hour and weekly usage is used, who is limited) and, if `cwd` is given, the worker threads in that project.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Optional absolute project folder.' } } },
  },
  {
    name: 'relay_ledger',
    description: 'Read the project ledger: everything Relay workers have done in a project folder (summaries, files touched, open issues). Use it to re-orient after your own context was compacted or in a new conversation.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Absolute project folder.' } }, required: ['cwd'] },
  },
];

module.exports = { TOOLS };
