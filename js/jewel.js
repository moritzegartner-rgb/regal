// CD-Hülle (Jewel Case) in 3D – Maße wie im Original (142 × 125 × 10,4 mm)
// Zwei Teile wie in echt: Deckel (klappt am Scharnier auf) und Unterteil mit Träger, CD und Einleger.
// Echte Bilder kommen aus dem Cover Art Archive – alle von EINER CD-Ausgabe, damit alles zusammenpasst:
// Cover, Rückseite mit Rücken, Innenseite (Tray), CD (Medium) und Booklet-Seiten.
import { getCache, setCache } from './db.js';
import { releasesOf } from './musicbrainz.js';
import { esc, sleep } from './util.js';

const DAY = 864e5;

// ---------- Zufall mit festem Startwert: jede Hülle hat immer dieselben kleinen Macken ----------
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Mikrokratzer (Haarlinien, Putz-Kringel, Staub) ----------
function scratchTexture() {
  const S = 680, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), r = rng(5);
  g.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const x = r() * S, y = r() * S, len = 6 + r() * r() * 90, a = r() * Math.PI;
    g.strokeStyle = `rgba(255,255,255,${0.14 + r() * 0.4})`;
    g.lineWidth = r() < 0.8 ? 1.2 : 2;
    g.beginPath(); g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * len / 2 + (r() - 0.5) * 6, y + Math.sin(a) * len / 2 + (r() - 0.5) * 6, x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  for (let k = 0; k < 2; k++) {
    const cx = r() * S, cy = r() * S;
    for (let i = 0; i < 80; i++) {
      const rad = 40 + r() * S * 0.6, a0 = r() * Math.PI * 2;
      g.strokeStyle = `rgba(255,255,255,${0.06 + r() * 0.16})`;
      g.lineWidth = 1.1;
      g.beginPath(); g.arc(cx, cy, rad, a0, a0 + 0.08 + r() * 0.45); g.stroke();
    }
  }
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(255,255,255,${0.1 + r() * 0.45})`;
    g.beginPath(); g.arc(r() * S, r() * S, r() < 0.9 ? 1 : 1.8, 0, Math.PI * 2); g.fill();
  }
  return c.toDataURL('image/png');
}

// ---------- Gebrauchsspuren: Abrieb an Kanten und Ecken, Fingerabdruck, Staub ----------
function wearTexture(seed) {
  const W = 640, H = 584, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), r = rng(seed);
  g.lineCap = 'round';
  const line = (x, y, a, len, alpha, lw) => {
    g.strokeStyle = `rgba(255,255,255,${alpha})`; g.lineWidth = lw;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  };
  for (let i = 0; i < 320; i++) {
    const side = Math.floor(r() * 4), along = r(), inset = Math.pow(r(), 2.5) * 0.08, wob = (r() - 0.5) * 0.5;
    const len = 4 + r() * r() * 46, alpha = 0.1 + r() * 0.35, lw = 1.2 + r() * 1.2;
    if (side === 0) line(along * W, inset * H, wob, len, alpha, lw);
    else if (side === 1) line(along * W, H - inset * H, wob, len, alpha, lw);
    else if (side === 2) line(inset * W, along * H, Math.PI / 2 + wob, len, alpha, lw);
    else line(W - inset * W, along * H, Math.PI / 2 + wob, len, alpha, lw);
  }
  for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    for (let i = 0; i < 45; i++) {
      const dist = Math.pow(r(), 1.6) * 0.09 * W, a = r() * Math.PI * 2;
      const x = cx + (cx ? -1 : 1) * Math.abs(Math.cos(a)) * dist, y = cy + (cy ? -1 : 1) * Math.abs(Math.sin(a)) * dist;
      line(x, y, r() * Math.PI, 2 + r() * 12, 0.15 + r() * 0.4, 1 + r() * 1.4);
    }
  }
  const fx = W * (0.55 + r() * 0.3), fy = H * (0.55 + r() * 0.3); // Fingerabdruck
  g.save(); g.translate(fx, fy); g.rotate(r() * Math.PI);
  const sm = g.createRadialGradient(0, 0, 0, 0, 0, 70);
  sm.addColorStop(0, 'rgba(255,255,255,.07)'); sm.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sm; g.beginPath(); g.ellipse(0, 0, 70, 56, 0, 0, Math.PI * 2); g.fill();
  g.lineWidth = 1.3;
  for (let k = 5; k < 50; k += 3.2) {
    for (let a = 0; a < Math.PI * 2; a += 0.5 + r() * 0.5) {
      g.strokeStyle = `rgba(255,255,255,${0.05 + r() * 0.07})`;
      g.beginPath(); g.ellipse(0, 0, k * 1.25, k, 0, a, a + 0.25 + r() * 0.5); g.stroke();
    }
  }
  g.restore();
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(255,255,255,${0.15 + r() * 0.5})`;
    g.beginPath(); g.arc(r() * W, r() * H, r() < 0.85 ? 1 : 2, 0, Math.PI * 2); g.fill();
  }
  return c.toDataURL('image/png');
}

