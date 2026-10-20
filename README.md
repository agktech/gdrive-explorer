# GDrive Explorer

A Windows 11 File Explorer–style file manager for **Google Drive**, running
entirely in the browser against the real **Google Drive API v3** (Google
Identity Services sign-in). No build step, no server, no backend.

**Live:** <https://gdrive-explorer.pages.dev> · **Repo:** <https://github.com/agktech/gdrive-explorer>

## What it does

- Explorer window: command bar (New folder, Upload, Cut/Copy/Paste, Rename,
  Share, Delete, Sort, View), breadcrumb address bar with Back/Forward/Up,
  left nav (My Drive, Recent, Starred, Shared with me, Bin, folder tree,
  storage meter), Details/List/Large-icons views, details pane, status bar.
- **Multi-drive switcher** — connect several Google accounts from the top
  corner ("+ Add Drive"); each drive has its own files and storage meter;
  switching is one click.
- **Sign out that leaves no traces** — per-drive or all-drives sign-out
  revokes the OAuth token and wipes every trace of the account from the
  device. Tokens live in `sessionStorage` by default (closing the window
  signs you out — made for shared/office PCs). "Remember on this device"
  switches to `localStorage` for a personal PC.
- **Full file management** — create folders, upload (multipart / resumable),
  download (Google-native files export to PDF/XLSX/PPTX/PNG), rename, move,
  copy, star, trash, restore, delete forever, search, sort.
- **Cloud-to-cloud between your drives** — right-click any item →
  *Send to another drive* → **Copy to …** (real copy, folders recurse) or
  **Shortcut in …** (creates a Drive shortcut; view access is granted to the
  other account first so the shortcut works).
- **Sharing at a glance** — 🌐 public / 👥 shared / 🔒 private badges on
  every item, right-click *Make public / Make private*, and a Share panel
  (add people as Viewer/Commenter/Editor, change roles, remove, copy link).

## One-time Google setup (required before sign-in works)

The app ships with a placeholder in `config.js`. To activate:

1. [Google Cloud Console](https://console.cloud.google.com/) → create a
   project → **APIs & Services → Library** → enable **Google Drive API**.
2. **OAuth consent screen** → External → app name "GDrive Explorer" →
   Publishing status **Testing** → add the Gmail addresses that will use
   the app as **Test users**.
3. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized JavaScript origins: `https://gdrive-explorer.pages.dev`
     (add `http://localhost:8080` too if you develop locally).
   - Scope used by the app: `https://www.googleapis.com/auth/drive`
4. Copy the generated **Client ID** into `config.js`:

   ```js
   window.GDRIVE_EXPLORER_CONFIG = { clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com" };
   ```

5. Redeploy (push to GitHub / redeploy the Pages project). Until then the
   app loads in a clean signed-out state with a setup notice.

> A web OAuth Client ID is a public identifier, not a secret — it is safe
> to commit in `config.js`.

## Run locally

```bash
cd gdrive-explorer-app
python3 -m http.server 8080   # then open http://localhost:8080
```

## Desktop app (.exe)

See [`desktop/`](desktop/) — an Electron wrapper that loads the hosted URL
and builds `GDriveExplorer-Setup.exe` (NSIS) via
`npm install && npm run build:win` (build on Windows, or Linux with Wine).

## Privacy / security model

- The app talks **only** to Google (`accounts.google.com`,
  `www.googleapis.com`, `oauth2.googleapis.com`) plus its own static files.
- No analytics, no third-party servers, files never pass through any
  intermediary — transfers happen browser ↔ Google only (cloud-to-cloud
  copies stream through the signed-in browser session).
- Sign-out revokes tokens at Google and erases all local app state.
