// Regal – deine CD-Sammlung als Musik-App
// Start: Interpreten durchblättern wie früher auf dem iPod. Sammeln (Scannen, Lücken, Wünsche) im Menü.
// Alles läuft im Browser auf dem iPhone, die Daten bleiben in der App (IndexedDB).
import { db, getSetting, setSetting, getCache, setCache } from './db.js';
import * as mb from './musicbrainz.js';
import * as gemini from './gemini.js';
import * as spotify from './spotify.js';
import { $, esc, norm, hue, uid, icon, toast, openSheet, closeSheet, prepareImage } from './util.js';

const APP_VERSION = '2.3';
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
};

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
function header(title, { back = false, left = '', actions = '', compact = false } = {}) {
  const leftHtml = back
    ? `<button class="glass-btn round" data-action="back" aria-label="Zurück">${icon('back', 24)}</button>`
    : left;
  return `<div class="navbar ${compact ? 'compact' : ''}">
    <div class="nav-side">${leftHtml}</div>
    <div class="nav-title">${esc(title)}</div>
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
let lastPage = '';

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  return h ? h.split('/').map(decodeURIComponent) : [''];
}

function render() {
  closeSheet();
  state.current = null;
  const r = route();
  const key = r.join('/');
  if (key !== lastPage) { window.scrollTo(0, 0); lastPage = key; }
  const [page, id] = r;
  document.body.classList.toggle('flow-page', page === '' || page === 'flow');
  if (page === '') renderFlow('artists');
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
// 1) Durchblättern – Startbildschirm (Interpreten) und Alben eines Interpreten
// =====================================================================
const CF = {
  level: 'artists', key: '', entries: [], els: [], pos: 0, target: 0, size: 240,
  raf: 0, flipped: -1, shown: -1, fast: false, fastTimer: 0, settleTimer: 0, mem: {},
};
const CF_WINDOW = 6; // so viele Cover links und rechts werden gezeichnet

function artistEntries() {
  return libraryGroups().map((g) => {
    const pic = artMem.get(g.key) || {};
    return { key: g.key, title: g.name, sub: groupSub(g), cover: groupCover(g), img: pic.img || '', big: pic.big || '', group: g };
  });
}

// Vorderseite eines Covers. Interpreten: Profilbild von Spotify, sonst der Name als Schriftzug.
function cfFaceHtml(e) {
  if (CF.level === 'artists') {
    return e.img
      ? `<div class="cover cf-cover artist-photo"><img data-src="${esc(e.img)}" data-big="${esc(e.big)}" alt="" draggable="false"></div>`
      : `<div class="cover cf-cover artist-card text"><span class="artist-name">${esc(e.title)}</span></div>`;
  }
  return `<div class="cover cf-cover" style="--h:${hue(e.title)}">
    <span class="ph">${esc(e.title)}</span>${e.cover ? `<img data-src="${esc(e.cover)}" alt="" draggable="false">` : ''}
  </div>`;
}

// Cover + Spiegelung darunter. Die Spiegelung ist deckend (schwarz verlaufend) wie beim iPod,
// darum überdecken sich die Spiegelungen benachbarter Cover sauber statt durchzuscheinen.
function cfFrontHtml(e) {
  const face = cfFaceHtml(e);
  return `${face}<div class="cf-reflect" aria-hidden="true"><div class="cf-reflect-inner">${face}</div></div>`;
}

// Profilbild nachträglich eingetroffen: nur dieses Cover austauschen (kein Springen)
function cfRefreshArtist(key) {
  if (CF.level !== 'artists' || !$('#cf-stage')) return;
  const i = CF.entries.findIndex((e) => e.key === key);
  if (i < 0) return;
  const pic = artMem.get(key) || {};
  if ((pic.img || '') === CF.entries[i].img) return;
  CF.entries[i].img = pic.img || '';
  CF.entries[i].big = pic.big || '';
  const front = CF.els[i]?.querySelector('.cf-front');
  if (front) front.innerHTML = cfFrontHtml(CF.entries[i]);
  cfLayout();
}

function albumEntries(g) {
  const list = g.items.map((it) => ({ key: it.mbid || it.id, title: it.title, sub: it.year || '', cover: it.cover, item: it, sortYear: it.year || '9999' }));
  const disco = g.mbid && discoMem.get(g.mbid)?.data;
  if (disco) {
    for (const a of studioAlbums(disco)) {
      if (ownedAlbum(a, g.mbid)) continue;
      list.push({ key: a.mbid, title: a.title, sub: a.year ? `${a.year} · fehlt dir noch` : 'fehlt dir noch', cover: a.cover, missing: true, album: a, sortYear: a.date || '9999' });
    }
  }
  return list.sort((a, b) => a.sortYear.localeCompare(b.sortYear) || collator.compare(a.title, b.title));
}

function renderFlow(level, key = '') {
  const g = level === 'albums' ? libraryGroups().find((x) => x.key === key) : null;
  if (level === 'albums' && !g) { location.replace('#/'); return; }
  const entries = level === 'artists' ? artistEntries() : albumEntries(g);
  Object.assign(CF, { level, key, entries, flipped: -1, shown: -1, fast: false });
  if (g) state.current = { kind: 'flow', g };

  const nav = level === 'artists'
    ? header('', {
      compact: true,
      left: `<a class="glass-btn round" href="#/menu" aria-label="Menü">${icon('menu', 22)}</a>`,
      actions: `<button class="glass-btn round" data-action="add-menu" aria-label="CDs hinzufügen">${icon('plus', 24)}</button>`,
    })
    : header(g.name, {
      back: true,
      compact: true,
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

  view().innerHTML = `${nav}
    <div class="cf-stage ${spConnected ? 'with-np' : ''}" id="cf-stage">
      ${entries.map((e, i) => `<div class="cf-item ${e.missing ? 'missing' : ''}" data-i="${i}" style="display:none">
        <div class="cf-card">
          <div class="cf-front">${cfFrontHtml(e)}</div>
          ${level === 'albums' ? '<div class="cf-back"></div>' : ''}
        </div>
      </div>`).join('')}
    </div>
    <div class="cf-info"><div class="cf-title"></div><div class="cf-sub"></div></div>
    ${entries.length > 1 ? `<input class="cf-scrub" id="cf-scrub" type="range" min="0" max="${entries.length - 1}" step="1" value="0" aria-label="Schnell blättern">` : ''}
    ${spConnected ? npHtml() : ''}`;
  if (spConnected) npTick();
  CF.els = [...document.querySelectorAll('.cf-item')];
  // dort weitermachen, wo man zuletzt war
  const memKey = `${level}:${key}`;
  const start = Math.max(0, entries.findIndex((e) => e.key === CF.mem[memKey]));
  CF.pos = start;
  CF.target = start;
  cfBind();
  cfLayout();
  cfSettle();

  // Diskografie fehlt noch? Laden und fehlende Alben grau dazustellen
  if (level === 'albums' && g.mbid && !discoMem.get(g.mbid)) {
    getDisco(g.mbid).then(() => {
      if (route()[0] === 'flow' && route()[1] === key && CF.flipped < 0) renderFlow('albums', key);
    }).catch(() => {});
  }
}

function cfLayout() {
  const stage = $('#cf-stage');
  if (!stage) return false;
  CF.size = Math.round(Math.min(stage.clientWidth * 0.56, stage.clientHeight * 0.58, 320));
  stage.style.setProperty('--cf', `${CF.size}px`);
  const s = CF.size;
  CF.els.forEach((el, i) => {
    const d = i - CF.pos;
    const ad = Math.abs(d);
    const imgs = el.querySelectorAll('.cf-front img');
    if (ad > CF_WINDOW + 0.5) {
      if (el.style.display !== 'none') el.style.display = 'none';
      // weit weg: Bilder aus dem Speicher werfen (sonst stürzt Safari bei großen Sammlungen ab)
      if (ad > CF_WINDOW * 2) imgs.forEach((img) => { if (img.hasAttribute('src')) img.removeAttribute('src'); });
      return;
    }
    if (el.style.display === 'none') el.style.display = '';
    if (!CF.fast) {
      imgs.forEach((img) => { if (!img.hasAttribute('src')) { img.classList.remove('broken'); img.src = img.dataset.src; } });
    }
    // Wie Cover Flow: das Cover dreht sich schon früh weg (r), während es zur Seite gleitet.
    // So berühren sich zwei Cover in der Mitte einer Bewegung nie.
    const c = Math.max(-1, Math.min(1, d));
    const r = Math.min(1, ad * 1.6) * Math.sign(d);
    const x = (c * 0.46 + d * 0.14) * s;
    const z = -Math.min(1, ad) * 0.45 * s;
    el.style.transform = `translate3d(${x.toFixed(1)}px,0,${z.toFixed(1)}px) rotateY(${(-r * 70).toFixed(2)}deg)`;
    el.style.zIndex = String(1000 - Math.round(ad * 100));
  });
  const cur = Math.max(0, Math.min(CF.entries.length - 1, Math.round(CF.pos)));
  if (cur !== CF.shown) {
    CF.shown = cur;
    const e = CF.entries[cur];
    $('.cf-title').textContent = e.title;
    $('.cf-sub').textContent = e.sub;
    const scrub = $('#cf-scrub');
    if (scrub && document.activeElement !== scrub) scrub.value = cur;
    if (CF.flipped >= 0 && CF.flipped !== cur) cfUnflip();
  }
  return true;
}

// Wenn das Blättern zur Ruhe kommt: Position merken, Mitte in hoher Auflösung laden
function cfSettle() {
  clearTimeout(CF.settleTimer);
  CF.settleTimer = setTimeout(() => {
    const cur = Math.round(CF.pos);
    const e = CF.entries[cur];
    if (!e || !$('#cf-stage')) return;
    CF.mem[`${CF.level}:${CF.key}`] = e.key;
    const img = CF.els[cur]?.querySelector('.cf-front > .cf-cover img');
    const hiSrc = img?.dataset.big || (/\/front-250$/.test(img?.dataset.src || '') ? img.dataset.src.replace(/\/front-250$/, '/front-500') : '');
    if (img && hiSrc && hiSrc !== img.getAttribute('src') && img.hasAttribute('src')) {
      const hi = hiSrc;
      const probe = new Image();
      probe.onload = () => { if (img.isConnected) img.src = hi; };
      probe.src = hi;
    }
  }, 350);
}

function cfAnimate() {
  cancelAnimationFrame(CF.raf);
  const step = () => {
    const diff = CF.target - CF.pos;
    if (Math.abs(diff) < 0.002) { CF.pos = CF.target; cfLayout(); cfSettle(); return; }
    CF.pos += diff * 0.16;
    if (cfLayout()) CF.raf = requestAnimationFrame(step);
  };
  CF.raf = requestAnimationFrame(step);
}

function cfGo(i) {
  CF.target = Math.max(0, Math.min(CF.entries.length - 1, i));
  cfAnimate();
}

function cfUnflip() {
  if (CF.flipped < 0) return;
  CF.els[CF.flipped]?.classList.remove('flipped');
  CF.flipped = -1;
}

function cfBackHtml(i, det, err) {
  const e = CF.entries[i];
  const artist = state.current?.g?.name || '';
  const sp = { artist, title: e.title, sid: det?.spotify || '' };
  let list = '<p class="hint"><span class="spinner small"></span> Lade Titel …</p>';
  if (det) list = tracksHtml(det, sp);
  else if (err) list = `<p class="hint">${esc(err)}</p>`;
  const wished = e.missing && isWished(`mb:${e.album.mbid}`);
  return `<div class="cf-back-head">
      <div class="cf-back-titles"><b>${esc(e.title)}</b><span>${esc(artist)}</span></div>
      ${e.missing ? `<button class="cf-round ${wished ? 'on' : ''}" data-action="cf-wish" data-i="${i}" aria-label="Wunschliste">${icon('heart', 18)}</button>` : ''}
      <button class="cf-round" data-action="cf-more" data-i="${i}" aria-label="Mehr">${icon('more', 18)}</button>
      <button class="cf-play" ${spData(sp)} data-action="sp-play" aria-label="Abspielen">${icon('play', 20)}</button>
    </div>
    <div class="cf-back-list">${list}</div>`;
}

async function cfFlip(i) {
  if (CF.flipped === i) { cfUnflip(); return; }
  cfUnflip();
  const el = CF.els[i];
  const e = CF.entries[i];
  const mbid = e.missing ? e.album.mbid : e.item?.mbid;
  const back = el.querySelector('.cf-back');
  back.innerHTML = cfBackHtml(i, null, mbid ? null : 'Keine Titelliste – ordne das Album über „Treffer ändern“ zu.');
  const stage = $('#cf-stage');
  stage.style.setProperty('--flip-scale', Math.max(1.05, Math.min((stage.clientWidth - 32) / CF.size, 1.45)).toFixed(3));
  el.classList.add('flipped');
  CF.flipped = i;
  if (!mbid) return;
  try {
    const det = await loadAlbumDetails(mbid);
    if (CF.flipped === i) back.innerHTML = cfBackHtml(i, det);
  } catch (err) {
    if (CF.flipped === i) back.innerHTML = cfBackHtml(i, null, err.message);
  }
}

function cfTap(i) {
  const e = CF.entries[i];
  if (CF.level === 'artists') location.hash = `#/flow/${enc(e.key)}`;
  else cfFlip(i);
}

