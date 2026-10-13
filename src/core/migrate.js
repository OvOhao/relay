'use strict';
// Relay used to be called Baton and kept its data in ~/.baton. The first time Relay starts, everything there moves to
// ~/.relay (settings, usage readings, the project ledgers and threads, browser profiles, logs) except the sign-in
// folders under ~/.baton/accounts: on macOS each login is a Keychain entry tied to its folder's path, so those stay
// where they are and Relay keeps using them in place (see store.accountRoots). Nobody has to sign in again.

const fs = require('fs');
const path = require('path');
const store = require('./store');

const KEEP_IN_PLACE = new Set(['accounts']);

function migrateHome() {
  const old = store.legacyHome();
  const home = store.home();
  if (!old || !fs.existsSync(old) || path.resolve(old) === path.resolve(home)) return { moved: [] };
  if (fs.existsSync(path.join(home, 'accounts.json'))) return { moved: [] }; // done before, or Relay set up from scratch
  fs.mkdirSync(home, { recursive: true });
  const moved = [];
  for (const name of fs.readdirSync(old)) {
    if (KEEP_IN_PLACE.has(name) || fs.existsSync(path.join(home, name))) continue;
    try {
      fs.renameSync(path.join(old, name), path.join(home, name));
      moved.push(name);
    } catch { /* in use or on another volume: Relay starts without it rather than not at all */ }
  }
  return { moved };
}

module.exports = { migrateHome };
