// Regal – deine CD- und DVD-Sammlung
// Alles läuft im Browser auf dem iPhone, die Daten bleiben in der App (IndexedDB).
import { db, getSetting, setSetting, getCache, setCache } from './db.js';
import * as mb from './musicbrainz.js';
import * as tmdb from './tmdb.js';
import * as video from './video.js';
import * as gemini from './gemini.js';
import { $, esc, norm, hue, uid, icon, toast, openSheet, closeSheet, prepareImage } from './util.js';

const APP_VERSION = '1.4.1';
const DAY = 864e5;
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
const sortName = (s) => String(s || '').replace(/^(the|die|der|das)\s+/i, '');
const today = () => new Date().toISOString().slice(0, 10);

const state = {
  items: [],
  wishes: [],
  version: 0,
  geminiKey: '',
  tmdbKey: '',
  includeLive: false,
  libTab: 'cd',
  sortBy: { cd: 'artist', dvd: 'title' },
  search: '',
  gapTab: 'cd',
  gapFilter: 'all',
  albumFilter: 'all',
  current: null, // Daten der gerade offenen Detailseite (Interpret, Filmreihe, Serie)
  scan: { rows: [], busy: false, matching: false, status: '' },
};

const view = () => $('#view');

// =====================================================================
// Schneller Zugriff: wer/was ist schon in der Sammlung?
// =====================================================================
let indexCache = { version: -1 };

function getIndex() {
  if (indexCache.version === state.version) return indexCache;
  const byMbid = new Map();
  const byArtistTitle = new Map();
  const byKey = new Map();
  const byVid = new Map();
  for (const it of state.items) {
    if (it.type === 'cd') {
      if (it.mbid) byMbid.set(it.mbid, it);
      if (it.artistMbid) byArtistTitle.set(`${it.artistMbid}|${norm(it.title)}`, it);
      byKey.set(`cd|${norm(it.artist)}|${norm(it.title)}`, it);
    } else {
      byKey.set(`dvd|${norm(it.title)}`, it);
      if (it.vid) {
        if (!byVid.has(it.vid)) byVid.set(it.vid, []);
        byVid.get(it.vid).push(it);
      }
    }
  }
  indexCache = { version: state.version, byMbid, byArtistTitle, byKey, byVid };
  return indexCache;
}

const changed = () => { state.version++; };

function isDuplicate(m) {
  const idx = getIndex();
  if (m.type === 'cd') {
    if (m.mbid && idx.byMbid.has(m.mbid)) return true;
    return idx.byKey.has(`cd|${norm(m.artist)}|${norm(m.title)}`);
  }
  if (m.vid) {
    const owned = idx.byVid.get(m.vid) || [];
    if (!owned.length) return false;
    if (m.kind !== 'tv') return true;
    const have = new Set(owned.flatMap((i) => i.seasons || []));
    const want = m.seasons || [];
    return want.length ? want.every((s) => have.has(s)) : true;
  }
  return idx.byKey.has(`dvd|${norm(m.title)}`);
}

// =====================================================================
// Sammlung speichern
// =====================================================================
function itemFromMatch(m, source) {
  const it = {
    id: uid(),
    addedAt: Date.now(),
    source,
    type: m.type,
    title: m.title || '',
    artist: m.type === 'cd' ? (m.artist || '') : '',
    year: m.year || '',
    cover: m.cover || '',
  };
  if (m.type === 'cd') {
    Object.assign(it, {
      kind: 'album',
      mbid: m.mbid || null,
      artistMbid: m.artistMbid || null,
      artistName: m.artistName || m.artist || '',
    });
  } else {
    Object.assign(it, {
      kind: m.kind || 'movie',
      vid: m.vid || null,
      collectionId: m.collectionId || null,
      collectionName: m.collectionName || '',
      seasons: m.seasons || [],
    });
  }
  return it;
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

// Filme: gehört er zu einer Reihe? Serien-Box „komplett“: alle Staffeln eintragen
async function enrichVideo(m, { complete = false } = {}) {
  if (m.type !== 'dvd' || !m.vid) return m;
  try {
    await video.enrich(m);
    if (m.kind === 'tv' && complete) {
      const tv = await cachedTv(m.vid);
      m.seasons = tv.seasons.map((s) => s.number);
    }
  } catch { /* ohne Zusatzinfos speichern */ }
  return m;
}

// =====================================================================
// Wunschliste
// =====================================================================
function wishId(o) {
  if (o.type === 'cd') return `mb:${o.mbid}`;
  if (o.kind === 'tv') return `tv:${o.vid}:${o.season}`;
  return `movie:${o.vid}`;
}

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
  updateTabBadges();
}

async function removeWish(id) {
  state.wishes = state.wishes.filter((x) => x.id !== id);
  await db.del('wishes', id);
  updateTabBadges();
}

async function removeWishFor(item) {
  const ids = [];
  if (item.type === 'cd' && item.mbid) ids.push(`mb:${item.mbid}`);
  if (item.kind === 'movie' && item.vid) ids.push(`movie:${item.vid}`);
  if (item.kind === 'tv' && item.vid) (item.seasons || []).forEach((s) => ids.push(`tv:${item.vid}:${s}`));
  for (const id of ids) if (isWished(id)) await removeWish(id);
}

// =====================================================================
// Bausteine für die Darstellung
// =====================================================================
function coverHtml(o, cls = '', extra = '') {
  return `<div class="cover ${o.type === 'dvd' ? 'poster' : ''} ${cls}" style="--h:${hue((o.title || '') + (o.artist || ''))}">
    <span class="ph">${esc(o.title || '?')}</span>
    ${o.cover ? `<img src="${esc(o.cover)}" loading="lazy" alt="">` : ''}
    ${extra}
  </div>`;
}

const bigCover = (url) => String(url || '').replace('/front-250', '/front-500').replace('/w342/', '/w500/');

function compactRange(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i + 1 ? `${s[i]}–${s[j]}` : (j === i + 1 ? `${s[i]}, ${s[j]}` : `${s[i]}`));
    i = j;
  }
  return out.join(', ');
}

function seasonsLabel(o) {
  const s = o.seasons || [];
  if (!s.length) return '';
  return (s.length === 1 ? 'Staffel ' : 'Staffeln ') + compactRange(s);
}

function parseSeasons(str) {
  const out = [];
  String(str || '').replace(/(\d+)\s*[-–]\s*(\d+)|(\d+)/g, (_, a, b, c) => {
    if (c) out.push(+c);
    else for (let n = +a; n <= +b && n - a < 50; n++) out.push(n);
    return '';
  });
  return [...new Set(out.filter((n) => n > 0))].sort((a, b) => a - b);
}

function videoLabel(o) {
  return [o.kind === 'tv' ? 'Serie' : 'Film', o.year, seasonsLabel(o)].filter(Boolean).join(' · ');
}

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

function cardHtml(it) {
  const sub = it.type === 'cd' ? it.artist : videoLabel(it);
  return `<button class="card" data-action="item" data-id="${it.id}">
    ${coverHtml(it)}
    <span class="card-title">${esc(it.title)}</span>
    <span class="card-sub">${esc(sub)}</span>
  </button>`;
}

// Kopfzeile wie in iOS 26: schwebende Glas-Knöpfe oben, großer Titel darunter,
// beim Scrollen erscheint ein kleiner Titel in der Mitte
function header(title, { back = false, actions = '' } = {}) {
  return `<div class="navbar">
    <div class="nav-side">${back ? `<button class="glass-btn round" data-action="back" aria-label="Zurück">${icon('back', 24)}</button>` : ''}</div>
    <div class="nav-title">${esc(title)}</div>
    <div class="nav-side right">${actions ? `<div class="glass-group">${actions}</div>` : ''}</div>
  </div>
  <h1 class="large-title">${esc(title)}</h1>`;
}

function setTitle(text) {
  document.querySelectorAll('.nav-title, .large-title').forEach((el) => { el.textContent = text; });
}

// Umschalter mit gleitendem Glas-Knopf (merkt sich die alte Position für die Animation)
const segMem = {};

function segHtml(id, action, options, active) {
  const i = Math.max(0, options.findIndex(([v]) => v === active));
  const from = segMem[id] ?? i;
  return `<div class="seg" data-seg="${id}" data-to="${i}" style="--n:${options.length};--i:${from}">
    ${options.map(([v, label]) => `<button data-action="${action}" data-tab="${v}" class="${v === active ? 'on' : ''}">${label}</button>`).join('')}
  </div>`;
}

function animateSegs() {
  document.querySelectorAll('.seg[data-seg]').forEach((el) => {
    const to = Number(el.dataset.to);
    void el.offsetWidth; // alte Position erst zeichnen, dann gleiten
    el.style.setProperty('--i', to);
    segMem[el.dataset.seg] = to;
  });
}

