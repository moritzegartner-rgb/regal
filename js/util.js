// Kleine Helfer, die überall gebraucht werden

export const $ = (sel, root = document) => root.querySelector(sel);

// Text sicher in HTML einsetzen
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const uid = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

// Titel/Namen vergleichbar machen: klein, ohne Akzente, ohne Zusätze wie „(Deluxe Edition)“
export function norm(s) {
  const raw = String(s ?? '');
  const r = raw
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*(edition|version|remaster|deluxe|bonus|expanded|anniversary|ausgabe|special)[^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|die|der|das) /, '')
    .trim();
  return r || raw.toLowerCase().trim();
}

// Feste Farbe pro Titel für Platzhalter-Cover
export function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// ---------- Symbole (Linien-Icons, offline verfügbar) ----------
const ICONS = {
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  camera: '<path d="M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2"/><circle cx="12" cy="13" r="3"/>',
  checklist: '<path d="M3.5 5.5l1.5 1.5l2.5 -2.5M3.5 11.5l1.5 1.5l2.5 -2.5M3.5 17.5l1.5 1.5l2.5 -2.5M11 6h9M11 12h9M11 18h9"/>',
  heart: '<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>',
  settings: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="M21 21l-6 -6"/>',
  back: '<path d="M15 6l-6 6l6 6"/>',
  x: '<path d="M18 6l-12 12M6 6l12 12"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/><path d="M7 12a5 5 0 0 1 5 -5"/>',
  movie: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v16M16 4v16M4 8h4M4 16h4M4 12h16M16 8h4M16 16h4"/>',
  photo: '<path d="M15 8h.01"/><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3"/>',
  edit: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4M13.5 6.5l4 4"/>',
  download: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2M7 11l5 5l5 -5M12 4v12"/>',
  upload: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2M7 9l5 -5l5 5M12 4v12"/>',
  refresh: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  external: '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6M11 13l9 -9M15 4h5v5"/>',
  chevron: '<path d="M9 6l6 6l-6 6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  cart: '<circle cx="6" cy="19" r="2"/><circle cx="17" cy="19" r="2"/><path d="M17 17h-11v-14h-2M6 5l14 1l-1 7h-13"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.85 12.15l9.15 -9.15M18 5l2 2M15 8l2 2"/>',
  eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
};

export function icon(name, size = 22, cls = '') {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---------- Kurze Meldungen unten am Bildschirm ----------
export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 5200 : 2600);
  setTimeout(() => el.remove(), kind === 'error' ? 5600 : 3000);
}

// ---------- Blatt, das von unten hereinfährt ----------
let sheetWrap = null;

export function openSheet(html, { onClose } = {}) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
    <div class="grabber"></div>
    <button class="icon-btn sheet-close" data-sheet-close aria-label="Schließen">${icon('x')}</button>
    ${html}
  </div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-sheet-close]')) closeSheet();
  });
  wrap._onClose = onClose;
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  sheetWrap = wrap;
  return wrap.querySelector('.sheet');
}

export function closeSheet() {
  if (!sheetWrap) return;
  const el = sheetWrap;
  sheetWrap = null;
  el._onClose?.();
  el.classList.add('closing');
  setTimeout(() => el.remove(), 200);
  document.body.classList.remove('no-scroll');
}

// ---------- Foto verkleinern (spart Datenvolumen, Schrift bleibt lesbar) ----------
export async function prepareImage(file, maxSide = 3072) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    if (!blob) throw new Error('Das Foto konnte nicht gelesen werden.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