function cfBind() {
  const stage = $('#cf-stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cf-back-titles')) { cfUnflip(); return; } // Titel antippen = zurückdrehen
    if (e.target.closest('.cf-back')) return; // Titelliste darf scrollen, Knöpfe dürfen klicken
    cancelAnimationFrame(CF.raf);
    drag = { x: e.clientX, pos: CF.pos, lastX: e.clientX, lastT: performance.now(), vel: 0, moved: false, item: e.target.closest('.cf-item') };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 6) drag.moved = true;
    const spacing = CF.size * 0.32;
    CF.pos = Math.max(-0.4, Math.min(CF.entries.length - 0.6, drag.pos - dx / spacing));
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    drag.vel = drag.vel * 0.6 + (-(e.clientX - drag.lastX) / spacing / dt * 1000) * 0.4;
    drag.lastX = e.clientX;
    drag.lastT = now;
    cfLayout();
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      const i = d.item ? Number(d.item.dataset.i) : Math.round(CF.pos);
      if (i === Math.round(CF.target) && Math.abs(CF.pos - i) < 0.3) cfTap(i);
      else cfGo(i);
      return;
    }
    cfGo(Math.round(CF.pos + Math.max(-8, Math.min(8, d.vel * 0.22))));
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  const scrub = $('#cf-scrub');
  scrub?.addEventListener('input', () => {
    // schnelles Schieben: erst Bilder laden, wenn der Finger kurz ruht
    CF.fast = true;
    clearTimeout(CF.fastTimer);
    CF.fastTimer = setTimeout(() => { CF.fast = false; cfLayout(); }, 180);
    cfGo(Number(scrub.value));
  });
}

