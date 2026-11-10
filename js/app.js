// Regal – deine CD-Sammlung als Musik-App
// Start: Interpreten durchblättern wie früher auf dem iPod. Sammeln (Scannen, Lücken, Wünsche) im Menü.
// Alles läuft im Browser auf dem iPhone, die Daten bleiben in der App (IndexedDB).
import { db, getSetting, setSetting, getCache, setCache } from './db.js';
import * as mb from './musicbrainz.js';
import * as gemini from './gemini.js';
import * as spotify from './spotify.js';
import * as jewel from './jewel.js';
import { $, esc, norm, hue, uid, icon, toast, openSheet, closeSheet, prepareImage, sleep } from './util.js';

const APP_VERSION = '2.13.0';
const DAY = 864e5;
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
const sortName = (s) => String(s || '').replace(/^(the|die|der|das)\s+/i, '');
const today = () => new Date().toISOString().slice(0, 10);
const enc = encodeURIComponent;

const state = {
  items: [], // nur CDs
  wishes: [],
  version: 0,
  geminiKey: '',
  includeLive: false,
  gapFilter: 'all',
  albumFilter: 'all',
  listQ: {}, // Suchtext je Liste
  current: null, // Daten der gerade offenen Interpretenseite
  scan: { rows: [], busy: false, matching: false, status: '' },
  caseType: 'classic', // CD-Hülle: 'classic' (schwarzer Träger) oder 'clear'
  scratches: '0.9', // Kratzer auf dem Plastik: 0 = aus … 1.35 = stark
};

// Aussehen der CD-Hüllen anwenden
function applyLook() {
  document.body.classList.toggle('jc-clear', state.caseType === 'clear');
  document.documentElement.style.setProperty('--sk', state.scratches);
}

const view = () => $('#view');

// =====================================================================
// Schneller Zugriff: was ist schon in der Sammlung?
// =====================================================================
let indexCache = { version: -1 };

function getIndex() {
  if (indexCache.version === state.version) return indexCache;
  const byMbid = new Map();
  const byArtistTitle = new Map();
  const byKey = new Map();
  for (const it of state.items) {
    if (it.mbid) byMbid.set(it.mbid, it);
    if (it.artistMbid) byArtistTitle.set(`${it.artistMbid}|${norm(it.title)}`, it);
    byKey.set(`${norm(it.artist)}|${norm(it.title)}`, it);
  }
  indexCache = { version: state.version, byMbid, byArtistTitle, byKey };
  return indexCache;
}

const changed = () => { state.version++; };

function isDuplicate(m) {
  const idx = getIndex();
  if (m.mbid && idx.byMbid.has(m.mbid)) return true;
  return idx.byKey.has(`${norm(m.artist)}|${norm(m.title)}`);
}

// =====================================================================
// Sammlung speichern
// =====================================================================
function itemFromMatch(m, source) {
  return {
    id: uid(),
    addedAt: Date.now(),
    source,
    type: 'cd',
    kind: 'album',
    title: m.title || '',
    artist: m.artist || '',
    year: m.year || '',
    cover: m.cover || '',
    mbid: m.mbid || null,
    artistMbid: m.artistMbid || null,
    artistName: m.artistName || m.artist || '',
  };
}

async function addItems(items) {
  state.items.push(...items);
  changed();
  await db.putMany('items', items);
  for (const it of items) await removeWishFor(it);
}

async function updateItem(item) {
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item;
  changed();
  await db.put('items', item);
  await removeWishFor(item);
}

async function deleteItem(id) {
  state.items = state.items.filter((x) => x.id !== id);
  changed();
  await db.del('items', id);
}

// =====================================================================
// Wunschliste
// =====================================================================
const wishId = (o) => `mb:${o.mbid}`;
const isWished = (id) => state.wishes.some((w) => w.id === id);

async function toggleWish(w) {
  w.id = wishId(w);
  if (isWished(w.id)) {
    await removeWish(w.id);
    toast('Von der Wunschliste genommen');
  } else {
    w.addedAt = Date.now();
    state.wishes.push(w);
    await db.put('wishes', w);
    toast('Auf der Wunschliste');
  }
}

async function removeWish(id) {
  state.wishes = state.wishes.filter((x) => x.id !== id);
  await db.del('wishes', id);
}

async function removeWishFor(item) {
  if (item.mbid && isWished(`mb:${item.mbid}`)) await removeWish(`mb:${item.mbid}`);
}

// =====================================================================
// Bausteine für die Darstellung
// =====================================================================
function coverHtml(o, cls = '', extra = '') {
  return `<div class="cover ${cls}" style="--h:${hue((o.title || '') + (o.artist || ''))}">
    <span class="ph">${esc(o.title || '?')}</span>
    ${o.cover ? `<img src="${esc(o.cover)}" loading="lazy" alt="">` : ''}
    ${extra}
  </div>`;
}

const bigCover = (url) => String(url || '').replace('/front-250', '/front-500');

function albumTypeLabel(r) {
  if (r.primaryType === 'Single') return 'Single';
  if (r.primaryType === 'EP') return 'EP';
  if (r.secondaryTypes?.includes('Compilation')) return 'Best-of/Sampler';
  if (r.secondaryTypes?.includes('Live')) return 'Live';
  if (r.secondaryTypes?.includes('Soundtrack')) return 'Soundtrack';
  if (r.secondaryTypes?.includes('Demo')) return 'Demo';
  if (r.secondaryTypes?.length) return r.secondaryTypes[0];
  return r.primaryType === 'Album' ? 'Album' : (r.primaryType || '');
}

const albumsLabel = (n) => (n === 1 ? '1 Album' : `${n} Alben`);
const chev = () => icon('chevron', 16, 'cell-chev');

// Kopfzeile wie in iOS: schwebende Glas-Knöpfe oben, großer Titel darunter
function header(title, { back = false, left = '', actions = '', compact = false, center = null } = {}) {
  const leftHtml = back
    ? `<button class="glass-btn round" data-action="back" aria-label="Zurück">${icon('back', 24)}</button>`
    : left;
  return `<div class="navbar ${compact ? 'compact' : ''}">
    <div class="nav-side">${leftHtml}</div>
    <div class="nav-title">${center ?? esc(title)}</div>
    <div class="nav-side right">${actions}</div>
  </div>
  ${compact ? '' : `<h1 class="large-title">${esc(title)}</h1>`}`;
}

function setTitle(text) {
  document.querySelectorAll('.nav-title, .large-title').forEach((el) => { el.textContent = text; });
}

function progressHtml(owned, total, label) {
  const pct = total ? Math.round((owned / total) * 100) : 0;
  const done = total > 0 && owned >= total;
  return `<div class="progress-head"><span>${owned} von ${total} ${label}</span><span class="muted">${pct} %</span></div>
    <div class="bar big ${done ? 'done' : ''}"><i style="width:${pct}%"></i></div>`;
}

function searchHtml(id, placeholder) {
  return `<label class="search list-search">${icon('search', 18)}<input id="${id}" type="search" placeholder="${placeholder}" value="${esc(state.listQ[id] || '')}" autocomplete="off"></label>`;
}

function bindSearch(id, fill) {
  $(`#${id}`)?.addEventListener('input', (e) => { state.listQ[id] = e.target.value; fill(); });
}

// =====================================================================
// Interpreten (Gruppen aus der Sammlung)
// =====================================================================
function libraryGroups() {
  const map = new Map();
  for (const it of state.items) {
    const various = it.artistMbid === mb.VARIOUS_ARTISTS || /^(various artists|various|verschiedene( interpreten)?)$/i.test((it.artist || '').trim());
    let key = 'various';
    if (!various) key = it.artistMbid ? `mb:${it.artistMbid}` : `name:${norm(it.artist) || 'unbekannt'}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        various,
        mbid: various ? null : (it.artistMbid || null),
        name: various ? 'Sampler' : (it.artistName || it.artist || 'Unbekannter Interpret'),
        items: [],
      });
    }
    map.get(key).items.push(it);
  }
  return [...map.values()].sort((a, b) => (a.various - b.various) || collator.compare(sortName(a.name), sortName(b.name)));
}

const byYear = (a, b) => (a.year || '9999').localeCompare(b.year || '9999') || collator.compare(a.title, b.title);

function groupCover(g) {
  const sorted = g.items.slice().sort(byYear);
  return (sorted.find((i) => i.cover) || sorted[0])?.cover || '';
}

function groupSub(g) {
  const disco = g.mbid && discoMem.get(g.mbid)?.data;
  if (disco) {
    const p = discoProgress(g.mbid, disco);
    if (p.total) return `${p.owned} von ${p.total} Alben`;
  }
  return albumsLabel(g.items.length);
}

// =====================================================================
// Navigation
// =====================================================================
let lastPage = null;
let prevPage = null; // Seite davor (Cover Flow → zurück ins Regal)

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  return h ? h.split('/').map(decodeURIComponent) : [''];
}

function render() {
  closeSheet();
  jewel.closeBooklet();
  state.current = null;
  const r = route();
  const key = r.join('/');
  if (key !== lastPage) { window.scrollTo(0, 0); prevPage = lastPage; lastPage = key; }
  const [page, id] = r;
  if (SHELF.layer && !((page === 'flow' && SHELF.layer.dir === 'in') || (page === '' && SHELF.layer.dir === 'out'))) trCleanup();
  if (CF.sw && (page !== 'flow' || CF.sw.used)) cfSwEnd(CF.sw, false); // Wechsel zum Nachbarn unterbrochen
  document.body.classList.toggle('flow-page', page === 'flow');
  document.body.classList.toggle('shelf-page', page === '');
  if (page === '') renderShelf();
  else if (page === 'flow') renderFlow('albums', id);
  else if (page === 'menu') renderMenu();
  else if (page === 'interpreten') { if (id) renderArtistPage(id); else renderArtistList(); }
  else if (page === 'alben') renderAlbumList();
  else if (page === 'luecken') renderGaps();
  else if (page === 'wuensche') renderWishes();
  else if (page === 'scan') renderScan();
  else if (page === 'einstellungen') renderSettings();
  else location.replace('#/');
}

// =====================================================================
// 0) Startbildschirm: CD-Regal – eine Reihe pro Interpret, alle Studioalben als CD-Rücken
//    (eigene farbig, fehlende grau). Antippen öffnet den Interpreten im Cover Flow.
// =====================================================================
const SHELF = { scroll: 0, io: null, layer: null }; // layer: Ebene beim Übergang zum/vom Cover Flow

function shelfSize() {
  const el = $('#shelf');
  if (!el) return;
  const h = Math.round(Math.max(110, Math.min(150, window.innerHeight * 0.165)));
  el.style.setProperty('--spH', `${h}px`);
  el.style.setProperty('--spW', `${(h * 0.083).toFixed(1)}px`); // Rücken: 10,4 × 125 mm
}

function shelfSpine(g, e, k) {
  const label = g.various ? e.title : `${g.name} · ${e.title}`;
  return `<div class="sh-sp ${e.missing ? 'missing' : ''}" data-k="${k}"><i class="sh-pl"></i>
    <i class="sh-in" style="background-image:url('${esc(e.cover || '')}')"><span>${esc(label)}</span></i>
    <i class="sh-se"></i><i class="sh-cap t"></i><i class="sh-cap b"></i><i class="sh-gl"></i></div>`;
}

function shelfFill(el, g) {
  const list = albumEntries(g);
  el._list = list;
  el.dataset.n = String(list.length);
  el.innerHTML = `<div class="sh-head"><b>${esc(g.name)}</b><span>${esc(groupSub(g))}</span></div>
    <div class="sh-spines">${list.map((e, k) => shelfSpine(g, e, k)).join('')}</div><div class="sh-floor"></div>`;
  list.forEach((e, k) => { const sc = jewel.scanCached(entryRgid(e)); if (sc) shelfApplyScan(el.querySelector(`.sh-sp[data-k="${k}"] .sh-in`), sc); });
  if (el.dataset.seen) shelfScans(el);
}

// echte Rücken (Foto der Hüllen-Rückseite) einsetzen – eigene Alben zuerst
async function shelfScans(el) {
  const list = el._list || [];
  const order = list.map((e, k) => [e, k]).sort((a, b) => (a[0].missing ? 1 : 0) - (b[0].missing ? 1 : 0));
  for (const [e, k] of order) {
    const rgid = entryRgid(e);
    if (!rgid) continue;
    const sc = await jewel.findScan(rgid).catch(() => null);
    if (el._list !== list || !el.isConnected) return; // Reihe neu gebaut oder Seite verlassen
    shelfApplyScan(el.querySelector(`.sh-sp[data-k="${k}"] .sh-in`), sc);
  }
}

// ---------- Übergang Regal ↔ Cover Flow ----------
// Hin: die anderen Reihen weichen aus, jede CD der Reihe dreht sich aus ihrem Rücken heraus an ihren Platz im Cover Flow.
// Zurück: jede CD dreht sich wieder auf den Rücken und fliegt an ihre Stelle im Regal, dann kommen die anderen Reihen zurück.
function shelfApplyScan(inl, sc) {
  if (!inl || !sc || !(sc.ratio > 1.22)) return;
  const total = 118 * sc.ratio;
  const f = Math.min(0.065, Math.max(0.03, (total - 138) / 2 / total)); // Anteil des Rückens am Foto
  inl.style.backgroundImage = `url("${sc.small}")`;
  inl.style.backgroundSize = `${(100 / f).toFixed(1)}% 100%`;
  inl.style.backgroundPosition = '100% 50%';
  inl.parentElement.classList.add('scan');
}

// Übergang Regal ↔ Cover Flow – nahtlos und mit den CDs aus dem Regal:
// Die Seite, die man verlässt, wandert unverändert in eine Ebene (hin: HINTER den Cover Flow, zurück: DARÜBER), die neue
// Seite wird aufgebaut, während das Bild still steht – erst dann beginnt die Bewegung. Jede fliegende Hülle trägt ihren
// Rücken aus dem Regal (genaue Kopie, gleich groß, an derselben Stelle): am Anfang bzw. Ende liegt sie flach darauf und
// sieht exakt so aus wie die CD im Regal, der Rücken selbst ist in dem Moment weg – es gibt nie zwei CDs gleichzeitig.
// Während des Flugs liegen die Hüllen über allem (Kopfzeile, Titel, Leiste) und werden nicht von der Bühne abgeschnitten.
const TR = { inD: 820, outD: 620, stag: 30 };
const trDelay = (i, cur) => Math.min(6, Math.abs(i - cur)) * TR.stag;
const nextFrames = (n = 2) => new Promise((res) => { const f = () => (--n > 0 ? requestAnimationFrame(f) : res()); requestAnimationFrame(f); });
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function trLayer(kind, els) {
  const layer = document.createElement('div');
  layer.className = `tr-layer ${kind}`;
  const scrolled = document.body.classList.contains('scrolled');
  const items = els.filter(Boolean).map((el) => ({ el, r: el.getBoundingClientRect(), sl: [...el.querySelectorAll('.sh-spines')].map((x) => x.scrollLeft) }));
  for (const { el, r, sl } of items) {
    Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (el.classList.contains('navbar') && scrolled) el.classList.add('keep-bg');
    layer.appendChild(el);
    el.querySelectorAll('.sh-spines').forEach((x, k) => { x.scrollLeft = sl[k] || 0; });
  }
  document.body.appendChild(layer);
  return layer;
}
function trCleanup() {
  SHELF.layer?.el.remove();
  SHELF.layer = null;
}
const fadeTo = (el, to, opt) => el?.animate([{ opacity: to ? 0 : 1 }, { opacity: to }], { easing: 'ease-out', fill: to ? 'backwards' : 'forwards', ...opt });
const spineCenters = (row) => [...row.querySelectorAll('.sh-sp')].map((sp) => { const r = sp.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

// Regal → Cover Flow
function shelfOpen(row) {
  const shelf = $('#shelf');
  if (SHELF.layer || !shelf) return;
  SHELF.scroll = window.scrollY;
  SHELF.layer = { el: trLayer('under', [shelf, $('#view > .navbar')]), key: row.dataset.key, row, dir: 'in' };
  location.hash = `#/flow/${enc(row.dataset.key)}`;
}
async function trIn(L) {
  const { row } = L;
  const spines = [...row.querySelectorAll('.sh-sp')];
  const pts = spineCenters(row);
  const h = spines[0]?.getBoundingClientRect().height || 0;
  if (!h || !$('#cf-stage')) { trCleanup(); return; }
  const nav = $('#view > .navbar');
  const late = [$('.cf-info'), $('.cf-extra'), ...document.querySelectorAll('.cf-nb')].filter(Boolean);
  const news = [nav, ...late].filter(Boolean);
  news.forEach((el) => { el.style.opacity = '0'; }); // Anfangsbild = Regal
  cfMorphSet(pts, h, 0, spines); // die Hüllen liegen jetzt flach und deckungsgleich auf ihren Rücken
  const flies = spines.map((_, k) => !!CF.els[k]?._gh);
  await nextFrames(2); // Cover Flow ist jetzt gezeichnet – erst jetzt bewegen
  if (SHELF.layer !== L || CF.morph?.pts !== pts) { news.forEach((el) => { el.style.opacity = ''; }); return; }
  const top = row.getBoundingClientRect().top;
  L.el.querySelectorAll('.sh-row').forEach((r) => {
    if (r === row) return;
    const up = r.getBoundingClientRect().top < top;
    r.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${up ? -26 : 26}px)` }],
      { duration: 340, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
  });
  fadeTo(row.querySelector('.sh-head'), 0, { duration: 240 });
  fadeTo(row.querySelector('.sh-floor'), 0, { duration: 320 });
  fadeTo(L.el.querySelector('.navbar'), 0, { duration: 300 });
  spines.forEach((sp, k) => { if (!flies[k]) fadeTo(sp, 0, { duration: 320 }); });
  if (nav) { fadeTo(nav, 1, { duration: 360, delay: 160 }); nav.style.opacity = ''; }
  await cfMorphRun('in');
  if (SHELF.layer === L) trCleanup();
  // Titel, Leiste und Nachbarn erst, wenn alle Hüllen gelandet sind – nichts legt sich über eine fliegende CD
  late.forEach((el) => { fadeTo(el, 1, { duration: 320 }); el.style.opacity = ''; });
  cfReflow();
}

// Cover Flow → Regal
async function trOut(L, rows) {
  const target = rows.find((r) => r.dataset.key === L.key);
  const nav = $('#view > .navbar');
  const all = [nav, ...rows].filter(Boolean);
  if (!target || !$('#cf-stage')) { trCleanup(); return; }
  // Reihe des Interpreten sichtbar machen (z. B. nach dem Wechsel zu einem Nachbarn)
  const tr = target.getBoundingClientRect();
  if (tr.top < 70 || tr.bottom > window.innerHeight - 20) window.scrollTo(0, Math.max(0, window.scrollY + tr.top - window.innerHeight * 0.35));
  const spines = [...target.querySelectorAll('.sh-sp')];
  all.forEach((el) => { el.style.opacity = '0'; }); // Anfangsbild = Cover Flow (liegt darüber)
  const pts = spineCenters(target);
  const h = spines[0]?.getBoundingClientRect().height || 0;
  if (!h) { all.forEach((el) => { el.style.opacity = ''; }); trCleanup(); return; }
  cfMorphSet(pts, h, 1, spines); // Rücken der fliegenden CDs erscheinen erst, wenn ihre Hülle genau darauf gelandet ist
  const flies = spines.map((_, k) => !!CF.els[k]?._gh);
  await nextFrames(2);
  if (SHELF.layer !== L) { [...all, ...spines].forEach((el) => { el.style.opacity = ''; }); return; }
  L.el.querySelectorAll('.navbar, .cf-info, .cf-extra, .cf-nb').forEach((el) => fadeTo(el, 0, { duration: 240 }));
  const ty = target.getBoundingClientRect().top;
  rows.forEach((r) => {
    if (r === target) return;
    const up = r.getBoundingClientRect().top < ty;
    r.animate([{ opacity: 0, transform: `translateY(${up ? -26 : 26}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 420, delay: TR.outD * 0.45, easing: 'cubic-bezier(.2,0,.2,1)', fill: 'backwards' });
  });
  fadeTo(nav, 1, { duration: 320, delay: 120 });
  fadeTo(target.querySelector('.sh-head'), 1, { duration: 320, delay: TR.outD * 0.55 });
  fadeTo(target.querySelector('.sh-floor'), 1, { duration: 320, delay: TR.outD * 0.5 });
  spines.forEach((sp, k) => { if (!flies[k]) fadeTo(sp, 1, { duration: 320, delay: TR.outD * 0.5 }); });
  all.forEach((el) => { el.style.opacity = ''; });
  await cfMorphRun('out');
  spines.forEach((sp) => { sp.style.opacity = ''; });
  if (SHELF.layer === L) trCleanup();
  CF.morph = null;
}