let TEX = '';
let WEAR = [];
export function initJewel() {
  if (TEX) return;
  TEX = scratchTexture();
  WEAR = [11, 23, 37].map(wearTexture);
  document.documentElement.style.setProperty('--tex', `url(${TEX})`);
}

// feiner Haarriss am Scharnier (klassischer Jewel-Case-Schaden) – nur bei manchen Hüllen
const CRACK = `<svg class="crack" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0.2 1.2 L1.74 4.6 L1.3 6.4 L3.7 10.8 L3.26 12.6"/><path d="M1.74 4.6 L4.78 5.6"/></svg>`;
const css = (u) => (u ? `url(&quot;${esc(u)}&quot;)` : 'none');

// Glanzschicht: Licht, Kratzer, Abrieb
function gloss(seed, cls, crack) {
  return `<div class="gloss ${cls}">
    <div class="sheen"></div><div class="uneven"></div>
    <div class="scratch" style="background-image:url(${TEX});--tx:${(seed * 137) % 340}px;--ty:${(seed * 211) % 340}px"></div>
    <div class="wear" style="background-image:url(${WEAR[seed % 3]})"></div>
    ${crack ? CRACK : ''}<div class="spot"></div>
  </div>`;
}

// Deckel außen. solid=true: undurchsichtige Fassung für die Spiegelung
function frontHtml(o, solid) {
  const r = rng(o.seed * 7 + 3);
  const rot = ((r() - 0.5) * 0.7).toFixed(2), ox = ((r() - 0.5) * 1.2).toFixed(2), oy = ((r() - 0.5) * 1.2).toFixed(2);
  const text = !o.img && o.name ? `<span class="booklet-name">${esc(o.name)}</span>` : '';
  return `<div class="face front"><div class="lid${solid ? ' solid' : ''}">
    <div class="rim-t"></div><div class="rim-b"></div><div class="rim-l"></div><div class="rim-r"></div>
    ${solid ? '<div class="tp-ribs"></div>' : ''}<div class="step"></div>
    <div class="booklet${o.img ? '' : ' text'}" style="background-image:${css(o.img)};--rot:${rot}deg;--ox:${ox}px;--oy:${oy}px">${text}</div>
    <div class="ring a"></div><div class="ring b"></div>
    ${solid ? '' : gloss(o.seed, '', o.seed % 4 === 2)}
  </div></div>`;
}
const LID_INNER = `<div class="face linner"><div class="bpage"></div><div class="lin-hinge"></div>
  <i class="clip t x1"></i><i class="clip t x2"></i><i class="clip b x1"></i><i class="clip b x2"></i><div class="lin-sheen"></div></div>`;
const TRAY = '<i class="tp-ribs"></i><i class="recess"></i><i class="fn t"></i><i class="fn b"></i><i class="hub"></i>';
function sideHtml(spine, which, full) {
  return `<div class="face side side-${which}">
    <div class="plate"></div>
    <div class="inlay"><span class="spine${which === 'r' ? ' r' : ''}">${esc(spine)}</span></div>
    <div class="seam"></div><div class="cap t"></div><div class="cap b"></div>
    ${full ? '<div class="wall"></div>' : ''}
  </div>`;
}
const LSIDES = '<div class="face lside lside-l"><div class="cap t"></div><div class="cap b"></div></div><div class="face lside lside-r"><div class="cap t"></div><div class="cap b"></div></div>';
const BK_RIM = '<div class="bk-rim t"></div><div class="bk-rim b"></div><div class="bk-rim l"></div><div class="bk-rim r"></div><div class="bk-dot"></div>'
  + [12, 30, 52, 70, 88].map((x) => `<i class="bk-nub" style="left:${x}%"></i><i class="bk-nub lo" style="left:${x}%"></i>`).join('');
