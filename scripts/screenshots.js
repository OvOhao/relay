'use strict';
// The README screenshots, taken from the real panel with the demo accounts (nothing of yours is read or shown):
//   npx electron scripts/screenshots.js
// Writes docs/screenshots/{overview,accounts,settings,overview-dark}.png at 2x.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const W = 400;
const H = 640;
const fake = path.join(__dirname, '..', 'test', 'fake-claude.js');
const root = require('../src/demo').seedDemo({
  claudeCmd: process.platform === 'win32' ? ['node', fake] : ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, fake],
});
app.setPath('userData', path.join(root, 'electron'));

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    await require('../src/core/connect').install(); // connected, as after setup: the panel shows the day-to-day view
    const server = await require('../src/server').createServer();
    const win = new BrowserWindow({
      width: W * 2, height: H * 2, show: false, frame: false, useContentSize: true, enableLargerThanScreen: true,
      webPreferences: { offscreen: true, zoomFactor: 2, sandbox: true },
    });
    const shot = async (name) => {
      await pause(900);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
      console.log(`wrote docs/screenshots/${name}.png (${img.getSize().width}x${img.getSize().height})`);
    };
    const click = (sel) => win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`);

    fs.mkdirSync(OUT, { recursive: true });
    nativeTheme.themeSource = 'light';
    await win.loadURL(server.url);
    await pause(1500);
    await shot('overview');
    await click('[data-act="tab"][data-tab="accounts"]');
    await shot('accounts');
    await click('[data-act="tab"][data-tab="overview"]');
    await click('[data-act="settings"]');
    await shot('settings');
    await click('[data-act="back"]');
    nativeTheme.themeSource = 'dark';
    await shot('overview-dark');
    server.close();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