function progressHtml(owned, total, label) {
  const pct = total ? Math.round((owned / total) * 100) : 0;
  const done = total > 0 && owned >= total;
  return `<div class="progress-head"><span>${owned} von ${total} ${label}</span><span class="muted">${pct} %</span></div>
    <div class="bar big ${done ? 'done' : ''}"><i style="width:${pct}%"></i></div>`;
}

// =====================================================================
// Navigation
// =====================================================================
let lastPage = '';

function route() {
  return (location.hash.replace(/^#\/?/, '') || 'sammlung').split('/').map(decodeURIComponent);
}

function render() {
  closeSheet();
  state.current = null;
  const r = route();
  const key = r.join('/');
  if (key !== lastPage) { window.scrollTo(0, 0); lastPage = key; }
  setActiveTab(r[0]);
  const [page, sub, id] = r;
  if (page === 'sammlung' || page === 'luecken') {
    if (sub === 'artist') renderArtist(id);
    else if (sub === 'gruppe') renderNameGroup(id);
    else if (sub === 'reihe') renderCollection(id);
    else if (sub === 'serie') renderSeries(id);
    else if (page === 'sammlung') renderLibrary();
    else renderGaps();
  } else if (page === 'scan') renderScan();
  else if (page === 'wuensche') renderWishes();
  else if (page === 'einstellungen') renderSettings();
  else location.replace('#/sammlung');
}

// Schwebende Tab-Leiste wie in iOS 26: Glas-Kapsel mit gleitendem Glas-Tropfen
// und daneben ein runder Kamera-Knopf (wie der Such-Knopf bei Apple)
const TABS = [['sammlung', 'grid', 'Sammlung'], ['luecken', 'checklist', 'Lücken'], ['wuensche', 'heart', 'Wünsche']];

function renderTabbar() {
  $('#tabbar').innerHTML = `
    <div class="tab-pill glass" style="--ti:0">
      <span class="tab-indicator"></span>
      ${TABS.map(([id, ic, label]) => `<a href="#/${id}" data-tab="${id}">
        <span class="tab-ic">${icon(ic, 24)}<i class="dot" hidden></i></span><span>${label}</span>
      </a>`).join('')}
    </div>
    <a class="tab-fab glass" href="#/scan" data-tab="scan" aria-label="Regal scannen">
      <span class="tab-ic">${icon('camera', 27)}<i class="dot" hidden></i></span>
    </a>`;
}

function setActiveTab(page) {
  const p = page === 'einstellungen' ? 'sammlung' : page;
  const idx = TABS.findIndex(([id]) => id === p);
  const pill = $('#tabbar .tab-pill');
  if (idx >= 0) pill.style.setProperty('--ti', idx);
  pill.classList.toggle('none', idx < 0);
  document.querySelectorAll('#tabbar [data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === p));
}

function updateTabBadges() {
  const scanDot = $('#tabbar [data-tab="scan"] .dot');
  if (scanDot) scanDot.hidden = !state.scan.rows.length;
  const wishDot = $('#tabbar [data-tab="wuensche"] .dot');
  if (wishDot) {
    wishDot.hidden = !state.wishes.length;
    wishDot.textContent = state.wishes.length > 99 ? '99+' : String(state.wishes.length || '');
    wishDot.classList.add('count');
  }
}

// =====================================================================
// 1) Sammlung
// =====================================================================
function renderLibrary() {
  const cds = state.items.filter((i) => i.type === 'cd').length;
  const dvds = state.items.length - cds;
  const isCd = state.libTab === 'cd';
  const sorts = isCd
    ? [['artist', 'Name'], ['count', 'Anzahl'], ['added', 'Neueste']]
    : [['title', 'Titel'], ['year', 'Jahr'], ['added', 'Neueste']];
  const curSort = state.sortBy[state.libTab];
  view().innerHTML = `
    ${header('Deine Sammlung', {
    actions: `<button class="icon-btn" data-action="add" aria-label="Von Hand hinzufügen">${icon('plus', 24)}</button>
      <a class="icon-btn" href="#/einstellungen" aria-label="Einstellungen">${icon('settings', 22)}</a>`,
  })}
    ${segHtml('lib', 'lib-tab', [['cd', `CDs <b>${cds}</b>`], ['dvd', `DVDs <b>${dvds}</b>`]], state.libTab)}
    <div class="toolbar">
      <label class="search">${icon('search', 18)}<input id="lib-q" type="search" placeholder="${isCd ? 'Interpret oder Album' : 'Film oder Serie'}" value="${esc(state.search)}" autocomplete="off"></label>
      <select id="lib-sort" aria-label="Sortierung">
        ${sorts.map(([v, l]) => `<option value="${v}" ${curSort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div id="lib-grid"></div>`;
  $('#lib-q').addEventListener('input', (e) => { state.search = e.target.value; fillLibrary(); });
  $('#lib-sort').addEventListener('change', (e) => {
    state.sortBy[state.libTab] = e.target.value;
    setSetting('sortBy', state.sortBy);
    fillLibrary();
  });
  animateSegs();
  fillLibrary();
}

function fillLibrary() {
  const box = $('#lib-grid');
  if (!box) return;
  const all = state.items.filter((i) => i.type === state.libTab);
  if (!all.length) { box.innerHTML = emptyLibrary(); return; }
  if (state.libTab === 'cd') fillArtistGrid(box);
  else fillVideoGrid(box);
}

// ---------- DVDs: Filmreihen und Serien zusammengefasst, Einzelfilme einzeln ----------
function videoGroups() {
  const map = new Map();
  const out = [];
  for (const it of state.items) {
    if (it.type !== 'dvd') continue;
    let key = null;
    if (it.kind === 'movie' && it.collectionId) key = `col:${it.collectionId}`;
    else if (it.kind === 'tv' && it.vid) key = `tv:${it.vid}`;
    if (!key) { out.push({ kind: 'single', key: it.id, name: it.title, items: [it] }); continue; }
    if (!map.has(key)) {
      const g = {
        kind: it.kind === 'tv' ? 'tv' : 'col',
        key,
        id: it.kind === 'tv' ? it.vid : it.collectionId,
        name: it.kind === 'tv' ? it.title : (it.collectionName || it.title),
        items: [],
      };
      map.set(key, g);
      out.push(g);
    }
    map.get(key).items.push(it);
  }
  for (const g of out) {
    const data = g.kind !== 'single' && videoMem.get(g.key);
    if (data?.name) g.name = data.name;
  }
  return out;
}

function videoGroupInfo(g) {
  const sorted = g.items.slice().sort(byYear);
  let cover = (sorted.find((i) => i.cover) || sorted[0]).cover;
  let sub = '';
  const data = videoMem.get(g.key);
  if (g.kind === 'col') {
    const parts = data ? released(data.parts).sort((a, b) => a.date.localeCompare(b.date)) : [];
    if (parts.length) {
      if (parts[0].cover) cover = parts[0].cover; // erster Teil der Reihe als Bild
      const idx = getIndex();
      sub = `${parts.filter((p) => idx.byVid.has(p.vid)).length} von ${parts.length} Filmen`;
    } else sub = g.items.length === 1 ? '1 Film' : `${g.items.length} Filme`;
  } else {
    const have = new Set(g.items.flatMap((i) => i.seasons || []));
    const seasons = data ? data.seasons.filter((s) => !s.date || s.date <= today()) : [];
    if (seasons.length) {
      sub = `${seasons.filter((s) => have.has(s.number)).length} von ${seasons.length} Staffeln`;
      cover = cover || data.cover;
    } else sub = seasonsLabel({ seasons: [...have] }) || 'Serie';
  }
  return { cover, sub };
}

function videoCardHtml(g) {
  if (g.kind === 'single') return cardHtml(g.items[0]);
  const { cover, sub } = videoGroupInfo(g);
  const href = `#/sammlung/${g.kind === 'col' ? 'reihe' : 'serie'}/${encodeURIComponent(g.id)}`;
  return `<a class="card" href="${href}">
    ${coverHtml({ type: 'dvd', title: g.name, cover }, 'stack', `<span class="kind-tag">${g.kind === 'col' ? 'Reihe' : 'Serie'}</span>`)}
    <span class="card-title">${esc(g.name)}</span>
    <span class="card-sub">${esc(sub)}</span>
  </a>`;
}

function fillVideoGrid(box) {
  const qn = norm(state.search);
  let groups = videoGroups();
  const counts = { col: 0, tv: 0, single: 0 };
  groups.forEach((g) => { counts[g.kind]++; });
  if (qn) groups = groups.filter((g) => norm(g.name).includes(qn) || g.items.some((i) => norm(i.title).includes(qn)));
  const s = state.sortBy.dvd;
  const first = (g) => g.items.map((i) => i.year || '9999').sort()[0];
  const newest = (g) => Math.max(...g.items.map((i) => i.addedAt));
  groups.sort((a, b) => {
    if (s === 'added') return newest(b) - newest(a);
    if (s === 'year') return first(a).localeCompare(first(b)) || collator.compare(sortName(a.name), sortName(b.name));
    return collator.compare(sortName(a.name), sortName(b.name));
  });
  const dvds = state.items.filter((i) => i.type === 'dvd').length;
  const parts = [dvds === 1 ? '1 DVD' : `${dvds} DVDs`];
  if (counts.col) parts.push(counts.col === 1 ? '1 Filmreihe' : `${counts.col} Filmreihen`);
  if (counts.tv) parts.push(counts.tv === 1 ? '1 Serie' : `${counts.tv} Serien`);
  box.innerHTML = groups.length
    ? `<p class="muted small lib-count">${parts.join(' · ')}</p>
       <div class="grid dvd">${groups.map(videoCardHtml).join('')}</div>`
    : `<p class="empty-small">Nichts gefunden für „${esc(state.search)}“.</p>`;
  if (groups.some((g) => g.kind !== 'single' && !videoMem.has(g.key) && !videoTried.has(g.key))) preloadVideos();
}

// ---------- CDs: nach Interpret gruppiert ----------
function libraryGroups() {
  const map = new Map();
  for (const it of state.items) {
    if (it.type !== 'cd') continue;
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
  return [...map.values()];
}

const groupHref = (g) => (g.mbid ? `#/sammlung/artist/${g.mbid}` : `#/sammlung/gruppe/${encodeURIComponent(g.key)}`);
const byYear = (a, b) => (a.year || '9999').localeCompare(b.year || '9999') || collator.compare(a.title, b.title);

function artistCardHtml(g) {
  const sorted = g.items.slice().sort(byYear);
  const withCover = sorted.filter((i) => i.cover);
  const art = withCover.length >= 4
    ? `<div class="cover mosaic" style="--h:${hue(g.name)}">${withCover.slice(0, 4).map((i) => `<img src="${esc(i.cover)}" loading="lazy" alt="">`).join('')}</div>`
    : coverHtml({ type: 'cd', title: g.name, artist: '', cover: (withCover[0] || sorted[0]).cover });
  let sub = g.items.length === 1 ? '1 CD' : `${g.items.length} CDs`;
  const disco = g.mbid && discoMem.get(g.mbid)?.data;
  if (disco) {
    const p = discoProgress(g.mbid, disco);
    if (p.total) sub = `${p.owned} von ${p.total} Alben`;
  }
  return `<a class="card" href="${groupHref(g)}">
    ${art}
    <span class="card-title">${esc(g.name)}</span>
    <span class="card-sub">${esc(sub)}</span>
  </a>`;
}

function fillArtistGrid(box) {
  const qn = norm(state.search);
  let groups = libraryGroups();
  const total = groups.length;
  if (qn) groups = groups.filter((g) => norm(g.name).includes(qn) || g.items.some((i) => norm(i.title).includes(qn)));
  const s = state.sortBy.cd;
  const newest = (g) => Math.max(...g.items.map((i) => i.addedAt));
  groups.sort((a, b) => {
    if (s === 'count') return b.items.length - a.items.length || collator.compare(sortName(a.name), sortName(b.name));
    if (s === 'added') return newest(b) - newest(a);
    if (a.various !== b.various) return a.various ? 1 : -1; // Sampler ans Ende
    return collator.compare(sortName(a.name), sortName(b.name));
  });
  const cds = state.items.filter((i) => i.type === 'cd').length;
  box.innerHTML = groups.length
    ? `<p class="muted small lib-count">${total === 1 ? '1 Interpret' : `${total} Interpreten`} · ${cds === 1 ? '1 CD' : `${cds} CDs`}</p>
       <div class="grid cd">${groups.map(artistCardHtml).join('')}</div>`
    : `<p class="empty-small">Nichts gefunden für „${esc(state.search)}“.</p>`;
}

// Interpret ohne Datenbank-Treffer (oder Sampler): nur die eigenen CDs zeigen
function renderNameGroup(key) {
  const g = libraryGroups().find((x) => x.key === key);
  state.current = { kind: 'group', key };
  view().innerHTML = `${header(g?.name || 'Interpret', { back: true })}
    <div id="detail-body">
      ${!g ? '<p class="empty-small">Hier ist nichts mehr.</p>' : `
        ${g.various ? '' : '<p class="hint">Für diesen Interpreten gibt es noch keinen Datenbank-Treffer. Tippe ein Album an → „Treffer ändern“ – dann siehst du hier auch alle Alben, die dir noch fehlen.</p>'}
        <div class="grid cd">${g.items.slice().sort(byYear).map(cardHtml).join('')}</div>`}
    </div>`;
}

function emptyLibrary() {
  const cd = state.libTab === 'cd';
  return `<div class="empty">
    ${icon(cd ? 'disc' : 'movie', 46)}
    <h2>${cd ? 'Noch keine CDs' : 'Noch keine DVDs'}</h2>
    <p>Fotografiere dein Regal – die App erkennt die Hüllen und legt sie hier mit Cover ab.</p>
    <a class="btn primary" href="#/scan">${icon('camera', 20)} Regal fotografieren</a>
    <button class="btn ghost" data-action="add">${icon('plus', 20)} Von Hand hinzufügen</button>
  </div>`;
}

function showItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  const meta = it.type === 'cd' ? [it.artist, it.year] : [videoLabel(it)];
  const links = [];
  const onThisArtist = state.current?.kind === 'artist' && state.current.mbid === it.artistMbid;
  if (it.type === 'cd' && it.artistMbid && it.artistMbid !== mb.VARIOUS_ARTISTS && !onThisArtist) {
    links.push(`<a class="btn" href="#/sammlung/artist/${it.artistMbid}">${icon('disc', 20)} Alle Alben von ${esc(it.artistName || it.artist)}</a>`);
  }
  const here = state.current;
  if (it.type === 'dvd' && it.collectionId && !(here?.kind === 'col' && here.id === it.collectionId)) {
    links.push(`<a class="btn" href="#/sammlung/reihe/${encodeURIComponent(it.collectionId)}">${icon('movie', 20)} Alle Filme: ${esc(it.collectionName || 'Filmreihe')}</a>`);
  }
  if (it.kind === 'tv' && it.vid && !(here?.kind === 'tv' && here.id === it.vid)) {
    links.push(`<a class="btn" href="#/sammlung/serie/${encodeURIComponent(it.vid)}">${icon('movie', 20)} Alle Staffeln</a>`);
  }
  openSheet(`<div class="detail">
    ${coverHtml({ ...it, cover: bigCover(it.cover) }, 'big')}
    <h2>${esc(it.title)}</h2>
    <p class="muted">${esc(meta.filter(Boolean).join(' · '))}</p>
    ${!it.mbid && !it.vid ? '<p class="hint">Ohne Datenbank-Treffer gespeichert. Mit „Treffer ändern“ findest du Cover und Infos.</p>' : ''}
    <div class="btn-col">
      ${links.join('')}
      <button class="btn" data-action="rematch" data-id="${it.id}">${icon('edit', 20)} Treffer ändern</button>
      <button class="btn danger" data-action="delete" data-id="${it.id}">${icon('trash', 20)} Aus der Sammlung löschen</button>
    </div>
    <p class="tiny">Hinzugefügt am ${new Date(it.addedAt).toLocaleDateString('de-DE')}${it.source === 'foto' ? ' per Foto' : ''}</p>
  </div>`);
}

function rematchItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  openSearch({
    heading: 'Treffer ändern',
    type: it.type,
    artist: it.artist,
    title: it.title,
    seasons: it.seasons,
    onPick: async (m) => {
      const fresh = itemFromMatch(await enrichVideo(m), it.source);
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
    heading: 'Von Hand hinzufügen',
    type: state.libTab,
    onPick: async (m) => {
      if (isDuplicate(m) && !confirm('Das ist schon in deiner Sammlung. Trotzdem nochmal hinzufügen?')) return;
      const it = itemFromMatch(await enrichVideo(m), 'hand');
      await addItems([it]);
      toast(`„${it.title}“ hinzugefügt`);
      state.libTab = it.type;
      render();
      preloadDiscographies();
    },
  });
}

// Suchblatt: für „Von Hand hinzufügen“, „Treffer ändern“ und „Eintrag korrigieren“
function openSearch({ heading, type = 'cd', artist = '', title = '', seasons = [], onPick, extraHtml = '', onExtra = null }) {
  let t = type;
  let results = [];
  const sheet = openSheet(`
    <h2>${esc(heading)}</h2>
    <div class="seg small" id="s-type" style="--n:2;--i:${type === 'cd' ? 0 : 1}">
      <button type="button" data-t="cd">${icon('disc', 18)} CD</button>
      <button type="button" data-t="dvd">${icon('movie', 18)} DVD</button>
    </div>
    <form class="form" id="s-form">
      <input id="s-artist" placeholder="Interpret" value="${esc(artist)}" autocomplete="off">
      <input id="s-title" placeholder="Albumtitel" value="${esc(title)}" autocomplete="off">
      <input id="s-seasons" placeholder="Staffeln, z. B. 1, 2 oder 1-3 (nur bei Serien)" value="${esc((seasons || []).join(', '))}" autocomplete="off">
      <button class="btn primary" type="submit">${icon('search', 20)} Suchen</button>
    </form>
    <div id="s-results" class="results"></div>
    <button class="btn ghost" type="button" id="s-raw">Ohne Treffer übernehmen</button>
    ${extraHtml}`);
  const q = (sel) => sheet.querySelector(sel);
  const sync = () => {
    sheet.querySelectorAll('#s-type button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    q('#s-type').style.setProperty('--i', t === 'cd' ? 0 : 1);
    q('#s-artist').hidden = t !== 'cd';
    q('#s-seasons').hidden = t !== 'dvd';
    q('#s-title').placeholder = t === 'cd' ? 'Albumtitel' : 'Film- oder Serientitel';
  };
  const values = () => ({
    artist: q('#s-artist').value.trim(),
    title: q('#s-title').value.trim(),
    seasons: parseSeasons(q('#s-seasons').value),
  });
  const go = async () => {
    const v = values();
    const box = q('#s-results');
    if (!v.title && !v.artist) { box.innerHTML = '<p class="hint">Gib einen Titel ein.</p>'; return; }
    box.innerHTML = '<p class="hint"><span class="spinner small"></span> Suche …</p>';
    try {
      results = t === 'cd' ? await mb.searchAlbums(v.artist, v.title) : await video.search(v.title);
      box.innerHTML = results.length
        ? results.map((r, i) => `<button class="result" type="button" data-i="${i}">
            ${coverHtml(r, 'thumb')}
            <span class="row-text"><span class="row-title">${esc(r.title)}</span>
            <span class="row-sub">${esc(r.type === 'cd' ? [r.artist, r.year, albumTypeLabel(r)].filter(Boolean).join(' · ') : videoLabel(r))}</span></span>
            ${r.kind !== 'tv' && isDuplicate(r) ? '<span class="badge">schon da</span>' : ''}
          </button>`).join('')
        : '<p class="hint">Keine Treffer. Prüf die Schreibweise – oder übernimm den Eintrag ohne Treffer.</p>';
    } catch (e) {
      box.innerHTML = `<p class="hint error">${esc(e.message)}</p>`;
    }
  };
  sync();
  sheet.querySelectorAll('#s-type button').forEach((b) => b.addEventListener('click', () => {
    t = b.dataset.t;
    sync();
    q('#s-results').innerHTML = '';
  }));
  q('#s-form').addEventListener('submit', (e) => { e.preventDefault(); document.activeElement?.blur(); go(); });
  q('#s-results').addEventListener('click', async (e) => {
    const b = e.target.closest('.result');
    if (!b || b.classList.contains('busy')) return;
    const r = { ...results[+b.dataset.i] };
    if (r.type === 'dvd' && r.kind === 'tv') r.seasons = values().seasons;
    b.classList.add('busy');
    try { await onPick(r); } finally { b.classList.remove('busy'); }
  });
  q('#s-raw').addEventListener('click', () => {
    const v = values();
    if (!v.title) { toast('Gib zuerst einen Titel ein.'); return; }
    onPick({
      type: t,
      artist: t === 'cd' ? v.artist : '',
      title: v.title,
      seasons: t === 'dvd' ? v.seasons : [],
      kind: t === 'cd' ? 'album' : (v.seasons.length ? 'tv' : 'movie'),
      raw: true,
    });
  });
  if (onExtra) sheet.addEventListener('click', (e) => { const x = e.target.closest('[data-extra]'); if (x) onExtra(x.dataset.extra); });
  if (title || artist) go();
}

// =====================================================================
// 2) Scannen: Foto -> Gemini -> Prüfliste -> Sammlung
// =====================================================================
const TIPS = `<div class="tips">
  <h3>So klappt die Erkennung am besten</h3>
  <ul>
    <li>Fotografiere das Regal in Abschnitten – etwa 20 bis 40 Hüllen pro Foto.</li>
    <li>Halte das Handy gerade vor die Rücken, sodass die Schrift scharf ist.</li>
    <li>Gutes Licht und möglichst keine Spiegelungen auf den Hüllen.</li>
    <li>Aus der Mediathek kannst du mehrere Fotos auf einmal wählen.</li>
    <li>Vor dem Speichern siehst du immer eine Prüfliste und kannst alles korrigieren.</li>
  </ul>
</div>`;

function renderScan() {
  view().innerHTML = `
    ${header('Regal scannen')}
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
        if (!items.length) toast(`${pre}Auf dem Foto wurde nichts erkannt.`);
        state.scan.rows.push(...items.map((f) => ({ ...f, id: uid(), checked: true, state: 'pending', match: null, dup: false })));
        saveScan();
        renderReview();
        updateTabBadges();
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

function rowObject(r) {
  if (r.match) return { ...r.match, type: r.type };
  return {
    type: r.type,
    artist: r.artist,
    title: r.title,
    seasons: r.seasons || [],
    kind: r.type === 'cd' ? 'album' : ((r.seasons || []).length || r.complete ? 'tv' : 'movie'),
  };
}

function sameThing(a, b) {
  if (a.type !== b.type) return false;
  if (a.mbid && b.mbid) return a.mbid === b.mbid;
  if (a.vid && b.vid) {
    return a.vid === b.vid && (a.kind !== 'tv' || String(a.seasons) === String(b.seasons));
  }
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
    if (r.type === 'cd') {
      const best = mb.pickBest(await mb.searchAlbums(r.artist, r.title), r.artist, r.title);
      r.match = best;
      r.state = best ? (best.sure && r.confidence !== 'low' ? 'found' : 'unsure') : 'none';
    } else {
      const clean = r.title.replace(/\s*[-–:,]?\s*(staffel|season|die komplette serie|komplette serie|the complete series)\b.*$/i, '').trim() || r.title;
      const wantTv = (r.seasons || []).length > 0 || r.complete;
      const best = video.pickBest(await video.search(clean), clean, wantTv);
      if (best) {
        if (best.kind === 'tv') best.seasons = r.seasons || [];
        await enrichVideo(best, { complete: r.complete && best.kind === 'tv' });
        r.match = best;
        r.state = best.sure && r.confidence !== 'low' ? 'found' : 'unsure';
      } else {
        r.state = 'none';
      }
    }
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
  const sub = r.type === 'cd' ? (o.artist || 'Interpret unbekannt') : videoLabel(o);
  const recognized = r.match && norm(r.match.title) !== norm(r.title)
    ? `<span class="row-note">erkannt: ${esc(r.artist ? `${r.artist} – ` : '')}${esc(r.title)}</span>` : '';
  const warn = !r.dup && (r.state === 'unsure' || r.state === 'error' || r.confidence === 'low');
  let badge = '';
  if (r.state === 'pending') badge = '<span class="badge"><span class="spinner small"></span></span>';
  else if (r.dup) badge = `<span class="badge">${r.dup}</span>`;
  else if (r.state === 'error') badge = '<span class="badge warn">Suche fehlgeschlagen</span>';
  else if (warn) badge = '<span class="badge warn">unsicher</span>';
  else if (r.state === 'none' || r.state === 'nokey') badge = '<span class="badge">ohne Cover</span>';
  return `<div class="row ${r.checked ? '' : 'off'}">
    <button class="check ${r.checked ? 'on' : ''} ${warn ? 'warn' : ''}" data-action="row-toggle" data-id="${r.id}" aria-label="${r.checked ? 'Abwählen' : 'Auswählen'}">${icon('check', 16)}</button>
    <button class="row-main" data-action="row-edit" data-id="${r.id}">
      ${coverHtml(o, 'thumb')}
      <span class="row-text"><span class="row-title">${esc(o.title)}</span><span class="row-sub">${esc(sub)}</span>${recognized}</span>
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
      <button class="btn primary" data-action="scan-save">${pending ? '<span class="spinner small"></span> ' : ''}${n === 1 ? '1 Eintrag' : `${n} Einträge`} hinzufügen</button>
    </div>`;
}

function editRow(id) {
  const r = state.scan.rows.find((x) => x.id === id);
  if (!r) return;
  openSearch({
    heading: 'Eintrag korrigieren',
    type: r.type,
    artist: r.match?.artist ?? r.artist,
    title: r.match?.title ?? r.title,
    seasons: r.seasons,
    extraHtml: `<button class="btn danger" type="button" data-extra="remove">${icon('trash', 20)} Aus der Liste entfernen</button>`,
    onExtra: () => {
      state.scan.rows = state.scan.rows.filter((x) => x.id !== id);
      saveScan();
      closeSheet();
      renderReview();
      updateTabBadges();
    },
    onPick: async (m) => {
      r.type = m.type;
      r.confidence = 'high';
      if (m.raw) {
        r.match = null;
        r.state = 'none';
        r.artist = m.artist;
        r.title = m.title;
        r.seasons = m.seasons;
      } else {
        if (m.type === 'dvd') await enrichVideo(m);
        r.match = m;
        r.state = 'found';
        r.seasons = m.seasons || [];
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
  updateTabBadges();
  toast(`${items.length} zur Sammlung hinzugefügt`);
  state.libTab = items[0].type;
  location.hash = '#/sammlung';
  preloadDiscographies();
}

// =====================================================================
// 3) Lücken: Diskografien (MusicBrainz) und Filmreihen/Serien (TMDB)
// =====================================================================
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
  const map = new Map();
  for (const it of state.items) {
    if (it.type !== 'cd' || !it.artistMbid || it.artistMbid === mb.VARIOUS_ARTISTS) continue;
    if (!map.has(it.artistMbid)) map.set(it.artistMbid, { mbid: it.artistMbid, name: it.artistName || it.artist, items: [] });
    map.get(it.artistMbid).items.push(it);
  }
  return [...map.values()];
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
    // 1. Schritt: Gespeichertes sofort laden (schnell)
    const todo = [];
    for (const g of artistGroups()) {
      const c = discoMem.get(g.mbid) || await getCache(`mb:${g.mbid}`);
      if (c) discoMem.set(g.mbid, c);
      if (!c || Date.now() - c.at >= 30 * DAY) todo.push(g);
    }
    refreshOverviews();
    // 2. Schritt: Fehlendes aus dem Internet holen (langsam)
    for (const g of todo) {
      discoTried.add(g.mbid);
      try { await getDisco(g.mbid); } catch { /* später nochmal */ }
      if (onGapList('cd')) fillGaps();
    }
  })().finally(() => {
    preloading = null;
    refreshOverviews();
  });
  return preloading;
}

const onGapList = (tab) => route()[0] === 'luecken' && !route()[1] && state.gapTab === tab && !!$('#gap-list');
const onLibrary = (tab) => route()[0] === 'sammlung' && !route()[1] && state.libTab === tab && !!$('#lib-grid');

function refreshOverviews() {
  if (onGapList('cd')) fillGaps();
  if (onGapList('dvd')) fillGapsDvd();
  if (onLibrary('cd') || onLibrary('dvd')) fillLibrary();
}

function gapRow({ href, ic, name, owned, total, loading, failed }) {
  const done = !loading && total > 0 && owned >= total;
  const pct = total ? Math.round((owned / total) * 100) : 0;
  let right = `${owned} / ${total}`;
  if (loading) right = failed ? 'nicht geladen' : '<span class="spinner small"></span>';
  return `<a class="gap-row" href="${href}">
    <span class="gap-ic is-${ic} ${done ? 'done' : ''}">${icon(done ? 'check' : ic, 20)}</span>
    <span class="gap-main">
      <span class="gap-top"><span class="gap-name">${esc(name)}</span><span class="muted">${right}</span></span>
      <span class="bar ${done ? 'done' : ''}"><i style="width:${loading ? 0 : pct}%"></i></span>
    </span>
    ${icon('chevron', 18, 'muted')}
  </a>`;
}

function renderGaps() {
  view().innerHTML = `
    ${header('Lücken')}
    ${segHtml('gap', 'gap-tab', [['cd', `${icon('disc', 18)} Interpreten`], ['dvd', `${icon('movie', 18)} Filme und Serien`]], state.gapTab)}
    <div class="chips">
      <button class="chip ${state.gapFilter === 'all' ? 'on' : ''}" data-action="gap-filter" data-f="all">Alle</button>
      <button class="chip ${state.gapFilter === 'open' ? 'on' : ''}" data-action="gap-filter" data-f="open">Nur unvollständige</button>
      ${state.gapTab === 'cd' ? `<button class="chip ${state.includeLive ? 'on' : ''}" data-action="toggle-live">${state.includeLive ? `${icon('check', 14)} ` : '+ '}Live-Alben</button>` : ''}
    </div>
    <div id="gap-list"></div>`;
  animateSegs();
  fillGaps();
}

async function fillGaps() {
  const box = $('#gap-list');
  if (!box) return;
  if (state.gapTab === 'dvd') { await fillGapsDvd(); return; }
  const groups = artistGroups();
  if (!groups.length) { box.innerHTML = emptyGaps('cd'); return; }
  const rows = [];
  for (const g of groups) {
    const disco = await getDisco(g.mbid, { fetch: false });
    rows.push({ ...g, disco, ...(disco ? discoProgress(g.mbid, disco) : {}) });
  }
  if (!onGapList('cd')) return;
  rows.sort((a, b) => collator.compare(sortName(a.name), sortName(b.name)));
  const shown = state.gapFilter === 'open' ? rows.filter((r) => !r.disco || r.owned < r.total) : rows;
  const unmatched = state.items.filter((i) => i.type === 'cd' && !i.artistMbid).length;
  $('#gap-list').innerHTML = `
    <div class="list">${shown.map((r) => gapRow({
    href: `#/luecken/artist/${r.mbid}`,
    ic: 'disc',
    name: r.name,
    owned: r.owned,
    total: r.total,
    loading: !r.disco,
    failed: !r.disco && discoTried.has(r.mbid) && !preloading,
  })).join('')}</div>
    ${state.gapFilter === 'open' && !shown.length ? '<p class="empty-small">Alles komplett – stark!</p>' : ''}
    ${unmatched ? `<p class="hint">${unmatched === 1 ? '1 CD ohne Datenbank-Treffer wird' : `${unmatched} CDs ohne Datenbank-Treffer werden`} hier nicht gezählt. Öffne sie in der Sammlung und tippe auf „Treffer ändern“.</p>` : ''}
    <p class="tiny">Gezählt werden nur Studioalben${state.includeLive ? ' und Live-Alben' : ''} – keine Singles, EPs oder Best-ofs. Daten: MusicBrainz.</p>`;
  if (rows.some((r) => !r.disco && !discoTried.has(r.mbid))) preloadDiscographies();
}

function emptyGaps(type) {
  if (type === 'cd') {
    return `<div class="empty">${icon('disc', 46)}<h2>Noch keine Interpreten</h2>
      <p>Sobald du CDs in der Sammlung hast, siehst du hier pro Interpret, welche Studioalben dir noch fehlen.</p>
      <a class="btn primary" href="#/scan">${icon('camera', 20)} Regal fotografieren</a></div>`;
  }
  return `<div class="empty">${icon('movie', 46)}<h2>Noch keine Reihen oder Serien</h2>
    <p>Hast du Filme aus einer Reihe (z. B. Harry Potter) oder Serien-Staffeln, siehst du hier, was dir noch fehlt.</p></div>`;
}

// ---------- Filmreihen/Serien mit Zwischenspeicher ----------
const videoMem = new Map(); // 'col:ID' bzw. 'tv:ID' -> Daten
const videoTried = new Set();
let videoLoading = null;

async function cachedVideo(key, fn) {
  const c = await getCache(`video:${key}`);
  if (c) videoMem.set(key, c.data);
  if (c && Date.now() - c.at < 30 * DAY) return c.data;
  try {
    const d = await fn();
    await setCache(`video:${key}`, d);
    videoMem.set(key, d);
    return d;
  } catch (e) {
    if (c) return c.data;
    throw e;
  }
}
const cachedCollection = (id) => cachedVideo(`col:${id}`, () => video.collection(id));
const cachedTv = (vid) => cachedVideo(`tv:${vid}`, () => video.tvDetails(vid));
const released = (list) => list.filter((p) => p.date && p.date <= today());

// Daten aller Reihen/Serien der Sammlung im Hintergrund laden
function preloadVideos() {
  if (videoLoading) return videoLoading;
  videoLoading = (async () => {
    const todo = [];
    for (const g of videoGroups()) {
      if (g.kind === 'single') continue;
      const c = videoMem.has(g.key) ? { at: Date.now() } : await getCache(`video:${g.key}`);
      if (c?.data) videoMem.set(g.key, c.data);
      if ((!c || Date.now() - c.at >= 30 * DAY) && !videoTried.has(g.key)) todo.push(g);
    }
    refreshOverviews();
    for (const g of todo) {
      videoTried.add(g.key);
      try { await (g.kind === 'col' ? cachedCollection(g.id) : cachedTv(g.id)); } catch { /* später nochmal */ }
      refreshOverviews();
    }
  })().finally(() => {
    videoLoading = null;
    refreshOverviews();
  });
  return videoLoading;
}

function fillGapsDvd() {
  const groups = videoGroups().filter((g) => g.kind !== 'single');
  if (!groups.length) { $('#gap-list').innerHTML = emptyGaps('dvd'); return; }
  const idx = getIndex();
  const rows = groups.map((g) => {
    const data = videoMem.get(g.key);
    const base = { href: `#/luecken/${g.kind === 'col' ? 'reihe' : 'serie'}/${encodeURIComponent(g.id)}`, name: g.name, kind: g.kind };
    if (!data) return { ...base, loading: true, failed: videoTried.has(g.key) && !videoLoading };
    if (g.kind === 'col') {
      const parts = released(data.parts);
      return { ...base, owned: parts.filter((p) => idx.byVid.has(p.vid)).length, total: parts.length };
    }
    const have = new Set(g.items.flatMap((i) => i.seasons || []));
    const seasons = data.seasons.filter((s) => !s.date || s.date <= today());
    return { ...base, owned: seasons.filter((s) => have.has(s.number)).length, total: seasons.length };
  });
  const filt = (kind) => rows.filter((r) => r.kind === kind)
    .filter((r) => state.gapFilter !== 'open' || r.loading || r.owned < r.total)
    .sort((a, b) => collator.compare(sortName(a.name), sortName(b.name)));
  const section = (title, list) => (list.length
    ? `<h3 class="group-title">${title}</h3><div class="list">${list.map((r) => gapRow({ ...r, ic: r.kind === 'col' ? 'movie' : 'checklist' })).join('')}</div>` : '');
  const a = filt('col');
  const b = filt('tv');
  $('#gap-list').innerHTML = `${section('Filmreihen', a)}${section('Serien', b)}
    ${state.gapFilter === 'open' && !a.length && !b.length ? '<p class="empty-small">Alles komplett – stark!</p>' : ''}
    <p class="tiny">Filmdaten: ${state.tmdbKey ? 'TMDB (diese App nutzt die TMDB-API, ist aber nicht von TMDB unterstützt oder zertifiziert)' : 'Wikidata und Wikipedia'}.</p>`;
  if (rows.some((r) => r.loading && !r.failed)) preloadVideos();
}

// ---------- Interpret: welche Studioalben habe ich, welche fehlen? ----------
async function renderArtist(mbid) {
  const g = artistGroups().find((x) => x.mbid === mbid);
  view().innerHTML = `${header(g?.name || 'Interpret', { back: true })}
    <div id="detail-body"><p class="hint"><span class="spinner small"></span> Lade alle Alben …</p></div>`;
  let disco;
  try {
    disco = await getDisco(mbid);
  } catch (e) {
    if (route()[2] === mbid && $('#detail-body')) {
      $('#detail-body').innerHTML = `<p class="hint error">${esc(e.message)}</p><button class="btn" data-action="reload">${icon('refresh', 20)} Nochmal versuchen</button>`;
    }
    return;
  }
  if (route()[2] !== mbid || !$('#detail-body')) return;
  state.current = { kind: 'artist', mbid, disco };
  fillArtist();
}

function fillArtist() {
  const { mbid, disco } = state.current;
  const g = artistGroups().find((x) => x.mbid === mbid) || { mbid, name: '', items: [] };
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
    ${shown.length ? `<div class="grid cd">${shown.map(({ a, item }) => albumCard(a, item, g)).join('')}</div>`
    : `<p class="empty-small">${list.length ? 'Du hast alle – Glückwunsch!' : 'MusicBrainz kennt keine Studioalben von diesem Interpreten.'}</p>`}
    ${others.length ? `<h3 class="section">Weitere CDs${g.name ? ` von ${esc(g.name)}` : ''}</h3>
      <p class="hint">Best-ofs, Live-Alben, Singles oder EPs aus deiner Sammlung – zählen nicht zu den Studioalben.</p>
      <div class="grid cd">${others.slice().sort(byYear).map(cardHtml).join('')}</div>` : ''}
    <p class="tiny">Daten: MusicBrainz. Fehlt ein Album oder ist eins zu viel? Die Daten pflegt die MusicBrainz-Community.</p>`;
}

function missingCard({ action, wishAction, key, o, wished, sub }) {
  return `<div class="card missing">
    <button class="card-hit" data-action="${action}" data-key="${esc(key)}">
      ${coverHtml(o)}
      <span class="card-title">${esc(o.title)}</span><span class="card-sub">${esc(sub)}</span>
    </button>
    <button class="heart ${wished ? 'on' : ''}" data-action="${wishAction}" data-key="${esc(key)}" aria-label="${wished ? 'Von der Wunschliste nehmen' : 'Auf die Wunschliste'}">${icon('heart', 18)}</button>
  </div>`;
}

function ownedCard(item, o, sub) {
  return `<button class="card" data-action="item" data-id="${item.id}">
    ${coverHtml(o, '', `<span class="owned">${icon('check', 14)}</span>`)}
    <span class="card-title">${esc(o.title)}</span><span class="card-sub">${esc(sub)}</span>
  </button>`;
}

function albumCard(a, item, g) {
  const o = { type: 'cd', title: a.title, artist: g.name, cover: item?.cover || a.cover };
  if (item) return ownedCard(item, o, a.year);
  return missingCard({ action: 'missing-album', wishAction: 'wish-album', key: a.mbid, o, wished: isWished(`mb:${a.mbid}`), sub: a.year });
}

const findAlbum = (key) => state.current?.disco?.find((a) => a.mbid === key);
const albumAsMatch = (a) => {
  const g = state.current.g;
  return { type: 'cd', kind: 'album', mbid: a.mbid, title: a.title, artist: g.name, artistMbid: g.mbid, artistName: g.name, year: a.year, cover: a.cover };
};

function showMissing({ o, sub, wishAction, ownAction, key, wished }) {
  openSheet(`<div class="detail">
    ${coverHtml({ ...o, cover: bigCover(o.cover) }, 'big')}
    <h2>${esc(o.title)}</h2>
    <p class="muted">${esc(sub)}</p>
    <div class="btn-col">
      <button class="btn primary" data-action="${wishAction}" data-key="${esc(key)}">${icon('heart', 20)} ${wished ? 'Von der Wunschliste nehmen' : 'Auf die Wunschliste'}</button>
      <button class="btn" data-action="${ownAction}" data-key="${esc(key)}">${icon('check', 20)} Hab ich doch – zur Sammlung</button>
    </div>
  </div>`);
}

async function ownMatch(m) {
  const it = itemFromMatch(await enrichVideo(m), 'hand');
  await addItems([it]);
  toast(`„${it.title}“ ist jetzt in deiner Sammlung`);
}

// ---------- Filmreihe ----------
async function renderCollection(id) {
  const name = state.items.find((i) => i.collectionId === id)?.collectionName || 'Filmreihe';
  view().innerHTML = `${header(name, { back: true })}
    <div id="detail-body"><p class="hint"><span class="spinner small"></span> Lade die Filmreihe …</p></div>`;
  let col;
  try {
    col = await cachedCollection(id);
  } catch (e) {
    if ($('#detail-body')) $('#detail-body').innerHTML = `<p class="hint error">${esc(e.message)}</p><button class="btn" data-action="reload">${icon('refresh', 20)} Nochmal versuchen</button>`;
    return;
  }
  if (route()[2] !== id || !$('#detail-body')) return;
  state.current = { kind: 'col', id, col };
  setTitle(col.name || name);
  fillCollection();
}

function fillCollection() {
  const { col, id } = state.current;
  const idx = getIndex();
  const parts = released(col.parts).sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({ p, item: (idx.byVid.get(p.vid) || [])[0] }));
  const owned = parts.filter((x) => x.item).length;
  const counted = new Set(parts.filter((x) => x.item).map((x) => x.item.id));
  const others = state.items.filter((i) => i.collectionId === id && !counted.has(i.id));
  $('#detail-body').innerHTML = `
    ${progressHtml(owned, parts.length, 'Filmen')}
    <div class="grid dvd">${parts.map(({ p, item }) => {
    const o = { type: 'dvd', title: p.title, cover: item?.cover || p.cover };
    if (item) return ownedCard(item, o, p.year);
    return missingCard({ action: 'missing-movie', wishAction: 'wish-movie', key: p.vid, o, wished: isWished(`movie:${p.vid}`), sub: p.year });
  }).join('')}</div>
    ${others.length ? `<h3 class="section">Weitere DVDs dieser Reihe</h3><div class="grid dvd">${others.map(cardHtml).join('')}</div>` : ''}
    <p class="tiny">Filmdaten: ${video.sourceName(id)}</p>`;
}

const findPart = (key) => state.current?.col?.parts.find((p) => p.vid === key);
const partAsMatch = (p) => ({
  type: 'dvd', kind: 'movie', vid: p.vid, title: p.title, year: p.year, cover: p.cover,
  collectionId: state.current.col.id, collectionName: state.current.col.name,
});

// ---------- Serie ----------
async function renderSeries(id) {
  const name = state.items.find((i) => i.kind === 'tv' && i.vid === id)?.title || 'Serie';
  view().innerHTML = `${header(name, { back: true })}
    <div id="detail-body"><p class="hint"><span class="spinner small"></span> Lade die Staffeln …</p></div>`;
  let tv;
  try {
    tv = await cachedTv(id);
  } catch (e) {
    if ($('#detail-body')) $('#detail-body').innerHTML = `<p class="hint error">${esc(e.message)}</p><button class="btn" data-action="reload">${icon('refresh', 20)} Nochmal versuchen</button>`;
    return;
  }
  if (route()[2] !== id || !$('#detail-body')) return;
  state.current = { kind: 'tv', id, tv };
  setTitle(tv.name || name);
  fillSeries();
}

function fillSeries() {
  const { tv, id } = state.current;
  const owners = state.items.filter((i) => i.kind === 'tv' && i.vid === id);
  const seasons = tv.seasons.filter((s) => !s.date || s.date <= today());
  const ownerOf = (n) => owners.find((i) => (i.seasons || []).includes(n));
  const owned = seasons.filter((s) => ownerOf(s.number)).length;
  const unknown = owners.filter((i) => !(i.seasons || []).length);
  $('#detail-body').innerHTML = `
    ${progressHtml(owned, seasons.length, 'Staffeln')}
    ${unknown.length ? '<p class="hint">Bei einer DVD dieser Serie ist nicht eingetragen, welche Staffel es ist. Tippe sie in der Sammlung an → „Treffer ändern“ → Staffeln eintragen.</p>' : ''}
    <div class="grid dvd">${seasons.map((s) => {
    const o = { type: 'dvd', title: s.name || `Staffel ${s.number}`, cover: s.cover };
    const item = ownerOf(s.number);
    if (item) return ownedCard(item, o, s.year);
    return missingCard({ action: 'missing-season', wishAction: 'wish-season', key: String(s.number), o, wished: isWished(`tv:${id}:${s.number}`), sub: s.year });
  }).join('')}</div>
    ${unknown.length ? `<h3 class="section">DVDs ohne Staffelangabe</h3><div class="grid dvd">${unknown.map(cardHtml).join('')}</div>` : ''}
    <p class="tiny">Filmdaten: ${video.sourceName(id)}</p>`;
}

const findSeason = (key) => state.current?.tv?.seasons.find((s) => String(s.number) === String(key));
const seasonAsMatch = (s) => ({
  type: 'dvd', kind: 'tv', vid: state.current.id, title: state.current.tv.name,
  season: s.number, seasons: [s.number], year: s.year, cover: s.cover,
});

function refreshCurrent() {
  closeSheet();
  const k = state.current?.kind;
  if (k === 'artist' && $('#detail-body')) fillArtist();
  else if (k === 'col' && $('#detail-body')) fillCollection();
  else if (k === 'tv' && $('#detail-body')) fillSeries();
  else render();
}

// =====================================================================
// 4) Wunschliste
// =====================================================================
function renderWishes() {
  const list = state.wishes.slice().sort((a, b) => b.addedAt - a.addedAt);
  const section = (type, label) => {
    const l = list.filter((w) => w.type === type);
    return l.length ? `<h3 class="group-title">${label}</h3><div class="list">${l.map(wishRow).join('')}</div>` : '';
  };
  view().innerHTML = `${header('Wunschliste')}
    ${list.length ? section('cd', 'CDs') + section('dvd', 'DVDs') : `<div class="empty">${icon('heart', 46)}
      <h2>Noch keine Wünsche</h2>
      <p>Unter „Lücken“ siehst du, welche Alben und Filme dir fehlen. Mit dem Herz landen sie hier.</p>
      <a class="btn primary" href="#/luecken">Zu den Lücken</a></div>`}`;
}

function wishRow(w) {
  const sub = w.type === 'cd'
    ? [w.artist, w.year].filter(Boolean).join(' · ')
    : [w.kind === 'tv' ? `Staffel ${w.season}` : 'Film', w.year].filter(Boolean).join(' · ');
  return `<div class="wish">
    ${coverHtml(w, 'thumb')}
    <span class="row-text"><span class="row-title">${esc(w.title)}</span><span class="row-sub">${esc(sub)}</span></span>
    <button class="btn small" data-action="wish-bought" data-key="${esc(w.id)}">${icon('cart', 18)} Gekauft</button>
    <button class="icon-btn" data-action="wish-remove" data-key="${esc(w.id)}" aria-label="Von der Wunschliste nehmen">${icon('x', 20)}</button>
  </div>`;
}

// =====================================================================
// 5) Einstellungen
// =====================================================================
async function renderSettings() {
  const cds = state.items.filter((i) => i.type === 'cd').length;
  const dvds = state.items.length - cds;
  const models = (await getSetting('geminiModels', null)) || [];
  const chosen = await getSetting('geminiModel', 'auto');
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (route()[0] !== 'einstellungen') return;
  // Aufbau wie Apples Einstellungen-App: Gruppen mit Zeilen, graue Überschriften und Fußnoten
  const cellIc = (name) => `<span class="cell-ic">${icon(name, 18)}</span>`;
  const chev = icon('chevron', 16, 'cell-chev');
  view().innerHTML = `
    ${header('Einstellungen', { back: true })}

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
        </select>${chev}
      </label>
      <a class="cell" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">
        <span class="cell-label">Schlüssel bei Google holen</span>${icon('external', 16, 'cell-chev')}</a>
    </div>
    <div id="gem-status" class="group-footer status-line"></div>
    <p class="group-footer">Kostenlos bei Google AI Studio: mit deinem Google-Konto anmelden, „API-Schlüssel erstellen“ tippen, kopieren und hier einfügen. Im Gratis-Kontingent darf Google die Fotos zur Verbesserung seiner KI nutzen – fotografiere also nur dein Regal.</p>

    <h3 class="group-title">Filmdaten</h3>
    <div class="group">
      <div class="cell">${cellIc('movie')}<span class="cell-label">TMDB-Schlüssel</span>
        <span class="cell-value" id="tmdb-badge">${state.tmdbKey ? 'Gespeichert' : 'Freiwillig'}</span></div>
      <div class="cell input-cell">
        <input id="tmdb-key" type="password" placeholder="Schlüssel einfügen" value="${esc(state.tmdbKey)}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="cell-icon-btn" data-action="toggle-key" data-for="tmdb-key" aria-label="Schlüssel anzeigen">${icon('eye', 20)}</button>
      </div>
      <button class="cell action" data-action="save-tmdb"><span class="cell-label">Speichern und prüfen</span></button>
      <a class="cell" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">
        <span class="cell-label">Schlüssel bei TMDB holen</span>${icon('external', 16, 'cell-chev')}</a>
    </div>
    <div id="tmdb-status" class="group-footer status-line"></div>
    <p class="group-footer">DVD-Cover, Filmreihen und Staffeln kommen auch ohne Schlüssel – kostenlos von Wikidata und Wikipedia. Mit TMDB gibt es oft deutsche Poster und mehr Filme.</p>

    <h3 class="group-title">Checkliste</h3>
    <div class="group">
      <label class="cell">${cellIc('checklist')}<span class="cell-label">Live-Alben mitzählen</span>
        <input type="checkbox" class="switch-input" id="opt-live" ${state.includeLive ? 'checked' : ''}><i class="switch"></i></label>
      <button class="cell action" data-action="refresh-disco">${cellIc('refresh')}<span class="cell-label">Diskografien neu laden</span></button>
    </div>
    <p class="group-footer">Singles, EPs und Best-ofs werden nie mitgezählt.</p>

    <h3 class="group-title">Deine Daten</h3>
    <div class="group">
      <div class="cell">${cellIc('disc')}<span class="cell-label">CDs</span><span class="cell-value">${cds}</span></div>
      <div class="cell">${cellIc('movie')}<span class="cell-label">DVDs</span><span class="cell-value">${dvds}</span></div>
      <div class="cell">${cellIc('heart')}<span class="cell-label">Wünsche</span><span class="cell-value">${state.wishes.length}</span></div>
    </div>
    <p class="group-footer">Alles wird nur hier in der App auf deinem iPhone gespeichert. ${persisted ? 'Der Speicher ist dauerhaft geschützt.' : (standalone ? '' : 'Tipp: Lege die App über „Teilen → Zum Home-Bildschirm“ ab, dann behält iOS die Daten dauerhaft.')}</p>

    <h3 class="group-title">Sicherung</h3>
    <div class="group">
      <button class="cell action" data-action="export">${cellIc('download')}<span class="cell-label">Sicherung erstellen</span>${chev}</button>
      <label class="cell action">${cellIc('upload')}<span class="cell-label">Sicherung laden</span>${chev}
        <input class="file-input" type="file" accept="application/json,.json" id="import-file"></label>
    </div>
    <p class="group-footer">Freiwillig. Löschst du das App-Symbol vom Home-Bildschirm, ist auch die Sammlung weg – eine Sicherung schützt davor.</p>

    <div class="group">
      <button class="cell action danger" data-action="clear-all"><span class="cell-label">Sammlung komplett löschen</span></button>
    </div>

    <p class="group-footer center">Regal ${APP_VERSION}<br>Fotoerkennung: Google Gemini · Musik: MusicBrainz und Cover Art Archive · Filme: Wikidata, Wikipedia und TMDB (diese App nutzt die TMDB-API, ist aber nicht von TMDB unterstützt oder zertifiziert).</p>`;
  $('#gem-model').addEventListener('change', (e) => setSetting('geminiModel', e.target.value));
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

async function saveTmdb() {
  const key = $('#tmdb-key').value.trim();
  const st = $('#tmdb-status');
  if (!key) {
    state.tmdbKey = '';
    await setSetting('tmdbKey', '');
    st.innerHTML = 'Schlüssel entfernt.';
    return;
  }
  st.innerHTML = '<span class="spinner small"></span> Prüfe den Schlüssel …';
  try {
    await tmdb.testKey(key);
    state.tmdbKey = key;
    await setSetting('tmdbKey', key);
    st.innerHTML = `<span class="ok">${icon('check', 16)} Funktioniert.</span>`;
    $('#tmdb-badge').textContent = 'Gespeichert';
  } catch (e) {
    st.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}

async function exportBackup() {
  const data = { app: 'regal', version: 1, exportedAt: new Date().toISOString(), items: state.items, wishes: state.wishes };
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
  const have = new Set(state.items.map((i) => i.id));
  const newItems = data.items.filter((i) => i && i.id && !have.has(i.id));
  const haveW = new Set(state.wishes.map((w) => w.id));
  const newWishes = (data.wishes || []).filter((w) => w && w.id && !haveW.has(w.id));
  state.items.push(...newItems);
  state.wishes.push(...newWishes);
  changed();
  await db.putMany('items', newItems);
  await db.putMany('wishes', newWishes);
  updateTabBadges();
  toast(`${newItems.length} Einträge und ${newWishes.length} Wünsche geladen`);
  render();
  preloadDiscographies();
}

async function clearAll() {
  if (!confirm('Wirklich die komplette Sammlung und Wunschliste löschen?')) return;
  if (!confirm('Ganz sicher? Das kann nicht rückgängig gemacht werden. (Deine Schlüssel bleiben gespeichert.)')) return;
  await Promise.all([db.clear('items'), db.clear('wishes'), db.clear('cache')]);
  state.items = [];
  state.wishes = [];
  state.scan.rows = [];
  discoMem.clear();
  discoTried.clear();
  videoTried.clear();
  videoMem.clear();
  changed();
  updateTabBadges();
  toast('Alles gelöscht');
  location.hash = '#/sammlung';
}

// =====================================================================
// Klicks: alle Knöpfe mit data-action landen hier
// =====================================================================
const actions = {
  'lib-tab': (el) => { state.libTab = el.dataset.tab; state.search = ''; renderLibrary(); },
  add: () => openAdd(),
  item: (el) => showItem(el.dataset.id),
  rematch: (el) => rematchItem(el.dataset.id),
  delete: async (el) => {
    const it = state.items.find((i) => i.id === el.dataset.id);
    if (!it || !confirm(`„${it.title}“ aus der Sammlung löschen?`)) return;
    await deleteItem(it.id);
    toast('Gelöscht');
    if (state.current) refreshCurrent(); else render();
  },
  back: () => {
    if (history.length > 1) history.back();
    else location.hash = route()[0] === 'luecken' ? '#/luecken' : '#/sammlung';
  },
  reload: () => render(),

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
    updateTabBadges();
  },

  'gap-tab': (el) => { state.gapTab = el.dataset.tab; renderGaps(); },
  'gap-filter': (el) => { state.gapFilter = el.dataset.f; renderGaps(); },
  'album-filter': (el) => { state.albumFilter = el.dataset.f; refreshCurrent(); },
  'toggle-live': async () => {
    state.includeLive = !state.includeLive;
    await setSetting('includeLive', state.includeLive);
    if (state.current) refreshCurrent(); else renderGaps();
  },

  'missing-album': (el) => {
    const a = findAlbum(el.dataset.key);
    if (!a) return;
    showMissing({
      o: { type: 'cd', title: a.title, artist: state.current.g.name, cover: a.cover },
      sub: [state.current.g.name, a.year, a.secondary.includes('Live') ? 'Live-Album' : 'Studioalbum'].filter(Boolean).join(' · '),
      wishAction: 'wish-album', ownAction: 'own-album', key: a.mbid, wished: isWished(`mb:${a.mbid}`),
    });
  },
  'wish-album': async (el) => { const a = findAlbum(el.dataset.key); if (a) { await toggleWish(albumAsMatch(a)); refreshCurrent(); } },
  'own-album': async (el) => { const a = findAlbum(el.dataset.key); if (a) { await ownMatch(albumAsMatch(a)); refreshCurrent(); } },

  'missing-movie': (el) => {
    const p = findPart(el.dataset.key);
    if (!p) return;
    showMissing({ o: { type: 'dvd', title: p.title, cover: p.cover }, sub: ['Film', p.year].filter(Boolean).join(' · '), wishAction: 'wish-movie', ownAction: 'own-movie', key: p.vid, wished: isWished(`movie:${p.vid}`) });
  },
  'wish-movie': async (el) => { const p = findPart(el.dataset.key); if (p) { await toggleWish(partAsMatch(p)); refreshCurrent(); } },
  'own-movie': async (el) => { const p = findPart(el.dataset.key); if (p) { await ownMatch(partAsMatch(p)); refreshCurrent(); } },

  'missing-season': (el) => {
    const s = findSeason(el.dataset.key);
    if (!s) return;
    showMissing({ o: { type: 'dvd', title: s.name || `Staffel ${s.number}`, cover: s.cover }, sub: [state.current.tv.name, s.year].filter(Boolean).join(' · '), wishAction: 'wish-season', ownAction: 'own-season', key: String(s.number), wished: isWished(`tv:${state.current.id}:${s.number}`) });
  },
  'wish-season': async (el) => { const s = findSeason(el.dataset.key); if (s) { await toggleWish(seasonAsMatch(s)); refreshCurrent(); } },
  'own-season': async (el) => { const s = findSeason(el.dataset.key); if (s) { await ownMatch(seasonAsMatch(s)); refreshCurrent(); } },

  'wish-bought': async (el) => {
    const w = state.wishes.find((x) => x.id === el.dataset.key);
    if (!w) return;
    await ownMatch({ ...w, seasons: w.season ? [w.season] : [] });
    await removeWish(w.id);
    renderWishes();
  },
  'wish-remove': async (el) => { await removeWish(el.dataset.key); renderWishes(); },

  'save-gemini': () => saveGemini(),
  'save-tmdb': () => saveTmdb(),
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
  renderTabbar();
  try {
    [state.items, state.wishes] = await Promise.all([db.all('items'), db.all('wishes')]);
    state.geminiKey = await getSetting('geminiKey', '');
    state.tmdbKey = await getSetting('tmdbKey', '');
    state.includeLive = await getSetting('includeLive', false);
    state.sortBy = { ...state.sortBy, ...(await getSetting('sortBy', {})) };
    const pending = await getCache('pendingScan');
    if (Array.isArray(pending?.data)) state.scan.rows = pending.data;
    // Alte Einträge (Version 1.0/1.1) auf das neue ID-Format umstellen
    const old = state.items.filter((i) => i.type === 'dvd' && i.tmdbId && !i.vid);
    for (const i of old) {
      i.vid = `tmdb:${i.kind === 'tv' ? 'tv' : 'movie'}:${i.tmdbId}`;
      if (i.collectionId && !String(i.collectionId).includes(':')) i.collectionId = `tmdb:col:${i.collectionId}`;
      delete i.tmdbId;
    }
    if (old.length) await db.putMany('items', old);
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
  render();
  updateTabBadges();
  if (state.scan.rows.some((r) => r.state === 'pending')) matchPending();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  preloadDiscographies();
}

init();