const EDGE = '<i class="eb"></i><i class="ribz"></i><i class="notch n1"></i><i class="notch n2"></i><i class="pivot"></i>';
const BEVELS = '<div class="face bev fl"></div><div class="face bev fr"></div><div class="face bev bl"></div><div class="face bev br"></div>';
function backHtml(o, full) {
  return `<div class="face back">
    <div class="bk-inlay">${full ? `<div class="bk-gen">${o.backHtml || ''}</div>` : ''}</div>
    ${full ? BK_RIM + gloss(o.seed + 5, 'bk', false) + (o.buttonsHtml ? `<div class="bk-btns">${o.buttonsHtml}</div>` : '') : ''}
  </div>`;
}

// Die ganze Hülle. o = { seed, img (Cover/Bild), small (kleines Bild für Rücken/Texturen), name (Text, wenn kein Bild),
//   spine (Text auf dem Rücken), backHtml (Inhalt der selbst gebauten Rückseite), buttonsHtml (Knöpfe hinten) }
export function caseHtml(o) {
  return `<div class="jc" style="--img:${css(o.small || o.img)}">
    <div class="face floor"></div>
    <div class="face trayp">${TRAY}</div>
    <div class="face disc"></div>
    <div class="face bframe"></div>
    <div class="face iwall iwall-l"></div><div class="face iwall iwall-r"></div><div class="face iwall iwall-t"></div><div class="face iwall iwall-b"></div>
    ${backHtml(o, true)}
    <div class="face bev bl"></div><div class="face bev br"></div>
    ${sideHtml(o.spine, 'l', true)}${sideHtml(o.spine, 'r', true)}
    <div class="face top-f">${EDGE}</div><div class="face bot-f">${EDGE}</div>
    <div class="lidg">
      ${frontHtml(o, false)}
      <div class="face bev fl"></div><div class="face bev fr"></div>
      ${LSIDES}<div class="face ltop"></div><div class="face lbot"></div>
      <div class="face liw liw-l"></div><div class="face liw liw-r"></div>
      ${LID_INNER}
    </div>
    <div class="mirror"><div class="core"></div>${frontHtml(o, true)}${BEVELS}
      ${sideHtml(o.spine, 'l', false)}${sideHtml(o.spine, 'r', false)}${LSIDES}${backHtml(o, false)}</div>
  </div>`;
}

// Licht: k = wie weit die Hülle seitlich gedreht ist (0 = gerade von vorn)
export function light(el, k, tilt = 0) {
  const ak = Math.abs(k);
  el.style.setProperty('--lx', `${(32 - k * 70).toFixed(1)}%`);
  el.style.setProperty('--ly', `${(20 + Math.min(ak, 2) * 8 - tilt * 1.6).toFixed(1)}%`);
  el.style.setProperty('--sx', `${(50 + k * 55).toFixed(1)}%`);
  el.style.setProperty('--ux', `${(50 + k * 95).toFixed(1)}%`);
  el.style.setProperty('--bvr', (0.12 + 0.42 * Math.max(0, Math.min(1, k))).toFixed(3));
  el.style.setProperty('--sl', (0.03 + 0.12 * Math.min(1, ak)).toFixed(3));
  el.style.setProperty('--lip', (0.2 + 0.3 * (0.5 + 0.5 * Math.sin(k * 2.2 + 0.6))).toFixed(3));
  el.style.setProperty('--da', `${(k * 120).toFixed(0)}deg`);
}

// =====================================================================
// Echte Bilder aus dem Cover Art Archive
// =====================================================================
const https = (u) => String(u || '').replace(/^http:/, 'https:');
const timeout = (pr, ms) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
const getJson = (url) => { const ac = new AbortController(); setTimeout(() => ac.abort(), 12000); return fetch(url, { signal: ac.signal }).then((r) => r.json()); };
export const ratioOf = async (u) => { const img = new Image(); img.src = u; await timeout(img.decode(), 12000); return img.naturalWidth / img.naturalHeight; };
const COUNTRY = ['DE', 'XE', 'AT', 'CH', 'EU', 'GB', 'US'];
const rank = (r) => { const k = COUNTRY.indexOf(r.country); return k < 0 ? 99 : k; };
const scanKey = (rgid) => `caa:case:${rgid}`;
const scanMem = new Map();

