/* =====================================================================
   Loci — parent app demo — app.js
   Router + rendering + asset-slot logic. Content comes from data.js.
   ===================================================================== */
(() => {
'use strict';

const D = (typeof LOCI_DATA !== 'undefined') ? LOCI_DATA : window.LOCI_DATA;
const C = D.copy;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Fill {placeholders} in copy strings. Child name/pronouns are always available.
function t(str, vars = {}) {
  const p = D.child.pronouns || { he: 'he', him: 'him', his: 'his' };
  const all = { child: D.child.name, he: p.he, him: p.him, his: p.his, He: cap(p.he), Him: cap(p.him), His: cap(p.his), ...vars };
  return String(str ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in all ? all[k] : m));
}
const te = (str, vars) => esc(t(str, vars));   // template + escape, the common case

/* =====================================================================
   1. Asset storage — the ONLY place that knows where assets live.
      Swap the IndexedDB calls for fetch("https://…/captures/{id}") later.
      Records: { id, dataUrl, type, name, duration (seconds|null), addedAt }

      A slot can also be pre-filled from data.js: any `asset:` / `cover:`
      value that is a string is treated as a URL (or data-URL) and rendered
      as a filled, read-only slot. That is the seam a real backend drops into.
   ===================================================================== */
const DB_NAME = 'loci-demo', DB_VERSION = 1, STORE = 'assets';
const assetCache = new Map();
const assetSeeds = new Map();
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no-idb'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
  return dbPromise;
}
function idb(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = fn(store);
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
// localStorage fallback (private-mode browsers, or an IndexedDB write that fails on quota)
const LS_ASSETS = 'loci.assets.v1';
function lsRead() { try { return JSON.parse(localStorage.getItem(LS_ASSETS) || '{}'); } catch (_) { return {}; } }
function lsWrite(obj) { try { localStorage.setItem(LS_ASSETS, JSON.stringify(obj)); return true; } catch (_) { return false; } }

async function preloadAssets() {
  // Always read the fallback store: a record can live there even when IndexedDB opens fine
  // (e.g. the IDB write failed on quota), and it must still come back after a reload.
  Object.values(lsRead()).forEach((r) => { if (r && r.id) assetCache.set(r.id, r); });
  try {
    const all = await idb('readonly', (s) => s.getAll());
    (all || []).forEach((r) => assetCache.set(r.id, r));   // IndexedDB wins on the same id
  } catch (_) { /* fallback contents already loaded */ }
}
function buildSeeds() {
  assetSeeds.clear();
  days().forEach((d) => d.routes.forEach((r) => r.steps.forEach((s, i) => { if (typeof s.asset === 'string' && s.asset) assetSeeds.set(stepAssetId(r.id, i), s.asset); })));
  (D.library.owned || []).forEach((p) => { if (typeof p.cover === 'string' && p.cover) assetSeeds.set(`zine:${p.id}`, p.cover); });
  (D.library.browse || []).forEach((b, i) => { if (typeof b.cover === 'string' && b.cover) assetSeeds.set(`zine:${b.id || 'browse-' + i}`, b.cover); });
  (D.lens.exchange || []).forEach((m, i) => { if (typeof m.asset === 'string' && m.asset) assetSeeds.set(m.id || `lens:${i}`, m.asset); });
}
function getAsset(id) {
  const rec = assetCache.get(id);
  if (rec) return rec;
  const seed = assetSeeds.get(id);
  return seed ? { id, dataUrl: seed, seeded: true, duration: null, type: '' } : null;
}
async function setAsset(id, blob, extra = {}) {
  const record = { id, type: blob.type || '', name: blob.name || '', addedAt: new Date().toISOString(), duration: null, ...extra };
  if (record.type.startsWith('image/')) record.dataUrl = extra.dataUrl || await imageToDataUrl(blob);
  else {
    record.dataUrl = await readAsDataURL(blob);
    if (record.duration == null) record.duration = await probeDuration(record.dataUrl);
  }
  assetCache.set(id, record);
  let durable = true;
  try { await idb('readwrite', (s) => s.put(record)); }
  catch (_) { const all = lsRead(); all[id] = record; durable = lsWrite(all); }
  return { record, durable };
}
async function removeAsset(id) {
  assetCache.delete(id);
  try { await idb('readwrite', (s) => s.delete(id)); } catch (_) {}
  const all = lsRead(); if (all[id]) { delete all[id]; lsWrite(all); }
}

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsDataURL(blob); });
}
function loadImage(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('decode')); img.src = src; });
}
// Downscale big phone photos so the feed stays quick. Throws if the file will not decode.
async function imageToDataUrl(blob) {
  const raw = await readAsDataURL(blob);
  const img = await loadImage(raw);
  const MAX = 1600, w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error('decode');
  if (Math.max(w, h) <= MAX && blob.size < 900 * 1024) return raw;
  try {
    const scale = Math.min(1, MAX / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  } catch (_) { return raw; }
}
function probeDuration(src) {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    let done = false;
    const finish = (v) => { if (!done) { done = true; a.src = ''; resolve(Number.isFinite(v) && v > 0 ? v : null); } };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(a.duration);
    a.ondurationchange = () => { if (Number.isFinite(a.duration) && a.duration > 0) finish(a.duration); };
    a.onerror = () => finish(null);
    setTimeout(() => finish(null), 4000);
    a.src = src;
  });
}

/* =====================================================================
   2. Persistent app state (small, JSON) + in-memory UI state
   ===================================================================== */
const LS_STATE = 'loci.state.v1';
const state = Object.assign({ talked: {}, scaffoldMode: null, lensSent: [] }, (() => { try { return JSON.parse(localStorage.getItem(LS_STATE) || '{}'); } catch (_) { return {}; } })());
function saveState() { try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch (_) {} }
function scaffoldMode() { return state.scaffoldMode || D.settings.scaffoldMode || 'full'; }

const ui = {
  filter: {},              // dayId → 'all' | 'audio' | 'photo'
  openStarters: new Set(), // `${guideId}:${i}`
  starterIndex: {},        // guideId → i (oneMove)
  started: new Set(),      // guideId (oneMove)
  talkedNow: new Set(),    // guideId — button in its "done" state for this visit
  openSpreads: new Set(),  // `${packId}:${n}`
  coming: new Set(),       // browse pack ids tapped
  showX: new Set(),        // asset ids whose clear chip is revealed
  deviceOpen: false,
  scroll: {},              // screen key → scrollTop
  freshNav: false,         // next mount is a forward jump: start at the top
  sheet: null,
  returnFocus: null
};

/* =====================================================================
   3. Data helpers — days, routes, guides
   ===================================================================== */
