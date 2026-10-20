'use strict';
/* =====================================================================
   GDrive Explorer — production app
   Talks directly to Google Drive API v3 from the browser via Google
   Identity Services (OAuth 2.0 token flow). No build step, no server.
   ===================================================================== */

/* ---------------- Config ---------------- */
const CFG = (window.GDRIVE_EXPLORER_CONFIG || {});
const CLIENT_ID = (CFG.clientId || '').trim();
const CONFIGURED = !!CLIENT_ID && CLIENT_ID !== 'PASTE_CLIENT_ID';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive openid email profile';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,starred,trashed,parents,' +
  'owners(displayName,emailAddress,me),' +
  'permissions(id,type,role,emailAddress,domain,displayName),' +
  'shared,thumbnailLink,iconLink,webViewLink,shortcutDetails,' +
  'capabilities(canEdit,canDelete,canTrash,canShare,canCopy,canDownload,canRename,canMoveItemWithinDrive)';
const STORE_KEY = 'gde_accounts_v1';
const REMEMBER_KEY = 'gde_remember';
const MULTIPART_LIMIT = 5 * 1024 * 1024;

/* ---------------- State ---------------- */
const accounts = new Map(); // email -> account
let activeEmail = null;
let rememberMode = false;
let sortKey = 'name', sortDir = 1; // 1 asc, -1 desc
let viewMode = 'details'; // details | list | icons
let searchTerm = '';
let clipboard = null; // {mode:'cut'|'copy', accEmail, items:[file]}

function newAccount(email) {
  return {
    email, name: email, picture: '',
    token: null, expiresAt: 0, needsAuth: true,
    about: null,
    nav: { view: 'folder', folderId: 'root', path: [{ id: 'root', name: 'My Drive' }], hist: [], hi: -1 },
    cache: new Map(), // key -> items array
    treeOpen: new Set(),
    items: [], selected: new Set(),
  };
}
const activeAcc = () => (activeEmail ? accounts.get(activeEmail) : null);

/* ---------------- Small utils ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

function fmtBytes(n) {
  n = Number(n); if (!n || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}
function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch (e) { return s; }
}
function typeLabel(mime, name) {
  if (mime === FOLDER_MIME) return 'Folder';
  if (mime === SHORTCUT_MIME) return 'Shortcut';
  const map = {
    'application/vnd.google-apps.document': 'Google Docs',
    'application/vnd.google-apps.spreadsheet': 'Google Sheets',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.drawing': 'Google Drawing',
    'application/vnd.google-apps.form': 'Google Form',
    'application/pdf': 'PDF',
  };
  if (map[mime]) return map[mime];
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('text/')) return 'Text';
  if (/zip|rar|7z|tar/.test(mime)) return 'Archive';
  if (/word/.test(mime)) return 'Word doc';
  if (/sheet|excel/.test(mime)) return 'Spreadsheet';
  if (/presentation|powerpoint/.test(mime)) return 'Presentation';
  const ext = (name || '').split('.').pop();
  return ext && ext.length <= 5 ? ext.toUpperCase() + ' file' : 'File';
}
function typeIcon(file) {
  const m = file.mimeType || '';
  if (m === FOLDER_MIME) return '&#128193;';
  if (m === SHORTCUT_MIME) return '&#128279;';
  const t = typeLabel(m, file.name);
  const icons = {
    'Google Docs': '&#128196;', 'Google Sheets': '&#128202;', 'Google Slides': '&#128200;',
    'Google Drawing': '&#127912;', 'Google Form': '&#128203;', 'PDF': '&#128209;',
    'Image': '&#128444;', 'Video': '&#127916;', 'Audio': '&#127925;',
    'Archive': '&#128230;', 'Text': '&#128196;', 'Word doc': '&#128196;',
    'Spreadsheet': '&#128202;', 'Presentation': '&#128200;',
  };
  return icons[t] || '&#128196;';
}
function accessOf(file) {
  const perms = file.permissions || [];
  const ownerEmails = (file.owners || []).map((o) => (o.emailAddress || '').toLowerCase());
  if (perms.some((p) => p.type === 'anyone')) return 'public';
  for (const p of perms) {
    if (p.type === 'anyone' || p.type === 'domain') return 'shared';
    if (p.type === 'user' && !ownerEmails.includes((p.emailAddress || '').toLowerCase())) return 'shared';
    if (p.type === 'group') return 'shared';
  }
  return 'private';
}
function accessBadge(file) {
  const a = accessOf(file);
  if (a === 'public') return '<span class="badge public" title="Public — anyone with the link">&#127760;</span>';
  if (a === 'shared') return '<span class="badge shared" title="Shared with specific people">&#128101;</span>';
  return '<span class="badge private" title="Private — only you">&#128274;</span>';
}

/* ---------------- Toasts / status ---------------- */
function toast(msg, kind) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 3600);
  setTimeout(() => el.remove(), 4200);
}
let statusTimer = null;
function setStatus(msg) {
  $('statusMsg').textContent = msg || '';
  if (statusTimer) clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { $('statusMsg').textContent = ''; }, 6000);
}
function setBusy(on, text) {
  $('busy').classList.toggle('hidden', !on);
  if (text) $('busyText').textContent = text;
}

/* ---------------- Modal helper ---------------- */
function openModal(title, bodyHTML, actions) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHTML;
  const box = $('modalActions'); box.innerHTML = '';
  (actions || [{ label: 'Close' }]).forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.onclick = () => { if (a.onClick) a.onClick(); if (!a.keepOpen) closeModal(); };
    box.appendChild(b);
  });
  $('modalBackdrop').classList.remove('hidden');
}
function closeModal() { $('modalBackdrop').classList.add('hidden'); }
$('modalBackdrop').addEventListener('mousedown', (e) => { if (e.target === $('modalBackdrop')) closeModal(); });
function inputModal(title, label, initial, okLabel, onOk) {
  openModal(title, '<label>' + esc(label) + '</label><input type="text" id="modalInput" value="' + escAttr(initial || '') + '">',
    [{ label: 'Cancel' }, {
      label: okLabel || 'OK', primary: true,
      onClick: () => { const v = $('modalInput').value.trim(); if (v) onOk(v); },
    }]);
  setTimeout(() => { const i = $('modalInput'); if (i) { i.focus(); i.select(); } }, 50);
}

/* ---------------- Persistence (tokens) ----------------
   Default (web/office mode): accounts+tokens live ONLY in sessionStorage —
   closing the window/tab wipes them automatically.
   Remember mode (personal PC / .exe): accounts+tokens live in localStorage. */
function currentStore() { return rememberMode ? localStorage : sessionStorage; }
function persistAccounts() {
  const data = [...accounts.values()].map((a) => ({
    email: a.email, name: a.name, picture: a.picture,
    token: a.token, expiresAt: a.expiresAt,
  }));
  localStorage.removeItem(STORE_KEY);
  sessionStorage.removeItem(STORE_KEY);
  if (data.length) { try { currentStore().setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {} }
  try { localStorage.setItem(REMEMBER_KEY, rememberMode ? '1' : '0'); } catch (e) {}
}
function restoreAccounts() {
  rememberMode = false;
  try { rememberMode = localStorage.getItem(REMEMBER_KEY) === '1'; } catch (e) {}
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY); } catch (e) {}
  if (!raw) return;
  try {
    for (const d of JSON.parse(raw)) {
      if (!d || !d.email) continue;
      const acc = newAccount(d.email);
      acc.name = d.name || d.email; acc.picture = d.picture || '';
      acc.token = d.token || null; acc.expiresAt = d.expiresAt || 0;
      acc.needsAuth = !acc.token || acc.expiresAt < Date.now() + 30000;
      accounts.set(acc.email, acc);
    }
    activeEmail = [...accounts.keys()][0] || null;
  } catch (e) { /* corrupt data -> start clean */ accounts.clear(); activeEmail = null; }
}