// Für ein Album (Release-Group) die beste CD-Ausgabe mit Fotos suchen
async function lookup(rgid) {
  const hasBack = (r) => (r['cover-art-archive']?.back ? 0 : 1);
  // nur reine CD-Ausgaben (keine mit Bonus-DVD o. Ä.), als Jewel Case eingetragene zuerst
  const cdOnly = (r) => (r.media || []).length > 0 && r.media.every((m) => /CD$/.test(m.format || ''));
  const jewel = (r) => (r.packaging === 'Jewel Case' ? 0 : r.packaging ? 2 : 1);
  const cds = (await releasesOf(rgid)).filter((r) => r['cover-art-archive']?.artwork && cdOnly(r))
    .sort((a, b) => jewel(a) - jewel(b) || hasBack(a) - hasBack(b) || rank(a) - rank(b));
  const cand = cds.slice(0, 8);
  const lists = await Promise.all(cand.map((r) => getJson(`https://coverartarchive.org/release/${r.id}`).catch(() => null)));
  const usable = (im) => !im.types.includes('Raw/Unedited') && !im.types.includes('Watermark');
  let pick = null;
  cand.forEach((r, k) => {
    const ims = (lists[k]?.images || []).filter(usable);
    const front = ims.find((im) => im.types.includes('Front') && !im.types.includes('Back'));
    const backs = ims.filter((im) => im.types.includes('Back') && !im.types.includes('Front'));
    const back = backs.find((im) => im.types.includes('Spine')) || backs[0];
    const tray = ims.find((im) => im.types.includes('Tray') && !im.types.includes('Back'));
    const medium = ims.find((im) => im.types.includes('Medium'));
    const booklet = ims.filter((im) => im.types.includes('Booklet') && !im.types.includes('Front') && !im.types.includes('Back'));
    if (!back) return;
    const score = (back.types.includes('Spine') ? 4 : 2) + (front ? 2 : 0) + (tray ? 1 : 0) + (medium ? 1 : 0) + (booklet.length > 1 ? 1 : 0)
      + (r.packaging === 'Jewel Case' ? 2 : 0) - ((r.media || []).length > 1 ? 1 : 0);
    if (!pick || score > pick.score) pick = { score, r, front, back, tray, medium, booklet };
  });
  if (!pick) return null;
  const url = (im, size = '500') => https(im.thumbnails?.[size] || im.thumbnails?.large || im.image);
  const big = (im) => (im.thumbnails?.['1200'] ? https(im.thumbnails['1200']) : url(im)); // nie die (oft riesige) Originaldatei
  const res = {
    rgid, country: pick.r.country || '', date: pick.r.date || '',
    small: url(pick.back), big: pick.back.thumbnails?.['1200'] ? https(pick.back.thumbnails['1200']) : '',
    front: pick.front ? url(pick.front) : '', frontSmall: pick.front ? url(pick.front, '250') : '', frontBig: pick.front ? big(pick.front) : '',
    frontOrig: pick.front ? https(pick.front.image) : '',
    medium: pick.medium ? url(pick.medium) : '',
    booklet: pick.booklet.map((im) => ({ s: url(im), b: big(im), o: https(im.image) })),
  };
  res.ratio = await ratioOf(res.small); // mit Rücken ≈ 151:118, nur Rückseite ≈ 138:118
  if (pick.tray) {
    res.tray = url(pick.tray);
    try { res.trayRatio = await ratioOf(res.tray); } catch { delete res.tray; }
  }
  return res;
}

export async function findScan(rgid) {
  if (!rgid) return null;
  if (scanMem.has(rgid)) return scanMem.get(rgid);
  const c = await getCache(scanKey(rgid));
  if (c && Date.now() - c.at < 60 * DAY) { scanMem.set(rgid, c.data); return c.data; }
  let res;
  try { res = await lookup(rgid); } catch {
    await sleep(3000); // archive.org antwortet manchmal nicht – einmal neu versuchen
    res = await lookup(rgid);
  }
  scanMem.set(rgid, res);
  await setCache(scanKey(rgid), res);
  return res;
}
const saveScan = (sc) => { if (sc?.rgid) setCache(scanKey(sc.rgid), sc).catch(() => {}); };

