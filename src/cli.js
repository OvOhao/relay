#!/usr/bin/env node
'use strict';
// Terminal companion to the Relay panel. Sign-in runs Claude Code's own `claude auth login` in
// this terminal, so the browser / code flow is exactly the one you already know.
//   relay add [--email you@x.com] [--name acct-b] [--desktop]
//   relay login <name>        sign in again
//   relay list                accounts and their state
//   relay desktop <name>      mark the account your Claude desktop app is signed in to
//   relay remove <name>
//   relay connect | disconnect       wire Relay into Claude Code (hooks, tool, skill) or take it out again
//   relay remove-all [--logins]      disconnect; with --logins also delete every saved sign-in, profile and note

const path = require('path');
const { spawn } = require('child_process');
const store = require('./core/store');
const setup = require('./core/setup');
const hook = require('./core/hook');
const connect = require('./core/connect');
const platform = require('./core/platform');
const { spawnClaude, accountEnv, authStatus } = require('./core/claude');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--') || (i > 0 && rest[i - 1] === undefined));

function fmt(sec) {
  return new Date(sec * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function runLogin(acct) {
  return new Promise((resolve) => {
    const args = ['auth', 'login', ...(acct.email ? ['--email', acct.email] : [])];
    console.log(`\nSigning in "${acct.name}" with Claude Code's own login. Follow the browser page; if it is already\nsigned in to a different Claude account, open the printed link in a private window instead.\n`);
    const child = spawnClaude(args, { env: accountEnv(acct), stdio: 'inherit' });
    child.on('error', (e) => { console.error(e.message); resolve(-1); });
    child.on('close', resolve);
  }).then(async (code) => {
    const info = await authStatus(acct);
    if (code === 0 && info.loggedIn) {
      store.update(acct.name, { needsLogin: false, email: info.email || acct.email, plan: info.subscriptionType || '' });
      console.log(`\n✓ ${acct.name}: signed in as ${info.email} (${info.subscriptionType || 'unknown plan'})`);
      return true;
    }
    console.log(`\n✗ ${acct.name}: sign-in did not finish (exit ${code}). Run \`relay login ${acct.name}\` to retry.`);
    return false;
  });
}

async function main() {
  switch (cmd) {
    case 'add': {
      const taken = new Set(store.load().map((a) => a.name));
      let n = 1;
      while (taken.has(`acct-${n}`)) n++;
      const name = typeof flag('name') === 'string' ? flag('name') : `acct-${n}`;
      if (taken.has(name)) throw new Error(`"${name}" already exists`);
      const email = typeof flag('email') === 'string' ? flag('email') : '';
      const dir = setup.accountDir(name);
      setup.prepareConfigDir(dir);
      store.upsert({ ...store.newAccount(name, dir, email), needsLogin: true });
      const ok = await runLogin(store.get(name));
      if (ok && flag('desktop')) { store.setDesktop(name); console.log(`  marked as your Claude desktop app account`); }
      break;
    }
    case 'login': {
      const acct = store.get(rest[0]);
      if (!acct) throw new Error(`no account named "${rest[0]}" (see \`relay list\`)`);
      await runLogin(acct);
      break;
    }
    case 'list': {
      const accounts = store.load();
      if (!accounts.length) return console.log('No accounts yet. Add one with `relay add`.');
      for (const a of accounts) {
        const state = a.needsLogin ? 'SIGN IN NEEDED' : a.blockedUntil > store.nowSec() ? `limited until ${fmt(a.blockedUntil)} (${a.blockedReason})` : 'ready';
        console.log(`${a.desktop ? '★' : ' '} ${a.name.padEnd(12)} ${(a.email || '-').padEnd(34)} ${(a.plan || '-').padEnd(6)} ${state}`);
      }
      console.log('\n★ = the account your Claude desktop app is signed in to');
      break;
    }
    case 'desktop': {
      if (!store.get(rest[0])) throw new Error(`no account named "${rest[0]}"`);
      store.setDesktop(rest[0]);
      console.log(`${rest[0]} is now marked as your Claude desktop app account`);
      break;
    }
    case 'remove': {
      const acct = store.get(rest[0]);
      if (!acct) throw new Error(`no account named "${rest[0]}"`);
      const own = store.ownsConfigDir(acct.configDir);
      if (own) await platform.forgetLogin(acct); // macOS: the login lives in the Keychain, not in the folder
      store.remove(acct.name);
      if (own) setup.removeConfigDir(acct.configDir);
      console.log(`removed ${acct.name}`);
      break;
    }
    case 'connect': {
      const st = await connect.install();
      console.log(`connected: hooks ${st.hook ? 'yes' : 'NO'}, tool ${st.mcp ? 'yes' : 'NO'}, skill ${st.skill ? 'yes' : 'NO'}`);
      break;
    }
    case 'disconnect': {
      const st = await connect.uninstall();
      console.log(`disconnected (all wired: ${st.all})`);
      break;
    }
    case 'remove-all': {
      const logins = rest.includes('--logins');
      await connect.removeAll({ logins });
      console.log(logins
        ? 'Relay was removed from Claude Code and all of its data, including saved sign-ins, was deleted.'
        : 'Relay was removed from Claude Code. Saved account sign-ins were kept (add --logins to delete them too).');
      break;
    }
    case 'hook': {
      const sub = rest[0];
      if (!['install', 'uninstall', 'status'].includes(sub)) throw new Error('usage: relay hook install|uninstall|status');
      const s = hook[sub]();
      console.log(`hook ${s.installed ? 'INSTALLED' : 'not installed'} in ${s.settingsPath}`);
      break;
    }
    default:
      console.log('relay add | login <name> | list | desktop <name> | remove <name> | connect | disconnect | remove-all | hook install|uninstall|status');
  }
}

main().catch((e) => { console.error(`relay: ${e.message}`); process.exitCode = 1; });
