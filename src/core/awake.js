'use strict';
// Keeping the Mac awake for a parked job's wake (Settings: preventSleepForWakes, off by default; preventSleepMinutes,
// default 10). A parked job's runner sleeps with short timer steps checked against the wall clock (job-runner.js), but
// while the Mac itself sleeps no timer runs at all: a wake due then happens only when the Mac next wakes (a wake due
// while the lid was closed ran a few minutes late, at the Mac's first DarkWake).
// With the setting on, the runner holds `caffeinate -i -s -w <runner pid> [-t <seconds>]` from preventSleepMinutes
// before the wake until its check ends: -i prevents idle sleep, -s system sleep on AC power, -w ends it with the runner
// (also if the runner is killed), -t bounds it. Closing the lid on battery still sleeps the Mac (macOS allows no
// process to prevent that). macOS only; elsewhere this does nothing.

const { spawn } = require('child_process');
const store = require('./store');

function settings() {
  const s = store.loadSettings();
  const min = Number(s.preventSleepMinutes);
  return { on: s.preventSleepForWakes === true, minutes: Number.isFinite(min) && min >= 0 ? Math.min(min, 120) : 10 };
}

// Starts caffeinate for this process; returns { pid, args, stop() } or null (setting off, not macOS, cannot start).
// untilMs: an end time (-t), or null for "until stop() or this process exits".
function hold({ untilMs = null, pid = process.pid } = {}) {
  if (!settings().on) return null;
  const bin = process.env.RELAY_CAFFEINATE || (process.platform === 'darwin' ? '/usr/bin/caffeinate' : '');
  if (!bin) return null;
  const args = ['-i', '-s', '-w', String(pid)];
  if (untilMs) args.push('-t', String(Math.max(1, Math.ceil((untilMs - Date.now()) / 1000))));
  let child;
  try {
    child = spawn(bin, args, { stdio: 'ignore', detached: false });
    child.on('error', () => {});
    if (child.unref) child.unref();
  } catch {
    return null;
  }
  if (!child.pid) return null;
  return {
    pid: child.pid, args, since: Date.now(), untilMs,
    stop() { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}

module.exports = { settings, hold };
