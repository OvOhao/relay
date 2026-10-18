'use strict';
// Electron shell: a small window that lives in the tray (Windows) or the menu bar (macOS). It has to keep running
// when closed, because the Claude Code hook can only reach a Relay that is alive.
//
// macOS: Relay is a menu-bar app. No Dock icon; a template icon in the menu bar (it follows light / dark menu bars)
// with the number of running jobs next to it; clicking it drops the panel down under the icon, and clicking
// anywhere else puts it away again, unless "Keep panel open" is ticked in the icon's right-click menu.

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, shell, powerSaveBlocker, screen } = require('electron');
const os = require('os');
const path = require('path');
const platform = require('./core/platform');

const isMac = process.platform === 'darwin';
// Opened from Finder, the Dock or at login, a macOS app gets launchd's bare PATH: find `claude` (and the `node` an
// npm-installed one needs) the way a terminal would. Done before anything below can start Claude Code.
if (isMac) platform.fixPath();

// `--demo`: throwaway accounts and a fake `claude` in a temporary folder; your real sign-ins and settings are not
// touched. The fake runs on this same Electron binary, as Node.
// (ELECTRON_RUN_AS_NODE is set for that one command only: Electron's own helper processes must not inherit it.)
const demo = process.argv.includes('--demo');
if (demo) {
  const fake = path.join(__dirname, '..', 'test', 'fake-claude.js');
  const root = require('./demo').seedDemo({
    claudeCmd: process.platform === 'win32' ? ['node', fake] : ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, fake],
  });
  app.setPath('userData', path.join(root, 'electron')); // not the real app's cookies and caches either
}

const { createServer } = require('./server');
const { createIntroGate } = require('./intro');
const store = require('./core/store');

// The language is a setting (English by default), read whenever a string is needed so a change applies at once.
const isZh = () => store.loadSettings().language === 'zh';
const txt = () => (isZh()
  ? { open: '打开 Relay', quit: '退出 Relay', pin: '保持面板打开', tip: 'Relay · 守着 Claude Code', tipBusy: (n) => `Relay · 接管中 (${n})` }
  : { open: 'Open Relay', quit: 'Quit Relay', pin: 'Keep panel open', tip: 'Relay · watching Claude Code', tipBusy: (n) => `Relay · taking over (${n})` });

// Names the app for Windows before it is ready, so the taskbar groups and icons it as Relay, not as Electron.
if (process.platform === 'win32') app.setAppUserModelId('dev.relay.app');

const MSG = {
  start: (n) => (isZh() ? [`${n.job.project}`, `${n.origin ? `${n.origin} 额度用完，` : ''}正在其他账号上继续`] : [n.job.project, `${n.origin ? `${n.origin} hit its limit. ` : ''}Continuing on another account`]),
  switch: (n, label) => (isZh() ? [n.job.project, `已交给 ${label(n.to)}`] : [n.job.project, `Passed on to ${label(n.to)}`]),
  done: (n) => (isZh() ? [n.job.project, '已完成，回到原窗口即可查看'] : [n.job.project, 'Finished. Open the session as usual to see the result']),
  failed: (n) => (isZh() ? [n.job.project, '未能完成'] : [n.job.project, 'Could not be finished']),
  leader: (n, label) => (isZh() ? ['领队已切换', n.to ? `现在窗口用的是 ${label(n.to)}` : `现在窗口用的是号池外的账号 ${n.outside}`] : ['Leader changed', n.to ? `This window now uses ${label(n.to)}` : `This window now uses ${n.outside}, which is not in the pool`]),
  'needs-login': (n, label) => (isZh() ? ['需要重新登录', label(n.account)] : ['Sign-in needed', label(n.account)]),
};

