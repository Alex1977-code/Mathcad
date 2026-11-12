/**
 * Desktop version of FormelWerk (Windows program): shows the built web app in its own window.
 * The app files are served from the program folder through the internal address app://formelwerk/,
 * nothing is loaded from the internet. Worksheets given on the command line (double click on a
 * .fwk, .mcdx or .xmcd file) are handed to the app.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://formelwerk';
const DOC_EXT = /\.(fwk|json|mcdx|xmcd|mcd)$/i;
const SMOKE = process.argv.includes('--smoke-test');

// the self test also runs on build machines without a graphics card
if (SMOKE) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** First worksheet file among command line arguments. */
function fileFromArgs(argv) {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') || !DOC_EXT.test(a)) continue;
    try { if (fs.statSync(a).isFile()) return path.resolve(a); } catch { /* not a file */ }
  }
  return null;
}

let win = null;
let pendingFile = fileFromArgs(process.argv);

function readDoc(file) {
  try {
    const data = fs.readFileSync(file);
    return { name: path.basename(file), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } catch { return null; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 720, minHeight: 480,
    title: 'FormelWerk',
    show: !SMOKE,
    backgroundColor: '#f3f5f9',
    icon: path.join(DIST, 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.loadURL(`${ORIGIN}/index.html`);
  // links to other sites open in the browser, the window itself never leaves the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) { e.preventDefault(); if (/^https?:/i.test(url)) void shell.openExternal(url); } });
  // unsaved changes: the page asks to stay – confirm before closing
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = SMOKE ? 0 : dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Schließen', 'Abbrechen'], defaultId: 1, cancelId: 1,
      title: 'FormelWerk', message: 'Ungespeicherte Änderungen verwerfen?', detail: 'Das Arbeitsblatt wurde seit dem letzten Speichern geändert.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  if (SMOKE) smokeTest();
}

/** Self test for the build: the app starts, calculates the example sheet and reports the outcome. */
function smokeTest() {
  const finish = (ok, text) => {
    const out = process.env.FORMELWERK_SMOKE_OUT;
    if (out) { try { fs.writeFileSync(out, `${ok ? 'OK' : 'FAILED'} ${text}\n`); } catch { /* ignore */ } }
    console.log(`SMOKE ${ok ? 'OK' : 'FAILED'} ${text}`);
    app.exit(ok ? 0 : 1);
  };
  const timer = setTimeout(() => finish(false, 'timeout'), 60000);
  win.webContents.on('did-fail-load', (_e, code, desc) => { clearTimeout(timer); finish(false, `load failed: ${code} ${desc}`); });
  win.webContents.on('did-finish-load', async () => {
    try {
      const text = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          const done = document.querySelector('.dot.ok, .dot.warn, .dot.err');
          const regions = document.querySelectorAll('.region').length;
          const results = document.querySelectorAll('.fw-result').length;
          if (done && regions > 0 && results > 0) resolve('regions=' + regions + ' results=' + results + ' status=' + done.className + ' picker=' + typeof window.showSaveFilePicker + ' worker=' + typeof Worker + ' title=' + document.title);
          else if (Date.now() - t0 > 45000) resolve('');
          else setTimeout(tick, 200);
        };
        tick();
      })`);
      clearTimeout(timer);
      finish(!!text && /regions=\d+ results=\d+ status=dot ok/.test(text), text || 'app did not calculate');
    } catch (e) { clearTimeout(timer); finish(false, String(e)); }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // a second start (double click on another file) hands the file to the running window
  app.on('second-instance', (_e, argv) => {
    const file = fileFromArgs(argv);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (file) { const doc = readDoc(file); if (doc) win.webContents.send('open-file', doc); }
  });
  ipcMain.handle('take-open-file', () => { const f = pendingFile; pendingFile = null; return f ? readDoc(f) : null; });

  app.whenReady().then(() => {
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(DIST, rel));
      if (url.host !== 'formelwerk' || !file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    // the app has its own menus; keep the usual window shortcuts
    Menu.setApplicationMenu(Menu.buildFromTemplate([{
      label: 'Fenster', submenu: [
        { role: 'togglefullscreen', label: 'Vollbild' },
        { role: 'zoomIn', label: 'Vergrößern', accelerator: 'CommandOrControl+Plus' }, { role: 'zoomOut', label: 'Verkleinern' }, { role: 'resetZoom', label: 'Originalgröße' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge', accelerator: 'F12' },
        { role: 'quit', label: 'Beenden' },
      ],
    }]));
    createWindow();
    win.setMenuBarVisibility(false);
  });
  app.on('window-all-closed', () => app.quit());
}