// k pro Hülle: 0 = flach auf dem Rücken im Regal, 1 = Platz im Cover Flow.
// Jede Hülle bekommt eine Kopie ihres Regal-Rückens auf die Seite, die beim Start zur Kamera zeigt.
function cfMorphSet(pts, h, k, spines) {
  const stage = $('#cf-stage');
  if (!stage) return;
  stage.classList.add('tr-free'); // Hüllen dürfen aus der Bühne heraus und liegen über allem
  const r = stage.getBoundingClientRect();
  CF.morph = { pts, h, spines, bx: r.left + r.width / 2, by: r.top + r.height * 0.42, ks: CF.els.map(() => k) };
  CF.els.forEach((el, i) => {
    const sp = spines[i];
    if (!sp || !pts[i] || !el.dataset.built || Math.abs(i - CF.pos) > CF_WINDOW + 0.5) return;
    const w0 = sp.getBoundingClientRect().width;
    const g = sp.cloneNode(true);
    g.classList.add('cf-ghost');
    g.removeAttribute('data-k');
    g.style.cssText = `left:${(-w0 / 2).toFixed(2)}px;top:${(-h / 2).toFixed(2)}px;width:${w0}px;height:${h}px;--spW:${w0}px;--spH:${h}px;opacity:0`;
    g._side = i - CF.pos > 0.001 ? 1 : -1; // rechts zeigt der rechte Rücken nach vorn, sonst der linke
    el.appendChild(g); // hinter der Hülle im DOM – firstElementChild bleibt die Hülle
    el._gh = g;
  });
  cfLayout();
}
function cfMorphRun(dir) {
  const m = CF.morph;
  if (!m) return Promise.resolve();
  const D = dir === 'in' ? TR.inD : TR.outD;
  const cur = Math.round(CF.pos);
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2); // sanft los, sanft an
  return new Promise((res) => {
    const t0 = performance.now();
    const step = (now) => {
      if (CF.morph !== m) { res(); return; }
      const t = now - t0;
      let done = true;
      m.ks = CF.els.map((_, i) => {
        const p = clamp01((t - trDelay(i, cur)) / D);
        if (p < 1) done = false;
        return dir === 'in' ? ease(p) : 1 - ease(p);
      });
      cfLayout();
      if (!done) { requestAnimationFrame(step); return; }
      if (dir === 'in') cfMorphClear();
      res();
    };
    requestAnimationFrame(step);
  });
}
// Übergang fertig: Kopien der Rücken weg, Hüllen wieder normal, Bühne schneidet wieder ab
function cfMorphClear() {
  CF.morph = null;
  for (const el of CF.els) {
    if (el._gh) { el._gh.remove(); el._gh = null; }
    const jc = el.firstElementChild;
    if (jc?._mt) { jc._mt = ''; jc._mv = ''; jc.style.transform = ''; jc.style.transition = ''; jc.style.visibility = ''; }
  }
  $('#cf-stage')?.classList.remove('tr-free');
  cfLayout();
}

// Spiegelung erst einblenden, wenn die CD aus dem Regal heraus ist (im Regal gibt es keine)
function cfMirror(el, v) {
  if (el._mo === v) return;
  el._mo = v;
  const jc = el.firstElementChild;
  if (!jc) return;
  for (const f of (jc._mf ||= [...jc.querySelectorAll('.mirror > *')])) f.style.opacity = v;
}

function renderShelf() {
  const groups = libraryGroups();
  if (!groups.length) { renderFlow('artists'); return; } // noch keine CDs: Hinweis wie bisher
  const nav = header('', {
    compact: true,
    center: spConnected ? npNowHtml() : '',
    left: `<a class="glass-btn round" href="#/menu" aria-label="Menü">${icon('menu', 22)}</a>`,
    actions: `<button class="glass-btn round" data-action="add-menu" aria-label="CDs hinzufügen">${icon('plus', 24)}</button>`,
  });
  view().innerHTML = `${nav}
    <div class="shelf" id="shelf">${groups.map((g) => `<section class="sh-row" data-action="shelf-open" data-key="${esc(g.key)}"></section>`).join('')}</div>`;
  shelfSize();
  const rows = [...document.querySelectorAll('.sh-row')];
  rows.forEach((el, i) => shelfFill(el, groups[i]));
  if (spConnected) npTick(); // „Läuft gerade“ oben in der Kopfzeile
  // Fotos der Rücken erst laden, wenn die Reihe ins Bild kommt
  SHELF.io?.disconnect();
  SHELF.io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (!en.isIntersecting || en.target.dataset.seen) continue;
      en.target.dataset.seen = '1';
      shelfScans(en.target);
    }
  }, { rootMargin: '200px 0px' });
  rows.forEach((el) => SHELF.io.observe(el));
  if (SHELF.scroll) window.scrollTo(0, SHELF.scroll); // zurück an die Stelle, von der aus du einen Interpreten geöffnet hast
  const L = SHELF.layer;
  if (L?.dir === 'out' && !L.used) { L.used = true; trOut(L, rows); }
}

// Diskografie eingetroffen: Reihe neu aufbauen, wenn sich etwas geändert hat
function shelfRefresh(groups = libraryGroups()) {
  if (!$('#shelf')) return;
  const byKey = new Map(groups.map((g) => [g.key, g]));
  document.querySelectorAll('.sh-row').forEach((el) => {
    const g = byKey.get(el.dataset.key);
    if (!g) return;
    if (albumEntries(g).length === Number(el.dataset.n) && el.querySelector('.sh-head span')?.textContent === groupSub(g)) return;
    shelfFill(el, g);
  });
}

addEventListener('resize', shelfSize);

// =====================================================================
// 1) Durchblättern – Alben eines Interpreten (Cover Flow)
// =====================================================================
const CF = {
  level: 'artists', key: '', entries: [], els: [], pos: 0, target: 0, size: 200,
  raf: 0, shown: -1, settleTimer: 0, mem: {},
  // ausgewählt (andere Hüllen weggeglitten), Drehwinkel, umgedreht, aufgeklappt, angetippt-und-unterwegs
  focused: -1, flipDeg: 0, flipped: -1, opened: -1, openK: 0, openRaf: 0, pending: -1,
};
const CF_WINDOW = 5; // so viele Hüllen links und rechts werden gebaut
const FOCUS_SCALE = 1.22; // ausgewählte Hülle etwas größer
const clampCF = (v) => Math.max(0, Math.min(CF.entries.length - 1, v));
const isBack = (deg) => Math.abs(Math.round(deg / 180)) % 2 === 1;
const entryRgid = (e) => (e?.missing ? e.album?.mbid : e?.item?.mbid) || '';

function artistEntries() {
  return libraryGroups().map((g) => {
    const pic = artMem.get(g.key) || {};
    return { key: g.key, title: g.name, sub: groupSub(g), cover: groupCover(g), img: pic.img || '', big: pic.big || '', group: g };
  });
}

function albumEntries(g) {
  // Interpret steht jetzt unten in der Zeile (oben ist Platz für „Läuft gerade“)
  const list = g.items.map((it) => ({
    key: it.mbid || it.id, title: it.title, sub: [g.name, it.year].filter(Boolean).join(' · '), cover: it.cover, item: it, sortYear: it.year || '9999',
  }));
  const disco = g.mbid && discoMem.get(g.mbid)?.data;
  if (disco) {
    for (const a of studioAlbums(disco)) {
      if (ownedAlbum(a, g.mbid)) continue;
      list.push({ key: a.mbid, title: a.title, sub: [g.name, a.year, 'fehlt'].filter(Boolean).join(' · '), cover: a.cover, missing: true, album: a, sortYear: a.date || '9999' });
    }
  }
  return list.sort((a, b) => a.sortYear.localeCompare(b.sortYear) || collator.compare(a.title, b.title));
}

// ---------- Die CD-Hülle eines Eintrags ----------
// Rückseite ohne Foto: Titel und echte Titelliste (jeder Titel lässt sich antippen)
function cfBackGen(e, det, err) {
  const artist = state.current?.g?.name || '';
  const sp = { artist, title: e.title, sid: det?.spotify || '' };
  const tracks = (det?.discs || []).flatMap((d) => d.tracks);
  const n = tracks.length, cols = n > 9 ? 2 : 1, rows = Math.max(6, Math.ceil(n / cols));
  const list = n
    ? `<ol class="jc-tracks ${cols === 2 ? 'two' : ''}" style="--rows:${rows}">${tracks.map((t, k) => `<li data-action="sp-track" ${spData(sp)} data-track="${esc(t.title)}" data-pos="${k}"><b>${esc(t.n)}</b>${esc(t.title)}</li>`).join('')}</ol>`
    : `<p class="jc-hint">${esc(err || (det ? 'Keine Titelliste gefunden.' : 'Titel werden geladen …'))}</p>`;
  const year = e.item?.year || e.album?.year || '';
  return `<div class="bk-head"><div><small>${esc(artist)}</small><b>${esc(e.title)}</b></div></div>${list}
    <div class="bk-foot"><i class="barcode"></i><span>${year ? `℗ ${esc(year)}` : ''}</span></div>`;
}

// Knöpfe auf der Rückseite: Titelliste, Wunschliste (nur fehlende Alben), Mehr, Abspielen
function cfButtons(i, e) {
  const artist = state.current?.g?.name || '';
  const sp = { artist, title: e.title, sid: albumMem.get(entryRgid(e))?.spotify || '' };
  const wished = e.missing && isWished(`mb:${e.album.mbid}`);
  return `<button class="bk-btn list" data-action="jc-list" aria-label="Titelliste">${icon('list', 18)}</button>
    ${e.missing ? `<button class="bk-btn wish ${wished ? 'on' : ''}" data-action="cf-wish" data-i="${i}" aria-label="Wunschliste">${icon('heart', 18)}</button>` : ''}
    <button class="bk-btn more" data-action="cf-more" data-i="${i}" aria-label="Mehr">${icon('more', 18)}</button>`;
}

// Hülle erst bauen, wenn sie in die Nähe kommt (spart Speicher bei großen Sammlungen)
function cfBuild(i) {
  const el = CF.els[i];
  if (!el || el.dataset.built) return;
  const e = CF.entries[i];
  const artists = CF.level === 'artists';
  el.innerHTML = jewel.caseHtml({
    seed: i + 1,
    img: artists ? (e.big || e.img) : bigCover(e.cover),
    small: artists ? (e.img || e.big) : e.cover,
    name: e.title, // ohne Bild: Name als Schriftzug
    spine: artists ? e.title : `${state.current?.g?.name || ''} · ${e.title}`,
    backHtml: artists ? `<div class="bk-head"><div><small>${esc(e.sub)}</small><b>${esc(e.title)}</b></div></div>` : cfBackGen(e, albumMem.get(entryRgid(e)) || null),
    buttonsHtml: artists ? '' : cfButtons(i, e),
  });
  el.dataset.built = '1';
  if (artists) return;
  const rgid = entryRgid(e);
  if (!rgid) return;
  const known = jewel.scanCached(rgid);
  if (known !== undefined) { if (known) jewel.applyScan(el.firstElementChild, known); return; }
  // echte Fotos (Rückseite, Rücken, Innenseite, CD, Booklet) suchen und einsetzen
  jewel.findScan(rgid).then((sc) => {
    if (sc && CF.els[i] === el && el.dataset.built) jewel.applyScan(el.firstElementChild, sc);
  }).catch(() => {});
}
function cfTeardown(i) {
  const el = CF.els[i];
  if (!el?.dataset.built || i === CF.focused) return;
  el.innerHTML = '';
  delete el.dataset.built;
}

// Profilbild nachträglich eingetroffen: nur diese Hülle neu bauen (kein Springen)
function cfRefreshArtist(key) {
  if (CF.level !== 'artists' || !$('#cf-stage')) return;
  const i = CF.entries.findIndex((e) => e.key === key);
  if (i < 0) return;
  const pic = artMem.get(key) || {};
  if ((pic.img || '') === CF.entries[i].img) return;
  CF.entries[i].img = pic.img || '';
  CF.entries[i].big = pic.big || '';
  if (CF.els[i]?.dataset.built) { CF.els[i].innerHTML = ''; delete CF.els[i].dataset.built; }
  cfLayout();
}

function renderFlow(level, key = '') {
  const g = level === 'albums' ? libraryGroups().find((x) => x.key === key) : null;
  if (level === 'albums' && !g) { location.replace('#/'); return; }
  const entries = level === 'artists' ? artistEntries() : albumEntries(g);
  cancelAnimationFrame(CF.openRaf);
  const sw = CF.sw && !CF.sw.used && level === 'albums' ? CF.sw : null; // Wechsel vom Nachbarn im Regal
  const L = SHELF.layer;
  const fromShelf = L?.dir === 'in' && !L.used && L.key === key && level === 'albums'; // gerade im Regal angetippt
  CF.fromShelf = sw ? CF.fromShelf : prevPage === ''; // kam aus dem Regal (auch nach Wechsel zum Nachbarn)
  Object.assign(CF, { level, key, entries, shown: -1, focused: -1, flipDeg: 0, flipped: -1, opened: -1, openK: 0, pending: -1, morph: null, reflow: '' });
  if (g) state.current = { kind: 'flow', g };
  jewel.initJewel();

  // Oben in der Mitte: „Läuft gerade“ (nur wenn ein anderes Album läuft) – sonst bleibt es leer
  const center = spConnected ? npNowHtml() : '';
  const nav = level === 'artists'
    ? header('', {
      compact: true,
      center,
      left: `<a class="glass-btn round" href="#/menu" aria-label="Menü">${icon('menu', 22)}</a>`,
      actions: `<button class="glass-btn round" data-action="add-menu" aria-label="CDs hinzufügen">${icon('plus', 24)}</button>`,
    })
    : header('', {
      back: true,
      compact: true,
      center,
      actions: `<a class="glass-btn round" href="#/interpreten/${enc(g.key)}" aria-label="Als Liste">${icon('list', 22)}</a>`,
    });

  if (!entries.length) {
    view().innerHTML = `${nav}<div class="empty flow-empty">${icon('disc', 46)}
      <h2>Noch keine CDs</h2>
      <p>Fotografiere dein Regal – die App erkennt die CDs und legt sie hier ab.</p>
      <a class="btn primary" href="#/scan">${icon('camera', 20)} Regal fotografieren</a>
      <button class="btn ghost" data-action="add">${icon('search', 20)} CD suchen und hinzufügen</button></div>`;
    return;
  }

  // Nachbarn im Regal (darüber / darunter)
  const all = libraryGroups();
  const gi = all.findIndex((x) => x.key === key);
  const prevG = level === 'albums' ? all[gi - 1] : null;
  const nextG = level === 'albums' ? all[gi + 1] : null;
  view().innerHTML = `${nav}
    <div class="cf-page">
    ${prevG ? `<button class="cf-nb up" data-action="cf-artist" data-key="${esc(prevG.key)}" data-dir="-1">${icon('chevron', 13, 'cf-nb-ic')}<span>${esc(prevG.name)}</span></button>` : ''}
    <div class="cf-area">
      <div class="cf-stage with-np" id="cf-stage">
        ${entries.map((e, i) => `<div class="cf-item ${e.missing ? 'missing' : ''}" data-i="${i}" style="display:none"></div>`).join('')}
      </div>
    </div>
    <div class="cf-info">
      <div class="cf-title"><span class="cf-title-text"></span></div>
      <div class="cf-sub">${EQ}<span class="cf-sub-text"></span></div>
    </div>
    <div class="cf-extra">${level === 'albums' ? scrubHtml(entries) : ''}</div>
    ${nextG ? `<button class="cf-nb down" data-action="cf-artist" data-key="${esc(nextG.key)}" data-dir="1"><span>${esc(nextG.name)}</span>${icon('chevron', 13, 'cf-nb-ic')}</button>` : ''}
    </div>`;
  if (spConnected) npTick();
  CF.els = [...view().querySelectorAll('.cf-item')]; // nur die neue Seite (beim Wechsel liegt die alte noch daneben)
  // aus dem Regal oder vom Nachbarn: immer beim ersten Album – sonst dort weitermachen, wo man zuletzt war
  const memKey = `${level}:${key}`;
  const start = fromShelf || sw ? 0 : Math.max(0, entries.findIndex((e) => e.key === CF.mem[memKey]));
  CF.pos = start;
  CF.target = start;
  cfLayout();
  cfSettle();
  // aus dem Regal gekommen: die CDs drehen sich aus ihren Rücken heraus
  if (L?.dir === 'in' && !L.used) {
    L.used = true;
    if (fromShelf) trIn(L); else trCleanup();
  }
  // vom Nachbarn gewechselt: alte Seite gleitet hinaus, neue von unten bzw. oben herein (wie eine Seite weiterblättern)
  if (sw) { sw.used = true; cfPager(sw); }

  // Diskografie fehlt noch? Laden und fehlende Alben grau dazustellen
  if (level === 'albums' && g.mbid && !discoMem.get(g.mbid)) {
    getDisco(g.mbid).then(() => {
      if (route()[0] !== 'flow' || route()[1] !== key || CF.focused >= 0) return;
      if (CF.morph || CF.sw) { CF.reflow = key; return; } // nicht mitten in einer Animation neu aufbauen
      renderFlow('albums', key);
    }).catch(() => {});
  }
}