// Gefundene Bilder in eine Hülle einsetzen
export function applyScan(jc, sc) {
  if (!jc || !sc) return;
  if (sc.front) {
    jc.querySelectorAll('.booklet').forEach((el) => { el.style.backgroundImage = `url("${sc.front}")`; });
    jc.style.setProperty('--img', `url("${sc.frontSmall || sc.front}")`);
  }
  if (sc.tray) { // Einleger-Innenseite: 118 mm hoch, Breite aus dem Seitenverhältnis
    jc.style.setProperty('--tray', `url("${sc.tray}")`);
    jc.style.setProperty('--trs', `${((118 * sc.trayRatio) / 142 * 100).toFixed(1)}% 94.4%`);
    jc.classList.add('has-tray');
    if (sc.trayRatio > 1.22) { // das Foto enthält die Innenseiten der Rücken
      const tw = 118 * sc.trayRatio, f = Math.min(0.065, Math.max(0.03, (tw - 138) / 2 / tw));
      jc.style.setProperty('--tsw', `${(100 / f).toFixed(1)}%`);
      jc.classList.add('has-tspine');
    }
  }
  if (sc.medium) { jc.style.setProperty('--medium', `url("${sc.medium}")`); jc.classList.add('has-medium'); }
  applyBpage(jc, sc);
  const hasSpine = sc.ratio > 1.22;
  const total = 118 * sc.ratio;
  const sp = hasSpine ? Math.min(0.065, Math.max(0.03, (total - 138) / 2 / total)) : 0;
  jc.style.setProperty('--scan', `url("${sc.small}")`);
  jc.style.setProperty('--bks', hasSpine ? `${(100 / (1 - 2 * sp)).toFixed(2)}% 100%` : 'cover');
  if (hasSpine) jc.style.setProperty('--spw', `${(100 / sp).toFixed(1)}%`);
  if (sc.big) jc.dataset.big = sc.big;
  jc.classList.add('has-scan');
  jc.classList.toggle('has-spine', hasSpine);
}

// Rückseite in voller Auflösung (umgedreht soll die Schrift scharf sein) – erst fertig laden, dann einwechseln
export function loadBigBack(jc) {
  if (!jc?.dataset.big || jc.dataset.bigOk) return;
  const im = new Image();
  im.onload = () => { jc.dataset.bigOk = '1'; jc.style.setProperty('--scan', `url("${jc.dataset.big}")`); };
  im.src = jc.dataset.big;
}

// innen im Deckel: Rückseite des Booklets (Außenumschlag links) – sonst die letzte Seite
function applyBpage(jc, sc) {
  if (!sc?.booklet?.length) return;
  const n = sc.booklet.length;
  const pick = sc.outerFirst ? { u: sc.booklet[0].s, spread: true }
    : { u: sc.booklet[n - 1].s, spread: (sc.bookRatios?.[n - 1] || 1) > 1.5 };
  jc.style.setProperty('--bpage', `url("${pick.u}")`);
  jc.style.setProperty('--bps', pick.spread ? '200% 100%' : 'cover');
  jc.style.setProperty('--bpp', pick.spread ? '0% 50%' : '50% 50%');
  jc.classList.add('has-bpage');
}

// kleines Graustufen-Abbild (16 × 16) zum Vergleichen zweier Bilder
async function thumbVec(url, part) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await timeout(img.decode(), 12000);
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d'), w = img.naturalWidth, h = img.naturalHeight;
  g.drawImage(img, part === 'r' ? w / 2 : 0, 0, part === 'full' ? w : w / 2, h, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data, v = [];
  for (let k = 0; k < d.length; k += 4) v.push((d[k] + d[k + 1] + d[k + 2]) / 3);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return v.map((x) => x - m);
}
const vecDiff = (a, b) => a.reduce((sum, x, k) => sum + Math.abs(x - b[k]), 0) / a.length;

// Booklet vorbereiten: Doppelseiten erkennen, prüfen ob der erste Scan der Außenumschlag (Rückseite | Cover) ist
export async function ensureBook(sc, jc) {
  if (!sc || sc.bookReady) return sc;
  const list = sc.booklet || [];
  sc.bookRatios = await Promise.all(list.map((p) => ratioOf(p.s).catch(() => 1)));
  sc.outerFirst = false;
  if (list.length && sc.bookRatios[0] > 1.5 && sc.front) {
    try {
      const [a, b] = await Promise.all([thumbVec(sc.front, 'full'), thumbVec(list[0].s, 'r')]);
      sc.outerFirst = vecDiff(a, b) < 28;
    } catch {}
  }
  sc.bookReady = true;
  saveScan(sc);
  if (jc) applyBpage(jc, sc);
  return sc;
}

// Originaldatei zu einem Vorschaubild des Cover Art Archive (…/123-1200.jpg → …/123.jpg); klappt das nicht, bleibt es beim Vorschaubild
const orig = (u) => (/coverartarchive\.org\/release\/[^/]+\/\d+-(1200|500|250)\.jpg$/.test(u || '') ? u.replace(/-(1200|500|250)\.jpg$/, '.jpg') : '');

