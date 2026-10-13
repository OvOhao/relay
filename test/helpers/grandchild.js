'use strict';
// Stands in for a `claude` run that started a long-lived process of its own (a dev server, a test watcher):
// it starts a grandchild, writes the grandchild's pid to $GRANDCHILD_PID_FILE, then waits to be stopped.
const fs = require('fs');
const { spawn } = require('child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(g.pid));
setInterval(() => {}, 1000);
