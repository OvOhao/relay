'use strict';
// Recognising "this account is out of quota" in Claude Code output.
// The structured `rate_limit_event` is the primary signal; these text helpers are the fallback.

const LIMIT_RE =
  /(hit your[^.·|]{0,40}limit|usage limit reached|(?:5-hour|session|weekly|opus|sonnet|usage) limit reached)/i;
const AUTH_RE =
  /(failed to authenticate|authentication_error|oauth (?:access )?token|not logged in|please run \/login|invalid api key)/i;
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

function looksLikeLimit(text) {
  return LIMIT_RE.test(text) && !/context limit/i.test(text);
}

// The session's context is full: Claude Code says "Prompt is too long" (also "prompt is too long: N tokens > M maximum";
// its own check also accepts "input is too long for requested model"; older builds: "Context limit reached") — strings
// in the 2.1.32x CLI. The API's own wording is "input length and `max_tokens` exceed context limit".
const CONTEXT_RE = /(prompt is too long|input is too long for requested model|context limit reached|exceeds? (?:the )?context (?:window|limit)|context window exceeded|context_length_exceeded|input length and [`']?max_tokens[`']? exceed)/i;
function looksLikeContextLimit(text) {
  return CONTEXT_RE.test(String(text || ''));
}

// `--resume <id>` found no transcript of that session in the account's projects folder (Claude Code 2.1.32x:
// "No conversation found with session ID: <id>").
const MISSING_SESSION_RE = /no conversation found with session id/i;
function looksLikeMissingSession(text) {
  return MISSING_SESSION_RE.test(String(text || ''));
}

function looksLikeAuthError(text) {
  return AUTH_RE.test(text);
}

// Best-effort reset time (epoch seconds) from CLI text such as
// "Claude AI usage limit reached|1760000000" or "You've hit your session limit · resets 3pm".
function parseReset(text, nowSec = Date.now() / 1000) {
  let m = /limit reached\s*\|\s*(\d{9,11})/.exec(text);
  if (m) return Number(m[1]);
  m = /resets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(text);
  if (!m) return null;
  const [, mon, day, hh, mm, ap] = m;
  const hour = (Number(hh) % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
  const now = new Date(nowSec * 1000);
  const t = new Date(now);
  t.setHours(hour, Number(mm || 0), 0, 0);
  const monthIdx = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
  if (monthIdx >= 0) {
    t.setMonth(monthIdx, Number(day));
    if (t <= now) t.setFullYear(t.getFullYear() + 1);
  } else if (t <= now) {
    t.setDate(t.getDate() + 1);
  }
  return t.getTime() / 1000;
}

module.exports = { looksLikeLimit, looksLikeAuthError, looksLikeContextLimit, looksLikeMissingSession, parseReset };