// Einzelseiten in Lesereihenfolge: Cover, Innenseiten (Doppelseiten geteilt), Rückseite
function bookPages(sc, front) {
  const list = sc?.booklet || [], pages = [];
  let backCover = null;
  list.forEach((p, k) => {
    const r = sc.bookRatios?.[k] || 1, u = p.b || p.s, o = p.o || orig(u);
    if (k === 0 && sc.outerFirst) { pages.push({ u, o, part: 'r' }); backCover = { u, o, part: 'l' }; return; }
    if (r > 1.5) pages.push({ u, o, part: 'l' }, { u, o, part: 'r' });
    else pages.push({ u, o, part: 'full' });
  });
  if (!sc?.outerFirst) { const u = sc?.frontBig || sc?.front || front; pages.unshift({ u, o: sc?.frontOrig || orig(u), part: 'full' }); }
  if (backCover) pages.push(backCover);
  return pages;
}

// =====================================================================
// Booklet zum Durchblättern – wie ein echtes Buch
// Es wird aus der Hülle herausgenommen: das Booklet im Deckel hebt sich ab, dreht sich auf die Vorderseite
// und wird groß – beim Schließen fliegt es wieder zurück an seinen Platz.
// Rechte Seite antippen = weiter, linke Seite = zurück, daneben ins Dunkle tippen = schließen.
// Zwei Finger = zoomen (und mit einem Finger verschieben), Doppeltippen = wieder ganz zeigen.
// =====================================================================
let bv = null, bvZoom = null, bvBook = null, bvPages = [], bvLeaf = 0, bvTok = 0, bvSrc = null, bvGray = false;
const Z = { s: 1, x: 0, y: 0 }; // Zoom: Faktor und Verschiebung
const FLY_MS = 800;

function bvInit() {
  if (bv) return;
  bv = document.createElement('div');
  bv.className = 'bv';
  bv.hidden = true;
  bv.innerHTML = '<div class="bv-wrap"><div class="bv-zoom"><div class="bv-book"></div></div></div><div class="bv-load">Booklet wird geladen …</div>';
  document.body.appendChild(bv);
  bvZoom = bv.querySelector('.bv-zoom');
  bvBook = bv.querySelector('.bv-book');
  bv.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS: kein Zoom der ganzen Seite
  bindGestures();
}
export const bookletOpen = () => !!bv && !bv.hidden;

// ---------- Zoom ----------
function zApply(anim) {
  bvZoom.style.transition = anim ? 'transform .3s cubic-bezier(.3,.8,.3,1)' : 'none';
  bvZoom.style.transform = Z.s === 1 && !Z.x && !Z.y ? '' : `translate(${Z.x.toFixed(1)}px,${Z.y.toFixed(1)}px) scale(${Z.s.toFixed(3)})`;
}
function zReset(anim = true) { Z.s = 1; Z.x = 0; Z.y = 0; zApply(anim); }
const zoomed = () => Z.s > 1.03;
// stark gezoomt: die sichtbaren Seiten in voller Auflösung nachladen (kleine Schrift wird lesbar)
function zSharpen() {
  if (Z.s < 1.8) return;
  const leaves = [...bvBook.children], n = leaves.length;
  const vis = [];
  if (bvLeaf > 0) vis.push([leaves[bvLeaf - 1]?.children[1], bvPages[2 * bvLeaf - 1]]);
  if (bvLeaf < n) vis.push([leaves[bvLeaf]?.children[0], bvPages[2 * bvLeaf]]);
  for (const [el, page] of vis) {
    if (!el || !page?.o || el.dataset.hi) continue;
    el.dataset.hi = '1';
    const im = new Image();
    im.onload = () => { if (el.isConnected) el.style.backgroundImage = `url("${page.o}")`; };
    im.src = page.o;
  }
}

