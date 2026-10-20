# GDrive Explorer (Desktop wrapper)

An Electron shell that loads the hosted web app
(<https://gdrive-explorer.pages.dev>) in a native window, packaged as a
Windows installer: **GDriveExplorer-Setup.exe**.

## Build the installer

On a Windows PC (recommended):

```bat
cd desktop
npm install
npm run build:win
```

The installer lands in `desktop\dist\GDriveExplorer-Setup.exe`.

> Building the Windows installer on Linux requires Wine (electron-builder
> uses it to stamp the .exe). If Wine is unavailable the build fails at the
> NSIS/packaging step — build on Windows instead; the project itself is
> complete either way.

## Notes

- Same Google sign-in, same drives, same data as the web version — the
  window just hosts the hosted app. Sign-in popups open inside the app.
- Tokens follow the web app's storage rules: session-only by default,
  "Remember on this device" persists them (personal PC mode).