function cfLayout() {
  const stage = $('#cf-stage');
  if (!stage) return false;
  const sw = stage.clientWidth; // einmal lesen – nach dem Schreiben unten würde jedes Lesen das Layout neu erzwingen
  const s = Math.round(Math.min(sw * 0.44, stage.clientHeight * 0.55, 280));
  CF.size = s;
  if (stage._s !== s) { stage._s = s; stage.style.setProperty('--s', `${s}px`); } // nur bei Änderung (sonst rechnet alles neu)
  const w = s * 1.136;
  const cur = clampCF(Math.round(CF.pos));
  // Hüllen ganz außerhalb des Bildschirms gar nicht erst zeichnen: Innenkante einer schräg stehenden Hülle
  // (68°, nach hinten versetzt, Perspektive 820 px) liegt bei (0.2127 + 0.21·|d|)·w·f vom Mittelpunkt
  const f = 820 / (820 + 0.5 * s + 0.4636 * w);
  const adVis = Math.min(CF_WINDOW + 0.5, (sw / 2 / (w * f) - 0.2127) / 0.21 + 0.3);
  CF.els.forEach((el, i) => {
    const d = i - CF.pos;
    const ad = Math.abs(d);
    if (ad > CF_WINDOW + 0.5) {
      if (el.style.display !== 'none') el.style.display = 'none';
      if (ad > CF_WINDOW * 2) cfTeardown(i); // weit weg: Hülle abbauen (sonst stürzt Safari bei großen Sammlungen ab)
      return;
    }
    cfBuild(i); // schon mal bauen, auch wenn sie noch knapp außerhalb liegt
    const mo = CF.morph, gh = mo ? el._gh : null;
    const mk = gh ? mo.ks[i] : 1; // < 1: fliegt gerade zwischen Regal und Cover Flow
    if (ad > adVis && i !== CF.focused && mk >= 1) {
      if (el.style.display !== 'none') el.style.display = 'none';
      return;
    }
    if (el.style.display === 'none') el.style.display = '';
    // weich hinaus- und hereindrehen wie beim iPod: Drehung, Versatz und Tiefe folgen derselben sanften Kurve
    const e = Math.sin(Math.min(1, ad) * Math.PI / 2);
    const sg = Math.sign(d);
    let x = sg * (e * 0.4 + ad * 0.21) * w;
    let z = -e * 0.5 * s;
    // ein Album ist ausgewählt: die anderen gleiten sanft zur Seite und nach hinten weg
    if (CF.openK > 0 && i !== cur) { x += sg * CF.openK * sw * 0.9; z -= CF.openK * s * 1.2; }
    // nur schreiben, was sich wirklich ändert
    const vis = CF.openK >= 1 && i !== cur ? 'hidden' : '';
    if (el._vis !== vis) { el._vis = vis; el.style.visibility = vis; }
    let tf = `translate3d(${x.toFixed(1)}px,0,${z.toFixed(1)}px) rotateY(${(-sg * e * 68).toFixed(2)}deg)`;
    if (mk < 1) { // Übergang: vom Rücken im Regal (gleiche Stelle, gleiche Größe) zum Platz im Cover Flow
      const mp = mo.pts[i], k = mk, k0 = mo.h / s, L = (a, b) => a + (b - a) * k;
      const side = gh._side; // diese Seite der Hülle zeigt am Anfang zur Kamera
      const sc = L(k0, 1);
      // am Anfang liegt der Regal-Rücken genau auf Bildschirmtiefe 0 (keine Perspektiv-Vergrößerung = pixelgenau)
      const gz = (w / 2) * 0.002 * k0 + 0.5;
      tf = `translate3d(${L(mp.x - mo.bx, x).toFixed(2)}px,${L(mp.y - mo.by, 0).toFixed(2)}px,${L(-gz, z).toFixed(3)}px) `
        + `rotateY(${L(-side * 90, -sg * e * 68).toFixed(2)}deg)`;
      // am Anfang ganz flach (nur der Rücken) – die Tiefe wächst beim Herausdrehen. Größe und Stauchung bekommt nur die
      // Hülle; der Regal-Rücken liegt einen halben Pixel davor, ist am Anfang 1:1 (gestochen scharf wie im Regal) und
      // dreht sich mit der Hülle heraus – dann übernimmt der echte Rücken der Hülle
      const sx = Math.max(0.002, Math.min(1, k * 2.4));
      const jc = el.firstElementChild, jt = `scale3d(${(sc * sx).toFixed(4)},${sc.toFixed(4)},${sc.toFixed(4)})`;
      if (jc && jc._mt !== jt) { jc._mt = jt; jc.style.transition = 'none'; jc.style.transform = jt; }
      const gt = `translate3d(${(side * (w / 2 * sx * sc + 0.5)).toFixed(3)}px,0,0) rotateY(${side * 90}deg) scale(${(sc / k0).toFixed(4)})`;
      if (gh._tf !== gt) { gh._tf = gt; gh.style.transform = gt; }
      // ganz am Anfang/Ende (noch keinen Pixel bewegt) ist die echte CD im Regal zu sehen, die Hülle wartet unsichtbar –
      // erstes und letztes Bild sind so auf jedem Gerät exakt das Regal. Die Übergabe überlappt um ein Bild (nie leer).
      const on = k >= 0.002, spOn = k < 0.004, sp = mo.spines[i];
      if (sp && sp._on !== spOn) { sp._on = spOn; sp.style.opacity = spOn ? '' : '0'; }
      const jv = on ? '' : 'hidden';
      if (jc && jc._mv !== jv) { jc._mv = jv; jc.style.visibility = jv; }
      const go = on ? (1 - clamp01((k - 0.08) / 0.32)).toFixed(2) : '0';
      if (gh._op !== go) { gh._op = go; gh.style.opacity = go; }
      cfMirror(el, clamp01((k - 0.55) / 0.35).toFixed(2)); // Spiegelung erst kurz vor dem Ziel (im Regal gibt es keine)
    } else if (el._mo != null) cfMirror(el, '');
    if (el._tf !== tf) { el._tf = tf; el.style.transform = tf; }
    const zi = 1000 - Math.round(ad * 20);
    if (el._zi !== zi) { el._zi = zi; el.style.zIndex = String(zi); }
    jewel.light(el, d, 0, i === CF.focused);
  });
  if (cur !== CF.shown) {
    CF.shown = cur;
    const e = CF.entries[cur];
    $('.cf-title-text').textContent = e.title;
    $('.cf-sub-text').textContent = e.sub;
    if (CF.flipped >= 0 && CF.flipped !== cur) cfResetFlip(CF.flipped);
    cfScrubMark(cur);
    npUpdateView();
  }
  return true;
}

// Wenn das Blättern zur Ruhe kommt: Position merken
function cfSettle() {
  clearTimeout(CF.settleTimer);
  CF.settleTimer = setTimeout(() => {
    const e = CF.entries[Math.round(CF.pos)];
    if (e && $('#cf-stage')) CF.mem[`${CF.level}:${CF.key}`] = e.key;
  }, 350);
}

function cfAnimate() {
  cancelAnimationFrame(CF.raf);
  const step = () => {
    const diff = CF.target - CF.pos;
    if (Math.abs(diff) < 0.002) {
      CF.pos = CF.target;
      cfLayout();
      cfSettle();
      if (CF.pending === CF.target) { const p = CF.pending; CF.pending = -1; cfSelect(p); } // angetippt: jetzt steht es gerade
      return;
    }
    CF.pos += diff * 0.14;
    if (cfLayout()) CF.raf = requestAnimationFrame(step);
  };
  CF.raf = requestAnimationFrame(step);
}

function cfGo(i) {
  CF.target = clampCF(i);
  cfAnimate();
}

// ---------- Auswählen, Umdrehen, Aufklappen ----------
// Ebenen: Blättern → ausgewählt → aufgeklappt → Booklet. Tippen ins Dunkle geht immer eine Ebene zurück.
function cfTweenOpen(to) {
  cancelAnimationFrame(CF.openRaf);
  const from = CF.openK;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 700);
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    CF.openK = from + (to - from) * k;
    if (!cfLayout()) return;
    if (t < 1) CF.openRaf = requestAnimationFrame(step);
  };
  CF.openRaf = requestAnimationFrame(step);
}

function cfJcTransform(i) {
  const jc = CF.els[i]?.firstElementChild;
  const stage = $('#cf-stage');
  if (!jc || !stage) return;
  if (CF.opened === i) { // aufgeklappt: Deckel links, Unterteil rechts – beides zusammen mittig und leicht geneigt
    const w = CF.size * 1.136;
    const osc = Math.min(0.9, (stage.clientWidth * 0.96) / (2 * w));
    jc.style.transform = `translateX(${(w * 0.5 * osc).toFixed(1)}px) scale(${osc.toFixed(3)}) rotateX(14deg)`;
  } else if (CF.focused === i) jc.style.transform = `rotateY(${CF.flipDeg}deg) scale(${FOCUS_SCALE})`;
  else jc.style.transform = '';
}

function cfResetFlip(i) {
  const el = CF.els[i];
  el?.classList.remove('flipped');
  el?.firstElementChild?.classList.remove('show-list');
  if (CF.flipped === i) CF.flipped = -1;
  if (CF.focused !== i && el?.firstElementChild) el.firstElementChild.style.transform = '';
}

function cfSetFlip(i, deg) {
  CF.flipDeg = deg;
  const el = CF.els[i];
  const jc = el?.firstElementChild;
  if (!jc) return;
  if (isBack(deg)) {
    el.classList.add('flipped');
    CF.flipped = i;
    jewel.loadBigBack(jc);
    cfFillBack(i);
  } else {
    el.classList.remove('flipped');
    jc.classList.remove('show-list');
    if (CF.flipped === i) CF.flipped = -1;
  }
  cfJcTransform(i);
}

// Titelliste auf der Rückseite mit echten Daten füllen
async function cfFillBack(i) {
  if (CF.level !== 'albums') return;
  const e = CF.entries[i];
  const el = CF.els[i];
  const gen = el?.querySelector('.bk-gen');
  if (!gen || gen.dataset.filled) return;
  const rgid = entryRgid(e);
  if (!rgid) { gen.innerHTML = cfBackGen(e, null, 'Keine Titelliste – ordne das Album über „Treffer ändern“ zu.'); gen.dataset.filled = '1'; return; }
  try {
    const det = await loadAlbumDetails(rgid);
    if (CF.els[i] !== el || !el.contains(gen)) return;
    gen.innerHTML = cfBackGen(e, det);
    gen.dataset.filled = '1';
    const play = el.querySelector('.bk-btn.play');
    if (play && det?.spotify) play.dataset.sid = det.spotify;
    npUpdateView();
  } catch (err) {
    if (el.contains(gen)) gen.innerHTML = cfBackGen(e, null, err.message);
  }
}

// Antippen: erst ganz gerade nach vorne fahren, dann auswählen (Interpreten: dessen Alben öffnen)
function cfSelect(i) {
  if (Math.abs(CF.pos - i) > 0.002) { CF.target = clampCF(i); CF.pending = CF.target; cfAnimate(); return; }
  CF.pos = CF.target = i;
  cfLayout();
  if (CF.level === 'artists') { location.hash = `#/flow/${enc(CF.entries[i].key)}`; return; }
  CF.focused = i;
  CF.flipDeg = 0;
  $('.cf-page')?.classList.add('focus');
  cfBuild(i);
  cfJcTransform(i);
  cfTweenOpen(1);
  cfFillBack(i); // Titelliste schon mal laden
}

function cfUnfocus() {
  const i = CF.focused;
  if (i < 0) return;
  if (CF.opened === i) cfSetOpen(i, false);
  CF.focused = -1;
  $('.cf-page')?.classList.remove('focus');
  if (isBack(CF.flipDeg)) cfSetFlip(i, CF.flipDeg + 180); // zurück auf die Vorderseite
  CF.flipDeg = 0;
  cfJcTransform(i);
  cfTweenOpen(0);
}

function cfSetOpen(i, on) {
  const el = CF.els[i];
  if (!el) return;
  if (on) {
    if (isBack(CF.flipDeg)) { // erst auf die Vorderseite drehen, dann aufklappen
      cfSetFlip(i, CF.flipDeg + 180);
      setTimeout(() => { if (CF.focused === i && CF.opened < 0) cfSetOpen(i, true); }, 450);
      return;
    }
    el.classList.add('inner'); // Innenteile zuerst einblenden, dann aufklappen
    jewel.findScan(entryRgid(CF.entries[i])).then((sc) => jewel.ensureBook(sc, el.firstElementChild)).catch(() => {});
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
    CF.opened = i;
  } else {
    el.classList.remove('open');
    if (CF.opened === i) CF.opened = -1;
    setTimeout(() => { if (!el.classList.contains('open')) el.classList.remove('inner'); }, 1000);
  }
  cfJcTransform(i);
}

async function cfOpenBooklet(i) {
  const e = CF.entries[i];
  const sc = await jewel.findScan(entryRgid(e)).catch(() => null);
  // das Booklet im Deckel der aufgeklappten Hülle – von dort wird es herausgenommen
  const src = CF.els[i]?.querySelector('.linner .bpage');
  jewel.openBooklet(sc, bigCover(e.cover), !!e.missing, src);
}

// ---------- CD drehen: antippen = anlaufen, schnell drehen – nach 3 s öffnet sich das Album in Spotify (nur öffnen, nicht abspielen) ----------
let cdSpin = null;
const SPIN = { up: 1000, hold: 2000, down: 1300, rps: 8 }; // Anlauf, volle Drehzahl, Auslauf (ms), Umdrehungen pro Sekunde

// liegt der Finger auf der CD? (die CD liegt unter dem Rahmen, darum über ihre Lage auf dem Bildschirm prüfen)
function cfDiscHit(i, x, y) {
  const disc = CF.els[i]?.querySelector('.disc');
  if (!disc) return false;
  const r = disc.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const nx = (x - (r.left + r.width / 2)) / (r.width / 2);
  const ny = (y - (r.top + r.height / 2)) / (r.height / 2);
  return nx * nx + ny * ny <= 1;
}

function cfSpinDisc(i) {
  const disc = CF.els[i]?.querySelector('.disc');
  if (!disc || cdSpin?.playState === 'running') return;
  const base = getComputedStyle(disc).transform;
  const pre = base && base !== 'none' ? `${base} ` : '';
  // gleichmäßig schneller werden (quadratisch), volle Drehzahl halten, sanft auslaufen – ohne Ruck an den Übergängen
  const v = (SPIN.rps * 360) / 1000;
  const A = (v * SPIN.up) / 2, B = A + v * SPIN.hold, C = B + (v * SPIN.down) / 2;
  const total = SPIN.up + SPIN.hold + SPIN.down;
  const frames = (sg, p) => [
    { transform: `${p}rotate(0deg)`, offset: 0, easing: 'cubic-bezier(0.33, 0, 0.67, 0.33)' },
    { transform: `${p}rotate(${sg * A}deg)`, offset: SPIN.up / total, easing: 'linear' },
    { transform: `${p}rotate(${sg * B}deg)`, offset: (SPIN.up + SPIN.hold) / total, easing: 'cubic-bezier(0.33, 0.67, 0.67, 1)' },
    { transform: `${p}rotate(${sg * C}deg)`, offset: 1 },
  ];
  cdSpin = disc.animate(frames(1, pre), { duration: total });
  // der Lichtreflex bleibt stehen, während sich die CD darunter dreht
  try { disc.animate(frames(-1, ''), { duration: total, pseudoElement: '::after' }); } catch {}
  const e = CF.entries[i];
  const artist = state.current?.g?.name || '';
  const idP = spotifyAlbumId(artist, e.title, entryRgid(e)); // schon während des Drehens heraussuchen
  setTimeout(async () => {
    if (CF.opened !== i || !$('#cf-stage')) return; // zugeklappt oder weg: nichts öffnen
    const id = await Promise.race([idP, sleep(2500).then(() => '')]);
    if (CF.opened !== i || !$('#cf-stage')) return;
    location.href = id ? `spotify:album:${id}` : spotifyLinks(artist, e.title, '').app;
  }, SPIN.up + SPIN.hold);
}