function bindGestures() {
  const pts = new Map();
  let pinch = null, drag = null, lastTap = 0;
  const two = () => [...pts.values()];
  const base = () => { const r = bvZoom.getBoundingClientRect(); return { left: r.left - Z.x, top: r.top - Z.y }; };
  bv.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { bv.setPointerCapture(e.pointerId); } catch {}
    if (pts.size === 2 && bv.classList.contains('ready')) { // zwei Finger: zoomen
      const [a, b] = two();
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s0: Z.s, x0: Z.x, y0: Z.y, base: base() };
      if (drag) drag.pinched = true;
      return;
    }
    if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, zx: Z.x, zy: Z.y, pg: e.target.closest('.pg'), moved: false, pinched: false };
  });
  bv.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = two();
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = Math.max(0.85, Math.min(5, pinch.s0 * d / pinch.d0));
      // der Punkt zwischen den Fingern bleibt unter den Fingern
      const qx = (pinch.mx - pinch.base.left - pinch.x0) / pinch.s0, qy = (pinch.my - pinch.base.top - pinch.y0) / pinch.s0;
      Z.s = s; Z.x = mx - pinch.base.left - qx * s; Z.y = my - pinch.base.top - qy * s;
      zApply(false);
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) drag.moved = true;
    if (zoomed() && !drag.pinched) { Z.x = drag.zx + dx; Z.y = drag.zy + dy; zApply(false); } // gezoomt: verschieben
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size < 2) {
        pinch = null;
        if (Z.s < 1.05) zReset(); else zSharpen();
        if (pts.size === 1) { const [p] = two(); drag = { x: p.x, y: p.y, zx: Z.x, zy: Z.y, pg: null, moved: true, pinched: true }; }
      }
      return;
    }
    if (pts.size || !drag) return;
    const d = drag, dx = e.clientX - d.x;
    drag = null;
    if (d.pinched) return;
    if (!bv.classList.contains('ready')) { if (!d.moved) closeBooklet(); return; }
    const now = performance.now();
    if (zoomed()) { // gezoomt: Doppeltippen zeigt wieder alles, sonst nichts blättern
      if (!d.moved && now - lastTap < 320) { zReset(); lastTap = 0; } else if (!d.moved) lastTap = now;
      return;
    }
    if (dx < -35) { bvGo(1); return; }
    if (dx > 35) { bvGo(-1); return; }
    if (d.moved) return;
    if (!d.pg) { closeBooklet(); return; }
    bvGo(d.pg.classList.contains('f') ? 1 : -1);
  };
  bv.addEventListener('pointerup', up);
  bv.addEventListener('pointercancel', up);
}

// ---------- Herausnehmen und Zurücklegen (das Booklet „fliegt“) ----------
function copyBg(from, to) {
  const cs = getComputedStyle(from);
  to.style.backgroundImage = cs.backgroundImage;
  to.style.backgroundSize = cs.backgroundSize;
  to.style.backgroundPosition = cs.backgroundPosition;
}
// Karte mit zwei Seiten, die von Rechteck a nach Rechteck b fliegt und sich dabei dreht
function fly(a, b, frontEl, backEl, fromDeg, toDeg) {
  const f = document.createElement('div');
  f.className = `bv-fly${bvGray ? ' gray' : ''}`;
  f.innerHTML = '<div class="bv-fly-in"><div class="pg f"></div><div class="pg b"></div></div>';
  f.style.width = `${b.width}px`;
  f.style.height = `${b.height}px`;
  if (frontEl) copyBg(frontEl, f.querySelector('.pg.f'));
  if (backEl) copyBg(backEl, f.querySelector('.pg.b'));
  const inner = f.firstElementChild;
  const at = (r) => `translate(${r.left.toFixed(1)}px,${r.top.toFixed(1)}px) scale(${(r.width / b.width).toFixed(4)},${(r.height / b.height).toFixed(4)})`;
  f.style.transform = at(a);
  inner.style.transform = `rotateY(${fromDeg}deg)`;
  document.body.appendChild(f);
  f.getBoundingClientRect(); // Startstellung festhalten, dann losfliegen
  f.style.transition = `transform ${FLY_MS}ms cubic-bezier(.3,.75,.25,1)`;
  inner.style.transition = `transform ${FLY_MS}ms cubic-bezier(.45,.1,.3,1)`;
  f.style.transform = at(b);
  inner.style.transform = `rotateY(${toDeg}deg)`;
  return new Promise((res) => setTimeout(() => res(f), FLY_MS + 30));
}
const usable = (el) => el?.isConnected && (() => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; })();

