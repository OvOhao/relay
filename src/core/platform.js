'use strict';
// macOS specifics that the Windows build never needed.
//   fixPath()        an app opened from Finder, the Dock or at login gets launchd's bare PATH (/usr/bin:/bin:...),
//                    so `claude` (and the `node` an npm-installed `claude` needs) would not be found. Borrow the
//                    PATH of the user's login shell once, at start-up, and add the usual install folders.
//   setAutoStart()   "Open at login" as a per-user LaunchAgent. Unlike Electron's login item it works when Relay is
//                    run from source too, and it can pass --hidden so Relay starts quietly in the menu bar.
//   forgetLogin()    on macOS Claude Code keeps each login in the Keychain (one entry per config dir), not in the
//                    config dir itself: deleting the folder would leave the entry behind. Signing out through
//                    Claude Code's own `claude auth logout` removes it. Relay still never reads it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const isMac = () => process.platform === 'darwin';
const LABEL = 'dev.relay.app';
const MARK = '__RELAY_PATH__';

// The folders Claude Code's installers use, then the system ones; whatever the login shell says comes first.
function standardDirs() {
  const h = os.homedir();
  return [path.join(h, '.local', 'bin'), path.join(h, '.claude', 'local'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

function shellPath() {
  const sh = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(sh, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' }, // never prompt from a dotfile
    });
    const m = new RegExp(`${MARK}(.*)${MARK}`).exec(out);
    return m ? m[1] : '';
  } catch {
    return ''; // a slow or broken dotfile must not stop Relay: the standard folders still apply
  }
}

function mergePath(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const d of (Array.isArray(list) ? list : String(list || '').split(path.delimiter))) {
      if (d && !seen.has(d)) { seen.add(d); out.push(d); }
    }
  }
  return out.join(path.delimiter);
}

function fixPath() {
  if (!isMac() || process.env.RELAY_SKIP_PATH_FIX) return process.env.PATH;
  process.env.PATH = mergePath(shellPath(), process.env.PATH, standardDirs());
  return process.env.PATH;
}

// ---- open at login ----
// Tests and the demo set RELAY_HOME; they must never write into the real ~/Library/LaunchAgents.
const agentsDir = () => process.env.RELAY_LAUNCH_AGENTS_DIR
  || (process.env.RELAY_HOME ? path.join(process.env.RELAY_HOME, 'LaunchAgents') : path.join(os.homedir(), 'Library', 'LaunchAgents'));
const agentFile = () => path.join(agentsDir(), `${LABEL}.plist`);

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// /Applications/Relay.app/Contents/MacOS/Relay -> /Applications/Relay.app
const bundleOf = (execPath) => path.resolve(execPath, '..', '..', '..');

// Packaged: start the bundle through LaunchServices (`open -g`: in the background, no window stealing focus).
// From source: start this Electron with the app folder, the same way `npm start` does.
function launchArgs({ packaged, execPath, appPath }) {
  return packaged
    ? ['/usr/bin/open', '-g', '-a', bundleOf(execPath), '--args', '--hidden']
    : [execPath, appPath, '--hidden'];
}

function agentPlist(opts) {
  const args = launchArgs(opts).map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

// launchd reads ~/Library/LaunchAgents at the next login; nothing is loaded now, so nothing starts twice.
function setAutoStart(on, opts) {
  const file = agentFile();
  if (!on) { fs.rmSync(file, { force: true }); return false; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, agentPlist(opts));
  return true;
}

const autoStartInstalled = () => fs.existsSync(agentFile());
const removeAutoStart = () => fs.rmSync(agentFile(), { force: true });

// ---- signing an account out before its folder is deleted ----
function forgetLogin(acct, { timeoutMs = 20000 } = {}) {
  if (!isMac() && !process.env.RELAY_LOGOUT_ON_REMOVE) return Promise.resolve(false);
  const { spawnClaude, accountEnv } = require('./claude'); // late: claude.js needs store, which is fine, but keep this module light
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnClaude(['auth', 'logout'], { env: accountEnv(acct, { RELAY_TAKEOVER: 'logout' }), cwd: os.tmpdir(), stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

module.exports = { fixPath, mergePath, standardDirs, setAutoStart, autoStartInstalled, removeAutoStart, agentPlist, agentFile, launchArgs, forgetLogin, LABEL };