// Spotify-ID eines Albums: von MusicBrainz, sonst (mit Verbindung) über die Spotify-Suche
async function spotifyAlbumId(artist, title, rgid) {
  let id = (rgid && albumMem.get(rgid)?.spotify) || '';
  if (!id && rgid) id = (await loadAlbumDetails(rgid).catch(() => null))?.spotify || '';
  if (!id && spConnected) id = (await spotify.findAlbum(artist, title).catch(() => '')) || '';
  return id;
}

// Cover Flow verlassen: zurück ins Regal
function cfLeave(viaBack = false) {
  if (CF.level !== 'albums' || CF.morph || SHELF.layer || CF.sw) return;
  const page = $('.cf-page');
  // Cover Flow wandert unverändert in eine Ebene ÜBER die Seite; darunter wird das Regal (erst unsichtbar) aufgebaut
  if (CF.focused < 0 && page && $('#cf-stage')) SHELF.layer = { el: trLayer('over', [page, $('#view > .navbar')]), key: CF.key, dir: 'out' };
  if ((CF.fromShelf || viaBack) && history.length > 1) history.back();
  else location.hash = '#/';
}

// ---------- Zum Nachbarn im Regal wechseln: Finger nach oben = nächster (steht im Regal darunter), nach unten = vorheriger ----------
// Die Seite folgt dem Finger. Loslassen nach genug Strecke (oder kurz geschnippt): sie gleitet weiter hinaus und die neue
// kommt von der anderen Seite herein – wie beim Weiterblättern. Die alte Seite liegt dabei als Ebene hinter der neuen.
const VSW = { dist: 56, flick: 0.35 }; // ab dieser Strecke (px) bzw. Geschwindigkeit (px/ms) wird gewechselt
const cfVNeighbor = (dy) => $(dy < 0 ? '.cf-page > .cf-nb.down' : '.cf-page > .cf-nb.up');
function cfVDrag(dy) {
  const page = $('.cf-page');
  if (!page) return;
  const nb = cfVNeighbor(dy);
  const t = nb ? dy : Math.sign(dy) * 40 * (1 - Math.exp(-Math.abs(dy) / 160)); // ohne Nachbarn nur ein kleines Federn
  page._vy = t;
  page.style.transform = `translateY(${t.toFixed(1)}px)`;
  // der Nachbar in Zugrichtung leuchtet auf, sobald Loslassen wechselt
  page.querySelectorAll('.cf-nb').forEach((b) => b.classList.toggle('ready', b === nb && Math.abs(dy) > VSW.dist));
}
function cfVEnd(dy, vy) {
  const page = $('.cf-page');
  if (!page) return;
  const nb = cfVNeighbor(dy);
  const flick = Math.abs(dy) > 14 && Math.sign(vy) === Math.sign(dy) && Math.abs(vy) > VSW.flick;
  if (nb && (Math.abs(dy) > VSW.dist || flick)) { cfSwitchArtist(nb.dataset.key, dy < 0 ? 1 : -1, vy); return; }
  page.querySelectorAll('.cf-nb.ready').forEach((b) => b.classList.remove('ready'));
  const from = page.style.transform || 'none';
  page.style.transform = '';
  page._vy = 0;
  page.animate([{ transform: from }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function cfSwitchArtist(key, dir, vy = 0) {
  const page = $('.cf-page');
  if (!page || !key || CF.morph || SHELF.layer || CF.sw || CF.focused >= 0) return;
  const from = page._vy || 0;
  page.getAnimations().forEach((a) => a.cancel());
  page.style.transform = '';
  const el = trLayer('under', [page]); // alte Seite bleibt genau so stehen (hinter der neuen)
  page.style.transform = `translateY(${from}px)`;
  CF.sw = { el, page, dir, from, vy, used: false };
  location.replace(`#/flow/${enc(key)}`);
}
async function cfPager(sw) {
  const np = $('.cf-page');
  if (!np) { cfSwEnd(sw); return; }
  const d = sw.dir;
  // Abstand der Seiten: die neue liegt anfangs ganz außerhalb des Bildschirms
  const S = window.innerHeight + Math.max(0, Math.abs(sw.from) - np.getBoundingClientRect().top) + 24;
  const o0 = sw.from, o1 = -d * S, n0 = `translateY(${(o0 + d * S).toFixed(1)}px)`, dim = 0.15;
  np.style.transform = n0;
  np.style.opacity = String(dim);
  await nextFrames(2); // neue Seite ist gezeichnet – erst jetzt bewegen
  if (CF.sw !== sw) return;
  const v = Math.abs(sw.vy || 0);
  const opt = {
    duration: Math.round(Math.max(320, Math.min(540, Math.abs(o1 - o0) / Math.max(1.5, v * 2.2)))),
    easing: v > 0.2 ? 'cubic-bezier(.2,.7,.25,1)' : 'cubic-bezier(.45,0,.2,1)', // geschnippt: gleich in Fahrt
  };
  sw.page.animate([{ transform: `translateY(${o0}px)`, opacity: 1 }, { transform: `translateY(${o1}px)`, opacity: dim }], { ...opt, fill: 'forwards' });
  const a = np.animate([{ transform: n0, opacity: dim }, { transform: 'none', opacity: 1 }], opt);
  np.style.transform = '';
  np.style.opacity = '';
  await a.finished.catch(() => {});
  cfSwEnd(sw);
}
function cfSwEnd(sw, reflow = true) {
  sw.el.remove();
  if (CF.sw === sw) CF.sw = null;
  if (reflow) cfReflow();
}
// Diskografie kam während einer Animation an: jetzt neu aufbauen (fehlende Alben grau dazu)
function cfReflow() {
  const key = CF.reflow;
  if (!key || CF.morph || CF.sw || CF.focused >= 0 || key !== CF.key || route()[0] !== 'flow' || route()[1] !== key) return;
  CF.reflow = '';
  renderFlow('albums', key);
}

// ---------- Diskografie-Leiste: ein Punkt pro Studioalbum (voll = deins, hohl = fehlt), mit dem Finger durchfahren ----------
function scrubHtml(entries) {
  const n = entries.length;
  if (n < 2) return '';
  const yr = (e) => String(e.item?.year || e.album?.year || e.sortYear || '').slice(0, 4);
  return `<div class="cf-scrub" style="--n:${n}">
    <div class="cf-scrub-track">${entries.map((e, i) => `<i class="${e.missing ? 'miss' : ''}" data-i="${i}"></i>`).join('')}</div>
    <div class="cf-scrub-years"><span>${esc(yr(entries[0]))}</span><span>${esc(yr(entries[n - 1]))}</span></div>
  </div>`;
}
function cfScrubMark(i) {
  const t = $('.cf-scrub-track');
  if (!t) return;
  t.querySelector('i.on')?.classList.remove('on');
  t.children[i]?.classList.add('on');
}
let scrub = null;
function scrubTo(x) {
  let best = 0, bd = Infinity;
  scrub.dots.forEach((cx, i) => { const dd = Math.abs(cx - x); if (dd < bd) { bd = dd; best = i; } });
  if (best !== CF.target) { CF.pending = -1; cfGo(best); }
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.cf-scrub');
  if (!el || CF.focused >= 0 || CF.morph || CF.sw) return;
  scrub = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: '', dots: [...el.querySelectorAll('.cf-scrub-track i')].map((d) => { const r = d.getBoundingClientRect(); return r.left + r.width / 2; }) };
  try { el.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', (e) => {
  if (!scrub || e.pointerId !== scrub.id) return;
  const dx = e.clientX - scrub.x, dy = e.clientY - scrub.y;
  if (!scrub.mode && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
    // senkrecht: wie überall auf der Seite zum Nachbarn wischen – waagerecht: durch die Alben fahren
    if (Math.abs(dy) > Math.abs(dx) * 1.1 && CF.level === 'albums') {
      cfDrag = { outside: true, x: scrub.x, y: scrub.y, cx: e.clientX, cy: e.clientY, moved: true, lock: 'v' };
      scrub = null;
      return;
    }
    scrub.mode = 'x';
  }
  if (scrub.mode) scrubTo(e.clientX);
});
document.addEventListener('pointerup', (e) => { if (scrub && e.pointerId === scrub.id) { if (!scrub.mode) scrubTo(e.clientX); scrub = null; } });
document.addEventListener('pointercancel', () => { scrub = null; });

// Eine Ebene zurück (ins Dunkle tippen, Escape)
function cfStepBack() {
  if (jewel.bookletOpen()) { jewel.closeBooklet(); return true; }
  if (CF.opened >= 0) { cfSetOpen(CF.opened, false); return true; }
  if (CF.focused >= 0) { cfUnfocus(); return true; }
  return false;
}

// ---------- Wischen und Tippen ----------
// Die ganze Seite hört zu, damit „ins Dunkle tippen“ überall klappt – Knöpfe, Kopfzeile und Player ausgenommen.
let cfDrag = null;
// Die Namen der Nachbarn oben/unten zählen mit: Antippen wechselt (über data-action), Wischen geht auch dort los.
const cfIgnore = (t) => !t.closest('.cf-nb') && !!t.closest('.navbar, .np, .sheet-wrap, .bv, .toasts, .cf-scrub, .tr-layer, [data-action], a, input, select, textarea, label');
document.addEventListener('pointerdown', (e) => {
  const stage = $('#cf-stage');
  if (!stage || CF.morph || CF.sw || jewel.bookletOpen() || cfIgnore(e.target)) return;
  if (CF.focused < 0 && !stage.contains(e.target)) { // Übersicht: neben der Bühne ins Dunkle tippen = zurück ins Regal
    cfDrag = { outside: true, nb: !!e.target.closest('.cf-nb'), x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, moved: false, lock: '' };
    return;
  }
  cancelAnimationFrame(CF.raf);
  cfDrag = {
    x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, pos: CF.pos, deg: CF.flipDeg, lastX: e.clientX, lastT: performance.now(), vel: 0, moved: false, lock: '',
    item: e.target.closest('.cf-item'), inJc: !!e.target.closest('.jc'), inLid: !!e.target.closest('.lidg'),
  };
  try { stage.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', (e) => {
  if (!cfDrag || !$('#cf-stage')) return;
  const dx = e.clientX - cfDrag.x;
  const dy = e.clientY - cfDrag.y;
  cfDrag.cx = e.clientX;
  cfDrag.cy = e.clientY;
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) cfDrag.moved = true;
  // Übersicht: Richtung festlegen – senkrecht = zum Nachbarn im Regal, waagerecht = blättern
  // (neben der Bühne gibt es nichts zu blättern – dort zählt fast jede Bewegung als senkrecht)
  if (CF.focused < 0 && !cfDrag.lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) cfDrag.lock = Math.abs(dy) > Math.abs(dx) * (cfDrag.outside ? 0.7 : 1.1) ? 'v' : 'h';
  if (cfDrag.lock === 'v') {
    const now = performance.now(); // Geschwindigkeit merken: kurz schnippen reicht zum Wechseln
    if (cfDrag.lastTY) cfDrag.vy = (cfDrag.vy || 0) * 0.4 + ((e.clientY - cfDrag.lastY) / Math.max(1, now - cfDrag.lastTY)) * 0.6;
    cfDrag.lastY = e.clientY;
    cfDrag.lastTY = now;
    if (CF.level === 'albums') cfVDrag(dy);
    return;
  }
  if (cfDrag.outside) return;
  if (CF.opened >= 0) return; // aufgeklappt: nichts verschieben
  if (CF.focused >= 0) { // ausgewählt: die Hülle folgt beim Umdrehen dem Finger
    if (!cfDrag.moved) return;
    const jc = CF.els[CF.focused]?.firstElementChild;
    if (!jc) return;
    jc.style.transition = 'none';
    jc.style.transform = `rotateY(${(cfDrag.deg + dx * 0.6).toFixed(1)}deg) scale(${FOCUS_SCALE})`;
    return;
  }
  if (cfDrag.lock !== 'h') return;
  const spacing = CF.size * 0.3;
  CF.pos = Math.max(-0.4, Math.min(CF.entries.length - 0.6, cfDrag.pos - dx / spacing));
  const now = performance.now();
  const dt = Math.max(1, now - cfDrag.lastT);
  cfDrag.vel = cfDrag.vel * 0.6 + (-(e.clientX - cfDrag.lastX) / spacing / dt * 1000) * 0.4;
  cfDrag.lastX = e.clientX;
  cfDrag.lastT = now;
  cfQueueLayout();
});
// höchstens einmal pro Bild neu anordnen (manche Geräte melden Fingerbewegungen öfter)
let cfMoveRaf = 0;
function cfQueueLayout() {
  if (cfMoveRaf) return;
  cfMoveRaf = requestAnimationFrame(() => { cfMoveRaf = 0; cfLayout(); });
}
const cfEnd = () => {
  if (!cfDrag) return;
  const d = cfDrag;
  cfDrag = null;
  if (!$('#cf-stage')) return;
  const tap = !d.moved;
  if (d.lock === 'v') { if (CF.level === 'albums') cfVEnd(d.cy - d.y, performance.now() - (d.lastTY || 0) > 90 ? 0 : d.vy || 0); return; }
  if (d.outside) { if (tap && CF.focused < 0 && !d.nb) cfLeave(); return; } // Name eines Nachbarn angetippt: der wechselt selbst
  if (CF.opened >= 0) { // aufgeklappt: Booklet antippen = lesen, CD antippen = drehen und abspielen, ins Dunkle = zuklappen
    if (tap) {
      if (d.inLid) cfOpenBooklet(CF.opened);
      else if (cfDiscHit(CF.opened, d.x, d.y)) cfSpinDisc(CF.opened);
      else if (!d.inJc) cfSetOpen(CF.opened, false);
    }
    return;
  }
  if (CF.focused >= 0) {
    const i = CF.focused;
    const jc = CF.els[i]?.firstElementChild;
    if (jc) jc.style.transition = '';
    if (tap) { if (d.inJc) cfSetOpen(i, true); else cfUnfocus(); return; }
    // Wischen: über die Hälfte gedreht oder kräftig gewischt → umdrehen (in Wischrichtung), sonst zurückfedern
    const dx = d.cx - d.x;
    let to = Math.round((d.deg + dx * 0.6) / 180) * 180;
    if (to === d.deg && Math.abs(dx) > 40) to = d.deg + Math.sign(dx) * 180;
    cfSetFlip(i, to);
    return;
  }
  if (tap) {
    if (d.item) cfSelect(Number(d.item.dataset.i));
    else if (Math.abs(CF.pos - Math.round(CF.pos)) > 0.002) cfGo(Math.round(CF.pos)); // daneben getippt: sauber einrasten
    else cfLeave(); // ins Dunkle getippt: zurück ins Regal
    return;
  }
  CF.pending = -1;
  cfGo(Math.round(CF.pos + Math.max(-8, Math.min(8, d.vel * 0.22))));
};
document.addEventListener('pointerup', cfEnd);
// abgebrochene Berührung (z. B. Systemgeste) zählt nicht als Tippen
document.addEventListener('pointercancel', () => { if (cfDrag) { cfDrag.moved = true; cfEnd(); } });

window.addEventListener('resize', () => {
  if (!$('#cf-stage')) return;
  cfLayout();
  if (CF.focused >= 0) cfJcTransform(CF.focused);
});
document.addEventListener('keydown', (e) => {
  if (!$('#cf-stage') || document.activeElement?.tagName === 'INPUT') return;
  if (e.key === 'Escape') { if (!cfStepBack()) cfLeave(); return; }
  if (CF.focused >= 0) return;
  if (e.key === 'ArrowRight') cfGo(Math.round(CF.target) + 1);
  if (e.key === 'ArrowLeft') cfGo(Math.round(CF.target) - 1);
  if (e.key === 'Enter') cfSelect(Math.round(CF.target));
});

function openAddMenu() {
  openSheet(`<h2>Hinzufügen</h2>
    <div class="group sheet-group">
      <a class="cell" href="#/scan"><span class="cell-ic">${icon('camera', 18)}</span><span class="cell-label">Regal fotografieren</span>${state.scan.rows.length ? '<span class="cell-value">Prüfliste offen</span>' : ''}${chev()}</a>
      <button class="cell action" data-action="add"><span class="cell-ic">${icon('search', 18)}</span><span class="cell-label">CD suchen und hinzufügen</span>${chev()}</button>
    </div>`);
}

// =====================================================================
// 2) Menü (wie das Hauptmenü des iPod)
// =====================================================================
function renderMenu() {
  const cellIc = (name) => `<span class="cell-ic">${icon(name, 18)}</span>`;
  const groups = libraryGroups();
  view().innerHTML = `${header('Regal', { back: true })}
    <div class="group">
      <a class="cell" href="#/">${cellIc('flow')}<span class="cell-label">Regal</span>${chev()}</a>
      <a class="cell" href="#/interpreten">${cellIc('user')}<span class="cell-label">Interpreten</span><span class="cell-value">${groups.length}</span>${chev()}</a>
      <a class="cell" href="#/alben">${cellIc('disc')}<span class="cell-label">Alben</span><span class="cell-value">${state.items.length}</span>${chev()}</a>
    </div>
    <h3 class="group-title">Sammeln</h3>
    <div class="group">
      <a class="cell" href="#/luecken">${cellIc('checklist')}<span class="cell-label">Lücken</span>${chev()}</a>
      <a class="cell" href="#/wuensche">${cellIc('heart')}<span class="cell-label">Wunschliste</span><span class="cell-value">${state.wishes.length || ''}</span>${chev()}</a>
    </div>
    <h3 class="group-title">Hinzufügen</h3>
    <div class="group">
      <a class="cell" href="#/scan">${cellIc('camera')}<span class="cell-label">Regal fotografieren</span>${state.scan.rows.length ? '<span class="cell-value">Prüfliste offen</span>' : ''}${chev()}</a>
      <button class="cell action" data-action="add">${cellIc('search')}<span class="cell-label">CD suchen und hinzufügen</span>${chev()}</button>
    </div>
    <div class="group">
      <a class="cell" href="#/einstellungen">${cellIc('settings')}<span class="cell-label">Einstellungen</span>${chev()}</a>
    </div>`;
}

// =====================================================================
// 3) Listen: Interpreten, Alben, Interpretenseite
// =====================================================================
function renderArtistList() {
  view().innerHTML = `${header('Interpreten', { back: true })}
    ${searchHtml('q-artists', 'Interpret suchen')}
    <div id="artist-list"></div>`;
  bindSearch('q-artists', fillArtistList);
  fillArtistList();
}

function fillArtistList() {
  const box = $('#artist-list');
  if (!box) return;
  const groups = libraryGroups();
  if (!groups.length) { box.innerHTML = '<p class="empty-small">Noch keine CDs in der Sammlung.</p>'; return; }
  const q = norm(state.listQ['q-artists']);
  const shown = q ? groups.filter((g) => norm(g.name).includes(q) || g.items.some((i) => norm(i.title).includes(q))) : groups;
  box.innerHTML = shown.length
    ? `<div class="list">${shown.map((g) => `<a class="lrow" href="#/interpreten/${enc(g.key)}">
        ${artistThumbHtml(g)}
        <span class="row-text"><span class="row-title">${esc(g.name)}</span><span class="row-sub">${esc(groupSub(g))}</span></span>
        ${chev()}</a>`).join('')}</div>`
    : `<p class="empty-small">Nichts gefunden.</p>`;
}

function renderAlbumList() {
  view().innerHTML = `${header('Alben', { back: true })}
    ${searchHtml('q-albums', 'Album oder Interpret')}
    <div id="album-list"></div>`;
  bindSearch('q-albums', fillAlbumList);
  fillAlbumList();
}

function albumRow(it) {
  return `<button class="lrow" data-action="item" data-id="${it.id}">
    ${coverHtml(it, 'thumb')}
    <span class="row-text"><span class="row-title">${esc(it.title)}</span><span class="row-sub">${esc([it.artist, it.year].filter(Boolean).join(' · '))}</span></span>
    ${chev()}</button>`;
}

function fillAlbumList() {
  const box = $('#album-list');
  if (!box) return;
  if (!state.items.length) { box.innerHTML = '<p class="empty-small">Noch keine CDs in der Sammlung.</p>'; return; }
  const q = norm(state.listQ['q-albums']);
  const list = state.items.filter((i) => !q || norm(`${i.title} ${i.artist}`).includes(q))
    .sort((a, b) => collator.compare(sortName(a.title), sortName(b.title)));
  box.innerHTML = list.length ? `<div class="list">${list.map(albumRow).join('')}</div>` : '<p class="empty-small">Nichts gefunden.</p>';
}

// Interpret: alle Studioalben – eigene normal, fehlende grau
async function renderArtistPage(key) {
  const g = libraryGroups().find((x) => x.key === key);
  view().innerHTML = `${header(g?.name || 'Interpret', {
    back: true,
    actions: g ? `<a class="glass-btn round" href="#/flow/${enc(key)}" aria-label="Durchblättern">${icon('flow', 22)}</a>` : '',
  })}
    <div id="detail-body"><p class="hint"><span class="spinner small"></span> Lade alle Alben …</p></div>`;
  if (!g) { $('#detail-body').innerHTML = '<p class="empty-small">Hier ist nichts mehr.</p>'; return; }
  if (!g.mbid) {
    $('#detail-body').innerHTML = `
      ${g.various ? '' : '<p class="hint">Für diesen Interpreten gibt es noch keinen Datenbank-Treffer. Tippe ein Album an → „Treffer ändern“ – dann siehst du hier auch alle Alben, die dir noch fehlen.</p>'}
      <div class="list">${g.items.slice().sort(byYear).map(albumRow).join('')}</div>`;
    return;
  }
  let disco;
  try {
    disco = await getDisco(g.mbid);
  } catch (e) {
    if (route()[1] === key && $('#detail-body')) {
      $('#detail-body').innerHTML = `<p class="hint error">${esc(e.message)}</p>
        <div class="list">${g.items.slice().sort(byYear).map(albumRow).join('')}</div>`;
    }
    return;
  }
  if (route()[1] !== key || !$('#detail-body')) return;
  state.current = { kind: 'artist', key, mbid: g.mbid, disco };
  fillArtist();
}

function fillArtist() {
  const { mbid, disco, key } = state.current;
  const g = libraryGroups().find((x) => x.key === key) || { key, mbid, name: '', items: [] };
  state.current.g = g;
  const list = studioAlbums(disco).map((a) => ({ a, item: ownedAlbum(a, mbid) }));
  const owned = list.filter((x) => x.item).length;
  const shown = state.albumFilter === 'missing' ? list.filter((x) => !x.item) : list;
  const counted = new Set(list.filter((x) => x.item).map((x) => x.item.id));
  const others = g.items.filter((i) => !counted.has(i.id));
  $('#detail-body').innerHTML = `
    ${progressHtml(owned, list.length, state.includeLive ? 'Alben' : 'Studioalben')}
    <div class="chips">
      <button class="chip ${state.albumFilter === 'all' ? 'on' : ''}" data-action="album-filter" data-f="all">Alle</button>
      <button class="chip ${state.albumFilter === 'missing' ? 'on' : ''}" data-action="album-filter" data-f="missing">Fehlende</button>
      <button class="chip ${state.includeLive ? 'on' : ''}" data-action="toggle-live">${state.includeLive ? `${icon('check', 14)} ` : '+ '}Live-Alben</button>
    </div>
    ${shown.length ? `<div class="list">${shown.map(({ a, item }) => (item
    ? `<button class="lrow" data-action="item" data-id="${item.id}">
        ${coverHtml({ title: a.title, artist: g.name, cover: item.cover || a.cover }, 'thumb')}
        <span class="row-text"><span class="row-title">${esc(a.title)}</span><span class="row-sub">${esc(a.year)}</span></span>${chev()}</button>`
    : `<div class="lrow missing">
        <button class="lrow-hit" data-action="missing-album" data-key="${a.mbid}">
          ${coverHtml({ title: a.title, artist: g.name, cover: a.cover }, 'thumb')}
          <span class="row-text"><span class="row-title">${esc(a.title)}</span><span class="row-sub">${esc([a.year, 'fehlt'].filter(Boolean).join(' · '))}</span></span>
        </button>
        <button class="heart-btn ${isWished(`mb:${a.mbid}`) ? 'on' : ''}" data-action="wish-album" data-key="${a.mbid}" aria-label="Wunschliste">${icon('heart', 20)}</button>
      </div>`)).join('')}</div>`
    : `<p class="empty-small">${list.length ? 'Du hast alle – Glückwunsch!' : 'MusicBrainz kennt keine Studioalben von diesem Interpreten.'}</p>`}
    ${others.length ? `<h3 class="group-title">Weitere CDs</h3><div class="list">${others.slice().sort(byYear).map(albumRow).join('')}</div>
      <p class="group-footer">Best-ofs, Live-Alben, Singles oder EPs – zählen nicht zu den Studioalben.</p>` : ''}
    <p class="tiny">Daten: MusicBrainz</p>`;
}

// =====================================================================
// Album-Blatt: Cover, Spotify, Titelliste
// =====================================================================
function showItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  const g = libraryGroups().find((x) => x.items.includes(it));
  const onThisArtist = state.current?.g?.key === g?.key;
  const sheet = openSheet(`<div class="detail">
    ${coverHtml({ ...it, cover: bigCover(it.cover) }, 'big')}
    <h2>${esc(it.title)}</h2>
    <p class="muted">${esc([it.artist, it.year].filter(Boolean).join(' · '))}</p>
    ${!it.mbid ? '<p class="hint">Ohne Datenbank-Treffer gespeichert. Mit „Treffer ändern“ findest du Cover und Titel.</p>' : ''}
    ${albumSectionHtml()}
    <div class="group sheet-group">
      ${g && !g.various && !onThisArtist ? `<a class="cell" href="#/interpreten/${enc(g.key)}"><span class="cell-label">Alle Alben von ${esc(g.name)}</span>${chev()}</a>` : ''}
      <button class="cell action" data-action="rematch" data-id="${it.id}"><span class="cell-label">Treffer ändern</span>${chev()}</button>
      <button class="cell action danger" data-action="delete" data-id="${it.id}"><span class="cell-label">Aus der Sammlung löschen</span></button>
    </div>
    <p class="tiny">Hinzugefügt am ${new Date(it.addedAt).toLocaleDateString('de-DE')}${it.source === 'foto' ? ' per Foto' : ''}</p>
  </div>`);
  fillAlbumSection(sheet, it);
}

const albumMem = new Map();

async function loadAlbumDetails(mbid) {
  if (!mbid) return null;
  if (albumMem.has(mbid)) return albumMem.get(mbid);
  const c = await getCache(`mb:album:${mbid}`);
  if (c && Date.now() - c.at < 90 * DAY) { albumMem.set(mbid, c.data); return c.data; }
  try {
    const d = await mb.albumDetails(mbid);
    await setCache(`mb:album:${mbid}`, d);
    albumMem.set(mbid, d);
    return d;
  } catch (e) {
    if (c) return c.data;
    throw e;
  }
}

// Direkt zum Album, wenn MusicBrainz den Spotify-Link kennt – sonst Spotify-Suche
function spotifyLinks(artist, title, spotifyId) {
  const q = enc(`${artist || ''} ${title || ''}`.trim());
  return spotifyId
    ? { exact: true, app: `spotify:album:${spotifyId}`, web: `https://open.spotify.com/album/${spotifyId}` }
    : { exact: false, app: `spotify:search:${q}`, web: `https://open.spotify.com/search/${q}` };
}

const fmtDur = (ms) => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Album-Infos für die Spotify-Knöpfe als data-Attribute
const spData = (sp) => `data-artist="${esc(sp.artist)}" data-title="${esc(sp.title)}" data-sid="${esc(sp.sid || '')}"`;

// Titelliste – jeder Titel lässt sich antippen und startet ab dort (mit Spotify-Verbindung)
function tracksHtml(det, sp) {
  const discs = det?.discs || [];
  const all = discs.flatMap((d) => d.tracks);
  if (!all.length) return '<p class="hint">Keine Titelliste gefunden.</p>';
  const multi = discs.length > 1;
  const total = all.reduce((s, t) => s + (t.ms || 0), 0);
  let pos = 0;
  return discs.map((d) => `
    ${multi ? `<h4 class="disc-title">CD ${d.n}${d.title ? ` – ${esc(d.title)}` : ''}</h4>` : ''}
    <ol class="tracks">${d.tracks.map((t) => `<li data-action="sp-track" ${spData(sp)} data-track="${esc(t.title)}" data-pos="${pos++}">
      <span class="tn"><b>${esc(t.n)}</b>${EQ}</span><span class="tt">${esc(t.title)}</span><span class="td">${fmtDur(t.ms)}</span></li>`).join('')}</ol>`).join('')
    + `<p class="tracks-foot">${all.length} Titel${total ? `, ${Math.round(total / 60000)} Minuten` : ''}</p>`;
}

// Abspielen: mit Spotify-Verbindung im Hintergrund (Spotify Connect), sonst die Spotify-App öffnen
let spConnected = false;

// ---------- Mini-Player im Blätter-Bildschirm: Play/Pause, vor, zurück ----------
// „Läuft gerade“ steht nur da, wenn du bei einem anderen Album/Interpreten bist.
// Ist das Album in der Mitte das laufende, zeigen kleine Equalizer-Balken das dezent an.
let npTimer = 0;
let npPlaying = false;
let npNow = null; // { albumId, album, artists, artistIds, track, img }

// Drei kleine Balken wie bei Apple Music (bewegen sich nur, während Musik läuft)
const EQ = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';

// „Läuft gerade“-Kapsel: sitzt oben in der Kopfzeile, damit sie nichts verdeckt und nichts verschiebt
function npNowHtml() {
  return `<button class="np-now glass" data-action="np-goto" hidden>
    <img alt="" hidden><span class="np-now-text"></span>${EQ}
  </button>`;
}

function npShow(st) {
  const t = st?.item;
  npNow = t ? {
    albumId: t.album?.id || '',
    album: t.album?.name || '',
    artists: (t.artists || []).map((a) => a.name),
    artistIds: (t.artists || []).map((a) => a.id),
    track: t.name || '',
    img: ((t.album?.images || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0)).find((p) => (p.width || 0) >= 64) || {}).url || '',
  } : null;
  npSetPlaying(!!st?.is_playing);
  npUpdateView();
}