/* ---------------- Google Identity Services auth ---------------- */
function ensureGis() {
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve(true);
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (window.google && google.accounts && google.accounts.oauth2) { clearInterval(t); resolve(true); }
      else if (n > 60) { clearInterval(t); reject(new Error('Google sign-in library did not load. Check your internet connection.')); }
    }, 100);
  });
}
async function requestToken(loginHint) {
  if (!CONFIGURED) { showSetupDialog(); return null; }
  await ensureGis();
  return new Promise((resolve) => {
    let client;
    try {
      client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (resp) => resolve(resp && resp.access_token ? resp : null),
        error_callback: () => resolve(null),
      });
    } catch (e) { resolve(null); return; }
    const opts = loginHint ? { login_hint: loginHint } : { prompt: 'select_account' };
    try { client.requestAccessToken(opts); } catch (e) { resolve(null); }
  });
}
async function addDrive() {
  if (!CONFIGURED) { showSetupDialog(); return; }
  setStatus('Waiting for Google sign-in…');
  const resp = await requestToken(null);
  if (!resp) { setStatus(''); toast('Sign-in was cancelled or blocked.'); return; }
  await completeSignIn(resp);
}
async function reauth(acc) {
  let resp = await requestToken(acc.email); // silent attempt for this account
  if (!resp) resp = await requestToken(null); // fall back to account chooser
  if (!resp) { toast('Sign-in was cancelled or blocked.'); return false; }
  return completeSignIn(resp, acc.email);
}
async function completeSignIn(resp, expectedEmail) {
  const token = resp.access_token;
  const expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
  let me = null;
  // Identity comes from the Drive API itself (the drive scope covers it).
  // The oauth2 userinfo endpoint is only a fallback — it must never block sign-in.
  try {
    const about = await fetchJson(API + '/about?fields=user(displayName,emailAddress,photoLink)', token);
    if (about && about.user && about.user.emailAddress) {
      me = { email: about.user.emailAddress, name: about.user.displayName, picture: about.user.photoLink };
    }
  } catch (e) { /* fall through to userinfo */ }
  if (!me) {
    try {
      const ui = await fetchJson('https://www.googleapis.com/oauth2/v3/userinfo', token);
      if (ui && ui.email) me = { email: ui.email, name: ui.name, picture: ui.picture };
    } catch (e) { /* non-fatal — expectedEmail (if any) is used below */ }
  }
  const email = ((me && me.email) || expectedEmail || '').toLowerCase();
  if (!email) { toast('Could not determine the account email.', 'err'); return false; }
  let acc = accounts.get(email);
  if (!acc) { acc = newAccount(email); accounts.set(email, acc); }
  acc.name = (me && me.name) || email; acc.picture = (me && me.picture) || '';
  acc.token = token; acc.expiresAt = expiresAt; acc.needsAuth = false;
  acc.cache.clear();
  // Always land on My Drive (Level 1 — direct children of root only) after sign-in.
  acc.nav = { view: 'folder', folderId: 'root', path: [{ id: 'root', name: 'My Drive' }], hist: [], hi: -1 };
  acc.selected = new Set();
  persistAccounts();
  await refreshAbout(acc).catch(() => {});
  renderChips();
  await switchAccount(email);
  toast('Connected: ' + email, 'ok');
  return true;
}
async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=' + encodeURIComponent(token),
    });
  } catch (e) { /* best effort — local wipe still happens */ }
}
async function signOutAccount(email, silent) {
  const acc = accounts.get(email);
  if (!acc) return;
  if (acc.token) await revokeToken(acc.token);
  try { if (window.google && google.accounts.oauth2 && google.accounts.oauth2.revoke && acc.token) google.accounts.oauth2.revoke(acc.token, () => {}); } catch (e) {}
  accounts.delete(email);
  if (clipboard && clipboard.accEmail === email) clipboard = null;
  if (activeEmail === email) activeEmail = [...accounts.keys()][0] || null;
  persistAccounts();
  renderChips();
  await renderAll();
  if (!silent) toast(email + ' signed out — token revoked, all its data cleared from this device.', 'ok');
}
function confirmSignOut(email) {
  const verb = email ? 'sign out of <b>' + esc(email) + '</b>' : 'sign out of <b>every drive</b>';
  openModal('Sign out',
    '<p>This will ' + verb + ':</p><ul>' +
    '<li>Revoke the Google access token</li>' +
    '<li>Remove the account and ALL cached data (file lists, selections, clipboard) from this device</li>' +
    '<li>Leave nothing behind — ideal on a shared/office PC</li></ul>' +
    '<p>Your files themselves stay safe in Google Drive.</p>',
    [{ label: 'Cancel' }, {
      label: 'Sign out & wipe', danger: true,
      onClick: async () => { if (email) await signOutAccount(email); else { for (const e of [...accounts.keys()]) await signOutAccount(e, true); toast('All drives signed out — everything wiped from this device.', 'ok'); } },
    }]);
}