// Relay must keep watching for Claude Code from the tray: a stray error is logged, not turned into Electron's
// "A JavaScript error occurred in the main process" dialog (which also leaves the app in an unknown state).
process.on('uncaughtException', (e) => console.error('[relay] uncaught exception (kept running):', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[relay] unhandled rejection (kept running):', (e && e.stack) || e));

// `--disconnect` (run by the uninstaller): take Relay out of Claude Code, print one line, leave. It runs before the
// single-instance lock and before any window, so it works while Relay is running and never shows anything.
if (process.argv.includes('--disconnect')) {
  const say = (line) => process.stdout.write(line + String.fromCharCode(10));
  require('./cli-disconnect').disconnect()
    .then(say)
    .catch((e) => say(`Relay disconnect: could not finish (${(e && e.message) || e}).`))
    .finally(() => app.exit(0));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let server = null;
  let quitting = false;
  let blocker = null;
  let hiddenAt = 0; // macOS: when the panel was put away because it lost focus (see togglePanel)

  let busyCount = 0;

  const asset = (f) => path.join(__dirname, '..', 'build', f);
  const windowIcon = () => asset(process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const pinned = () => !!store.loadSettings().panelPinned;

  const setTooltip = () => {
    tray?.setToolTip(busyCount ? txt().tipBusy(busyCount) : txt().tip);
    // macOS: the running-job count sits right next to the menu-bar icon
    if (isMac) tray?.setTitle(busyCount ? String(busyCount) : '', { fontType: 'monospacedDigit' });
  };
  const trayMenu = () => Menu.buildFromTemplate([
    { label: txt().open, click: showWindow },
    ...(isMac ? [{ label: txt().pin, type: 'checkbox', checked: pinned(), click: (item) => { store.saveSettings({ panelPinned: item.checked }); } }] : []),
    { type: 'separator' },
    { label: txt().quit, click: () => { quitting = true; app.quit(); } },
  ]);
  function buildMenu() {
    // macOS: a context menu set on the tray would take over the left click, which opens the panel instead;
    // the menu is popped up on a right click (or control-click) instead.
    if (!isMac) tray?.setContextMenu(trayMenu());
  }

  // macOS: drop the panel down under the menu-bar icon, kept inside the screen the icon is on.
  function placeUnderTray() {
    if (!isMac || !tray || !win || pinned()) return;
    const tb = tray.getBounds();
    const wb = win.getBounds();
    if (!tb.width) return; // the icon is not on screen (hidden by the menu bar overflow): keep the last place
    const area = screen.getDisplayNearestPoint({ x: tb.x + tb.width / 2, y: tb.y }).workArea;
    const x = Math.round(Math.min(Math.max(tb.x + tb.width / 2 - wb.width / 2, area.x + 8), area.x + area.width - wb.width - 8));
    win.setPosition(x, Math.round(area.y + 6), false);
  }

  function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    placeUnderTray();
    const reveal = () => {
      if (isMac) app.focus({ steal: true }); // a menu-bar app is not active by itself: bring the panel to the front
      win.show(); win.focus();
    };
    // started hidden: the first time the window is opened plays the intro (the page draws its splash, then we show it)
    if (intro.onShow()) win.webContents.executeJavaScript('window.relayIntro && window.relayIntro()').catch(() => {}).finally(reveal);
    else reveal();
    server?.refreshUsage({ maxAgeMs: 15000 }); // opening the panel shows fresh numbers, not the ones from when it was hidden
  }

  // macOS menu-bar click: open, or put away. Clicking the icon while the panel is open first takes the focus away
  // (which already hides it), so a hide that just happened counts as this click's answer.
  function togglePanel() {
    if (!win) return;
    if (win.isVisible() && win.isFocused()) { win.hide(); return; }
    if (Date.now() - hiddenAt < 300) return;
    showWindow();
  }

  // Windows 11 22H2+ (build 22621) can draw Mica behind the page; macOS draws its own frosted material
  // (vibrancy); anywhere else the window gets a solid colour.
  const micaSupported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
  const theme = () => (nativeTheme.shouldUseDarkColors
    ? { bg: '#1f1e1d', symbols: '#f5f4ee' }
    : { bg: '#f5f4f0', symbols: '#1a1a19' });
  const intro = createIntroGate();
  const INK = '#1f1e1d'; // the intro's splash colour: the window starts in it so nothing flashes white
  const overlay = () => ({ color: '#00000000', symbolColor: theme().symbols, height: 36 });

  function createWindow(hidden) {
    let material = '';
    const playIntro = intro.onLoad(!hidden);
    const webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false };
    if (isMac) {
      // A borderless panel with the system's popover material behind the page; the page draws its own title row.
      win = new BrowserWindow({
        width: 400, height: 640, minWidth: 360, minHeight: 480, title: 'Relay', show: false,
        frame: false, fullscreenable: false, minimizable: false, maximizable: false, skipTaskbar: true,
        vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000', roundedCorners: true,
        webPreferences,
      });
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // opens over whatever Space is showing
      material = 'vibrancy';
    } else {
      const opts = {
        width: 420, height: 680, minWidth: 380, minHeight: 520, title: 'Relay', show: false, // shown on ready-to-show
        autoHideMenuBar: true, backgroundColor: playIntro ? INK : theme().bg, icon: windowIcon(),
        titleBarStyle: 'hidden', titleBarOverlay: overlay(), // the page draws the title bar, Windows keeps its own buttons
        webPreferences,
      };
      if (micaSupported) {
        try {
          win = new BrowserWindow({ ...opts, backgroundColor: '#00000000', backgroundMaterial: 'mica' });
          material = 'mica';
        } catch { win = null; }
      }
      if (!win) win = new BrowserWindow(opts);
      win.setIcon(windowIcon()); // Windows / Linux only: macOS windows have no icon of their own
    }
    // The page lets the material show through only when it is really there (#m=… survives the token redirect).
    const flags = [material && `m=${material}`, playIntro && 'boot=1'].filter(Boolean).join('&');
    win.loadURL(`${server.url}${flags ? `#${flags}` : ''}`);
    win.once('ready-to-show', () => {
      if (!hidden) showWindow();
      if (demo) {
        console.log(`[relay demo] panel ${server.url} · tray ${JSON.stringify(tray?.getBounds())} · window ${JSON.stringify(win.getBounds())}`);
        // RELAY_DEMO_SNAPSHOT=<file.png>: save what the panel shows (for screenshots in the docs)
        const snap = process.env.RELAY_DEMO_SNAPSHOT;
        if (snap) setTimeout(() => win.webContents.capturePage().then((img) => require('fs').writeFileSync(snap, img.toPNG())).catch((e) => console.error(e)), 3000);
      }
      if (playIntro && !material) setTimeout(() => { if (!win.isDestroyed()) win.setBackgroundColor(theme().bg); }, 2500);
    });
    if (material) win.webContents.on('dom-ready', () => { win.webContents.executeJavaScript(`document.documentElement.dataset.material = '${material}'`).catch(() => {}); });
    nativeTheme.on('updated', () => {
      if (!win || win.isDestroyed()) return;
      if (!isMac) { try { win.setTitleBarOverlay(overlay()); } catch { /* not supported here */ } }
      if (!material) win.setBackgroundColor(theme().bg);
    });
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(server.origin)) { e.preventDefault(); shell.openExternal(url); }
    });
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
    if (isMac) {
      // Like any menu-bar panel: clicking elsewhere puts it away (not while pinned, nor while DevTools has focus).
      win.on('blur', () => {
        if (quitting || pinned() || win.webContents.isDevToolsFocused()) return;
        hiddenAt = Date.now();
        win.hide();
      });
    }
  }

  let workerRuns = 0; // jobs handed to worker accounts by any Claude window (they run in that window's Relay tool)
  function updateBusy(jobs) {
    const n = jobs.active.length;
    busyCount = n + workerRuns;
    setTooltip();
    if (n && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension'); // do not sleep mid-task
    if (!n && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
  }

  // macOS: keyboard shortcuts in the panel (copy, paste, select all, undo in the e-mail and code boxes; Cmd+W to put
  // the panel away; Cmd+Q to quit) come from the application menu, which a menu-bar app has but never shows.
  function appMenu() {
    if (!isMac) return null;
    return Menu.buildFromTemplate([
      { role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'windowMenu', submenu: [{ role: 'close' }, { role: 'reload', visible: !app.isPackaged }, { role: 'toggleDevTools', visible: !app.isPackaged }] },
    ]);
  }

  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // macOS: opened again from Finder or Spotlight while already running

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(appMenu());
    if (isMac) app.dock?.hide(); // a menu-bar app: no Dock icon (packaged builds also say so in Info.plist)
    const label = (name, accounts) => accounts.find((a) => a.name === name)?.label || name;

    // Open at login. macOS: a LaunchAgent that starts Relay hidden in the menu bar (works when run from source too).
    // Windows: the login item; run from source ("electron ."), it must name the app folder too, or Windows would
    // start a bare Electron (its default welcome window) at sign-in instead of Relay.
    const setAutoStart = isMac
      ? (on) => platform.setAutoStart(!!on, { packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath() })
      : (on) => app.setLoginItemSettings({ openAtLogin: !!on, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] });

    server = await createServer({
      shell: {
        isPanelVisible: () => !!win && win.isVisible() && !win.isMinimized(), // usage is read live only while someone is looking
        setAutoStart,
        quit: () => { quitting = true; app.quit(); },
        onLanguage: () => { buildMenu(); setTooltip(); },
        onRuns: (runs) => { workerRuns = runs.length; busyCount = (server?.takeovers.snapshot().active.length || 0) + workerRuns; setTooltip(); },
        notify: (n, accounts) => {
          const make = MSG[n.kind];
          if (!make || !Notification.isSupported()) return;
          const [title, body] = make({ ...n, origin: n.origin ? label(n.origin, accounts) : '' }, (x) => label(x, accounts));
          const note = new Notification({ title, body, icon: asset('icon.png'), silent: n.kind === 'switch' });
          note.on('click', showWindow);
          note.show();
        },
      },
    });
    server.takeovers.on('update', updateBusy);
    // Worker sessions run Relay's guard hook with this same program (see setup.hookRuntime).
    try { require('fs').writeFileSync(require('path').join(store.home(), 'runtime.json'), JSON.stringify({ execPath: process.execPath })); } catch { /* the guard falls back to the caller's runtime */ }

    if (isMac) {
      // "…Template" images are drawn by macOS in the menu bar's own colour; the @2x file is picked up by itself.
      const icon = nativeImage.createFromPath(asset('trayTemplate.png'));
      icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.on('click', togglePanel);
      tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
    } else {
      tray = new Tray(nativeImage.createFromPath(asset('tray.png')).resize({ width: 16, height: 16 }));
      tray.on('click', showWindow);
    }
    setTooltip();
    buildMenu();

    // An existing "open at login" choice follows Relay when it moves (a new app version, another folder).
    if (isMac && store.loadSettings().startAtLogin && platform.autoStartInstalled()) setAutoStart(true);

    createWindow(process.argv.includes('--hidden') && store.loadSettings().startAtLogin);
  });

  // Closing the window must not quit: Relay keeps watching from the tray.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
}