function npSetPlaying(playing) {
  npPlaying = playing;
  document.body.classList.toggle('np-paused', !playing);
}

// Spielt gerade dieses Album / dieser Interpret?
const normTrack = (s) => norm(String(s || '').replace(/\s+-\s+.*(remaster|version|live|edit|mix|mono|stereo|demo).*$/i, ''));

function isPlayingArtist(g) {
  if (!npNow || !g) return false;
  const id = artMem.get(g.key)?.id;
  return (id && npNow.artistIds.includes(id)) || npNow.artists.some((a) => norm(a) === norm(g.name));
}

function isPlayingAlbum(title, artist, spotifyId = '') {
  if (!npNow) return false;
  if (spotifyId && spotifyId === npNow.albumId) return true;
  return norm(title) === norm(npNow.album) && npNow.artists.some((a) => norm(a) === norm(artist));
}

function entryIsPlaying(e) {
  if (!e) return false;
  if (CF.level === 'artists') return isPlayingArtist(e.group);
  const mbid = e.missing ? e.album.mbid : e.item?.mbid;
  return isPlayingAlbum(e.title, state.current?.g?.name, mbid && albumMem.get(mbid)?.spotify);
}

// Anzeige auffrischen: laufender Song unter dem Cover, „Läuft gerade“-Kapsel, laufender Titel in Listen
function npUpdateView() {
  const e = CF.entries[CF.shown];
  const here = npNow && $('#cf-stage') && entryIsPlaying(e);
  // Steht das laufende Album/der laufende Interpret in der Mitte: Song (mit Balken) statt Jahr/Anzahl
  const sub = $('.cf-sub');
  if (sub && e) {
    sub.classList.toggle('playing', !!here);
    sub.querySelector('.cf-sub-text').textContent = here
      ? (CF.level === 'artists' ? `${npNow.track} · ${npNow.album}` : npNow.track)
      : e.sub;
  }
  const pill = $('.np-now');
  if (pill) {
    pill.hidden = !npNow || !!here;
    if (npNow) {
      pill.querySelector('.np-now-text').textContent = `${npNow.track} · ${npNow.artists[0] || ''}`;
      const img = pill.querySelector('img');
      if (npNow.img) { if (img.getAttribute('src') !== npNow.img) img.src = npNow.img; img.hidden = false; } else img.hidden = true;
    }
  }
  // Titellisten (umgedrehtes Album, Album-Blatt): laufenden Titel markieren
  document.querySelectorAll('.tracks li[data-track], .jc-tracks li[data-track]').forEach((li) => {
    const on = !!npNow && isPlayingAlbum(li.dataset.title, li.dataset.artist, li.dataset.sid)
      && normTrack(li.dataset.track) === normTrack(npNow.track);
    li.classList.toggle('playing', on);
  });
}

// „Läuft gerade“ antippen: zum laufenden Album springen
function npGoto() {
  if (!npNow) return;
  const g = libraryGroups().find((x) => isPlayingArtist(x));
  if (!g) { toast('Dieses Album ist nicht in deiner Sammlung.'); return; }
  if (CF.level === 'albums' && CF.key === g.key) {
    const i = CF.entries.findIndex((e) => entryIsPlaying(e));
    if (i >= 0) cfGo(i);
    return;
  }
  const target = albumEntries(g).find((e) => isPlayingAlbum(e.title, g.name, albumMem.get(e.missing ? e.album.mbid : e.item?.mbid)?.spotify));
  if (target) CF.mem[`albums:${g.key}`] = target.key;
  location.hash = `#/flow/${enc(g.key)}`;
}

// Alle 5 Sekunden nachsehen, solange der Blätter-Bildschirm sichtbar ist
async function npTick() {
  clearTimeout(npTimer);
  if (!spConnected || !$('.np-now')) return; // nur solange „Läuft gerade“ oben zu sehen ist
  if (document.visibilityState === 'visible') {
    try { npShow(await spotify.playerState()); } catch { npShow(null); }
  }
  npTimer = setTimeout(npTick, 5000);
}

async function spotifyPlay({ artist, title, sid, track = '', pos = -1 }) {
  if (!spConnected) {
    location.href = spotifyLinks(artist, title, sid).app;
    return;
  }
  toast(track ? `„${track}“ wird gestartet …` : 'Wird gestartet …');
  let albumId = sid;
  try {
    if (!albumId) albumId = await spotify.findAlbum(artist, title);
    if (!albumId) throw new Error('Das Album wurde bei Spotify nicht gefunden.');
    let offset;
    if (track) {
      try {
        const list = await spotify.albumTracks(albumId);
        const t = list.find((x) => norm(x.name) === norm(track)) || list.find((x) => norm(x.name).startsWith(norm(track)));
        offset = t ? { uri: t.uri } : { position: Math.max(0, pos) };
      } catch {
        offset = { position: Math.max(0, pos) };
      }
    }
    const device = await spotify.pickDevice();
    if (!device) {
      toast('Spotify läuft gerade nicht – die App wird geöffnet.');
      location.href = `spotify:album:${albumId}`;
      return;
    }
    await spotify.play({ deviceId: device.id, contextUri: `spotify:album:${albumId}`, offset });
    toast(`Läuft auf ${device.name}`);
    setTimeout(npTick, 900);
  } catch (e) {
    if (e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404) {
      toast('Spotify läuft gerade nicht – die App wird geöffnet.');
      location.href = albumId ? `spotify:album:${albumId}` : spotifyLinks(artist, title, '').app;
      return;
    }
    if (e instanceof spotify.NotConnected) spConnected = false;
    toast(e.message, 'error');
  }
}

function albumSectionHtml() {
  return `<div class="album-extra">
    <div class="album-actions"></div>
    <div class="tracks-box"><p class="hint"><span class="spinner small"></span> Titelliste wird geladen …</p></div>
  </div>`;
}

