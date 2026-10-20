// GDrive Explorer — desktop shell (Electron)
// Loads the hosted web app so the same sign-in, drives and data work
// identically to the browser version. Google sign-in opens in a child
// window inside the app (GIS popup), external links go to the browser.
const { app, BrowserWindow, shell } = require('electron');

const APP_URL = 'https://gdrive-explorer.pages.dev';

function isAuthUrl(url) {
  return url.startsWith('https://accounts.google.com') || url.startsWith('https://oauth2.googleapis.com');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'GDrive Explorer',
    autoHideMenuBar: true,
    backgroundColor: '#f3f3f3',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Google sign-in popups must stay inside the app; everything else external.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url) || url.startsWith(APP_URL)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 640, autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL) && !isAuthUrl(url) && !url.startsWith('https://www.googleapis.com')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
