'use strict';
// Run Relay's panel in a normal browser, no Electron needed.
//   node src/dev.js          your real accounts
//   node src/dev.js --demo   throwaway accounts + a fake claude, to look at every state
if (process.argv.includes('--demo')) require('./demo').seedDemo();

require('./server').createServer().then((s) => console.log(`Relay panel: ${s.url}\nwith the launch intro: ${s.url}#boot=1`));
