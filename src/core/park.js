'use strict';
// Park / wake: a worker that has launched long-running work (an experiment on a server, a long build) and checked it
// really runs can end its turn with one final line
//     RELAY_PARK: <minutes> | <what to check on wake>
// The job is then "parked": nothing runs, no account is held, and at the given time the same session is resumed with
// a scheduled-check prompt. This module only reads that line and words the prompts; the job runner (src/job-runner.js)
// and core/jobs.js do the parking itself.

const MIN_MINUTES = 5;
const MAX_MINUTES = 1440;
const maxWakes = () => Number(process.env.RELAY_MAX_WAKES || 48); // tests lower it
// How long a parked job waits before trying again when, at wake time, every worker is busy or limited.
const RETRY_MINUTES = 5;
// One "minute" of a park, in ms (tests shorten it so a 5-minute park takes a moment).
const minuteMs = () => Number(process.env.RELAY_PARK_MINUTE_MS || 60000);

// The worker-side protocol, as written into every worker prompt (all providers).
const INSTRUCTIONS = [
  '- Long-running work (an experiment or training run on a server, a long build or download): you do not have to sit and watch it.',
  '  Once you have launched it AND verified it is actually running, and nothing else useful remains until it finishes, you may park this job:',
  '  first write in your report what you launched, where its logs and results are, and exactly how to check its status;',
  '  then end your reply with this one final line and nothing after it:',
  '  RELAY_PARK: <minutes> | <what to check on wake>',
  `  <minutes> is your estimate of the time until the work is done or worth checking (${MIN_MINUTES} to ${MAX_MINUTES}). Relay frees your account meanwhile and resumes this same session at that time with a scheduled check.`,
  '  Never park while work you could still do is pending, and never park without having verified the launched work is running.',
].join('\n');

// manual: the user asked for a progress check now (the panel's "Check progress", or relay_wake), before the
// scheduled time; the report then starts with one "Progress:" line Relay shows in a notification.
const wakePrompt = (n, { manual = false } = {}) => [
  manual
    ? `Progress check requested by the user now (wake ${n} of the job), before the scheduled time. Check the status of what you launched.\nStart your reply with one line "Progress: <one or two sentences: where it stands, what is done, what is left>": Relay shows that line in a notification.`
    : `Scheduled check (wake ${n} of the job). Check the status of what you launched.`,
  'If it has finished: collect and verify the results and write the final report (ending with the relay-summary block, as before).',
  'If it will finish within about 15 minutes: stay and monitor until it finishes.',
  'Otherwise: report progress and park again with a new RELAY_PARK estimate.',
  `(Park line format, as the very last line: RELAY_PARK: <minutes> | <what to check on wake>; minutes ${MIN_MINUTES} to ${MAX_MINUTES}.)`,
].join('\n');

// Reads the last non-empty line of a worker's final report.
//   null                                   no park line: the job ends as usual
//   { park: { minutes, asked, check, line } }  a valid park (minutes clamped to [5, 1440]; `asked` = as written)
//   { malformed: line }                    a line that tries to park but cannot be read: ignored, the job ends
const LOOSE = /^[\s>*_`]*RELAY[_ ]PARK\b/i;
const STRICT = /^[\s>*_`]*RELAY_PARK:\s*(\d+(?:\.\d+)?)\s*(?:min(?:utes?)?)?\s*\|\s*(.*?)[\s*_`]*$/;
function parseParkLine(report) {
  const lines = String(report || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (!LOOSE.test(last)) return null;
  const m = STRICT.exec(last);
  if (!m) return { malformed: last };
  const asked = Number(m[1]);
  const check = m[2].trim();
  if (!Number.isFinite(asked) || asked <= 0 || !check) return { malformed: last };
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(asked)));
  return { park: { minutes, asked, check: check.slice(0, 500), line: last } };
}

// The report without its park line (what the leader reads as "the latest report").
function stripParkLine(report) {
  const lines = String(report || '').replace(/\s+$/, '').split('\n');
  if (lines.length && LOOSE.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n').replace(/\s+$/, '');
}

const localTime = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

module.exports = { parseParkLine, stripParkLine, wakePrompt, INSTRUCTIONS, MIN_MINUTES, MAX_MINUTES, RETRY_MINUTES, maxWakes, minuteMs, localTime };
