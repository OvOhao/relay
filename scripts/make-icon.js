'use strict';
// Renders the Relay icons from the two SVG sources, keeping transparency. Run with Electron (it is the SVG renderer):
//   npx electron scripts/make-icon.js
// build/logo.svg (the tile)  -> build/icon.png (1024), build/tray.png (64), build/icon.ico (16-256)
// build/mark.svg (the R)     -> build/trayTemplate.png (18) + trayTemplate@2x.png (36): black on transparent, which
//                               macOS recolours to match a light or dark menu bar.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const svg = (name) => fs.readFileSync(path.join(BUILD, name), 'utf8');

// ICO container: ICONDIR, one ICONDIRENTRY per image, then the PNG files themselves (supported since Windows Vista).
function makeIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, k) => {
    const e = 6 + 16 * k;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size; // 0 means 256
    head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}

// One transparent offscreen window draws each SVG large, alpha channel kept; every size is scaled down from that.
const BIG = 1024;
async function render(win, source) {
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}" style="display:block;width:${BIG}px;height:${BIG}px"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 200));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: BIG, height: BIG });
  return img.getSize().width === BIG ? img : img.resize({ width: BIG, height: BIG, quality: 'best' });
}
const at = (img, size) => (size === BIG ? img : img.resize({ width: size, height: size, quality: 'best' })).toPNG();

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: BIG, height: BIG, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true, sandbox: true },
    });
    const logo = await render(win, svg('logo.svg'));
    const mark = await render(win, svg('mark.svg'));
    win.destroy();
    const write = (f, buf) => fs.writeFileSync(path.join(BUILD, f), buf);
    write('icon.png', at(logo, BIG));
    write('tray.png', at(logo, 64));
    write('icon.ico', makeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: at(logo, size) }))));
    write('trayTemplate.png', at(mark, 18));
    write('trayTemplate@2x.png', at(mark, 36));
    console.log('wrote build/icon.png, tray.png, icon.ico and trayTemplate(@2x).png');
  } catch (e) { console.error(e); process.exitCode = 1; }
  app.quit();
});