function localISO(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function parseISO(id) { const [y, m, d] = id.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtTime(d) { let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0'); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${m}${ap}`; }
function fmtDay(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', ''); }
function dayDiff(a, b) { return Math.round((parseISO(localISO(a)) - parseISO(localISO(b))) / 86400000); }

let DAYS = null;
function days() {
  if (DAYS) return DAYS;
  const list = (D.days || []).map((d) => ({ ...d, routes: d.routes || [] })).sort((a, b) => b.id.localeCompare(a.id));
  const real = localISO(new Date());
  let today = list.find((d) => d.label === 'Today') || list.find((d) => d.id === real);
  if (!today) { today = { id: real, label: 'Today', routes: [] }; list.push(today); }
  const rest = list.filter((d) => d !== today && d.id <= today.id).sort((a, b) => b.id.localeCompare(a.id));
  const todayDate = parseISO(today.id);
  rest.forEach((d) => {
    if (d.label) return;
    const diff = dayDiff(todayDate, parseISO(d.id));
    d.label = diff === 1 ? 'Yesterday' : fmtDay(parseISO(d.id));
  });
  today.label = today.label || 'Today';
  DAYS = [today, ...rest];
  return DAYS;
}
const todayDay = () => days()[0];
const dayById = (id) => days().find((d) => d.id === id) || null;
const isToday = (day) => day === todayDay();
// Pagination walks days that actually have captures (today always counts, so it is never orphaned).
function olderWithActivity(day) { const list = days(); const i = list.indexOf(day); return list.slice(i + 1).find((d) => d.routes.length) || null; }
function newerWithActivity(day) {
  const list = days(); const i = list.indexOf(day);
  for (let j = i - 1; j >= 0; j--) if (list[j].routes.length || isToday(list[j])) return list[j];
  return null;
}
function mostRecentActive() { return days().find((d) => d.routes.length) || null; }

function allRoutes() { return days().flatMap((d) => d.routes.map((r) => ({ route: r, day: d }))); }
function routeById(id) { return allRoutes().find((x) => x.route.id === id) || null; }
function guideContext(guideId) {
  for (const { route, day } of allRoutes()) {
    const idx = route.steps.findIndex((s) => s.guideId === guideId);
    if (idx >= 0) return { route, day, step: route.steps[idx], index: idx };
  }
  return null;
}
const stepAssetId = (routeId, i) => `${routeId}:${i}`;

function whenLabel(iso) {
  const d = new Date(iso); if (isNaN(d)) return String(iso);
  const diff = dayDiff(new Date(), d);
  if (diff === 0) return `today at ${fmtTime(d)}`;
  if (diff === 1) return `yesterday at ${fmtTime(d)}`;
  return `on ${fmtDay(d)}`;
}
// Overlay persisted "talked" stamps onto the routes in memory. Re-run on every render so a
// long-lived session's "today at 4:13pm" becomes "yesterday at 4:13pm" after midnight.
function applyState() {
  allRoutes().forEach(({ route }) => {
    if (route.talkedAtFixed === undefined) route.talkedAtFixed = route.talkedAt || null;
    const iso = state.talked[route.id];
    route.talkedAt = iso ? whenLabel(iso) : route.talkedAtFixed;
  });
}
function markTalked(routeId) { state.talked[routeId] = new Date().toISOString(); saveState(); applyState(); }

const dayHash = (day) => (isToday(day) ? '#/wonders' : `#/wonders/${day.id}`);

/* =====================================================================
   4. Icons (inline SVG)
   ===================================================================== */
const svg = (inner, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${inner}</svg>`;
const I = {
  sparkle: svg('<path d="M12 2.5c.6 5.4 4.1 8.9 9.5 9.5-5.4.6-8.9 4.1-9.5 9.5-.6-5.4-4.1-8.9-9.5-9.5 5.4-.6 8.9-4.1 9.5-9.5z"/>'),
  sparkleFill: svg('<path d="M12 2.5c.6 5.4 4.1 8.9 9.5 9.5-5.4.6-8.9 4.1-9.5 9.5-.6-5.4-4.1-8.9-9.5-9.5 5.4-.6 8.9-4.1 9.5-9.5z" fill="currentColor"/>'),
  book: svg('<path d="M5 5.2A2.2 2.2 0 0 1 7.2 3h9.6A2.2 2.2 0 0 1 19 5.2v13.6a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 18.8z"/><path d="M9.5 3v18"/>'),
  bookFill: svg('<path d="M5 5.2A2.2 2.2 0 0 1 7.2 3h9.6A2.2 2.2 0 0 1 19 5.2v13.6a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 18.8z" fill="currentColor"/><path d="M9.5 3.5v17" stroke="var(--cream)" stroke-width="2"/>'),
  camera: svg('<path d="M4 8.6A2.6 2.6 0 0 1 6.6 6H8l1.3-2h5.4L16 6h1.4A2.6 2.6 0 0 1 20 8.6v8.8a2.6 2.6 0 0 1-2.6 2.6H6.6A2.6 2.6 0 0 1 4 17.4z"/><circle cx="12" cy="13" r="3.4"/>'),
  cameraFill: svg('<path d="M4 8.6A2.6 2.6 0 0 1 6.6 6H8l1.3-2h5.4L16 6h1.4A2.6 2.6 0 0 1 20 8.6v8.8a2.6 2.6 0 0 1-2.6 2.6H6.6A2.6 2.6 0 0 1 4 17.4z" fill="currentColor"/><circle cx="12" cy="13" r="3.4" fill="var(--cream)" stroke="var(--cream)"/>'),
  gear: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  gearFill: svg('<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" fill="currentColor"/><circle cx="12" cy="12" r="3.2" fill="var(--cream)" stroke="var(--cream)"/>'),
  bell: svg('<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3.5M9 21h6"/>'),
  play: '<svg viewBox="0 0 24 24" class="ic-play" aria-hidden="true"><path d="M8.5 6.2v11.6l9.6-5.8z"/></svg><svg viewBox="0 0 24 24" class="ic-pause" aria-hidden="true"><rect x="7" y="6" width="3.6" height="12" rx="1"/><rect x="13.4" y="6" width="3.6" height="12" rx="1"/></svg>',
  chevDown: svg('<path d="M6 9.5l6 6 6-6"/>'),
  chevRight: svg('<path d="M9.5 6l6 6-6 6"/>'),
  chevLeft: svg('<path d="M14.5 6l-6 6 6 6"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  battery: svg('<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M21.5 10.5v3"/><rect x="5" y="9.5" width="9" height="5" rx="1" fill="currentColor" stroke="none"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/>'),
  photo: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>')
};

/* =====================================================================
   5. Shared components — asset slots, audio player, waveform
   ===================================================================== */
function seeded(seed) { let h = 2166136261; for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h += 0x6D2B79F5; let x = Math.imul(h ^ (h >>> 15), 1 | h); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function waveform(seed, n = 34) {
  const rnd = seeded(seed);
  let bars = '';
  for (let i = 0; i < n; i++) {
    const env = 0.55 + 0.45 * Math.sin((i / n) * Math.PI);          // fuller in the middle
    const h = Math.min(1, Math.max(0.14, env * (0.25 + rnd() * 0.85)));
    bars += `<i style="--h:${h.toFixed(2)};--d:-${Math.round(rnd() * 900)}ms"></i>`;
  }
  return `<div class="wave" aria-hidden="true">${bars}</div>`;
}
function photoSlot(assetId, { cls = '', label = C.slots.photo, alt = '', pickable = true } = {}) {
  const rec = getAsset(assetId);
  if (rec) {
    // Spec §3: the clear chip appears on long-press or a corner tap, so the photo reads clean.
    const clearable = !rec.seeded;
    const shown = ui.showX.has(assetId);
    return `<div class="slot photo filled ${cls}${shown ? ' show-x' : ''}" data-slot-id="${esc(assetId)}"${clearable ? ' data-press="reveal"' : ''}>
      <img src="${rec.dataUrl}" alt="${esc(alt)}" draggable="false">
      ${clearable ? `<button class="slot-x" data-action="slot-clear" data-slot-id="${esc(assetId)}" data-kind="photo" aria-label="${te(C.a11y.removePhoto)}">${esc(C.a11y.clear)}</button>` : ''}
    </div>`;
  }
  if (!pickable) return `<div class="slot photo ${cls}" aria-hidden="true">${I.camera}<span>${te(label)}</span></div>`;
  return `<button class="slot photo ${cls}" data-action="slot" data-kind="photo" data-slot-id="${esc(assetId)}">${I.camera}<span>${te(label)}</span></button>`;
}
function fmtDur(sec) { if (!Number.isFinite(sec) || sec <= 0) return ''; const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function audioPlayer(assetId, { duration = '', compact = false, label = C.slots.audio, bars } = {}) {
  const rec = getAsset(assetId);
  const filled = !!rec;
  const playing = filled && player.current === assetId && !player.el.paused;
  // Never show a duration from data.js for a file the parent added — only what the file really is.
  const dur = filled ? (rec.seeded ? (duration || '') : (fmtDur(rec.duration) || '')) : '';
  const n = bars || (compact ? 18 : 34);
  const cls = `audio-player${compact ? ' compact' : ''}${filled ? '' : ' empty'}${playing ? ' playing is-playing' : ''}`;
  const meta = filled
    ? `<span class="dur">${esc(dur)}</span>${rec.seeded ? '' : `<button class="x" data-action="slot-clear" data-slot-id="${esc(assetId)}" data-kind="audio">${te(C.slots.remove)}</button>`}`
    : `<span>${te(label)}</span>`;
  const btn = filled
    ? `<button class="play" data-action="play" data-slot-id="${esc(assetId)}" aria-label="${te(playing ? C.a11y.pause : C.a11y.play)}" aria-pressed="${playing}">${I.play}</button>`
    : `<span class="play" aria-hidden="true">${I.play}</span>`;
  // Empty: the whole row is the single control. Filled: the play button is the single control.
  const row = filled
    ? `<div class="audio-row">${btn}${waveform(assetId, n)}</div>`
    : `<button class="audio-row" data-action="slot" data-kind="audio" data-slot-id="${esc(assetId)}" aria-label="${te(label)}">${btn}${waveform(assetId, n)}</button>`;
  return `<div class="${cls}" data-audio-id="${esc(assetId)}">${row}<div class="audio-meta">${meta}</div></div>`;
}

// One <audio> element for the whole app.
const player = { el: $('#player'), current: null };
function togglePlay(assetId) {
  const rec = getAsset(assetId); if (!rec) return;
  const a = player.el;
  if (player.current === assetId) { if (a.paused) a.play().catch(() => {}); else a.pause(); return; }
  player.current = assetId;
  a.src = rec.dataUrl;
  a.play().catch(() => {});
  syncPlayers();
}
function syncPlayers() {
  const a = player.el;
  $$('.audio-player').forEach((p) => {
    const mine = p.dataset.audioId === player.current;
    const playing = mine && !a.paused && !a.ended;
    // .is-playing drives the pause glyph (always), .playing drives the bar animation
    // (the reduced-motion media query switches that animation off in CSS).
    p.classList.toggle('is-playing', playing);
    p.classList.toggle('playing', playing);
    const btn = $('.play', p);
    if (btn && btn.tagName === 'BUTTON') {
      btn.setAttribute('aria-label', t(playing ? C.a11y.pause : C.a11y.play));
      btn.setAttribute('aria-pressed', String(playing));
    }
    const bars = $$('.wave i', p);
    const frac = mine && Number.isFinite(a.duration) && a.duration > 0 ? a.currentTime / a.duration : 0;
    bars.forEach((b, i) => b.classList.toggle('past', mine && i < frac * bars.length));
  });
}
['play', 'pause', 'ended', 'timeupdate'].forEach((ev) => player.el.addEventListener(ev, syncPlayers));
player.el.addEventListener('ended', () => { player.el.currentTime = 0; });
player.el.addEventListener('error', () => { if (player.current) toast(t(C.slots.badAudio)); });

/* =====================================================================
   6. Screens
   ===================================================================== */
const TAB_ORDER = ['wonders', 'library', 'lens', 'settings'];
function buildNav() {
  const items = [
    ['wonders', I.sparkle, I.sparkleFill], ['library', I.book, I.bookFill],
    ['lens', I.camera, I.cameraFill], ['settings', I.gear, I.gearFill]
  ];
  const nav = $('#nav');
  nav.setAttribute('aria-label', t(C.a11y.mainNav));
  nav.innerHTML = items.map(([k, line, fill]) => `<a class="nav-item" href="#/${k}" data-tab="${k}">
      <span class="ic-line">${line}</span><span class="ic-fill">${fill}</span><span>${esc(C.nav[k])}</span></a>`).join('');
}
// Rebuilding the nav on every route would drop keyboard focus, so only the state changes.
function setNavActive(tab) {
  $$('.nav-item').forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

/* ---- Wonders: one day per page ---- */
function wondersHTML(day) {
  const filter = ui.filter[day.id] || 'all';
  const newer = newerWithActivity(day);
  const older = olderWithActivity(day);
  const heading = day.heading || D.week.heading;
  const subline = day.subline || D.week.subline;

  const head = `<div class="head-wrap"><header class="day-head">
      <div class="titles">
        ${newer ? `<a class="newer" href="${dayHash(newer)}">${I.chevLeft}<span>${esc(newer.label)}</span></a>` : ''}
        <h1>${esc(day.label)}</h1>
      </div>
      <span class="bell" aria-hidden="true">${I.bell}</span>
    </header></div>
    <section class="topic-block"><h2>${esc(heading)}</h2><p class="subline">${te(subline)}</p></section>`;

  if (!day.routes.length) {
    // An empty day gets exactly one card: no "that's everything" on a page with nothing on it.
    const next = older || (isToday(day) ? mostRecentActive() : null);
    return head + `<section class="empty-day">
        <div class="empty-art">${I.sparkle}</div>
        <p>${te(isToday(day) ? C.wonders.emptyToday : C.wonders.emptyDay, { label: day.label })}</p>
        ${next && next !== day ? `<a class="btn orange-outline" href="${dayHash(next)}" data-fresh="1">${te(C.wonders.seeDay, { label: next.label })}</a>` : ''}
      </section>`;
  }

  const pills = ['all', 'audio', 'photo'].map((k) => `<button class="pill${filter === k ? ' active' : ''}" data-action="filter" data-day="${esc(day.id)}" data-filter="${k}" aria-pressed="${filter === k}">${esc(C.wonders.filters[k])}</button>`).join('');
  const cards = day.routes.map((r) => routeCardHTML(r, filter)).filter(Boolean);
  const body = `<div class="pills" role="group" aria-label="${te(C.a11y.filters)}">${pills}</div>` +
    (cards.length ? cards.join('') : `<p class="no-match">${te(filter === 'audio' ? C.wonders.noAudio : C.wonders.noPhotos)}</p>`);

  const end = `<section class="day-end">
      ${older ? `<p>${te(C.wonders.endOfDay, { label: day.label })}</p><a class="btn orange-outline" href="${dayHash(older)}" data-fresh="1">${te(C.wonders.seeDay, { label: older.label })}</a>`
             : `<p>${te(C.wonders.began)}</p>`}
    </section>`;
  return head + body + end;
}

function routeCardHTML(route, filter) {
  const steps = route.steps.map((s, i) => ({ s, i })).filter(({ s }) => filter === 'all' || s.type === filter);
  if (!steps.length) return '';
  const chip = route.zineRef ? `<span class="zine-chip" style="background:${esc(route.topicTint || '#F4E9F2')};border-color:${esc(route.topicEdge || '#C9A9C3')}">${esc(route.zineRef)}</span>` : '';
  const stepsHTML = steps.map(({ s, i }) => {
    const id = stepAssetId(route.id, i);
    let body = `<p class="prompt">${te(s.prompt)}</p>`;
    if (s.type === 'photo') {
      body += photoSlot(id, { alt: t(s.prompt) });
      // A typed response (no recording made) — e.g. the exhibit's wonder-page captures.
      if (s.response) body += `<p class="child-quote">“${te(s.response)}”</p>`;
      if (s.guideId && D.guides[s.guideId]) {
        body += route.talkedAt
          ? `<a class="btn orange-outline" href="#/guide/${esc(s.guideId)}">${te(C.wonders.talkAgain)}</a>
             <p class="talked-line">${I.check}<span>${te(C.wonders.talked, { when: route.talkedAt })}</span></p>`
          : `<a class="btn orange" href="#/guide/${esc(s.guideId)}">${te(C.wonders.talk)}</a>`;
      }
    } else {
      body += audioPlayer(id, { duration: s.duration });
    }
    return `<div class="step"><div class="node" aria-hidden="true">${s.type === 'photo' ? I.camera : I.mic}</div><div class="step-body">${body}</div></div>`;
  }).join('');
  return `<article class="route" data-route="${esc(route.id)}">
      <div class="route-head">
        <div class="title-row"><h3>${esc(route.topic)}</h3>${chip}</div>
        <p class="meta">${te(route.meta || '')}</p>
      </div>
      <div class="timeline">${stepsHTML}</div>
    </article>`;
}

/* ---- Guide: "Talk about this" ---- */
function starterHTML(guideId, st, i, route) {
  let say = te(st.say);
  if (st.blank) {
    const blank = te(st.blank);
    const tint = route && route.topicTint, edge = route && route.topicEdge;
    const style = tint && edge ? ` style="background:${esc(tint)};border-color:${esc(edge)}"` : '';
    say = say.split(blank).join(`<span class="blank"${style}>${blank}</span>`);
  }
  const open = ui.openStarters.has(`${guideId}:${i}`);
  return `<div class="starter${open ? ' open' : ''}" role="button" tabindex="0" data-action="starter" data-guide="${esc(guideId)}" data-i="${i}" aria-expanded="${open}">
      <span class="say">“${say}”</span>
      <span class="why-link">${esc(C.guide.why)} ${I.chevDown}</span>
      <span class="why-text">${te(st.why)}</span>
    </div>`;
}
function guideHTML(guideId) {
  const g = D.guides[guideId];
  const ctx = guideContext(guideId);
  const route = ctx ? ctx.route : (g.recap && g.recap.photoFrom ? (routeById(g.recap.photoFrom[0]) || {}).route : null);
  const mode = scaffoldMode();
  const photoId = g.recap && g.recap.photoFrom ? stepAssetId(g.recap.photoFrom[0], g.recap.photoFrom[1]) : null;
  const audioId = g.recap && g.recap.audioFrom ? stepAssetId(g.recap.audioFrom[0], g.recap.audioFrom[1]) : null;
  const audioRoute = audioId ? routeById(g.recap.audioFrom[0]) : null;
  const audioStep = audioRoute ? audioRoute.route.steps[g.recap.audioFrom[1]] : null;

  const head = `<div class="head-wrap green"><header class="guide-head">
      <button class="back-pill" data-action="back" data-fallback="${route && ctx ? dayHash(ctx.day) : '#/wonders'}">${I.chevLeft}${esc(C.guide.back)}</button>
      <h1 tabindex="-1">${te(g.title)}</h1>
      ${g.subtitle ? `<p class="sub">${te(g.subtitle)}</p>` : ''}
    </header></div>`;

  const recap = `<section class="recap">
      ${photoId ? photoSlot(photoId, { cls: 'thumb', label: C.slots.photoSmall, alt: '' }) : ''}
      <div class="recap-text">
        <p>${te((g.recap && g.recap.text) || '')}</p>
        ${audioId ? audioPlayer(audioId, { compact: true, duration: audioStep && audioStep.duration, bars: 26 })
          : (g.recap && g.recap.response) ? `<p class="child-quote">“${te(g.recap.response)}”</p>` : ''}
      </div>
    </section>`;

  const before = g.before ? `<section class="g-section"><h2>${esc(C.guide.before)}</h2><p>${te(g.before)}</p></section>` : '';

  const movesHTML = `<section class="g-section"><h2>${esc(C.guide.keeping)}</h2>
      ${(g.moves || []).map((m) => `<div class="move"><div class="dot" aria-hidden="true">${esc(m.icon)}</div><div>
          <p class="name">${esc(m.name)}</p><p class="text">${te(m.text)}</p>${m.eg ? `<p class="eg">${te(m.eg)}</p>` : ''}</div></div>`).join('')}
    </section>`;
  const avoidHTML = (g.avoid || []).length ? `<section class="g-section"><h2>${esc(C.guide.avoid)}</h2>
      <div class="avoid"><ul>${g.avoid.map((a) => `<li>${te(a)}</li>`).join('')}</ul></div></section>` : '';

  const done = ui.talkedNow.has(guideId);
  const footHTML = `<section class="guide-foot">
      ${route && route.talkedAt && !done ? `<p class="already">${te(C.guide.alreadyTalked, { when: route.talkedAt })}</p>` : ''}
      <button class="btn ${done ? 'green' : 'plum'}" data-action="talked" data-guide="${esc(guideId)}" data-route="${esc((route && route.id) || '')}" ${done ? 'disabled' : ''}>
        ${esc(done ? C.guide.talkedDone : (route && route.talkedAt ? C.guide.talkedAgain : C.guide.talked))}
      </button>
    </section>`;

  if (mode === 'oneMove') {
    const n = (g.starters || []).length;
    const i = ((ui.starterIndex[guideId] || 0) % Math.max(1, n));
    const started = ui.started.has(guideId);
    const main = `<section class="g-section"><h2>${esc(C.guide.waysIn)}</h2>
        ${n ? starterHTML(guideId, g.starters[i], i, route) : ''}
        ${n > 1 ? `<button class="another" data-action="another" data-guide="${esc(guideId)}">${esc(C.guide.another)}</button>` : ''}
        ${started ? '' : `<button class="started-pill" data-action="started" data-guide="${esc(guideId)}">${esc(C.guide.started)}</button><p class="started-hint">${esc(C.guide.startedHint)}</p>`}
      </section>` + (started ? movesHTML + avoidHTML : '');
    return head + `<div class="guide-body">${recap}${before}${main}</div>` + footHTML;
  }
  const main = `<section class="g-section"><h2>${esc(C.guide.waysIn)}</h2>
      ${g.waysInIntro ? `<p class="lead">${te(g.waysInIntro)}</p>` : ''}
      ${(g.starters || []).map((st, i) => starterHTML(guideId, st, i, route)).join('')}
    </section>` + movesHTML + avoidHTML;
  return head + `<div class="guide-body">${recap}${before}${main}</div>` + footHTML;
}

/* ---- Library ---- */
const TINTS = [['#EAF2FF', '#78ABFE'], ['#FFF4E0', '#F5B940'], ['#FDEEEE', '#F19394'], ['#EAF7EE', '#6CC08B'], ['#F4E9F2', '#C9A9C3']];
function spreadTint(spread, i) {
  if (spread.tint && spread.edge) return [spread.tint, spread.edge];
  const r = allRoutes().find((x) => x.route.topic === spread.title);
  if (r && r.route.topicTint) return [r.route.topicTint, r.route.topicEdge];
  return TINTS[i % TINTS.length];
}
function libraryHTML() {
  const L = D.library;
  const packs = (L.owned || []).map((p) => {
    const spreads = (p.spreads || []).map((s, i) => {
      const [tint, edge] = spreadTint(s, i);
      const key = `${p.id}:${s.n}`; const open = ui.openSpreads.has(key);
      return `<button class="spread${open ? ' open' : ''}" data-action="spread" data-key="${esc(key)}" aria-expanded="${open}">
          <span class="num" style="background:${esc(tint)};border-color:${esc(edge)}">${esc(s.n)}</span>
          <span class="sbody"><span class="stitle">${esc(s.title)}</span><span class="sblurb">${te(s.blurb)}</span></span>
          <span class="chev">${I.chevDown}</span></button>`;
    }).join('');
    return `<article class="pack">
        <div class="pack-head">${photoSlot(`zine:${p.id}`, { cls: 'cover', label: C.slots.cover, alt: p.title })}
          <div><h3>${esc(p.title)}</h3><p class="count">${te(C.library.spreads, { n: (p.spreads || []).length })}</p></div></div>
        <div class="spreads">${spreads}</div>
        ${p.territory ? `<section class="g-section"><h2>${esc(C.library.territory)}</h2><p>${te(p.territory)}</p></section>` : ''}
        ${(p.listenFor || []).length ? `<section class="g-section"><h2>${esc(C.library.listenFor)}</h2><ul class="listen">${p.listenFor.map((x) => `<li>${te(x)}</li>`).join('')}</ul></section>` : ''}
      </article>`;
  }).join('');
  // The cover is decorative here: the whole card is one control, so a tap never opens a picker.
  const browse = (L.browse || []).map((b, i) => {
    const id = b.id || `browse-${i}`; const coming = ui.coming.has(id);
    return `<button class="browse${coming ? ' coming' : ''}" data-action="browse" data-id="${esc(id)}"${coming ? ' aria-disabled="true"' : ''}>
        ${photoSlot(`zine:${id}`, { cls: 'grid-cover', label: C.slots.cover, alt: b.title, pickable: false })}
        <span class="btitle">${esc(b.title)}</span><span class="bblurb">${te(b.blurb)}</span>
        <span class="price">${esc(coming ? C.library.coming : b.price)}</span></button>`;
  }).join('');
  return `<div class="head-wrap"><header class="tab-head"><h1>${esc(C.nav.library)}</h1><p class="sub">${te(L.intro)}</p></header></div>
    <div class="tab-body">
      <h2 class="lib-h">${te(C.library.owned)}</h2>${packs}
      <h2 class="lib-h">${esc(C.library.more)}</h2><div class="browse-grid">${browse}</div>
    </div>`;
}

/* ---- Lens: photo & voice exchange ---- */
function lensMessages() {
  const data = (D.lens.exchange || []).map((m, i) => ({ ...m, assetId: m.id || `lens:${i}` }));
  const sent = (state.lensSent || []).map((m) => ({ ...m, assetId: `lens:sent:${m.id}` }));
  return data.concat(sent);
}
function lensHTML() {
  const L = D.lens, dev = L.device || {};
  const msgs = lensMessages();
  let firstChild = true, firstParent = true;
  const thread = msgs.map((m) => {
    let byline = '';
    if (m.from === 'child' && firstChild) { byline = `<span class="byline">${te(C.lens.fromLens)}</span>`; firstChild = false; }
    else if (m.from === 'parent' && firstParent) { byline = `<span class="byline">${te(C.lens.you)}</span>`; firstParent = false; }
    const content = m.type === 'photo'
      ? photoSlot(m.assetId, { cls: 'in-bubble', label: C.slots.lensPhoto, alt: t(m.from === 'child' ? C.lens.photoFromLens : C.lens.photoFromYou) })
      : audioPlayer(m.assetId, { compact: true, duration: m.duration, label: C.slots.lensAudio, bars: 16 });
    return `<div class="msg ${m.from} ${m.type === 'voice' ? 'voice' : 'pic'}">${byline}<div class="bubble">${content}</div><span class="time">${esc(m.time || '')}</span></div>`;
  }).join('');
  const queue = L.queue || {};
  const queueLine = queue.count ? t(C.lens.queueSome, { count: queue.count }) : C.lens.queueEmpty;
  // The device strip and swap card sit outside the scroller so auto-scroll-to-newest never hides them.
  return `<div class="head-wrap"><header class="tab-head"><h1>${esc(C.nav.lens)}</h1></header></div>
    <div class="lens-top">
      <div class="device${ui.deviceOpen ? ' open' : ''}">
        <button class="row" data-action="device" aria-expanded="${ui.deviceOpen}" aria-controls="lens-note">${I.battery}<span>${te(C.lens.strip, { name: t(dev.name || ''), battery: dev.battery == null ? '' : dev.battery, sync: dev.lastSync || '' })}</span><span class="chev">${I.chevDown}</span></button>
        <p class="note" id="lens-note"><b>${esc(queueLine)}</b>${te(queue.note || '')}</p>
      </div>
      ${L.swapPrompt ? `<div class="swap">${I.circle}<span>${te(L.swapPrompt)}</span></div>` : ''}
    </div>
    <div class="lens-scroll"><div class="thread">${thread}</div></div>
    <div class="composer">
      <button class="btn orange" data-action="send-photo">${I.photo}${esc(C.lens.sendPhoto)}</button>
      <button class="btn plum-outline" data-action="voice-memo">${I.mic}${esc(C.lens.voiceMemo)}</button>
    </div>`;
}

/* ---- Settings ---- */
function settingsHTML() {
  const S = C.settings; const mode = scaffoldMode();
  const rows = (S.rows || []).map((r) => {
    if (r.id === 'scaffold') {
      return `<div class="srow toggle"><span>${esc(r.label)}</span>
          <div class="seg" role="radiogroup" aria-label="${esc(r.label)}">
            <button data-action="scaffold" data-mode="full" class="${mode === 'full' ? 'active' : ''}" role="radio" aria-checked="${mode === 'full'}">${esc(S.scaffoldFull)}</button>
            <button data-action="scaffold" data-mode="oneMove" class="${mode === 'oneMove' ? 'active' : ''}" role="radio" aria-checked="${mode === 'oneMove'}">${esc(S.scaffoldOne)}</button>
          </div><p class="hint">${esc(S.scaffoldHint)}</p></div>`;
    }
    const val = t(r.value || '', { lensName: t((D.lens.device || {}).name || '') });
    return `<button class="srow" data-action="noop"><span>${esc(r.label)}</span><span class="val">${esc(val)}</span><span class="chev">${I.chevRight}</span></button>`;
  }).join('');
  return `<div class="head-wrap"><header class="tab-head"><h1>${esc(C.nav.settings)}</h1></header></div>
    <div class="tab-body"><div class="settings-list">${rows}</div><p class="settings-foot">${esc(S.footer)}</p></div>`;
}

/* =====================================================================
   7. Router + screen transitions
   ===================================================================== */
const mounted = { tab: null, el: null, guide: null, guideEl: null };
let depth = -1;

function parseHash() {
  const h = (location.hash || '#/wonders').replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'guide' && b && D.guides[b]) return { kind: 'guide', guideId: b };
  if (a === 'wonders') { const day = (b && dayById(b)) || todayDay(); return { kind: 'tab', tab: 'wonders', dayId: day.id, key: `wonders:${day.id}` }; }
  if (TAB_ORDER.includes(a)) return { kind: 'tab', tab: a, key: a };
  return { kind: 'tab', tab: 'wonders', dayId: todayDay().id, key: `wonders:${todayDay().id}` };
}
function renderTab(r) {
  if (r.tab === 'wonders') return wondersHTML(dayById(r.dayId) || todayDay());
  if (r.tab === 'library') return libraryHTML();
  if (r.tab === 'lens') return lensHTML();
  return settingsHTML();
}
function tabDirection(prev, next) {
  if (!prev) return null;
  if (prev.tab !== next.tab) return TAB_ORDER.indexOf(next.tab) > TAB_ORDER.indexOf(prev.tab) ? 'forward' : 'back';
  if (prev.tab === 'wonders' && prev.dayId !== next.dayId) return next.dayId < prev.dayId ? 'forward' : 'back';
  return null;
}
function scrollerOf(el) { return el.classList.contains('lens') ? ($('.lens-scroll', el) || el) : el; }

function mountTab(r, dir) {
  const stage = $('#stage');
  const old = mounted.el;
  if (old && mounted.tab) ui.scroll[mounted.tab.key] = scrollerOf(old).scrollTop;
  // Any screen that is not the one we are transitioning from is a leftover from an
  // interrupted slide: drop it now so #stage never holds more than two screens.
  $$('.screen', stage).forEach((s) => { if (s !== old) { clearTimeout(s._exit); s.remove(); } });

  const el = document.createElement('section');
  el.className = `screen tab ${r.tab}`; el.dataset.key = r.key;
  el.innerHTML = renderTab(r);
  stage.appendChild(el);
  mounted.el = el; mounted.tab = r;

  if (old) {
    if (!dir || reduceMotion()) { clearTimeout(old._exit); old.remove(); }
    else {
      el.classList.add(dir === 'forward' ? 'from-right' : 'from-left');
      el.getBoundingClientRect();
      requestAnimationFrame(() => {
        el.classList.add('anim'); el.classList.remove('from-right', 'from-left');
        old.classList.add('anim', dir === 'forward' ? 'to-left' : 'to-right');
      });
      old._exit = setTimeout(() => { old.remove(); el.classList.remove('anim'); }, 400);
    }
  }
  const fresh = ui.freshNav; ui.freshNav = false;
  afterMount(el, r, fresh);
  setNavActive(r.tab);
  $('#app').classList.toggle('on-lens', r.tab === 'lens');
}
function afterMount(el, r, fresh) {
  const sc = scrollerOf(el);
  if (r.tab === 'lens') requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
  else if (!fresh && ui.scroll[r.key] != null) sc.scrollTop = ui.scroll[r.key];
  else sc.scrollTop = 0;
  syncPlayers();
}

function setBackgroundInert(on) {
  const stage = $('#stage'), nav = $('#nav');
  [stage, nav].forEach((n) => { n.inert = on; if (on) n.setAttribute('aria-hidden', 'true'); else n.removeAttribute('aria-hidden'); });
}
function pushGuide(guideId, animate) {
  const overlay = $('#overlay');
  ui.returnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const el = document.createElement('section');
  el.className = 'screen guide'; el.dataset.guide = guideId;
  el.innerHTML = guideHTML(guideId);
  $$('.screen', overlay).forEach((s) => { clearTimeout(s._exit); s.remove(); });
  overlay.appendChild(el);
  mounted.guide = guideId; mounted.guideEl = el;
  $('#nav').classList.add('hidden-nav');
  $('#app').classList.add('on-guide');
  setBackgroundInert(true);
  if (animate && !reduceMotion()) {
    el.classList.add('from-right'); el.getBoundingClientRect();
    requestAnimationFrame(() => { el.classList.add('anim'); el.classList.remove('from-right'); });
    el._exit = setTimeout(() => el.classList.remove('anim'), 400);
  }
  const h1 = $('h1', el); if (h1) h1.focus({ preventScroll: true });
  syncPlayers();
}
function popGuide() {
  const el = mounted.guideEl;
  if (mounted.guide) ui.talkedNow.delete(mounted.guide);   // confirmation is per visit
  mounted.guide = null; mounted.guideEl = null;
  $('#nav').classList.remove('hidden-nav');
  $('#app').classList.remove('on-guide');
  setBackgroundInert(false);
  const back = ui.returnFocus; ui.returnFocus = null;
  if (back && document.contains(back)) back.focus({ preventScroll: true });
  if (!el) return;
  if (reduceMotion()) { el.remove(); return; }
  el.classList.add('anim', 'to-right');
  el._exit = setTimeout(() => el.remove(), 400);
}

function route() {
  // Track how deep we are so the Back pill knows whether there is history to pop.
  if (history.state && typeof history.state.depth === 'number') depth = history.state.depth;
  else { depth += 1; try { history.replaceState({ depth }, ''); } catch (_) {} }

  if (ui.sheet) { if (ui.sheet.phase === 'recording') stopRecording(true); else closeSheet(); }

  const r = parseHash();
  if (r.kind === 'guide') {
    const ctx = guideContext(r.guideId);
    const dayId = ctx ? ctx.day.id : todayDay().id;
    const hadTab = !!mounted.tab;
    if (!hadTab) mountTab({ kind: 'tab', tab: 'wonders', dayId, key: `wonders:${dayId}` }, null);
    if (mounted.guide !== r.guideId) pushGuide(r.guideId, hadTab);
    return;
  }
  if (mounted.guide) popGuide();
  if (!mounted.tab || mounted.tab.key !== r.key) mountTab(r, tabDirection(mounted.tab, r));
  else setNavActive(r.tab);
}
function goBack(fallback) {
  if (depth > 0) { history.back(); return; }
  // Deep-linked with nothing behind us: rewrite this entry instead of pushing a duplicate.
  try { history.replaceState({ depth: 0 }, '', fallback || '#/wonders'); } catch (_) { location.replace(fallback || '#/wonders'); }
  route();
}

// Re-render mounted screens in place (after uploads / state changes), keeping scroll.
function refresh() {
  applyState();
  const el = mounted.el;
  if (el && mounted.tab) {
    const top = scrollerOf(el).scrollTop;
    el.innerHTML = renderTab(mounted.tab);
    scrollerOf(el).scrollTop = top;
    syncPlayers();
  }
  const g = mounted.guideEl;
  if (g && mounted.guide) { const top = g.scrollTop; g.innerHTML = guideHTML(mounted.guide); g.scrollTop = top; }
  syncPlayers();
}

/* =====================================================================
   8. Sheets (round-screen preview, voice memo) + toast
   ===================================================================== */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
function renderSheet() {
  const root = $('#sheet-root'); const s = ui.sheet;
  if (!s) {
    root.innerHTML = '';
    $$('#stage, #overlay, #nav').forEach((n) => { if (!mounted.guide || (n.id !== 'stage' && n.id !== 'nav')) n.inert = false; });
    if (mounted.guide) setBackgroundInert(true);
    return;
  }
  let title = '', inner = '';
  if (s.type === 'photo-preview') {
    title = t(C.lens.sheetTitle);
    inner = `<h2 id="sheet-title">${esc(title)}</h2>
      <div class="round-preview"><img src="${s.dataUrl}" alt="" draggable="false"></div>
      <p>${te(C.lens.preview)}</p>
      <div class="stack"><button class="btn orange" data-action="sheet-send-photo">${esc(C.lens.send)}</button>
      <button class="btn text" data-action="sheet-close">${esc(C.lens.cancel)}</button></div>`;
  } else if (s.type === 'voice') {
    if (s.phase === 'recording') {
      title = t(C.lens.recording);
      inner = `<h2 id="sheet-title"><span class="rec-dot"></span>${esc(title)}</h2><p class="rec-timer">${fmtDur(s.elapsed || 0) || '0:00'}</p>
        <div class="stack"><button class="btn plum" data-action="sheet-stop">${esc(C.lens.stop)}</button>
        <button class="btn text" data-action="sheet-discard">${esc(C.lens.cancel)}</button></div>`;
    } else {
      title = t(C.lens.voiceMemo);
      const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
      const waiting = s.phase === 'requesting';
      inner = `<h2 id="sheet-title">${esc(title)}</h2>
        <div class="stack">${canRecord ? `<button class="btn plum" data-action="sheet-record"${waiting ? ' disabled' : ''}>${esc(waiting ? C.lens.waitingMic : C.lens.recordNow)}</button>` : ''}
        <button class="btn plum-outline" data-action="sheet-upload">${esc(C.lens.uploadMemo)}</button>
        <button class="btn text" data-action="sheet-close">${esc(C.lens.cancel)}</button></div>`;
    }
  }
  root.innerHTML = `<div class="scrim" data-action="sheet-close"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">${inner}</div></div>`;
  $$('#stage, #overlay, #nav').forEach((n) => { n.inert = true; });
  const first = $('.sheet .btn:not([disabled])', root); if (first) first.focus({ preventScroll: true });
}
function openSheet(s) { if (!ui.sheet) ui.returnFocus = document.activeElement; ui.sheet = s; renderSheet(); }
function closeSheet() {
  const back = ui.returnFocus;
  ui.sheet = null; rec.token += 1;   // invalidate any pending mic request
  renderSheet();
  if (!mounted.guide && back && document.contains(back)) { ui.returnFocus = null; back.focus({ preventScroll: true }); }
}

const rec = { mr: null, chunks: [], stream: null, started: 0, timer: null, token: 0, discard: false };
async function startRecording() {
  if (rec.mr && rec.mr.state === 'recording') return;
  if (ui.sheet && ui.sheet.phase === 'requesting') return;
  const token = ++rec.token;
  ui.sheet = { type: 'voice', phase: 'requesting' }; renderSheet();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (_) { if (rec.token === token) { ui.sheet = { type: 'voice', phase: 'choose' }; renderSheet(); toast(t(C.lens.micDenied)); } return; }
  // The sheet may have been cancelled while the permission prompt was up.
  if (rec.token !== token || !ui.sheet) { stream.getTracks().forEach((tr) => tr.stop()); return; }
  rec.stream = stream; rec.chunks = []; rec.discard = false;
  rec.mr = new MediaRecorder(stream);
  rec.mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.mr.onstop = async () => {
    const elapsed = (Date.now() - rec.started) / 1000;
    stream.getTracks().forEach((tr) => tr.stop());
    clearInterval(rec.timer); rec.timer = null;
    const discard = rec.discard; rec.discard = false; rec.mr = null;
    if (!discard && rec.chunks.length) {
      const blob = new Blob(rec.chunks, { type: (rec.mimeType || 'audio/webm') });
      closeSheet();
      await sendLensMessage('voice', blob, { duration: elapsed });
    } else closeSheet();
  };
  rec.mimeType = rec.mr.mimeType;
  rec.started = Date.now();
  rec.mr.start();
  ui.sheet = { type: 'voice', phase: 'recording', elapsed: 0 }; renderSheet();
  rec.timer = setInterval(() => {
    if (ui.sheet && ui.sheet.phase === 'recording') {
      ui.sheet.elapsed = (Date.now() - rec.started) / 1000;
      const tm = $('.rec-timer'); if (tm) tm.textContent = fmtDur(ui.sheet.elapsed) || '0:00';
    }
  }, 500);
}
function stopRecording(discard) {
  rec.discard = !!discard;
  if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop();
  else { clearInterval(rec.timer); rec.timer = null; if (rec.stream) rec.stream.getTracks().forEach((tr) => tr.stop()); closeSheet(); }
}

async function sendLensMessage(type, blob, extra = {}) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const msg = { id, from: 'parent', type, time: fmtTime(new Date()) };
  // Write the message alongside the asset BEFORE storing, so a crash can never leave
  // an asset with no message; a message with no asset just renders as an empty slot.
  state.lensSent = state.lensSent || []; state.lensSent.push(msg); saveState();
  try {
    const { record, durable } = await setAsset(`lens:sent:${id}`, blob, extra.duration ? { duration: extra.duration } : (extra.dataUrl ? { dataUrl: extra.dataUrl } : {}));
    if (type === 'voice') { msg.duration = fmtDur(record.duration) || ''; saveState(); }
    if (!durable) toast(t(C.slots.sessionOnly));
    else toast(t(C.lens.sent));
  } catch (err) {
    console.warn(err);
    state.lensSent = state.lensSent.filter((m) => m.id !== id); saveState();
    toast(t(C.slots.failed));
  }
  refresh();
  const sc = $('.lens-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;
}

/* =====================================================================
   9. File picking (asset slots + lens composer)
   ===================================================================== */
const fileInput = $('#file-input');
let pending = null;   // { mode: 'slot' | 'lens-photo' | 'lens-voice', id?, kind }
function openPicker(p) {
  pending = p;
  fileInput.accept = p.kind === 'photo' ? 'image/*' : 'audio/*';
  fileInput.value = '';
  fileInput.click();
}
function wrongKind(file, kind) {
  const want = kind === 'photo' ? 'image/' : 'audio/';
  return !(file.type || '').startsWith(want);
}
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  const p = pending; pending = null;
  if (!file || !p) return;
  if (wrongKind(file, p.kind)) { toast(t(p.kind === 'photo' ? C.slots.wrongPhoto : C.slots.wrongAudio)); return; }
  try {
    if (p.mode === 'slot') {
      const { durable } = await setAsset(p.id, file);
      refresh();
      if (!durable) toast(t(C.slots.sessionOnly));
    } else if (p.mode === 'lens-photo') {
      const dataUrl = await imageToDataUrl(file);      // decoded once, reused on send
      openSheet({ type: 'photo-preview', dataUrl, file });
    } else if (p.mode === 'lens-voice') {
      closeSheet();
      await sendLensMessage('voice', file);
    }
  } catch (err) { console.warn(err); toast(t(C.slots.failed)); }
});

/* =====================================================================
   10. Events (delegated)
   ===================================================================== */
const armTimers = new Map();
function armClear(btn, id, kind) {
  if (btn.classList.contains('arm')) {
    clearTimeout(armTimers.get(id)); armTimers.delete(id);
    if (player.current === id) { player.el.pause(); player.el.removeAttribute('src'); player.current = null; }
    ui.showX.delete(id);
    // Clearing a message you sent removes the message, not just its picture.
    if (id.startsWith('lens:sent:')) {
      const mid = id.slice('lens:sent:'.length);
      state.lensSent = (state.lensSent || []).filter((m) => m.id !== mid);
      saveState();
    }
    removeAsset(id).then(refresh);
    return;
  }
  ui.showX.add(id);
  const slot = btn.closest('.slot'); if (slot) slot.classList.add('show-x');
  btn.classList.add('arm'); btn.textContent = kind === 'photo' ? C.a11y.clear : C.slots.removeConfirm;
  btn.setAttribute('aria-label', t(C.a11y.confirmRemove));
  toast(t(C.slots.removeConfirm));
  clearTimeout(armTimers.get(id));
  armTimers.set(id, setTimeout(() => {
    btn.classList.remove('arm');
    btn.textContent = kind === 'photo' ? C.a11y.clear : C.slots.remove;
    btn.setAttribute('aria-label', t(kind === 'photo' ? C.a11y.removePhoto : C.slots.remove));
    ui.showX.delete(id); if (slot) slot.classList.remove('show-x');
  }, 10000));
}

// Long-press a filled photo to reveal its clear chip (spec §3).
let pressTimer = null;
document.addEventListener('pointerdown', (e) => {
  const slot = e.target.closest && e.target.closest('.slot[data-press="reveal"]');
  clearTimeout(pressTimer);
  if (!slot) return;
  pressTimer = setTimeout(() => { ui.showX.add(slot.dataset.slotId); slot.classList.add('show-x'); }, 500);
}, { passive: true });
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => document.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));