async function fillAlbumSection(root, a) {
  const actions = root.querySelector('.album-actions');
  const box = root.querySelector('.tracks-box');
  if (!actions || !box) return;
  const showLinks = (spotifyId) => {
    const l = spotifyLinks(a.artist, a.title, spotifyId);
    const sp = { artist: a.artist, title: a.title, sid: spotifyId || '' };
    actions.innerHTML = `<button class="btn primary" data-action="sp-play" ${spData(sp)}>${icon('play', 18)} ${spConnected ? 'Abspielen' : 'In Spotify öffnen'}</button>
      ${spConnected
    ? '<span class="sub-link">Spielt über Spotify im Hintergrund · Titel antippen startet ab dort</span>'
    : `<a class="sub-link" href="${esc(l.web)}" target="_blank" rel="noopener">${l.exact ? 'Spotify im Browser öffnen' : 'Kein direkter Link – öffnet die Spotify-Suche'}</a>`}`;
  };
  showLinks(null);
  if (!a.mbid) { box.innerHTML = '<p class="hint">Keine Titelliste – ordne das Album über „Treffer ändern“ zu.</p>'; return; }
  try {
    const det = await loadAlbumDetails(a.mbid);
    if (!root.isConnected) return;
    showLinks(det?.spotify);
    box.innerHTML = tracksHtml(det, { artist: a.artist, title: a.title, sid: det?.spotify || '' });
    npUpdateView();
  } catch (e) {
    if (root.isConnected) box.innerHTML = `<p class="hint error">${esc(e.message)}</p>`;
  }
}

function showMissing(a, g) {
  const wished = isWished(`mb:${a.mbid}`);
  const sheet = openSheet(`<div class="detail">
    ${coverHtml({ title: a.title, artist: g.name, cover: bigCover(a.cover) }, 'big')}
    <h2>${esc(a.title)}</h2>
    <p class="muted">${esc([g.name, a.year, 'fehlt dir noch'].filter(Boolean).join(' · '))}</p>
    ${albumSectionHtml()}
    <div class="group sheet-group">
      <button class="cell action" data-action="wish-album" data-key="${a.mbid}"><span class="cell-label">${wished ? 'Von der Wunschliste nehmen' : 'Auf die Wunschliste'}</span>${icon('heart', 18, 'cell-chev')}</button>
      <button class="cell action" data-action="own-album" data-key="${a.mbid}"><span class="cell-label">Hab ich doch – zur Sammlung</span>${icon('check', 18, 'cell-chev')}</button>
    </div>
  </div>`);
  fillAlbumSection(sheet, { mbid: a.mbid, artist: g.name, title: a.title });
}

function rematchItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  openSearch({
    heading: 'Treffer ändern',
    artist: it.artist,
    title: it.title,
    onPick: async (m) => {
      const fresh = itemFromMatch(m, it.source);
      fresh.id = it.id;
      fresh.addedAt = it.addedAt;
      await updateItem(fresh);
      toast('Gespeichert');
      render();
      preloadDiscographies();
    },
  });
}

function openAdd() {
  openSearch({
    heading: 'CD hinzufügen',
    onPick: async (m) => {
      if (isDuplicate(m) && !confirm('Das ist schon in deiner Sammlung. Trotzdem nochmal hinzufügen?')) return;
      const it = itemFromMatch(m, 'hand');
      await addItems([it]);
      toast(`„${it.title}“ hinzugefügt`);
      render();
      preloadDiscographies();
      preloadArtistArt();
    },
  });
}

// Suchblatt: für „CD hinzufügen“, „Treffer ändern“ und „Eintrag korrigieren“
function openSearch({ heading, artist = '', title = '', onPick, extraHtml = '', onExtra = null }) {
  let results = [];
  const sheet = openSheet(`
    <h2>${esc(heading)}</h2>
    <form class="form" id="s-form">
      <input id="s-artist" placeholder="Interpret" value="${esc(artist)}" autocomplete="off">
      <input id="s-title" placeholder="Albumtitel" value="${esc(title)}" autocomplete="off">
      <button class="btn primary" type="submit">${icon('search', 20)} Suchen</button>
    </form>
    <div id="s-results" class="results"></div>
    <button class="btn ghost" type="button" id="s-raw">Ohne Treffer übernehmen</button>
    ${extraHtml}`);
  const q = (sel) => sheet.querySelector(sel);
  const values = () => ({ artist: q('#s-artist').value.trim(), title: q('#s-title').value.trim() });
  const go = async () => {
    const v = values();
    const box = q('#s-results');
    if (!v.title && !v.artist) { box.innerHTML = '<p class="hint">Gib einen Titel ein.</p>'; return; }
    box.innerHTML = '<p class="hint"><span class="spinner small"></span> Suche …</p>';
    try {
      results = await mb.searchAlbums(v.artist, v.title);
      box.innerHTML = results.length
        ? results.map((r, i) => `<button class="result" type="button" data-i="${i}">
            ${coverHtml(r, 'thumb')}
            <span class="row-text"><span class="row-title">${esc(r.title)}</span>
            <span class="row-sub">${esc([r.artist, r.year, albumTypeLabel(r)].filter(Boolean).join(' · '))}</span></span>
            ${isDuplicate(r) ? '<span class="badge">schon da</span>' : ''}
          </button>`).join('')
        : '<p class="hint">Keine Treffer. Prüf die Schreibweise – oder übernimm den Eintrag ohne Treffer.</p>';
    } catch (e) {
      box.innerHTML = `<p class="hint error">${esc(e.message)}</p>`;
    }
  };
  q('#s-form').addEventListener('submit', (e) => { e.preventDefault(); document.activeElement?.blur(); go(); });
  q('#s-results').addEventListener('click', async (e) => {
    const b = e.target.closest('.result');
    if (!b || b.classList.contains('busy')) return;
    b.classList.add('busy');
    try { await onPick({ ...results[+b.dataset.i] }); } finally { b.classList.remove('busy'); }
  });
  q('#s-raw').addEventListener('click', () => {
    const v = values();
    if (!v.title) { toast('Gib zuerst einen Titel ein.'); return; }
    onPick({ type: 'cd', artist: v.artist, title: v.title, raw: true });
  });
  if (onExtra) sheet.addEventListener('click', (e) => { const x = e.target.closest('[data-extra]'); if (x) onExtra(x.dataset.extra); });
  if (title || artist) go();
}

// =====================================================================
// 4) Scannen: Foto -> Gemini -> Prüfliste -> Sammlung
// =====================================================================
const TIPS = `<div class="tips">
  <h3>So klappt die Erkennung am besten</h3>
  <ul>
    <li>Fotografiere das Regal in Abschnitten – etwa 20 bis 40 CDs pro Foto.</li>
    <li>Halte das Handy gerade vor die Rücken, sodass die Schrift scharf ist.</li>
    <li>Gutes Licht und möglichst keine Spiegelungen auf den Hüllen.</li>
    <li>Aus der Mediathek kannst du mehrere Fotos auf einmal wählen.</li>
    <li>Vor dem Speichern siehst du immer eine Prüfliste und kannst alles korrigieren.</li>
  </ul>
</div>`;

function renderScan() {
  view().innerHTML = `
    ${header('Regal fotografieren', { back: true })}
    ${state.geminiKey ? '' : `<div class="notice">${icon('key', 24)}<div>
      <b>Noch kein Gemini-Schlüssel</b>
      <p>Für die Fotoerkennung brauchst du einen kostenlosen Schlüssel von Google. Das dauert zwei Minuten.</p>
      <a class="btn primary" href="#/einstellungen">Schlüssel eintragen</a>
    </div></div>`}
    <div class="scan-buttons">
      <label class="big-btn">${icon('camera', 32)}<span>Foto aufnehmen</span>
        <input class="file-input" type="file" accept="image/*" capture="environment" id="scan-cam"></label>
      <label class="big-btn">${icon('photo', 32)}<span>Aus Fotos wählen</span>
        <input class="file-input" type="file" accept="image/*" multiple id="scan-lib"></label>
    </div>
    <div id="scan-status"></div>
    <div id="scan-review"></div>
    <div id="scan-tips"></div>`;
  for (const id of ['#scan-cam', '#scan-lib']) {
    $(id).addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) handlePhotos(files);
    });
  }
  renderScanStatus();
  renderReview();
}

function setScanStatus(msg) {
  state.scan.status = msg;
  renderScanStatus();
}

function renderScanStatus() {
  const el = $('#scan-status');
  if (!el) return;
  el.innerHTML = state.scan.status
    ? `<div class="status"><span class="spinner"></span><span>${esc(state.scan.status)}</span></div>`
    : '';
}

function saveScan() {
  setCache('pendingScan', state.scan.rows).catch(() => {});
}

async function handlePhotos(files) {
  if (!state.geminiKey) {
    toast('Trag zuerst deinen Gemini-Schlüssel ein.');
    location.hash = '#/einstellungen';
    return;
  }
  if (state.scan.busy) { toast('Moment – das vorige Foto wird noch gelesen.'); return; }
  state.scan.busy = true;
  try {
    for (let i = 0; i < files.length; i++) {
      const pre = files.length > 1 ? `Foto ${i + 1} von ${files.length}: ` : '';
      setScanStatus(`${pre}Foto wird vorbereitet …`);
      try {
        const blob = await prepareImage(files[i]);
        const { items } = await gemini.recognize(blob, (msg) => setScanStatus(pre + msg));
        if (!items.length) toast(`${pre}Auf dem Foto wurde keine CD erkannt.`);
        state.scan.rows.push(...items.map((f) => ({ ...f, id: uid(), checked: true, state: 'pending', match: null, dup: false })));
        saveScan();
        renderReview();
        matchPending();
      } catch (e) {
        toast(pre + e.message, 'error');
        if (/Schlüssel/.test(e.message)) break;
      }
    }
  } finally {
    state.scan.busy = false;
    setScanStatus(state.scan.matching ? 'Suche Cover und Infos …' : '');
  }
}

const rowObject = (r) => (r.match ? { ...r.match } : { artist: r.artist, title: r.title });

function sameThing(a, b) {
  if (a.mbid && b.mbid) return a.mbid === b.mbid;
  return norm(a.title) === norm(b.title) && norm(a.artist) === norm(b.artist);
}

function rowDupLabel(r) {
  const o = rowObject(r);
  if (isDuplicate(o)) return 'schon da';
  const i = state.scan.rows.indexOf(r);
  return state.scan.rows.slice(0, i).some((p) => p.checked && sameThing(rowObject(p), o)) ? 'doppelt' : false;
}

async function matchRow(r) {
  try {
    const best = mb.pickBest(await mb.searchAlbums(r.artist, r.title), r.artist, r.title);
    r.match = best;
    r.state = best ? (best.sure && r.confidence !== 'low' ? 'found' : 'unsure') : 'none';
  } catch (e) {
    r.state = 'error';
    r.error = e.message;
  }
  r.dup = rowDupLabel(r);
  if (r.dup) r.checked = false;
}

async function matchPending() {
  if (state.scan.matching) return;
  state.scan.matching = true;
  try {
    let row;
    while ((row = state.scan.rows.find((r) => r.state === 'pending'))) {
      const left = state.scan.rows.filter((r) => r.state === 'pending').length;
      if (!state.scan.busy) setScanStatus(`Suche Cover und Infos … (noch ${left})`);
      await matchRow(row);
      saveScan();
      renderReview();
    }
  } finally {
    state.scan.matching = false;
    if (!state.scan.busy) setScanStatus('');
    renderReview();
  }
}

function rowHtml(r) {
  const o = rowObject(r);
  const recognized = r.match && norm(r.match.title) !== norm(r.title)
    ? `<span class="row-note">erkannt: ${esc(r.artist ? `${r.artist} – ` : '')}${esc(r.title)}</span>` : '';
  const warn = !r.dup && (r.state === 'unsure' || r.state === 'error' || r.confidence === 'low');
  let badge = '';
  if (r.state === 'pending') badge = '<span class="badge"><span class="spinner small"></span></span>';
  else if (r.dup) badge = `<span class="badge">${r.dup}</span>`;
  else if (r.state === 'error') badge = '<span class="badge warn">Suche fehlgeschlagen</span>';
  else if (warn) badge = '<span class="badge warn">unsicher</span>';
  else if (r.state === 'none') badge = '<span class="badge">ohne Cover</span>';
  return `<div class="row ${r.checked ? '' : 'off'}">
    <button class="check ${r.checked ? 'on' : ''} ${warn ? 'warn' : ''}" data-action="row-toggle" data-id="${r.id}" aria-label="${r.checked ? 'Abwählen' : 'Auswählen'}">${icon('check', 16)}</button>
    <button class="row-main" data-action="row-edit" data-id="${r.id}">
      ${coverHtml(o, 'thumb')}
      <span class="row-text"><span class="row-title">${esc(o.title)}</span><span class="row-sub">${esc(o.artist || 'Interpret unbekannt')}</span>${recognized}</span>
      ${badge}
    </button>
  </div>`;
}

function renderReview() {
  const box = $('#scan-review');
  if (!box) return;
  const rows = state.scan.rows;
  const tips = $('#scan-tips');
  if (tips) tips.innerHTML = rows.length ? '' : TIPS;
  if (!rows.length) { box.innerHTML = ''; return; }
  const n = rows.filter((r) => r.checked).length;
  const unsure = rows.filter((r) => !r.dup && (r.state === 'unsure' || r.confidence === 'low')).length;
  const dups = rows.filter((r) => r.dup).length;
  const pending = rows.some((r) => r.state === 'pending');
  box.innerHTML = `
    <div class="review-head"><h2>Prüfliste</h2>
      <button class="text-btn" data-action="scan-clear">Verwerfen</button></div>
    <p class="muted small">${rows.length} erkannt${unsure ? ` · ${unsure} unsicher` : ''}${dups ? ` · ${dups} schon da` : ''}</p>
    <p class="hint">Tippe auf einen Eintrag, um ihn zu korrigieren. Gelb markierte solltest du kurz prüfen.</p>
    <div class="rows">${rows.map(rowHtml).join('')}</div>
    <div class="review-actions">
      <button class="btn primary" data-action="scan-save">${pending ? '<span class="spinner small"></span> ' : ''}${n === 1 ? '1 CD' : `${n} CDs`} hinzufügen</button>
    </div>`;
}

function editRow(id) {
  const r = state.scan.rows.find((x) => x.id === id);
  if (!r) return;
  openSearch({
    heading: 'Eintrag korrigieren',
    artist: r.match?.artist ?? r.artist,
    title: r.match?.title ?? r.title,
    extraHtml: `<button class="btn danger" type="button" data-extra="remove">${icon('trash', 20)} Aus der Liste entfernen</button>`,
    onExtra: () => {
      state.scan.rows = state.scan.rows.filter((x) => x.id !== id);
      saveScan();
      closeSheet();
      renderReview();
    },
    onPick: async (m) => {
      r.confidence = 'high';
      if (m.raw) {
        r.match = null;
        r.state = 'none';
        r.artist = m.artist;
        r.title = m.title;
      } else {
        r.match = m;
        r.state = 'found';
      }
      r.dup = false;
      r.dup = rowDupLabel(r);
      r.checked = !r.dup;
      saveScan();
      closeSheet();
      renderReview();
    },
  });
}

async function saveScanRows() {
  if (state.scan.rows.some((r) => r.state === 'pending')) { toast('Einen Moment – die Cover werden noch gesucht.'); return; }
  const chosen = state.scan.rows.filter((r) => r.checked);
  if (!chosen.length) { toast('Nichts ausgewählt.'); return; }
  const items = chosen.map((r) => itemFromMatch(rowObject(r), 'foto'));
  await addItems(items);
  state.scan.rows = [];
  saveScan();
  toast(`${items.length === 1 ? '1 CD' : `${items.length} CDs`} hinzugefügt`);
  location.hash = '#/';
  preloadDiscographies();
  preloadArtistArt();
}

// =====================================================================
// 5) Lücken: Diskografien (MusicBrainz)
// =====================================================================
// ---------- Profilbilder der Interpreten (Spotify) ----------
const artMem = new Map(); // Gruppen-Schlüssel -> { id, img, big }
let artLoading = null;

function artistThumbHtml(g) {
  const img = artMem.get(g.key)?.img;
  return img
    ? `<div class="cover thumb round"><img src="${esc(img)}" loading="lazy" alt=""></div>`
    : coverHtml({ title: g.name, cover: groupCover(g) }, 'thumb');
}

// Bilder im Hintergrund holen und merken (gefunden: 60 Tage, nicht gefunden: 7 Tage).
// Braucht die Spotify-Verbindung; die Spotify-ID kommt möglichst von MusicBrainz (sicherer Treffer).
function preloadArtistArt() {
  if (artLoading || !spConnected) return artLoading;
  artLoading = (async () => {
    const todo = [];
    for (const g of libraryGroups()) {
      if (g.various || artMem.has(g.key)) continue;
      const c = await getCache(`spimg:${g.key}`);
      if (c) {
        artMem.set(g.key, c.data);
        cfRefreshArtist(g.key);
        if (Date.now() - c.at < (c.data.img ? 60 : 7) * DAY) continue;
      }
      todo.push(g);
    }
    for (const g of todo) {
      try {
        const sid = g.mbid ? await mb.artistSpotifyId(g.mbid).catch(() => '') : '';
        const data = await spotify.artistImage({ spotifyId: sid, name: g.name });
        artMem.set(g.key, data);
        await setCache(`spimg:${g.key}`, data);
        cfRefreshArtist(g.key);
        if (route()[0] === 'interpreten' && !route()[1]) fillArtistList();
      } catch (e) {
        if (e instanceof spotify.NotConnected) break;
      }
    }
  })().finally(() => { artLoading = null; });
  return artLoading;
}

// =====================================================================
// Alle Bilder vorladen (Einstellungen): für jedes Album Cover, Rückseite, Innenseite, CD, Booklet und Titelliste
// einmal holen – danach kommt alles aus dem Speicher (Service Worker: Cover-Speicher, Datenbank: Fundstellen).
// =====================================================================
const PL = { running: false, stop: false, phase: '', dDone: 0, dTotal: 0, done: 0, total: 0, failed: 0, usage: 0, lock: null };