window.addEventListener('resize', () => { if ($('#cf-stage')) cfLayout(); });
document.addEventListener('keydown', (e) => {
  if (!$('#cf-stage') || document.activeElement?.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') cfGo(Math.round(CF.target) + 1);
  if (e.key === 'ArrowLeft') cfGo(Math.round(CF.target) - 1);
  if (e.key === 'Enter') cfTap(Math.round(CF.target));
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
      <a class="cell" href="#/">${cellIc('flow')}<span class="cell-label">Durchblättern</span>${chev()}</a>
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
      <span class="tn">${esc(t.n)}</span><span class="tt">${esc(t.title)}</span><span class="td">${fmtDur(t.ms)}</span></li>`).join('')}</ol>`).join('')
    + `<p class="tracks-foot">${all.length} Titel${total ? `, ${Math.round(total / 60000)} Minuten` : ''}</p>`;
}

// Abspielen: mit Spotify-Verbindung im Hintergrund (Spotify Connect), sonst die Spotify-App öffnen
let spConnected = false;

// ---------- Mini-Player im Blätter-Bildschirm: was läuft gerade, Play/Pause, vor, zurück ----------
let npTimer = 0;
let npPlaying = false;

function npHtml() {
  return `<div class="np glass" id="np">
    <div class="np-art"><img alt="" hidden></div>
    <div class="np-text"><span class="np-title">Spotify</span><span class="np-sub">Album antippen und abspielen</span></div>
    <button class="np-btn" data-action="np-prev" aria-label="Vorheriger Titel">${icon('prev', 22)}</button>
    <button class="np-btn main" data-action="np-toggle" aria-label="Abspielen oder Pause">${icon('play', 22)}</button>
    <button class="np-btn" data-action="np-next" aria-label="Nächster Titel">${icon('next', 22)}</button>
  </div>`;
}

function npShow(st, err) {
  const box = $('#np');
  if (!box) return;
  const t = st?.item;
  box.querySelector('.np-title').textContent = t ? t.name : (err ? 'Spotify' : 'Gerade läuft nichts');
  box.querySelector('.np-sub').textContent = t
    ? [(t.artists || []).map((a) => a.name).join(', '), st.device?.name].filter(Boolean).join(' · ')
    : (err || 'Album antippen und abspielen');
  const img = box.querySelector('.np-art img');
  const pics = (t?.album?.images || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  const pic = pics.find((p) => (p.width || 0) >= 64) || pics[0];
  if (pic) { if (img.getAttribute('src') !== pic.url) img.src = pic.url; img.hidden = false; } else img.hidden = true;
  npSetPlaying(!!st?.is_playing);
}

function npSetPlaying(playing) {
  npPlaying = playing;
  const b = $('#np [data-action="np-toggle"]');
  if (b) b.innerHTML = icon(playing ? 'pause' : 'play', 22);
}

// Alle 5 Sekunden nachsehen, solange der Blätter-Bildschirm sichtbar ist
async function npTick() {
  clearTimeout(npTimer);
  if (!spConnected || !$('#np')) return;
  if (document.visibilityState === 'visible') {
    try { npShow(await spotify.playerState()); } catch (e) { npShow(null, e.message); }
  }
  npTimer = setTimeout(npTick, 5000);
}

async function npCommand(fn, playingAfter) {
  try {
    await fn();
    if (playingAfter !== undefined) npSetPlaying(playingAfter);
  } catch (e) {
    if (e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404) toast('Spotify läuft gerade nicht – spiel zuerst ein Album ab.');
    else toast(e.message, 'error');
  }
  setTimeout(npTick, 700);
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
  if (spConnected) fillSpDevices();
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

  // Knöpfe auf der Rückseite eines umgedrehten Albums
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
  'np-toggle': () => npCommand(() => (npPlaying ? spotify.pause() : spotify.resume()), !npPlaying),
  'np-next': () => npCommand(() => spotify.next()),
  'np-prev': () => npCommand(() => spotify.previous()),

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
    const pending = await getCache('pendingScan');
    if (Array.isArray(pending?.data)) state.scan.rows = pending.data.filter((r) => r.type !== 'dvd');
    spConnected = await spotify.isConnected();
  } catch (e) {
    toast(`Der Speicher konnte nicht geöffnet werden: ${e.message}`, 'error');
  }
  changed();
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