document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a[data-fresh]');
  if (link) ui.freshNav = true;
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const a = target.dataset.action;
  if (a === 'noop') return;
  e.preventDefault();
  switch (a) {
    case 'filter': {
      ui.filter[target.dataset.day] = target.dataset.filter;
      refresh();
      toast(t(C.wonders.filtered, { label: C.wonders.filters[target.dataset.filter] }));
      break;
    }
    case 'slot': openPicker({ mode: 'slot', id: target.dataset.slotId, kind: target.dataset.kind }); break;
    case 'slot-clear': e.stopPropagation(); armClear(target, target.dataset.slotId, target.dataset.kind); break;
    case 'play': togglePlay(target.dataset.slotId); break;
    case 'back': goBack(target.dataset.fallback); break;
    case 'starter': {
      const k = `${target.dataset.guide}:${target.dataset.i}`;
      if (ui.openStarters.has(k)) ui.openStarters.delete(k); else ui.openStarters.add(k);
      const open = ui.openStarters.has(k);
      target.classList.toggle('open', open); target.setAttribute('aria-expanded', String(open));
      break;
    }
    case 'another': { const g = target.dataset.guide; const n = (D.guides[g].starters || []).length; ui.starterIndex[g] = ((ui.starterIndex[g] || 0) + 1) % Math.max(1, n); refresh(); break; }
    case 'started': ui.started.add(target.dataset.guide); refresh(); break;
    case 'talked': {
      const rid = target.dataset.route;
      if (rid) markTalked(rid);
      ui.talkedNow.add(target.dataset.guide);
      refresh();
      toast(t(C.guide.talkedToast));
      break;
    }
    case 'spread': { const k = target.dataset.key; if (ui.openSpreads.has(k)) ui.openSpreads.delete(k); else ui.openSpreads.add(k); const open = ui.openSpreads.has(k); target.classList.toggle('open', open); target.setAttribute('aria-expanded', String(open)); break; }
    case 'browse': if (!ui.coming.has(target.dataset.id)) { ui.coming.add(target.dataset.id); refresh(); toast(t(C.library.comingToast)); } break;
    case 'device': { ui.deviceOpen = !ui.deviceOpen; const box = target.closest('.device'); if (box) box.classList.toggle('open', ui.deviceOpen); target.setAttribute('aria-expanded', String(ui.deviceOpen)); break; }
    case 'send-photo': openPicker({ mode: 'lens-photo', kind: 'photo' }); break;
    case 'voice-memo': openSheet({ type: 'voice', phase: 'choose' }); break;
    case 'sheet-close': if (e.target === target || target.classList.contains('btn')) { if (ui.sheet && ui.sheet.phase === 'recording') stopRecording(true); else closeSheet(); } break;
    case 'sheet-send-photo': { const s = ui.sheet; closeSheet(); if (s && s.file) sendLensMessage('photo', s.file, { dataUrl: s.dataUrl }); break; }
    case 'sheet-record': startRecording(); break;
    case 'sheet-upload': openPicker({ mode: 'lens-voice', kind: 'audio' }); break;
    case 'sheet-stop': stopRecording(false); break;
    case 'sheet-discard': stopRecording(true); break;
    case 'scaffold': state.scaffoldMode = target.dataset.mode; saveState(); refresh(); break;
    default: break;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.sheet) { if (ui.sheet.phase === 'recording') stopRecording(true); else closeSheet(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); }
});
window.addEventListener('hashchange', route);

/* =====================================================================
   11. Boot
   ===================================================================== */
(async function boot() {
  // Set only when a backend adapter script (live-data.js) is loaded ahead of this one;
  // resolves immediately otherwise, so the standalone demo boots exactly as before.
  await (window.LOCI_LIVE_READY || Promise.resolve());
  await preloadAssets();
  buildSeeds();
  applyState();
  buildNav();
  if (!location.hash) { try { history.replaceState({ depth: 0 }, '', '#/wonders'); depth = 0; } catch (_) { location.hash = '#/wonders'; } }
  route();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    const reg = () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
  }
})();

// Exposed for the demo / debugging (not used by the UI).
window.Loci = { data: D, state, ui, getAsset, setAsset, removeAsset, refresh };
})();