/* ---------------- HTTP / Drive API helpers ---------------- */
async function fetchJson(url, token, opts) {
  const res = await fetch(url, Object.assign({ headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, opts || {}));
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.status === 204 ? {} : res.json();
}
async function drive(acc, path, opts) {
  if (!acc || !acc.token) { acc && (acc.needsAuth = true); throw new Error('Not signed in for this drive. Click its chip to sign in again.'); }
  const url = path.startsWith('http') ? path : API + path;
  const res = await fetch(url, Object.assign({ headers: { Authorization: 'Bearer ' + acc.token } }, opts || {}));
  if (res.status === 401) {
    acc.needsAuth = true; acc.token = null; persistAccounts(); renderChips();
    throw new Error('Session expired — click your drive chip to sign in again.');
  }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res;
}
const driveJson = async (acc, path, opts) => { const r = await drive(acc, path, opts); return r.status === 204 ? {} : r.json(); };
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function listAll(acc, baseQuery) {
  // baseQuery already starts with '/files?' — do NOT prepend another '/files?' here.
  // (A double '/files?/files?' silently drops the real `q` filter, which once made
  // every listing return the whole drive instead of the requested folder/view.)
  let items = [], pageToken = '';
  do {
    const q = baseQuery + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const page = await driveJson(acc, q);
    items = items.concat(page.files || []);
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return items;
}
const LIST_Q = (extra) => 'pageSize=200&fields=nextPageToken,files(' + FIELDS + ')' + (extra || '');
function listChildren(acc, folderId) {
  const q = "q=" + encodeURIComponent("'" + folderId + "' in parents and trashed=false");
  return listAll(acc, '/files?' + q + '&' + LIST_Q());
}
async function getFile(acc, id, fields) {
  return driveJson(acc, '/files/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent(fields || FIELDS));
}
async function refreshAbout(acc) {
  const about = await driveJson(acc, '/about?fields=user(displayName,emailAddress,photoLink),storageQuota');
  acc.about = about;
  if (about.user && about.user.displayName) acc.name = about.user.displayName;
  renderStorage();
  return about;
}

/* ---------------- Navigation ---------------- */
function snapshotNav(acc) {
  return { view: acc.nav.view, folderId: acc.nav.folderId, path: JSON.parse(JSON.stringify(acc.nav.path)) };
}
function applyNav(acc, s) {
  acc.nav.view = s.view; acc.nav.folderId = s.folderId;
  acc.nav.path = JSON.parse(JSON.stringify(s.path));
  acc.selected = new Set();
}
function pushNav(acc) {
  acc.nav.hist = acc.nav.hist.slice(0, acc.nav.hi + 1);
  acc.nav.hist.push(snapshotNav(acc));
  acc.nav.hi = acc.nav.hist.length - 1;
  updateNavButtons(acc);
}
function updateNavButtons(acc) {
  $('backBtn').disabled = !acc || acc.nav.hi <= 0;
  $('fwdBtn').disabled = !acc || acc.nav.hi >= acc.nav.hist.length - 1;
  $('upBtn').disabled = !acc || acc.nav.view !== 'folder' || acc.nav.path.length <= 1;
}
async function goFolder(acc, folderId, path) {
  acc.nav.view = 'folder'; acc.nav.folderId = folderId; acc.nav.path = path;
  acc.selected = new Set(); pushNav(acc); await loadCurrent();
}
async function goView(acc, view) {
  acc.nav.view = view; acc.nav.folderId = 'root';
  acc.nav.path = [{ id: view, name: viewLabel(view) }];
  acc.selected = new Set(); pushNav(acc); await loadCurrent();
}
function viewLabel(v) {
  return { folder: 'My Drive', recent: 'Recent', starred: 'Starred', shared: 'Shared with me', trash: 'Bin', search: 'Search results' }[v] || v;
}

/* ---------------- Data loading ---------------- */
async function loadCurrent() {
  const acc = activeAcc();
  renderChips(); renderSidebar(); renderCrumbs(); updateNavButtons(acc); renderDetailsPane();
  $('statusDrive').textContent = acc ? acc.email : 'No drive connected';
  $('accountTag').textContent = acc ? (acc.name + ' (' + acc.email + ')') : '';
  if (!acc) { showSignedOut(); return; }
  hideCenter();
  if (acc.needsAuth) { showNeedsAuth(acc); return; }
  const nav = acc.nav;
  const cacheKey = nav.view + ':' + (nav.view === 'folder' ? nav.folderId : '') + (nav.view === 'search' ? ':' + searchTerm : '');
  setBusy(true, 'Loading…');
  try {
    let items;
    if (acc.cache.has(cacheKey)) items = acc.cache.get(cacheKey);
    else {
      items = await fetchViewItems(acc, nav);
      acc.cache.set(cacheKey, items);
    }
    acc.items = sortedItems(items.slice());
    renderItems(); renderTree(); renderStorage();
  } catch (e) {
    toast(e.message, 'err');
    acc.items = []; renderItems();
  } finally { setBusy(false); }
}
async function fetchViewItems(acc, nav) {
  switch (nav.view) {
    case 'folder': return listChildren(acc, nav.folderId);
    case 'recent': return listAll(acc, '/files?' + 'q=' + encodeURIComponent('trashed=false') + '&orderBy=modifiedTime%20desc&' + LIST_Q());
    case 'starred': return listAll(acc, '/files?' + 'q=' + encodeURIComponent('starred=true and trashed=false') + '&' + LIST_Q());
    case 'shared': return listAll(acc, '/files?' + 'q=' + encodeURIComponent('sharedWithMe=true and trashed=false') + '&' + LIST_Q());
    case 'trash': return listAll(acc, '/files?' + 'q=' + encodeURIComponent('trashed=true') + '&' + LIST_Q());
    case 'search': {
      const term = searchTerm.replace(/'/g, "\\'");
      return listAll(acc, '/files?' + 'q=' + encodeURIComponent("name contains '" + term + "' and trashed=false") + '&' + LIST_Q());
    }
    default: return [];
  }
}
function sortedItems(items) {
  const dir = sortDir;
  const keyFns = {
    name: (f) => (f.name || '').toLowerCase(),
    modified: (f) => f.modifiedTime || '',
    type: (f) => typeLabel(f.mimeType, f.name),
    size: (f) => Number(f.size || 0),
  };
  const fn = keyFns[sortKey] || keyFns.name;
  return items.sort((a, b) => {
    const fa = a.mimeType === FOLDER_MIME ? 0 : 1, fb = b.mimeType === FOLDER_MIME ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const va = fn(a), vb = fn(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

/* ---------------- Rendering ---------------- */
function renderChips() {
  const box = $('driveChips'); box.innerHTML = '';
  for (const acc of accounts.values()) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (acc.email === activeEmail ? ' active' : '') + (acc.needsAuth ? ' needs-auth' : '');
    chip.title = acc.needsAuth ? 'Session expired — click to sign in again' : acc.email;
    chip.innerHTML = (acc.picture ? '<img src="' + escAttr(acc.picture) + '" alt="">' : '') +
      '<span class="email">' + esc(acc.email) + '</span>' +
      '<button class="chip-x" title="Sign out of this drive">&times;</button>';
    chip.addEventListener('click', (e) => { if (!e.target.classList.contains('chip-x')) switchAccount(acc.email); });
    chip.querySelector('.chip-x').addEventListener('click', (e) => { e.stopPropagation(); confirmSignOut(acc.email); });
    box.appendChild(chip);
  }
  $('signOutAllBtn').style.display = accounts.size ? '' : 'none';
}
function showSignedOut() {
  $('emptyState').classList.remove('hidden');
  $('fileWrap').classList.add('hidden');
  const acc = activeAcc();
  $('emptyState').querySelector('h2').textContent = "You're signed out — nothing left behind";
  $('tabLabel').textContent = 'My Drive';
  $('statusCount').textContent = '0 items'; $('statusSel').textContent = '';
}
function showNeedsAuth(acc) {
  $('emptyState').classList.remove('hidden');
  $('fileWrap').classList.add('hidden');
  $('emptyState').querySelector('h2').textContent = 'Session expired for ' + acc.email;
  $('statusCount').textContent = '0 items'; $('statusSel').textContent = '';
  setStatus('Click the ' + acc.email + ' chip (or Add Drive) to sign in again.');
}
function hideCenter() { $('emptyState').classList.add('hidden'); $('fileWrap').classList.remove('hidden'); }

function renderCrumbs() {
  const acc = activeAcc(); const box = $('crumbs'); box.innerHTML = '';
  if (!acc) { box.innerHTML = '<span class="crumb">This PC</span>'; $('tabLabel').textContent = 'My Drive'; return; }
  const path = acc.nav.path;
  path.forEach((p, i) => {
    if (i > 0) { const s = document.createElement('span'); s.className = 'crumb-sep'; s.textContent = '›'; box.appendChild(s); }
    const c = document.createElement('span'); c.className = 'crumb'; c.textContent = p.name;
    c.addEventListener('click', () => {
      if (acc.nav.view === 'folder') goFolder(acc, p.id, path.slice(0, i + 1));
      else if (i === 0 && acc.nav.view !== 'folder') { /* stay */ }
    });
    box.appendChild(c);
  });
  $('tabLabel').textContent = (path[path.length - 1] || {}).name || 'My Drive';
}
function renderSidebar() {
  const acc = activeAcc();
  document.querySelectorAll('.side-item').forEach((el) => {
    const v = el.dataset.view;
    const active = acc && ((v === 'folder-root' && acc.nav.view === 'folder') || v === acc.nav.view);
    el.classList.toggle('active', !!active);
  });
  $('emptyBinBtn').classList.toggle('hidden', !(acc && acc.nav.view === 'trash'));
}
function renderStorage() {
  const acc = activeAcc();
  const fill = $('storageFill'), text = $('storageText');
  if (!acc || !acc.about || !acc.about.storageQuota) { text.textContent = acc ? '' : '—'; fill.style.width = '0'; return; }
  const q = acc.about.storageQuota;
  const used = Number(q.usage || 0), limit = Number(q.limit || 0);
  if (limit > 0) {
    fill.style.width = Math.min(100, (used / limit) * 100).toFixed(1) + '%';
    text.textContent = fmtBytes(used) + ' of ' + fmtBytes(limit) + ' used';
  } else {
    fill.style.width = '0'; text.textContent = fmtBytes(used) + ' used (unlimited plan)';
  }
}

/* Folder tree (lazy, folders only) */
async function renderTree() {
  const acc = activeAcc(); const tree = $('folderTree');
  tree.innerHTML = '';
  if (!acc || acc.needsAuth) return;
  const rootNode = await treeNode(acc, 'root', 'My Drive', 0);
  tree.appendChild(rootNode);
}
async function treeNode(acc, id, name, depth) {
  const wrap = document.createElement('div'); wrap.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row' + (acc.nav.view === 'folder' && acc.nav.folderId === id ? ' active' : '');
  row.style.paddingLeft = (12 + depth * 14) + 'px';
  const open = acc.treeOpen.has(id);
  row.innerHTML = '<span class="tree-toggle">' + (open ? '▾' : '▸') + '</span><span>&#128193;</span><span>' + esc(name) + '</span>';
  row.querySelector('.tree-toggle').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (acc.treeOpen.has(id)) acc.treeOpen.delete(id); else acc.treeOpen.add(id);
    await renderTree();
  });
  row.addEventListener('click', () => {
    const path = buildPathTo(acc, id, name);
    goFolder(acc, id, path);
  });
  wrap.appendChild(row);
  if (open) {
    const kids = document.createElement('div'); kids.className = 'tree-children';
    try {
      const children = (await listChildren(acc, id)).filter((f) => f.mimeType === FOLDER_MIME);
      for (const c of children) kids.appendChild(await treeNode(acc, c.id, c.name, depth + 1));
    } catch (e) { /* ignore tree errors */ }
    wrap.appendChild(kids);
  }
  return wrap;
}
function buildPathTo(acc, id, name) {
  // Best-effort path: if the folder is in the current listing, walk parents via cache; else root+folder.
  if (id === 'root') return [{ id: 'root', name: 'My Drive' }];
  return [{ id: 'root', name: 'My Drive' }, { id, name }];
}

/* File lists */
function itemRowHTML(f) {
  const sel = activeAcc().selected.has(f.id) ? ' selected' : '';
  const sc = f.mimeType === SHORTCUT_MIME || f.shortcutDetails ? '<span class="shortcut-arrow" title="Shortcut">↗</span>' : '';
  return { sel, sc };
}
function renderItems() {
  const acc = activeAcc();
  const table = $('detailsTable'), grid = $('gridView'), body = $('detailsBody');
  if (!acc) { body.innerHTML = ''; grid.innerHTML = ''; return; }
  const items = acc.items;
  $('statusCount').textContent = items.length + (items.length === 1 ? ' item' : ' items');
  updateSelStatus();
  // Folder views (incl. My Drive Level 1) are grouped like Google Drive:
  // a "Folders" section first, then a "Files" section — never one mixed dump.
  const _folders = items.filter((f) => f.mimeType === FOLDER_MIME);
  const _files = items.filter((f) => f.mimeType !== FOLDER_MIME);
  const groups = (acc.nav.view === 'folder' && _folders.length && _files.length)
    ? [['Folders', _folders], ['Files', _files]]
    : [[null, items]];
  if (viewMode === 'details') {
    table.classList.remove('hidden'); grid.classList.add('hidden');
    body.innerHTML = '';
    for (const [gLabel, gItems] of groups) {
      if (gLabel) {
        const gh = document.createElement('tr');
        gh.className = 'group-row';
        gh.innerHTML = '<td colspan="5">' + (gLabel === 'Folders' ? '&#128193;' : '&#128196;') + ' ' + gLabel + ' <span class="group-count">' + gItems.length + '</span></td>';
        body.appendChild(gh);
      }
      for (const f of gItems) {
      const { sel, sc } = itemRowHTML(f);
      const tr = document.createElement('tr');
      if (sel) tr.className = 'selected';
      tr.dataset.id = f.id;
      tr.innerHTML =
        '<td><span class="item-icon">' + typeIcon(f) + '</span>' + esc(f.name) + sc + accessBadge(f) + (f.starred ? ' <span title="Starred">&#11088;</span>' : '') + '</td>' +
        '<td>' + esc(fmtDate(f.modifiedTime)) + '</td>' +
        '<td>' + esc(typeLabel(f.mimeType, f.name)) + '</td>' +
        '<td>' + (f.mimeType === FOLDER_MIME ? '—' : esc(fmtBytes(f.size))) + '</td>' +
        '<td>' + esc(accessOf(f)) + '</td>';
      wireItemEvents(tr, f);
      body.appendChild(tr);
      }
    }
  } else {
    table.classList.add('hidden'); grid.classList.remove('hidden');
    grid.className = 'grid-view' + (viewMode === 'list' ? ' list-rows' : '');
    grid.innerHTML = '';
    for (const [gLabel, gItems] of groups) {
      if (gLabel) {
        const gh = document.createElement('div');
        gh.className = 'group-head';
        gh.innerHTML = (gLabel === 'Folders' ? '&#128193;' : '&#128196;') + ' ' + gLabel + ' <span class="group-count">' + gItems.length + '</span>';
        grid.appendChild(gh);
      }
      for (const f of gItems) {
      const { sel, sc } = itemRowHTML(f);
      const el = document.createElement('div');
      if (viewMode === 'list') {
        el.className = 'list-row' + sel;
        el.innerHTML = '<span class="item-icon">' + typeIcon(f) + '</span><span>' + esc(f.name) + sc + '</span>' + accessBadge(f) +
          '<span style="color:var(--muted);font-size:12px">' + esc(typeLabel(f.mimeType, f.name)) + ' · ' + esc(fmtDate(f.modifiedTime)) + '</span>';
      } else {
        el.className = 'tile' + sel;
        el.innerHTML = '<div class="t-icon">' + typeIcon(f) + '</div><div class="t-name">' + esc(f.name) + sc + accessBadge(f) + '</div>';
      }
      el.dataset.id = f.id;
      wireItemEvents(el, f);
      grid.appendChild(el);
      }
    }
  }
  document.querySelectorAll('#detailsTable thead th').forEach((th) => {
    const k = th.dataset.sort; if (!k) return;
    const ind = th.querySelector('.sort-ind');
    if (ind) ind.textContent = k === sortKey ? (sortDir === 1 ? '▲' : '▼') : '';
  });
  renderDetailsPane();
}
function updateSelStatus() {
  const acc = activeAcc();
  const n = acc ? acc.selected.size : 0;
  $('statusSel').textContent = n ? n + ' selected' : '';
  syncCommandBar();
}
function selectedFiles() {
  const acc = activeAcc(); if (!acc) return [];
  return acc.items.filter((f) => acc.selected.has(f.id));
}
function wireItemEvents(el, f) {
  el.addEventListener('click', (e) => {
    const acc = activeAcc(); if (!acc) return;
    if (e.ctrlKey || e.metaKey) { acc.selected.has(f.id) ? acc.selected.delete(f.id) : acc.selected.add(f.id); }
    else if (e.shiftKey && acc.items.length) {
      const ids = acc.items.map((i) => i.id);
      const last = [...acc.selected].pop();
      const a = ids.indexOf(last), b = ids.indexOf(f.id);
      if (a >= 0) { const [s, en] = a < b ? [a, b] : [b, a]; for (let i = s; i <= en; i++) acc.selected.add(ids[i]); }
      else acc.selected = new Set([f.id]);
    } else acc.selected = new Set([f.id]);
    renderItems();
  });
  el.addEventListener('dblclick', () => openItem(f));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const acc = activeAcc(); if (!acc) return;
    if (!acc.selected.has(f.id)) { acc.selected = new Set([f.id]); renderItems(); }
    openItemMenu(e.clientX, e.clientY, selectedFiles());
  });
}
function openItem(f) {
  const acc = activeAcc(); if (!acc) return;
  if (f.mimeType === FOLDER_MIME) {
    const path = acc.nav.view === 'folder' ? acc.nav.path.concat([{ id: f.id, name: f.name }]) : [{ id: 'root', name: 'My Drive' }, { id: f.id, name: f.name }];
    goFolder(acc, f.id, path);
  } else if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails && f.shortcutDetails.targetId) {
    getFile(acc, f.shortcutDetails.targetId).then((t) => openItem(t)).catch((e) => toast(e.message, 'err'));
  } else if (f.webViewLink) {
    window.open(f.webViewLink, '_blank');
  }
}

/* Details pane */
function renderDetailsPane() {
  const acc = activeAcc();
  const sel = acc ? selectedFiles() : [];
  const empty = $('dpEmpty'), body = $('dpBody');
  if (!acc || sel.length !== 1) {
    empty.classList.remove('hidden'); body.classList.add('hidden');
    empty.textContent = sel.length > 1 ? sel.length + ' items selected' : 'Select an item to see details';
    if (sel.length === 1) { /* handled below */ } else return;
  }
  const f = sel[0];
  empty.classList.add('hidden'); body.classList.remove('hidden');
  $('dpIcon').innerHTML = typeIcon(f);
  $('dpName').textContent = f.name;
  const owner = (f.owners && f.owners[0] && (f.owners[0].displayName || f.owners[0].emailAddress)) || '—';
  const a = accessOf(f);
  const rows = [
    ['Type', typeLabel(f.mimeType, f.name)],
    ['Size', f.mimeType === FOLDER_MIME ? '—' : fmtBytes(f.size)],
    ['Modified', fmtDate(f.modifiedTime)],
    ['Created', fmtDate(f.createdTime)],
    ['Owner', owner],
    ['Sharing', a === 'public' ? '🌐 Public (anyone with link)' : a === 'shared' ? '👥 Shared with people' : '🔒 Private'],
    ['Account', acc.email],
  ];
  $('dpRows').innerHTML = rows.map((r) => '<div class="dp-row"><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>').join('');
}
function syncCommandBar() {
  const acc = activeAcc();
  const sel = acc ? acc.selected.size : 0;
  const inTrash = acc && acc.nav.view === 'trash';
  const can = (cmd) => {
    if (!acc || acc.needsAuth) return false;
    switch (cmd) {
      case 'newfolder': case 'upload': return !inTrash;
      case 'cut': case 'copy': return sel > 0;
      case 'paste': return !!clipboard && !inTrash;
      case 'rename': return sel === 1 && !inTrash;
      case 'share': return sel === 1;
      case 'trash': return sel > 0 && !inTrash;
      case 'emptybin': return inTrash;
      default: return true;
    }
  };
  document.querySelectorAll('.cmd').forEach((b) => { b.disabled = !can(b.dataset.cmd); });
}

/* ---------------- Account switching ---------------- */
async function switchAccount(email) {
  const acc = accounts.get(email);
  if (!acc) return;
  activeEmail = email;
  renderChips();
  if (acc.needsAuth) { await reauth(acc); return; }
  if (acc.nav.hi < 0) pushNav(acc);
  if (!acc.about) refreshAbout(acc).catch(() => {});
  await loadCurrent();
}

/* ---------------- Mutations (single account) ---------------- */
function invalidate(acc) { acc.cache.clear(); }
async function createFolderHere() {
  const acc = activeAcc(); if (!acc) return;
  inputModal('New folder', 'Folder name', 'Untitled folder', 'Create', async (name) => {
    setBusy(true, 'Creating folder…');
    try {
      await driveJson(acc, '/files', jsonOpts('POST', { name, mimeType: FOLDER_MIME, parents: [acc.nav.folderId] }));
      invalidate(acc); toast('Folder created: ' + name, 'ok'); await loadCurrent();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  });
}
async function renameSelected() {
  const acc = activeAcc(); const sel = selectedFiles(); if (!acc || sel.length !== 1) return;
  const f = sel[0];
  inputModal('Rename', 'New name', f.name, 'Rename', async (name) => {
    setBusy(true, 'Renaming…');
    try {
      await driveJson(acc, '/files/' + f.id, jsonOpts('PATCH', { name }));
      invalidate(acc); toast('Renamed to ' + name, 'ok'); await loadCurrent();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  });
}
async function trashSelected(items) {
  const acc = activeAcc(); if (!acc || !items.length) return;
  setBusy(true, 'Moving to bin…');
  try {
    for (const f of items) await driveJson(acc, '/files/' + f.id, jsonOpts('PATCH', { trashed: true }));
    invalidate(acc); toast(items.length + ' item(s) moved to Bin', 'ok'); await loadCurrent();
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
}
async function restoreSelected(items) {
  const acc = activeAcc(); if (!acc || !items.length) return;
  setBusy(true, 'Restoring…');
  try {
    for (const f of items) await driveJson(acc, '/files/' + f.id, jsonOpts('PATCH', { trashed: false }));
    invalidate(acc); toast(items.length + ' item(s) restored', 'ok'); await loadCurrent();
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
}
function deleteForeverSelected(items) {
  const acc = activeAcc(); if (!acc || !items.length) return;
  openModal('Delete forever?',
    '<p><b>' + items.length + ' item(s)</b> will be permanently deleted. This cannot be undone.</p>',
    [{ label: 'Cancel' }, {
      label: 'Delete forever', danger: true,
      onClick: async () => {
        setBusy(true, 'Deleting…');
        try {
          for (const f of items) await drive(acc, '/files/' + f.id, { method: 'DELETE' });
          invalidate(acc); toast('Deleted forever', 'ok'); await loadCurrent();
        } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
      },
    }]);
}
function emptyBin() {
  const acc = activeAcc(); if (!acc) return;
  openModal('Empty the Bin?',
    '<p>Everything in the Bin will be permanently deleted. This cannot be undone.</p>',
    [{ label: 'Cancel' }, {
      label: 'Empty bin', danger: true,
      onClick: async () => {
        setBusy(true, 'Emptying bin…');
        try { await drive(acc, '/files/trash', { method: 'DELETE' }); invalidate(acc); toast('Bin emptied', 'ok'); await loadCurrent(); }
        catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
      },
    }]);
}
async function toggleStar(f) {
  const acc = activeAcc(); if (!acc) return;
  try {
    await driveJson(acc, '/files/' + f.id, jsonOpts('PATCH', { starred: !f.starred }));
    invalidate(acc); await loadCurrent();
    toast(f.starred ? 'Removed from Starred' : 'Added to Starred', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
async function moveInDrive(acc, items, destFolderId) {
  for (const f of items) {
    const oldParents = (f.parents || []).join(',');
    const path = '/files/' + f.id + '?addParents=' + encodeURIComponent(destFolderId) + (oldParents ? '&removeParents=' + encodeURIComponent(oldParents) : '');
    await driveJson(acc, path, jsonOpts('PATCH', {}));
  }
}
async function copyInDrive(acc, items, destParentId) {
  for (const f of items) {
    if (f.mimeType === FOLDER_MIME) {
      const nf = await driveJson(acc, '/files', jsonOpts('POST', { name: f.name, mimeType: FOLDER_MIME, parents: [destParentId] }));
      const kids = await listChildren(acc, f.id);
      if (kids.length) await copyInDrive(acc, kids, nf.id);
    } else {
      await driveJson(acc, '/files/' + f.id + '/copy', jsonOpts('POST', { parents: [destParentId] }));
    }
  }
}

/* ---------------- Upload / download ---------------- */
async function uploadBlob(acc, blob, name, parentId, mimeType) {
  const metadata = { name, parents: parentId ? [parentId] : undefined, mimeType: mimeType || undefined };
  const cleanMeta = JSON.parse(JSON.stringify(metadata));
  if (blob.size <= MULTIPART_LIMIT) {
    const boundary = 'gde_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(cleanMeta) +
      '\r\n--' + boundary + '\r\nContent-Type: ' + (mimeType || blob.type || 'application/octet-stream') + '\r\n\r\n';
    const tail = '\r\n--' + boundary + '--';
    const body = new Blob([head, blob, tail], { type: 'multipart/related; boundary="' + boundary + '"' });
    return driveJson(acc, UPLOAD_API + '/files?uploadType=multipart&fields=id,name', { method: 'POST', body });
  }
  // Resumable for large files
  const start = await drive(acc, UPLOAD_API + '/files?uploadType=resumable&fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mimeType || blob.type || 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify(cleanMeta),
  });
  const loc = start.headers.get('Location');
  if (!loc) throw new Error('Upload init failed (no session URI).');
  const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mimeType || blob.type || 'application/octet-stream' }, body: blob });
  if (!put.ok) throw new Error('Upload failed: ' + put.status);
  return put.json().catch(() => ({}));
}
async function uploadPicked(fileList) {
  const acc = activeAcc(); if (!acc || !fileList.length) return;
  const parent = acc.nav.view === 'folder' ? acc.nav.folderId : 'root';
  setBusy(true, 'Uploading…');
  let done = 0;
  try {
    for (const file of fileList) {
      $('busyText').textContent = 'Uploading ' + file.name + ' (' + (++done) + '/' + fileList.length + ')';
      await uploadBlob(acc, file, file.name, parent, file.type || undefined);
    }
    invalidate(acc); toast(fileList.length + ' file(s) uploaded', 'ok'); await loadCurrent();
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
}
async function ensureFolderUpload(acc, name, parentId, cache) {
  const key = parentId + '|' + name;
  if (cache.has(key)) return cache.get(key);
  const created = await driveJson(acc, '/files', jsonOpts('POST', { name, mimeType: FOLDER_MIME, parents: [parentId] }));
  cache.set(key, created.id);
  return created.id;
}
async function uploadFolderPicked(fileList) {
  const acc = activeAcc(); if (!acc || !fileList.length) return;
  const baseParent = acc.nav.view === 'folder' ? acc.nav.folderId : 'root';
  const folderCache = new Map();
  setBusy(true, 'Uploading folder…');
  let done = 0;
  try {
    for (const file of fileList) {
      const parts = (file.webkitRelativePath || file.name).split('/');
      const fname = parts.pop();
      let parent = baseParent;
      for (const seg of parts) parent = await ensureFolderUpload(acc, seg, parent, folderCache);
      $('busyText').textContent = 'Uploading ' + (file.webkitRelativePath || file.name) + ' (' + (++done) + '/' + fileList.length + ')';
      await uploadBlob(acc, file, fname, parent, file.type || undefined);
    }
    invalidate(acc); toast('Folder uploaded: ' + fileList.length + ' file(s), structure kept', 'ok'); await loadCurrent();
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
}

const EXPORT_MAP = {
  'application/vnd.google-apps.document': ['application/pdf', '.pdf'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  'application/vnd.google-apps.drawing': ['image/png', '.png'],
  'application/vnd.google-apps.script': ['application/vnd.google-apps.script+json', '.json'],
};
const isNative = (f) => (f.mimeType || '').startsWith('application/vnd.google-apps.') && f.mimeType !== FOLDER_MIME && f.mimeType !== SHORTCUT_MIME;

async function fetchFileBlob(acc, f) {
  // Returns {blob, outName, mime} — exports Google-native files to a sensible format.
  if (isNative(f)) {
    const exp = EXPORT_MAP[f.mimeType];
    if (!exp) {
      if (f.webViewLink) window.open(f.webViewLink, '_blank');
      throw new Error('"' + f.name + '" is a Google-native file that cannot be downloaded directly — opened it in a tab instead.');
    }
    const res = await drive(acc, '/files/' + f.id + '/export?mimeType=' + encodeURIComponent(exp[0]));
    const blob = await res.blob();
    return { blob, outName: f.name + exp[1], mime: exp[0] };
  }
  const res = await drive(acc, '/files/' + f.id + '?alt=media');
  const blob = await res.blob();
  return { blob, outName: f.name, mime: f.mimeType };
}
async function downloadItem(f) {
  const acc = activeAcc(); if (!acc) return;
  if (f.mimeType === FOLDER_MIME) { toast('Folders cannot be downloaded directly. Open the folder and select files, or copy it to another drive.'); return; }
  setBusy(true, 'Preparing download…');
  try {
    const { blob, outName } = await fetchFileBlob(acc, f);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = outName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Download started: ' + outName, 'ok');
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
}

/* ---------------- Clipboard ---------------- */
function setClipboard(mode) {
  const acc = activeAcc(); const sel = selectedFiles();
  if (!acc || !sel.length) return;
  clipboard = { mode, accEmail: acc.email, items: sel };
  setStatus(mode === 'cut' ? 'Cut ' + sel.length + ' item(s) — navigate and Paste' : 'Copied ' + sel.length + ' item(s) — navigate and Paste');
  syncCommandBar();
}
async function pasteHere() {
  const acc = activeAcc(); if (!acc || !clipboard) return;
  const destId = acc.nav.view === 'folder' ? acc.nav.folderId : 'root';
  const srcAcc = accounts.get(clipboard.accEmail);
  setBusy(true, clipboard.mode === 'cut' ? 'Moving…' : 'Copying…');
  try {
    if (srcAcc && srcAcc.email === acc.email) {
      if (clipboard.mode === 'cut') { await moveInDrive(acc, clipboard.items, destId); clipboard = null; }
      else await copyInDrive(acc, clipboard.items, destId);
    } else if (srcAcc) {
      for (const f of clipboard.items) await crossCopy(srcAcc, f, acc, destId);
      if (clipboard.mode === 'cut') toast('Cross-drive "cut" copies only — the original stays in ' + srcAcc.email + ' (delete it there if you want a move).');
    }
    invalidate(acc); toast('Done', 'ok'); await loadCurrent();
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); syncCommandBar(); }
}

/* ---------------- Cloud-to-cloud transfer ---------------- */
async function crossCopy(srcAcc, f, dstAcc, dstParentId, depth) {
  if (f.mimeType === FOLDER_MIME) {
    const nf = await driveJson(dstAcc, '/files', jsonOpts('POST', { name: f.name, mimeType: FOLDER_MIME, parents: [dstParentId] }));
    const kids = await listChildren(srcAcc, f.id);
    for (const k of kids) await crossCopy(srcAcc, k, dstAcc, nf.id, (depth || 0) + 1);
    return;
  }
  try {
    const { blob, outName, mime } = await fetchFileBlob(srcAcc, f);
    await uploadBlob(dstAcc, blob, outName, dstParentId, mime);
  } catch (e) {
    toast('Skipped "' + f.name + '": ' + e.message, 'err');
  }
}
async function crossShortcut(srcAcc, f, dstAcc) {
  // The destination account must be able to read the source item, otherwise
  // the shortcut would be dead. Grant view access first (quietly).
  try {
    await driveJson(srcAcc, '/files/' + f.id + '/permissions?sendNotificationEmail=false',
      jsonOpts('POST', { type: 'user', role: 'reader', emailAddress: dstAcc.email }));
  } catch (e) { /* already shared, or insufficient rights — continue anyway */ }
  await driveJson(dstAcc, '/files', jsonOpts('POST', {
    name: f.name, mimeType: SHORTCUT_MIME, parents: ['root'],
    shortcutDetails: { targetId: f.id },
  }));
}
async function sendToDrive(files, dstAcc, asShortcut) {
  const srcAcc = activeAcc(); if (!srcAcc || !dstAcc) return;
  setBusy(true, asShortcut ? 'Creating shortcuts…' : 'Copying across drives…');
  try {
    if (asShortcut) {
      for (const f of files) {
        $('busyText').textContent = 'Shortcut for ' + f.name + '…';
        await crossShortcut(srcAcc, f, dstAcc);
      }
      toast(files.length + ' shortcut(s) created in ' + dstAcc.email, 'ok');
    } else {
      const destId = dstAcc.nav.view === 'folder' ? dstAcc.nav.folderId : 'root';
      for (const f of files) {
        $('busyText').textContent = 'Copying ' + f.name + '…';
        await crossCopy(srcAcc, f, dstAcc, destId);
      }
      toast(files.length + ' item(s) copied to ' + dstAcc.email, 'ok');
    }
    if (dstAcc.email === srcAcc.email) { invalidate(srcAcc); await loadCurrent(); }
    else { invalidate(dstAcc); }
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
}

/* ---------------- Sharing ---------------- */
async function listPerms(acc, id) {
  const d = await driveJson(acc, '/files/' + id + '/permissions?fields=permissions(id,type,role,emailAddress,domain,displayName)');
  return d.permissions || [];
}
async function makePublic(acc, f) {
  try {
    await driveJson(acc, '/files/' + f.id + '/permissions', jsonOpts('POST', { type: 'anyone', role: 'reader' }));
    invalidate(acc); await loadCurrent(); toast('"' + f.name + '" is now public (anyone with the link)', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
async function makePrivate(acc, f) {
  setBusy(true, 'Making private…');
  try {
    const perms = await listPerms(acc, f.id);
    for (const p of perms) {
      if (p.type === 'anyone' || p.type === 'domain') {
        await drive(acc, '/files/' + f.id + '/permissions/' + p.id, { method: 'DELETE' });
      }
    }
    invalidate(acc); await loadCurrent(); toast('"' + f.name + '" is now private', 'ok');
  } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
}
async function sharePanel(f) {
  const acc = activeAcc(); if (!acc) return;
  setBusy(true, 'Loading sharing…');
  let perms;
  try { perms = await listPerms(acc, f.id); } catch (e) { setBusy(false); toast(e.message, 'err'); return; }
  setBusy(false);
  const a = accessOf(f);
  const badge = a === 'public' ? '🌐 <b>Public</b> — anyone with the link' : a === 'shared' ? '👥 <b>Shared</b> with specific people' : '🔒 <b>Private</b> — only you';
  openModal('Share "' + f.name + '"',
    '<p>Status: ' + badge + '</p>' +
    '<div id="permList">' + perms.map(permRowHTML).join('') + '</div>' +
    '<div class="link-row"><input type="text" id="shareLink" readonly value="' + escAttr(f.webViewLink || '') + '"><button class="btn" id="copyLinkBtn">Copy link</button></div>' +
    '<h4 style="margin:14px 0 6px">Add people</h4>' +
    '<div class="link-row"><input type="email" id="shareEmail" placeholder="email@example.com">' +
    '<select id="shareRole"><option value="reader">Viewer</option><option value="commenter">Commenter</option><option value="writer">Editor</option></select>' +
    '<button class="btn primary" id="addPersonBtn">Add</button></div>' +
    '<div style="margin-top:14px;display:flex;gap:8px"><button class="btn" id="mkPubBtn">🌐 Make public</button><button class="btn" id="mkPrivBtn">🔒 Make private</button></div>',
    [{ label: 'Done' }]);
  wirePermRows(acc, f);
  $('copyLinkBtn').onclick = () => {
    const i = $('shareLink'); i.select();
    (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(() => toast('Link copied', 'ok')).catch(() => toast('Link selected — press Ctrl+C'));
  };
  $('addPersonBtn').onclick = async () => {
    const email = $('shareEmail').value.trim(), role = $('shareRole').value;
    if (!email) return;
    try {
      await driveJson(acc, '/files/' + f.id + '/permissions?sendNotificationEmail=false',
        jsonOpts('POST', { type: 'user', role, emailAddress: email }));
      toast('Shared with ' + email, 'ok'); sharePanel(f);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('mkPubBtn').onclick = () => { closeModal(); makePublic(acc, f); };
  $('mkPrivBtn').onclick = () => { closeModal(); makePrivate(acc, f); };
}
function permRowHTML(p) {
  const label = p.type === 'anyone' ? '🌐 Anyone with the link' : p.type === 'domain' ? '🏢 ' + esc(p.domain || 'Domain') : '👤 ' + esc(p.displayName || p.emailAddress || '');
  const locked = p.role === 'owner';
  return '<div class="perm-row" data-pid="' + escAttr(p.id) + '">' +
    '<span class="p-email">' + label + '</span>' +
    (locked ? '<span style="color:var(--muted)">Owner</span>'
      : '<select class="perm-role"><option value="reader"' + (p.role === 'reader' ? ' selected' : '') + '>Viewer</option>' +
        '<option value="commenter"' + (p.role === 'commenter' ? ' selected' : '') + '>Commenter</option>' +
        '<option value="writer"' + (p.role === 'writer' ? ' selected' : '') + '>Editor</option></select>' +
        '<button class="btn perm-remove" title="Remove">✕</button>') +
    '</div>';
}
function wirePermRows(acc, f) {
  document.querySelectorAll('#permList .perm-row').forEach((row) => {
    const pid = row.dataset.pid;
    const sel = row.querySelector('.perm-role');
    if (sel) sel.onchange = async () => {
      try { await driveJson(acc, '/files/' + f.id + '/permissions/' + pid, jsonOpts('PATCH', { role: sel.value })); toast('Permission updated', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    const rm = row.querySelector('.perm-remove');
    if (rm) rm.onclick = async () => {
      try { await drive(acc, '/files/' + f.id + '/permissions/' + pid, { method: 'DELETE' }); toast('Removed', 'ok'); sharePanel(f); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

/* ---------------- Properties ---------------- */
function propertiesDialog(f) {
  const acc = activeAcc();
  const a = accessOf(f);
  const owner = (f.owners && f.owners[0] && (f.owners[0].displayName || f.owners[0].emailAddress)) || '—';
  openModal('Properties — ' + f.name,
    '<div class="dp-rows">' +
    [['Name', f.name], ['Type', typeLabel(f.mimeType, f.name)], ['Size', f.mimeType === FOLDER_MIME ? '—' : fmtBytes(f.size)],
     ['Created', fmtDate(f.createdTime)], ['Modified', fmtDate(f.modifiedTime)], ['Owner', owner],
     ['Sharing', a === 'public' ? '🌐 Public (anyone with link)' : a === 'shared' ? '👥 Shared with people' : '🔒 Private'],
     ['Account', acc ? acc.email : '—']]
      .map((r) => '<div class="dp-row"><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>').join('') +
    '</div>',
    [{ label: 'Close' }]);
}

/* ---------------- Context menu ---------------- */
function openCtxMenu(x, y, sections) {
  closeCtxMenu();
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  for (const s of sections) {
    if (s.sep) { const d = document.createElement('div'); d.className = 'ctx-sep'; menu.appendChild(d); continue; }
    if (s.head) { const h = document.createElement('div'); h.className = 'ctx-head'; h.textContent = s.head; menu.appendChild(h); continue; }
    for (const it of s.items) {
      const el = document.createElement('div');
      el.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
      el.innerHTML = '<span class="ctx-icon">' + (it.icon || '') + '</span><span>' + esc(it.label) + '</span>';
      el.onclick = () => { closeCtxMenu(); if (it.fn) it.fn(); };
      menu.appendChild(el);
    }
  }
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - r.width - 8) + 'px';
  menu.style.top = Math.min(y, vh - r.height - 8) + 'px';
}
function closeCtxMenu() { $('ctxMenu').classList.add('hidden'); }

function otherAccounts() {
  const acc = activeAcc();
  return [...accounts.values()].filter((a) => a.email !== (acc && acc.email) && !a.needsAuth);
}
function openItemMenu(x, y, files) {
  const acc = activeAcc(); if (!acc) return;
  const single = files.length === 1 ? files[0] : null;
  const inTrash = acc.nav.view === 'trash';
  const others = otherAccounts();
  const sections = [];
  const acc2 = activeAcc();
  sections.push({
    items: [
      single && single.mimeType === FOLDER_MIME ? { icon: '📂', label: 'Open', fn: () => openItem(single) } : null,
      single ? { icon: '⬇️', label: 'Download', fn: () => downloadItem(single) } : null,
      single && single.starred ? { icon: '⭐', label: 'Remove star', fn: () => toggleStar(single) } : single ? { icon: '⭐', label: 'Add star', fn: () => toggleStar(single) } : null,
    ].filter(Boolean),
  });
  if (!inTrash) {
    sections.push({ sep: true });
    sections.push({
      items: [
        { icon: '✂️', label: 'Cut', fn: () => setClipboard('cut') },
        { icon: '📋', label: 'Copy', fn: () => setClipboard('copy') },
        { icon: '📥', label: 'Paste', disabled: !clipboard, fn: () => pasteHere() },
        { icon: '✏️', label: 'Rename', disabled: files.length !== 1, fn: () => renameSelected() },
      ],
    });
    sections.push({ head: 'Send to another drive', sep: true });
    if (others.length) {
      sections.push({
        items: others.flatMap((o) => ([
          { icon: '📋', label: 'Copy to ' + o.email, fn: () => sendToDrive(files, o, false) },
          { icon: '↗', label: 'Shortcut in ' + o.email, fn: () => sendToDrive(files, o, true) },
        ])),
      });
    } else {
      sections.push({ items: [{ icon: 'ℹ️', label: 'Connect another drive to send across', disabled: true }] });
    }
    sections.push({ head: 'Sharing', sep: true });
    sections.push({
      items: [
        { icon: '🌐', label: 'Make public', fn: async () => { for (const f of files) await makePublic(acc, f); } },
        { icon: '🔒', label: 'Make private', fn: async () => { for (const f of files) await makePrivate(acc, f); } },
        { icon: '🔗', label: 'Share…', disabled: files.length !== 1, fn: () => sharePanel(single) },
      ],
    });
    sections.push({ sep: true });
    sections.push({
      items: [
        { icon: 'ℹ️', label: 'Properties', disabled: files.length !== 1, fn: () => propertiesDialog(single) },
        { icon: '🗑️', label: 'Move to bin', fn: () => trashSelected(files) },
      ],
    });
  } else {
    sections.push({ sep: true });
    sections.push({
      items: [
        { icon: '↩️', label: 'Restore', fn: () => restoreSelected(files) },
        { icon: '⛔', label: 'Delete forever', fn: () => deleteForeverSelected(files) },
      ],
    });
  }
  openCtxMenu(x, y, sections);
}
function openAreaMenu(x, y) {
  const acc = activeAcc(); if (!acc || acc.needsAuth) return;
  const sections = [{
    items: [
      { icon: '📁', label: 'New folder', fn: () => createFolderHere() },
      { icon: '⬆️', label: 'Upload file', fn: () => $('filePicker').click() },
      { icon: '📁', label: 'Upload folder', fn: () => $('folderPicker').click() },
      { icon: '📥', label: 'Paste', disabled: !clipboard, fn: () => pasteHere() },
      { icon: '✅', label: 'Select all', fn: () => { acc.selected = new Set(acc.items.map((f) => f.id)); renderItems(); } },
      { icon: '🔄', label: 'Refresh', fn: async () => { invalidate(acc); await loadCurrent(); } },
    ],
  }];
  openCtxMenu(x, y, sections);
}

/* ---------------- Setup dialog ---------------- */
function showSetupDialog() {
  openModal('Setup needed',
    '<p>Paste your Google OAuth <b>Client ID</b> into <code>config.js</code> (<code>clientId</code>) and redeploy.</p>' +
    '<p>Quick checklist:</p><ol>' +
    '<li>Google Cloud Console → new project → enable <b>Google Drive API</b></li>' +
    '<li>OAuth consent screen → External → <b>Testing</b>, add your Gmail(s) as test users</li>' +
    '<li>Credentials → Create credentials → <b>OAuth client ID</b> → Web application</li>' +
    '<li>Authorized JavaScript origins: <b>https://gdrive-explorer.pages.dev</b></li>' +
    '<li>Copy the client ID into <code>config.js</code> and redeploy</li></ol>',
    [{ label: 'Got it' }]);
}

/* ---------------- Init / events ---------------- */
function wireEvents() {
  $('addDriveBtn').onclick = addDrive;
  $('addDriveBtn2').onclick = addDrive;
  $('signOutAllBtn').onclick = () => { if (accounts.size) confirmSignOut(null); };
  const rt = $('rememberToggle');
  rt.checked = rememberMode;
  rt.onchange = () => {
    rememberMode = rt.checked;
    persistAccounts();
    updateModeBadge();
    toast(rememberMode ? 'Remember mode ON — sign-in persists on THIS device between sessions.' : 'Remember mode OFF — sign-in exists only while this window is open (best for shared/office PCs).', 'ok');
  };
  updateModeBadge();

  document.querySelectorAll('.cmd').forEach((b) => {
    b.onclick = () => {
      const c = b.dataset.cmd;
      const sel = selectedFiles();
      const acc = activeAcc();
      if (c === 'newfolder') createFolderHere();
      else if (c === 'upload') {
        const r = b.getBoundingClientRect();
        openCtxMenu(r.left, r.bottom + 4, [{
          items: [
            { icon: '📄', label: 'Upload file', fn: () => $('filePicker').click() },
            { icon: '📁', label: 'Upload folder', fn: () => $('folderPicker').click() },
          ],
        }]);
      }
      else if (c === 'cut') setClipboard('cut');
      else if (c === 'copy') setClipboard('copy');
      else if (c === 'paste') pasteHere();
      else if (c === 'rename') renameSelected();
      else if (c === 'share') { if (sel.length === 1) sharePanel(sel[0]); }
      else if (c === 'trash') trashSelected(sel);
      else if (c === 'emptybin') emptyBin();
      else if (c === 'sort') {
        const order = ['name', 'modified', 'size', 'type'];
        let i = order.indexOf(sortKey);
        if (sortDir === 1) sortDir = -1; else { sortDir = 1; i = (i + 1) % order.length; sortKey = order[i]; }
        if (acc) { acc.items = sortedItems(acc.items); renderItems(); }
        toast('Sort: ' + sortKey + (sortDir === 1 ? ' ↑' : ' ↓'));
      } else if (c === 'view') {
        viewMode = viewMode === 'details' ? 'list' : viewMode === 'list' ? 'icons' : 'details';
        renderItems(); toast('View: ' + viewMode);
      }
    };
  });
  document.querySelectorAll('#detailsTable thead th').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort; if (!k) return;
      const acc = activeAcc();
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      if (acc) { acc.items = sortedItems(acc.items); renderItems(); }
    };
  });

  $('backBtn').onclick = () => { const acc = activeAcc(); if (acc && acc.nav.hi > 0) { acc.nav.hi--; applyNav(acc, acc.nav.hist[acc.nav.hi]); loadCurrent(); } };
  $('fwdBtn').onclick = () => { const acc = activeAcc(); if (acc && acc.nav.hi < acc.nav.hist.length - 1) { acc.nav.hi++; applyNav(acc, acc.nav.hist[acc.nav.hi]); loadCurrent(); } };
  $('upBtn').onclick = () => {
    const acc = activeAcc(); if (!acc || acc.nav.view !== 'folder' || acc.nav.path.length <= 1) return;
    const path = acc.nav.path.slice(0, -1);
    goFolder(acc, path[path.length - 1].id, path);
  };
  $('refreshBtn').onclick = () => { const acc = activeAcc(); if (acc) { invalidate(acc); loadCurrent(); } };
  $('tabClose').onclick = () => { const acc = activeAcc(); if (acc) goFolder(acc, 'root', [{ id: 'root', name: 'My Drive' }]); };

  document.querySelectorAll('.side-item').forEach((el) => {
    el.onclick = () => {
      const acc = activeAcc(); if (!acc || acc.needsAuth) { toast('Connect a drive first.', 'err'); return; }
      const v = el.dataset.view;
      if (v === 'folder-root') goFolder(acc, 'root', [{ id: 'root', name: 'My Drive' }]);
      else goView(acc, v);
    };
  });

  let searchDeb = null;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchDeb);
    searchDeb = setTimeout(() => {
      const acc = activeAcc(); if (!acc || acc.needsAuth) return;
      const t = e.target.value.trim();
      if (t) { searchTerm = t; acc.nav.view = 'search'; acc.nav.path = [{ id: 'search', name: 'Search: ' + t }]; acc.selected = new Set(); pushNav(acc); loadCurrent(); }
      else if (acc.nav.view === 'search') goFolder(acc, 'root', [{ id: 'root', name: 'My Drive' }]);
    }, 500);
  });

  $('filePicker').addEventListener('change', (e) => { uploadPicked(e.target.files); e.target.value = ''; });
  $('folderPicker').addEventListener('change', (e) => { uploadFolderPicked(e.target.files); e.target.value = ''; });
  $('contentArea').addEventListener('contextmenu', (e) => {
    if (e.target.closest('tr[data-id]') || e.target.closest('.tile') || e.target.closest('.list-row')) return;
    e.preventDefault(); openAreaMenu(e.clientX, e.clientY);
  });
  document.addEventListener('click', (e) => { if (!$('ctxMenu').contains(e.target)) closeCtxMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCtxMenu(); closeModal(); return; }
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName || '')) return;
    const acc = activeAcc(); if (!acc) return;
    const sel = selectedFiles();
    if (e.key === 'F2' && sel.length === 1) { e.preventDefault(); renameSelected(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && e.key !== 'Backspace' && sel.length && acc.nav.view !== 'trash') { e.preventDefault(); trashSelected(sel); }
    else if (e.key === 'Enter' && sel.length === 1 && sel[0].mimeType === FOLDER_MIME) openItem(sel[0]);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel.length) { e.preventDefault(); setClipboard('copy'); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && sel.length) { e.preventDefault(); setClipboard('cut'); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteHere(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); acc.selected = new Set(acc.items.map((f) => f.id)); renderItems(); }
  });
}
function updateModeBadge() {
  $('modeBadge').textContent = rememberMode ? 'Personal mode (remembered)' : 'Web mode (session only)';
  $('modeBadge').title = rememberMode
    ? 'Sign-in persists on this device — use on your personal PC'
    : 'Tokens kept only while this window/tab lives — best for office/shared PCs';
}

async function renderAll() {
  await loadCurrent();
  syncCommandBar();
}

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  wireEvents();
  if (!CONFIGURED) $('setupBanner').classList.remove('hidden');
  restoreAccounts();
  renderChips();
  if (activeEmail && accounts.has(activeEmail)) {
    const acc = accounts.get(activeEmail);
    if (acc.nav.hi < 0) pushNav(acc);
    await loadCurrent();
    for (const a of accounts.values()) if (!a.needsAuth) refreshAbout(a).catch(() => {});
  } else {
    activeEmail = null;
    showSignedOut();
    $('statusDrive').textContent = 'No drive connected';
  }
  syncCommandBar();
});