async function plLock() {
  if (!PL.running || document.visibilityState !== 'visible') return;
  try { PL.lock = await navigator.wakeLock?.request('screen'); } catch {}
}
// iOS gibt die Sperre frei, sobald die App kurz im Hintergrund war – beim Zurückkommen neu anfordern
document.addEventListener('visibilitychange', () => { if (PL.running && document.visibilityState === 'visible') plLock(); });

async function plAlbum({ rgid, cover }) {
  const urls = cover ? [cover, bigCover(cover)] : [];
  let sc = null;
  if (rgid) {
    const [scan] = await Promise.all([jewel.findScan(rgid), loadAlbumDetails(rgid).catch(() => null)]);
    sc = scan;
    if (sc) urls.push(sc.small, sc.big, sc.front, sc.frontSmall, sc.frontBig, sc.medium, sc.tray, ...(sc.booklet || []).flatMap((p) => [p.s, p.b]));
  }
  const timeoutSignal = () => (AbortSignal.timeout ? AbortSignal.timeout(45000) : undefined);
  await Promise.all([...new Set(urls.filter(Boolean))].map((u) => fetch(u, { signal: timeoutSignal() }).then((r) => r.blob()).catch(() => null)));
  if (sc) await jewel.ensureBook(sc).catch(() => {}); // Booklet-Seiten vorbereiten (kommt jetzt aus dem Speicher)
}

async function plStart() {
  if (PL.running) return;
  Object.assign(PL, { running: true, stop: false, phase: 'disco', dDone: 0, dTotal: 0, done: 0, total: 0, failed: 0, usage: 0 });
  plUpdate();
  await plLock();
  try {
    // 1) Diskografien – damit auch die fehlenden Alben dabei sind
    const groups = libraryGroups();
    const withMbid = groups.filter((g) => g.mbid);
    PL.dTotal = withMbid.length;
    for (const g of withMbid) {
      if (PL.stop) break;
      await getDisco(g.mbid).catch(() => null);
      PL.dDone++;
      plUpdate();
    }
    // 2) alle Alben (eigene und fehlende), jedes nur einmal
    const seen = new Set();
    const list = [];
    for (const g of groups) {
      for (const e of albumEntries(g)) {
        const rgid = entryRgid(e);
        const key = rgid || e.cover || e.key;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        list.push({ rgid, cover: e.cover });
      }
    }
    PL.phase = 'images';
    PL.total = list.length;
    plUpdate();
    let next = 0;
    const worker = async () => {
      while (!PL.stop && next < list.length) {
        const a = list[next++];
        try { await plAlbum(a); } catch { PL.failed++; }
        PL.done++;
        plUpdate();
      }
    };
    await Promise.all([worker(), worker(), worker()]); // drei Alben gleichzeitig
  } finally {
    PL.running = false;
    PL.phase = PL.stop ? 'stopped' : 'done';
    try { await PL.lock?.release(); } catch {}
    PL.lock = null;
    try { PL.usage = (await navigator.storage?.estimate?.())?.usage || 0; } catch {}
    plUpdate();
    if (!PL.stop) toast(PL.failed ? `Fertig – ${PL.failed} Alben waren nicht erreichbar` : 'Alle Bilder sind geladen');
  }
}

function plUpdate() {
  const box = $('#pl-box');
  if (!box) return;
  const label = $('#pl-btn .cell-label');
  label.textContent = PL.running ? 'Anhalten' : (PL.phase === 'done' ? 'Nochmal prüfen' : 'Alle Bilder laden');
  box.hidden = !PL.phase;
  const pct = PL.total ? Math.floor((PL.done / PL.total) * 100) : 0;
  let left = '';
  let right = '';
  let width = 0;
  if (PL.phase === 'disco') {
    left = `Diskografien: ${PL.dDone} von ${PL.dTotal}`;
    right = '0 %';
  } else if (PL.phase === 'images') {
    left = `${PL.done} von ${PL.total} Alben`;
    right = `${pct} %`;
    width = pct;
  } else if (PL.phase === 'stopped') {
    left = `Angehalten bei ${PL.done} von ${PL.total || '?'} Alben`;
    right = `${pct} %`;
    width = pct;
  } else if (PL.phase === 'done') {
    left = `Fertig: ${PL.total} Alben`;
    right = '100 %';
    width = 100;
  }
  const extra = PL.phase === 'done' || PL.phase === 'stopped'
    ? [PL.failed ? `${PL.failed} nicht erreichbar – nochmal drücken lädt den Rest` : '', PL.usage ? `Belegt: ${Math.round(PL.usage / 1048576)} MB` : ''].filter(Boolean).join(' · ')
    : 'App bitte geöffnet lassen – das Display bleibt an.';
  box.innerHTML = `<div class="progress-head"><span>${esc(left)}</span><span class="muted">${right}</span></div>
    <div class="bar big ${PL.phase === 'done' ? 'done' : ''}"><i style="width:${width}%"></i></div>
    <p class="pl-note">${esc(extra)}</p>`;
}

const discoMem = new Map();
const discoTried = new Set();
let preloading = null;

async function getDisco(mbid, { fetch = true, force = false } = {}) {
  const c = discoMem.get(mbid) || await getCache(`mb:${mbid}`);
  if (c) discoMem.set(mbid, c);
  const fresh = c && Date.now() - c.at < 30 * DAY;
  if (c && (fresh || !fetch) && !force) return c.data;
  if (!fetch) return null;
  try {
    const data = await mb.artistAlbums(mbid);
    await setCache(`mb:${mbid}`, data);
    discoMem.set(mbid, { key: `mb:${mbid}`, data, at: Date.now() });
    return data;
  } catch (e) {
    if (c) return c.data;
    throw e;
  }
}

function artistGroups() {
  return libraryGroups().filter((g) => g.mbid);
}

function studioAlbums(disco) {
  const t = today();
  return disco
    .filter((a) => a.secondary.length === 0 || (state.includeLive && a.secondary.length === 1 && a.secondary[0] === 'Live'))
    .filter((a) => !a.date || a.date <= t)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
}

function ownedAlbum(album, artistMbid) {
  const idx = getIndex();
  return idx.byMbid.get(album.mbid) || idx.byArtistTitle.get(`${artistMbid}|${norm(album.title)}`) || null;
}

function discoProgress(mbid, disco) {
  const list = studioAlbums(disco);
  return { owned: list.filter((a) => ownedAlbum(a, mbid)).length, total: list.length };
}

// Diskografien im Hintergrund laden (MusicBrainz: 1 Anfrage pro Sekunde)
function preloadDiscographies() {
  if (preloading) return preloading;
  preloading = (async () => {
    const todo = [];
    for (const g of artistGroups()) {
      const c = discoMem.get(g.mbid) || await getCache(`mb:${g.mbid}`);
      if (c) discoMem.set(g.mbid, c);
      if (!c || Date.now() - c.at >= 30 * DAY) todo.push(g);
    }
    refreshOverviews();
    for (const g of todo) {
      discoTried.add(g.mbid);
      try { await getDisco(g.mbid); } catch { /* später nochmal */ }
      if (route()[0] === 'luecken') fillGaps();
      shelfRefresh();
    }
  })().finally(() => {
    preloading = null;
    refreshOverviews();
  });
  return preloading;
}

// Listen, die Fortschritt zeigen, nach dem Laden auffrischen
function refreshOverviews() {
  const page = route()[0];
  if (page === 'luecken') fillGaps();
  if (page === 'interpreten' && !route()[1]) fillArtistList();
  if (page === '') shelfRefresh();
}

function gapRow({ href, name, owned, total, loading, failed }) {
  const done = !loading && total > 0 && owned >= total;
  const pct = total ? Math.round((owned / total) * 100) : 0;
  let right = `${owned} / ${total}`;
  if (loading) right = failed ? 'nicht geladen' : '<span class="spinner small"></span>';
  return `<a class="gap-row" href="${href}">
    <span class="gap-ic ${done ? 'done' : ''}">${icon(done ? 'check' : 'disc', 20)}</span>
    <span class="gap-main">
      <span class="gap-top"><span class="gap-name">${esc(name)}</span><span class="muted">${right}</span></span>
      <span class="bar ${done ? 'done' : ''}"><i style="width:${loading ? 0 : pct}%"></i></span>
    </span>
    ${chev()}
  </a>`;
}

function renderGaps() {
  view().innerHTML = `
    ${header('Lücken', { back: true })}
    <div class="chips">
      <button class="chip ${state.gapFilter === 'all' ? 'on' : ''}" data-action="gap-filter" data-f="all">Alle</button>
      <button class="chip ${state.gapFilter === 'open' ? 'on' : ''}" data-action="gap-filter" data-f="open">Nur unvollständige</button>
      <button class="chip ${state.includeLive ? 'on' : ''}" data-action="toggle-live">${state.includeLive ? `${icon('check', 14)} ` : '+ '}Live-Alben</button>
    </div>
    <div id="gap-list"></div>`;
  fillGaps();
}

async function fillGaps() {
  if (!$('#gap-list')) return;
  const groups = artistGroups();
  if (!groups.length) {
    $('#gap-list').innerHTML = `<div class="empty">${icon('disc', 46)}<h2>Noch keine Interpreten</h2>
      <p>Sobald du CDs in der Sammlung hast, siehst du hier pro Interpret, welche Studioalben dir noch fehlen.</p></div>`;
    return;
  }
  const rows = [];
  for (const g of groups) {
    const disco = await getDisco(g.mbid, { fetch: false });
    rows.push({ ...g, disco, ...(disco ? discoProgress(g.mbid, disco) : {}) });
  }
  if (route()[0] !== 'luecken' || !$('#gap-list')) return;
  const shown = state.gapFilter === 'open' ? rows.filter((r) => !r.disco || r.owned < r.total) : rows;
  const unmatched = state.items.filter((i) => !i.artistMbid).length;
  $('#gap-list').innerHTML = `
    ${shown.length ? `<div class="list">${shown.map((r) => gapRow({
    href: `#/interpreten/${enc(r.key)}`,
    name: r.name,
    owned: r.owned,
    total: r.total,
    loading: !r.disco,
    failed: !r.disco && discoTried.has(r.mbid) && !preloading,
  })).join('')}</div>` : ''}
    ${state.gapFilter === 'open' && !shown.length ? '<p class="empty-small">Alles komplett – stark!</p>' : ''}
    ${unmatched ? `<p class="group-footer">${unmatched === 1 ? '1 CD ohne Datenbank-Treffer wird' : `${unmatched} CDs ohne Datenbank-Treffer werden`} hier nicht gezählt. Öffne sie und tippe auf „Treffer ändern“.</p>` : ''}
    <p class="group-footer">Gezählt werden nur Studioalben${state.includeLive ? ' und Live-Alben' : ''} – keine Singles, EPs oder Best-ofs. Daten: MusicBrainz.</p>`;
  if (rows.some((r) => !r.disco && !discoTried.has(r.mbid))) preloadDiscographies();
}

const findAlbum = (key) => state.current?.disco?.find((a) => a.mbid === key);
const albumAsMatch = (a, g) => ({
  type: 'cd', mbid: a.mbid, title: a.title, artist: g.name, artistMbid: g.mbid, artistName: g.name, year: a.year, cover: a.cover,
});

async function ownMatch(m) {
  const it = itemFromMatch(m, 'hand');
  await addItems([it]);
  toast(`„${it.title}“ ist jetzt in deiner Sammlung`);
}

// Nach Änderungen die aktuelle Ansicht neu zeichnen (Blätter-Position bleibt erhalten)
function refreshCurrent() {
  closeSheet();
  if (state.current?.kind === 'artist' && $('#detail-body')) fillArtist();
  else render();
}

// =====================================================================
// 6) Wunschliste
// =====================================================================
function renderWishes() {
  const list = state.wishes.slice().sort((a, b) => b.addedAt - a.addedAt);
  view().innerHTML = `${header('Wunschliste', { back: true })}
    ${list.length ? `<div class="list">${list.map(wishRow).join('')}</div>` : `<div class="empty">${icon('heart', 46)}
      <h2>Noch keine Wünsche</h2>
      <p>Bei jedem Interpreten siehst du, welche Alben dir fehlen. Mit dem Herz landen sie hier.</p></div>`}`;
}

function wishRow(w) {
  return `<div class="wish">
    ${coverHtml(w, 'thumb')}
    <span class="row-text"><span class="row-title">${esc(w.title)}</span><span class="row-sub">${esc([w.artist, w.year].filter(Boolean).join(' · '))}</span></span>
    <button class="btn small" data-action="wish-bought" data-key="${esc(w.id)}">Gekauft</button>
    <button class="icon-btn" data-action="wish-remove" data-key="${esc(w.id)}" aria-label="Von der Wunschliste nehmen">${icon('x', 20)}</button>
  </div>`;
}