// src = das Booklet in der aufgeklappten Hülle (von dort wird es herausgenommen)
export async function openBooklet(sc, front, gray = false, src = null) {
  bvInit();
  const tok = ++bvTok;
  bvGray = !!gray;
  bvSrc = usable(src) ? src : null;
  bv.hidden = false;
  bv.classList.toggle('gray', bvGray); // fehlendes Album: Booklet grau
  bv.classList.remove('ready');
  bvBook.innerHTML = '';
  zReset(false);
  requestAnimationFrame(() => requestAnimationFrame(() => { if (tok === bvTok) bv.classList.add('show'); }));
  await ensureBook(sc).catch(() => {});
  if (tok !== bvTok) return;
  const pages = bookPages(sc, front);
  const ratio = sc?.outerFirst ? (sc.bookRatios[0] / 2) : await ratioOf(pages[0].u).catch(() => 1);
  if (tok !== bvTok) return;
  bvPages = pages; bvLeaf = 0;
  const par = Math.min(1.4, Math.max(0.7, ratio)); // Seitenformat (CD-Booklets sind fast quadratisch)
  bvBook.style.setProperty('--par', par.toFixed(3));
  bvBook.style.aspectRatio = String(2 * par);
  bvBook.innerHTML = Array.from({ length: Math.ceil(pages.length / 2) }, () => '<div class="leaf"><div class="pg f"></div><div class="pg b"></div></div>').join('');
  bvShow();
  await new Promise((res) => { const im = new Image(); im.onload = res; im.onerror = res; im.src = pages[0].u; });
  if (tok !== bvTok) return;
  const cover = bvBook.querySelector('.leaf .pg.f');
  if (bvSrc && cover) { // aus der Hülle herausnehmen: Rückseite zeigt nach oben, dreht sich beim Herausheben auf das Cover
    bvSrc.style.visibility = 'hidden';
    bv.classList.add('flying'); // während des Flugs kein „wird geladen“
    const f = await fly(bvSrc.getBoundingClientRect(), cover.getBoundingClientRect(), cover, bvSrc, 180, 0);
    bv.classList.remove('flying');
    if (tok !== bvTok) { f.remove(); return; }
    bv.classList.add('ready');
    requestAnimationFrame(() => f.remove());
  } else {
    requestAnimationFrame(() => requestAnimationFrame(() => { if (tok === bvTok) bv.classList.add('ready'); }));
  }
}

// die gerade sichtbare Seite (für den Rückflug)
function visiblePage() {
  const leaves = [...bvBook.children], n = leaves.length;
  if (!n) return null;
  if (bvLeaf === 0) return leaves[0].children[0];
  if (bvLeaf >= n) return leaves[n - 1].children[1];
  return leaves[bvLeaf].children[0];
}

export async function closeBooklet() {
  if (!bv || bv.hidden) return;
  const tok = ++bvTok;
  const src = bvSrc;
  bvSrc = null;
  const page = bv.classList.contains('ready') && usable(src) ? visiblePage() : null;
  if (page) { // zurück in die Hülle legen
    zReset(false);
    const from = page.getBoundingClientRect();
    bv.classList.remove('ready', 'show');
    const f = await fly(from, src.getBoundingClientRect(), page, src, 0, 180);
    src.style.visibility = '';
    f.remove();
  } else {
    if (src) src.style.visibility = '';
    bv.classList.remove('ready', 'show');
    await new Promise((res) => setTimeout(res, 450));
  }
  if (tok === bvTok) { bv.hidden = true; bvBook.innerHTML = ''; zReset(false); }
}

function pageStyle(el, page) {
  if (!page) { el.style.backgroundImage = 'none'; return; }
  el.style.backgroundImage = `url("${page.u}")`;
  el.style.backgroundSize = page.part === 'full' ? 'cover' : '200% 100%';
  el.style.backgroundPosition = page.part === 'l' ? '0% 50%' : page.part === 'r' ? '100% 50%' : '50% 50%';
}
function bvShow() {
  const leaves = [...bvBook.children], n = leaves.length;
  leaves.forEach((lf, j) => {
    const turned = j < bvLeaf;
    lf.classList.toggle('turned', turned);
    lf.style.zIndex = String(turned ? 100 + j : 100 - j);
    if (Math.abs(j - bvLeaf) <= 2 && !lf.dataset.on) { // nur Blätter in der Nähe laden (spart Speicher)
      lf.dataset.on = '1';
      pageStyle(lf.children[0], bvPages[2 * j]);
      pageStyle(lf.children[1], bvPages[2 * j + 1]);
    }
  });
  bvBook.style.transform = bvLeaf === 0 ? 'translateX(-25%)' : bvLeaf >= n ? 'translateX(25%)' : 'none';
  bvBook.style.setProperty('--shl', bvLeaf === 0 ? '50%' : '0%');
  bvBook.style.setProperty('--shr', bvLeaf >= n ? '50%' : '0%');
}
function bvGo(dir) {
  const n = bvBook.children.length;
  const next = Math.max(0, Math.min(n, bvLeaf + dir));
  if (next === bvLeaf) return;
  zReset();
  const lf = bvBook.children[dir > 0 ? bvLeaf : bvLeaf - 1];
  lf.classList.add('turning');
  setTimeout(() => lf.classList.remove('turning'), 850);
  bvLeaf = next;
  bvShow();
}