// =====================================================================
// 7) Einstellungen
// =====================================================================
async function renderSettings() {
  const models = (await getSetting('geminiModels', null)) || [];
  const chosen = await getSetting('geminiModel', 'auto');
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const spUser = await getSetting('spUser', '');
  const spClient = await getSetting('spClientId', '');
  if (route()[0] !== 'einstellungen') return;
  const cellIc = (name) => `<span class="cell-ic">${icon(name, 18)}</span>`;
  const spGroup = spConnected
    ? `<div class="cell">${cellIc('play')}<span class="cell-label">Spotify</span><span class="cell-value">${spUser ? `Verbunden: ${esc(spUser)}` : 'Verbunden'}</span></div>
      <label class="cell"><span class="cell-label">Abspielen auf</span>
        <select id="sp-device" class="cell-select"><option value="">Automatisch</option></select>${chev()}</label>
      <button class="cell action danger" data-action="sp-disconnect"><span class="cell-label">Verbindung trennen</span></button>`
    : `<div class="cell">${cellIc('play')}<span class="cell-label">Spotify</span><span class="cell-value">Nicht verbunden</span></div>
      <div class="cell input-cell"><input id="sp-client" placeholder="Client ID einfügen" value="${esc(spClient)}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <button class="cell action" data-action="sp-connect"><span class="cell-label">Mit Spotify verbinden</span>${chev()}</button>
      <div class="cell input-cell"><input id="sp-code" placeholder="Verbindungs-Code einfügen" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <button class="cell action" data-action="sp-code"><span class="cell-label">Code übernehmen</span></button>
      <button class="cell action" data-action="sp-help"><span class="cell-label">So richtest du es ein</span>${chev()}</button>`;
  view().innerHTML = `
    ${header('Einstellungen', { back: true })}

    <h3 class="group-title">Spotify</h3>
    <div class="group">${spGroup}</div>
    <div id="sp-status" class="group-footer status-line"></div>
    <p class="group-footer">Mit Spotify Premium spielt Regal Alben und einzelne Titel im Hintergrund ab – ohne dass die Spotify-App aufgeht. Spotify muss dafür auf dem iPhone irgendwann geöffnet worden sein.</p>

    <h3 class="group-title">CD-Hülle</h3>
    <div class="group">
      <label class="cell">${cellIc('disc')}<span class="cell-label">Hülle</span>
        <select id="opt-case" class="cell-select">
          <option value="classic" ${state.caseType !== 'clear' ? 'selected' : ''}>Klassisch</option>
          <option value="clear" ${state.caseType === 'clear' ? 'selected' : ''}>Klar</option>
        </select>${chev()}</label>
      <label class="cell">${cellIc('eye')}<span class="cell-label">Kratzer</span>
        <select id="opt-scratch" class="cell-select">
          ${[['0', 'Aus'], ['0.55', 'Wenig'], ['0.9', 'Mittel'], ['1.35', 'Stark']].map(([v, l]) => `<option value="${v}" ${state.scratches === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>${chev()}</label>
    </div>
    <p class="group-footer">Klassisch: schwarzer, geriffelter Träger. Klar: durchsichtiger Träger – darunter sieht man den bedruckten Einleger. Die Kratzer glänzen nur dort, wo gerade Licht hinfällt.</p>

    <h3 class="group-title">Bilder</h3>
    <div class="group">
      <button class="cell action" id="pl-btn" data-action="preload-all">${cellIc('download')}<span class="cell-label">Alle Bilder laden</span></button>
    </div>
    <div class="group-footer pl-box" id="pl-box" hidden></div>
    <p class="group-footer">Lädt für alle Alben – auch die fehlenden – Cover, Rückseite, Innenseite, CD, Booklet und Titelliste einmal auf dein iPhone. Danach musst du beim Öffnen nicht mehr warten. Das dauert je nach Sammlung eine halbe Stunde oder länger; lass die App so lange geöffnet. Nochmal drücken lädt nur, was noch fehlt.</p>

    <h3 class="group-title">Fotoerkennung</h3>
    <div class="group">
      <div class="cell">${cellIc('key')}<span class="cell-label">Gemini-Schlüssel</span>
        <span class="cell-value" id="gem-badge">${state.geminiKey ? 'Gespeichert' : 'Fehlt'}</span></div>
      <div class="cell input-cell">
        <input id="gem-key" type="password" placeholder="Schlüssel einfügen" value="${esc(state.geminiKey)}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="cell-icon-btn" data-action="toggle-key" data-for="gem-key" aria-label="Schlüssel anzeigen">${icon('eye', 20)}</button>
      </div>
      <button class="cell action" data-action="save-gemini"><span class="cell-label">Speichern und prüfen</span></button>
      <label class="cell"><span class="cell-label">Modell</span>
        <select id="gem-model" class="cell-select">
          <option value="auto">Automatisch</option>
          ${models.map((m) => `<option value="${esc(m)}" ${chosen === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>${chev()}
      </label>
      <a class="cell" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">
        <span class="cell-label">Schlüssel bei Google holen</span>${icon('external', 16, 'cell-chev')}</a>
    </div>
    <div id="gem-status" class="group-footer status-line"></div>
    <p class="group-footer">Kostenlos bei Google AI Studio: mit deinem Google-Konto anmelden, „API-Schlüssel erstellen“ tippen, kopieren und hier einfügen. Im Gratis-Kontingent darf Google die Fotos zur Verbesserung seiner KI nutzen – fotografiere also nur dein Regal.</p>

    <h3 class="group-title">Lücken</h3>
    <div class="group">
      <label class="cell">${cellIc('checklist')}<span class="cell-label">Live-Alben mitzählen</span>
        <input type="checkbox" class="switch-input" id="opt-live" ${state.includeLive ? 'checked' : ''}><i class="switch"></i></label>
      <button class="cell action" data-action="refresh-disco">${cellIc('refresh')}<span class="cell-label">Diskografien neu laden</span></button>
    </div>
    <p class="group-footer">Singles, EPs und Best-ofs werden nie mitgezählt.</p>

    <h3 class="group-title">Deine Daten</h3>
    <div class="group">
      <div class="cell">${cellIc('disc')}<span class="cell-label">CDs</span><span class="cell-value">${state.items.length}</span></div>
      <div class="cell">${cellIc('heart')}<span class="cell-label">Wünsche</span><span class="cell-value">${state.wishes.length}</span></div>
    </div>
    <p class="group-footer">Alles wird nur hier in der App auf deinem iPhone gespeichert. ${persisted ? 'Der Speicher ist dauerhaft geschützt.' : (standalone ? '' : 'Tipp: Lege die App über „Teilen → Zum Home-Bildschirm“ ab, dann behält iOS die Daten dauerhaft.')}</p>

    <h3 class="group-title">Sicherung</h3>
    <div class="group">
      <button class="cell action" data-action="export">${cellIc('download')}<span class="cell-label">Sicherung erstellen</span>${chev()}</button>
      <label class="cell action">${cellIc('upload')}<span class="cell-label">Sicherung laden</span>${chev()}
        <input class="file-input" type="file" accept="application/json,.json" id="import-file"></label>
    </div>
    <p class="group-footer">Freiwillig. Löschst du das App-Symbol vom Home-Bildschirm, ist auch die Sammlung weg – eine Sicherung schützt davor.</p>

    <div class="group">
      <button class="cell action danger" data-action="clear-all"><span class="cell-label">Sammlung komplett löschen</span></button>
    </div>

    <p class="group-footer center">Regal ${APP_VERSION}<br>Fotoerkennung: Google Gemini · Musikdaten: MusicBrainz und Cover Art Archive · Interpretenbilder: Spotify</p>`;
  $('#gem-model').addEventListener('change', (e) => setSetting('geminiModel', e.target.value));
  $('#opt-case').addEventListener('change', async (e) => {
    state.caseType = e.target.value;
    applyLook();
    await setSetting('caseType', state.caseType);
  });
  $('#opt-scratch').addEventListener('change', async (e) => {
    state.scratches = e.target.value;
    applyLook();
    await setSetting('scratches', state.scratches);
  });
  if (spConnected) fillSpDevices();
  plUpdate();
  $('#opt-live').addEventListener('change', async (e) => {
    state.includeLive = e.target.checked;
    await setSetting('includeLive', state.includeLive);
  });
  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importBackup(f);
  });
}

// ---------- Spotify verbinden ----------
async function fillSpDevices() {
  const sel = $('#sp-device');
  if (!sel) return;
  const pref = await getSetting('spDevice', '');
  try {
    const list = await spotify.devices();
    sel.innerHTML = `<option value="">Automatisch</option>${list.map((d) => `<option value="${esc(d.id)}" ${d.id === pref ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}`;
    if (pref && !list.some((d) => d.id === pref)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(pref)}" selected>Zuletzt gewähltes Gerät</option>`);
    if (!spUserKnown) {
      spUserKnown = true;
      const name = await spotify.me().catch(() => '');
      if (name) await setSetting('spUser', name);
    }
  } catch (e) {
    const st = $('#sp-status');
    if (st) st.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
  sel.onchange = () => setSetting('spDevice', sel.value);
}
let spUserKnown = false;

function showSpotifyHelp() {
  openSheet(`<h2>Spotify einrichten</h2>
    <div class="help">
      <p>Einmalig, dauert etwa 5 Minuten. Du brauchst Spotify Premium.</p>
      <ol>
        <li>Öffne <a class="inline-link" href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> und melde dich mit deinem Spotify-Konto an.</li>
        <li>Tippe auf <b>„Create app“</b>. Name: <i>Regal</i>, Beschreibung: <i>Meine CD-Sammlung</i>.</li>
        <li>Bei <b>„Redirect URIs“</b> genau diese Adresse eintragen und „Add“ tippen:<br><code>${esc(spotify.redirectUri())}</code></li>
        <li>Bei „Which API/SDKs“ <b>„Web API“</b> ankreuzen, Bedingungen bestätigen, <b>„Save“</b>.</li>
        <li>In der neuen App auf <b>„Settings“</b> → die <b>Client ID</b> kopieren.</li>
        <li>Hier in Regal einfügen → <b>„Mit Spotify verbinden“</b> → anmelden → zustimmen.</li>
        <li>Zeigt Safari danach einen <b>Verbindungs-Code</b>: kopieren, zurück in Regal, bei „Verbindungs-Code einfügen“ einfügen → „Code übernehmen“.</li>
      </ol>
    </div>`);
}

async function handleSpotifyCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('state') || (!q.has('code') && !q.has('error'))) return false;
  history.replaceState(null, '', `${location.pathname}#/spotify`);
  document.body.classList.remove('flow-page');
  view().innerHTML = `${header('Spotify')}<div id="sp-cb"><p class="hint"><span class="spinner small"></span> Verbindung wird hergestellt …</p></div>`;
  const box = $('#sp-cb');
  if (q.get('error')) {
    box.innerHTML = `<p class="hint error">Spotify hat die Verbindung nicht erlaubt (${esc(q.get('error'))}).</p><a class="btn" href="#/einstellungen">Zurück</a>`;
    return true;
  }
  try {
    const code = await spotify.finishLogin(q.get('code'), q.get('state'));
    spConnected = true;
    preloadArtistArt();
    const name = await spotify.me().catch(() => '');
    if (name) await setSetting('spUser', name);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    box.innerHTML = standalone
      ? `<div class="empty">${icon('check', 46)}<h2>Mit Spotify verbunden</h2><a class="btn primary" href="#/einstellungen">Weiter</a></div>`
      : `<div class="notice">${icon('check', 24)}<div><b>Fast geschafft!</b>
          <p>Kopiere den Verbindungs-Code, wechsle zurück in die Regal-App auf deinem Home-Bildschirm und füge ihn unter Einstellungen → Spotify bei „Verbindungs-Code einfügen“ ein.</p></div></div>
        <textarea class="code-box" readonly>${esc(code)}</textarea>
        <button class="btn primary" data-action="sp-copy" data-code="${esc(code)}">Code kopieren</button>
        <p class="group-footer">Benutzt du Regal hier im Browser, bist du schon verbunden – dann einfach <a class="inline-link" href="#/einstellungen">weiter</a>.</p>`;
  } catch (e) {
    box.innerHTML = `<p class="hint error">${esc(e.message)}</p><a class="btn" href="#/einstellungen">Zurück</a>`;
  }
  return true;
}

async function saveGemini() {
  const key = $('#gem-key').value.trim();
  const st = $('#gem-status');
  if (!key) {
    state.geminiKey = '';
    await setSetting('geminiKey', '');
    await setSetting('geminiModels', null);
    st.innerHTML = 'Schlüssel entfernt.';
    return;
  }
  st.innerHTML = '<span class="spinner small"></span> Prüfe den Schlüssel …';
  try {
    const models = await gemini.listModels(key);
    state.geminiKey = key;
    await setSetting('geminiKey', key);
    await setSetting('geminiModels', models);
    st.innerHTML = models.length
      ? `<span class="ok">${icon('check', 16)} Funktioniert – ${models.length} passende Modelle gefunden.</span>`
      : '<span class="error">Der Schlüssel ist gültig, aber es wurde kein passendes Modell gefunden.</span>';
    $('#gem-badge').textContent = 'Gespeichert';
    const sel = $('#gem-model');
    const cur = sel.value;
    sel.innerHTML = `<option value="auto">Automatisch</option>${models.map((m) => `<option value="${esc(m)}" ${cur === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}`;
  } catch (e) {
    st.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}

async function exportBackup() {
  const all = await db.all('items'); // auch alte DVD-Einträge mitsichern
  const data = { app: 'regal', version: 1, exportedAt: new Date().toISOString(), items: all, wishes: state.wishes };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `regal-sicherung-${today()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Regal-Sicherung' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Diese Datei ist keine Regal-Sicherung.', 'error');
    return;
  }
  if (data?.app !== 'regal' || !Array.isArray(data.items)) { toast('Diese Datei ist keine Regal-Sicherung.', 'error'); return; }
  const have = new Set((await db.all('items')).map((i) => i.id));
  const newItems = data.items.filter((i) => i && i.id && !have.has(i.id));
  const haveW = new Set(state.wishes.map((w) => w.id));
  const newWishes = (data.wishes || []).filter((w) => w && w.id && w.type !== 'dvd' && !haveW.has(w.id));
  await db.putMany('items', newItems);
  await db.putMany('wishes', newWishes);
  state.items.push(...newItems.filter((i) => i.type === 'cd'));
  state.wishes.push(...newWishes);
  changed();
  toast(`${newItems.filter((i) => i.type === 'cd').length} CDs und ${newWishes.length} Wünsche geladen`);
  render();
  preloadDiscographies();
}

async function clearAll() {
  if (!confirm('Wirklich die komplette Sammlung und Wunschliste löschen?')) return;
  if (!confirm('Ganz sicher? Das kann nicht rückgängig gemacht werden. (Dein Schlüssel bleibt gespeichert.)')) return;
  await Promise.all([db.clear('items'), db.clear('wishes'), db.clear('cache')]);
  state.items = [];
  state.wishes = [];
  state.scan.rows = [];
  discoMem.clear();
  discoTried.clear();
  albumMem.clear();
  artMem.clear();
  changed();
  toast('Alles gelöscht');
  location.hash = '#/';
}

// =====================================================================
// Klicks: alle Knöpfe mit data-action landen hier
// =====================================================================
const flowAlbum = (el) => {
  const e = CF.entries[Number(el.dataset.i)];
  return e && state.current?.g ? { e, g: state.current.g } : null;
};

const actions = {
  add: () => openAdd(),
  'add-menu': () => openAddMenu(),
  item: (el) => showItem(el.dataset.id),
  rematch: (el) => rematchItem(el.dataset.id),
  delete: async (el) => {
    const it = state.items.find((i) => i.id === el.dataset.id);
    if (!it || !confirm(`„${it.title}“ aus der Sammlung löschen?`)) return;
    await deleteItem(it.id);
    toast('Gelöscht');
    refreshCurrent();
  },
  back: () => {
    if (route()[0] === 'flow' && $('#cf-stage')) { cfLeave(true); return; } // mit Übergang zurück
    if (history.length > 1) history.back();
    else location.hash = '#/';
  },

  'row-toggle': (el) => {
    const r = state.scan.rows.find((x) => x.id === el.dataset.id);
    if (!r) return;
    r.checked = !r.checked;
    saveScan();
    renderReview();
  },
  'row-edit': (el) => editRow(el.dataset.id),
  'scan-save': () => saveScanRows(),
  'scan-clear': () => {
    if (!confirm('Die Prüfliste verwerfen? Es wird nichts gespeichert.')) return;
    state.scan.rows = [];
    saveScan();
    renderReview();
  },

  'gap-filter': (el) => { state.gapFilter = el.dataset.f; renderGaps(); },
  'album-filter': (el) => { state.albumFilter = el.dataset.f; refreshCurrent(); },
  'toggle-live': async () => {
    state.includeLive = !state.includeLive;
    await setSetting('includeLive', state.includeLive);
    refreshCurrent();
  },

  'missing-album': (el) => {
    const a = findAlbum(el.dataset.key);
    if (a) showMissing(a, state.current.g);
  },
  'wish-album': async (el) => {
    const a = findAlbum(el.dataset.key) || CF.entries.find((e) => e.album?.mbid === el.dataset.key)?.album;
    const g = state.current?.g;
    if (a && g) { await toggleWish(albumAsMatch(a, g)); refreshCurrent(); }
  },
  'own-album': async (el) => {
    const a = findAlbum(el.dataset.key) || CF.entries.find((e) => e.album?.mbid === el.dataset.key)?.album;
    const g = state.current?.g;
    if (a && g) { await ownMatch(albumAsMatch(a, g)); refreshCurrent(); preloadDiscographies(); }
  },

  // Knöpfe auf der Rückseite einer umgedrehten Hülle
  'jc-list': (el) => { el.closest('.jc')?.classList.toggle('show-list'); },
  'preload-all': () => { if (PL.running) { PL.stop = true; plUpdate(); } else plStart(); },

  // Regal: Reihe antippen -> Interpret im Cover Flow
  'shelf-open': (el) => shelfOpen(el),
  'cf-artist': (el) => { if (!el.closest('.tr-layer')) cfSwitchArtist(el.dataset.key, Number(el.dataset.dir) || 1); },
  'cf-more': (el) => {
    const x = flowAlbum(el);
    if (!x) return;
    if (x.e.missing) showMissing(x.e.album, x.g);
    else showItem(x.e.item.id);
  },
  'cf-wish': async (el) => {
    const x = flowAlbum(el);
    if (!x?.e.missing) return;
    await toggleWish(albumAsMatch(x.e.album, x.g));
    el.classList.toggle('on', isWished(`mb:${x.e.album.mbid}`));
  },

  'wish-bought': async (el) => {
    const w = state.wishes.find((x) => x.id === el.dataset.key);
    if (!w) return;
    await ownMatch(w);
    await removeWish(w.id);
    renderWishes();
    preloadDiscographies();
  },
  'wish-remove': async (el) => { await removeWish(el.dataset.key); renderWishes(); },

  'save-gemini': () => saveGemini(),

  // Mini-Player
  'np-goto': () => npGoto(),

  // Spotify
  'sp-play': (el) => spotifyPlay({ artist: el.dataset.artist, title: el.dataset.title, sid: el.dataset.sid }),
  'sp-track': (el) => spotifyPlay({
    artist: el.dataset.artist, title: el.dataset.title, sid: el.dataset.sid, track: el.dataset.track, pos: Number(el.dataset.pos),
  }),
  'sp-connect': async () => {
    const cid = $('#sp-client').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(cid)) { toast('Füge zuerst die Client ID von Spotify ein (32 Zeichen).'); return; }
    await setSetting('spClientId', cid);
    location.href = await spotify.authorizeUrl(cid);
  },
  'sp-code': async () => {
    const st = $('#sp-status');
    st.innerHTML = '<span class="spinner small"></span> Prüfe den Code …';
    try {
      await spotify.useConnectCode($('#sp-code').value);
      spConnected = true;
      preloadArtistArt();
      spUserKnown = false;
      toast('Mit Spotify verbunden');
      renderSettings();
    } catch (e) {
      st.innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  },
  'sp-disconnect': async () => {
    if (!confirm('Die Verbindung zu Spotify trennen?')) return;
    await spotify.disconnect();
    spConnected = false;
    renderSettings();
  },
  'sp-copy': async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.code);
      toast('Code kopiert');
    } catch {
      const box = $('.code-box');
      box?.select();
      toast('Markiert – jetzt über „Kopieren“ kopieren');
    }
  },
  'sp-help': () => showSpotifyHelp(),
  'toggle-key': (el) => { const inp = $(`#${el.dataset.for}`); inp.type = inp.type === 'password' ? 'text' : 'password'; },
  export: () => exportBackup(),
  'clear-all': () => clearAll(),
  'refresh-disco': async () => {
    for (const g of artistGroups()) {
      discoMem.delete(g.mbid);
      await db.del('cache', `mb:${g.mbid}`);
    }
    discoTried.clear();
    toast('Diskografien werden neu geladen …');
    preloadDiscographies();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => toast(err?.message || String(err), 'error'));
});

// Kaputte Cover-Bilder ausblenden -> Platzhalter wird sichtbar
document.addEventListener('error', (e) => {
  if (e.target?.tagName === 'IMG') e.target.classList.add('broken');
}, true);

// =====================================================================
// Start
// =====================================================================
async function init() {
  try {
    const [items, wishes] = await Promise.all([db.all('items'), db.all('wishes')]);
    state.items = items.filter((i) => i.type === 'cd'); // DVDs gibt es in der App nicht mehr
    state.wishes = wishes.filter((w) => w.type !== 'dvd');
    state.geminiKey = await getSetting('geminiKey', '');
    state.includeLive = await getSetting('includeLive', false);
    state.caseType = await getSetting('caseType', 'classic');
    state.scratches = String(await getSetting('scratches', '0.9'));
    const pending = await getCache('pendingScan');
    if (Array.isArray(pending?.data)) state.scan.rows = pending.data.filter((r) => r.type !== 'dvd');
    spConnected = await spotify.isConnected();
  } catch (e) {
    toast(`Der Speicher konnte nicht geöffnet werden: ${e.message}`, 'error');
  }
  changed();
  applyLook();
  window.addEventListener('hashchange', render);
  // Beim Scrollen: kleiner Titel + weicher Glas-Rand oben (wie iOS)
  const onScroll = () => {
    document.body.classList.toggle('scrolled', window.scrollY > 4);
    document.body.classList.toggle('titled', window.scrollY > 40);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('hashchange', () => requestAnimationFrame(onScroll));
  // Zurück von der Spotify-Anmeldung? Sonst normal starten
  if (!(await handleSpotifyCallback())) render();
  // Wenn die App wieder sichtbar wird (z. B. nach der Anmeldung in Safari): Verbindung neu prüfen
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const now = await spotify.isConnected();
    if (now !== spConnected) {
      spConnected = now;
      if (now) preloadArtistArt();
      if (route()[0] === 'einstellungen') renderSettings();
    }
    npTick(); // Mini-Player sofort auffrischen
  });
  if (state.scan.rows.some((r) => r.state === 'pending')) matchPending();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  preloadDiscographies();
  preloadArtistArt();
}

init();
