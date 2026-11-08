// MusicBrainz: freie Musikdatenbank (Alben, Diskografien) + Cover Art Archive (Cover)
import { norm, sleep } from './util.js';

const MB = 'https://musicbrainz.org/ws/2';
export const VARIOUS_ARTISTS = '89ad4ac3-39f7-470e-963a-56509c546377';

export const coverUrl = (mbid, size = 250) => `https://coverartarchive.org/release-group/${mbid}/front-${size}`;

// MusicBrainz erlaubt etwa eine Anfrage pro Sekunde – darum eine Warteschlange
let last = 0;
let chain = Promise.resolve();

function mbFetch(path) {
  const job = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, last + 1100 - Date.now());
      if (wait) await sleep(wait);
      last = Date.now();
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(`${MB}${path}${sep}fmt=json`);
      if (res.status === 503 || res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`MusicBrainz antwortet nicht (${res.status}).`);
      return res.json();
    }
    throw new Error('MusicBrainz ist gerade überlastet. Versuch es gleich nochmal.');
  };
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
}

// Sonderzeichen für die Suche entschärfen (klein geschrieben, damit AND/OR keine Befehle werden)
function q(s) {
  return String(s ?? '').toLowerCase().replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1').trim();
}

function toAlbum(rg) {
  const credit = rg['artist-credit'] || [];
  return {
    type: 'cd',
    mbid: rg.id,
    title: rg.title,
    artist: credit.map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim(),
    artistMbid: credit[0]?.artist?.id || null,
    artistName: credit[0]?.artist?.name || '',
    year: (rg['first-release-date'] || '').slice(0, 4),
    primaryType: rg['primary-type'] || '',
    secondaryTypes: rg['secondary-types'] || [],
    score: rg.score ?? 0,
    cover: coverUrl(rg.id),
  };
}

// Album suchen (Interpret + Titel)
export async function searchAlbums(artist, title, limit = 10) {
  const t = q(title);
  const a = q(artist);
  if (!t && !a) return [];
  const parts = [];
  if (t) parts.push(`releasegroup:(${t})`);
  if (a) parts.push(`artist:(${a})`);
  let d = await mbFetch(`/release-group?query=${encodeURIComponent(parts.join(' AND '))}&limit=${limit}`);
  let list = (d['release-groups'] || []).map(toAlbum);
  // Falls der Interpret falsch gelesen wurde: nur nach dem Titel suchen
  if (!list.length && t && a) {
    d = await mbFetch(`/release-group?query=${encodeURIComponent(`releasegroup:(${t})`)}&limit=${limit}`);
    list = (d['release-groups'] || []).map(toAlbum);
  }
  return list;
}

// Besten Treffer auswählen – Studioalben bevorzugt
export function pickBest(list, artist, title) {
  const nt = norm(title);
  const na = norm(artist);
  let best = null;
  let bestScore = -1;
  for (const a of list) {
    let s = a.score;
    const t = norm(a.title);
    if (t === nt) s += 40;
    else if (nt && (t.includes(nt) || nt.includes(t))) s += 15;
    const an = norm(a.artist);
    if (na && an && (an === na || an.includes(na) || na.includes(an))) s += 20;
    if (a.primaryType === 'Album') s += 10;
    if (!a.secondaryTypes.length) s += 8;
    if (s > bestScore) { best = a; bestScore = s; }
  }
  if (!best) return null;
  return { ...best, sure: bestScore >= 150 };
}

// Titelliste und Spotify-Link eines Albums (Release-Group)
// Titel: von der „normalsten“ CD-Ausgabe (häufigste Titelzahl, deutsche/europäische Ausgabe bevorzugt)
// Spotify: Link, den die MusicBrainz-Community bei einer Digital-Ausgabe hinterlegt hat
export async function albumDetails(rgid) {
  let d = await mbFetch(`/release?release-group=${rgid}&status=official&inc=media+url-rels&limit=100`);
  let rels = d.releases || [];
  if (!rels.length) {
    d = await mbFetch(`/release?release-group=${rgid}&inc=media+url-rels&limit=100`);
    rels = d.releases || [];
  }
  if (!rels.length) return { discs: [], spotify: null };
  const total = (r) => (r.media || []).reduce((s, m) => s + (m['track-count'] || 0), 0);
  const isCd = (r) => (r.media || []).length > 0 && r.media.every((m) => /CD/i.test(m.format || '') && !/CD-R\b/i.test(m.format || ''));
  let pool = rels.filter(isCd);
  if (!pool.length) pool = rels;
  const counts = {};
  pool.forEach((r) => { counts[total(r)] = (counts[total(r)] || 0) + 1; });
  const mode = Number(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
  const countries = ['DE', 'XE', 'AT', 'CH', 'GB', 'US', 'XW'];
  const rank = (r) => { const i = countries.indexOf(r.country); return i < 0 ? 99 : i; };
  const best = pool.filter((r) => total(r) === mode)
    .sort((a, b) => rank(a) - rank(b) || (a.date || '9999').localeCompare(b.date || '9999'))[0];

  const spotify = [];
  for (const r of rels) {
    for (const rel of r.relations || []) {
      const m = /open\.spotify\.com\/album\/([A-Za-z0-9]+)/.exec(rel.url?.resource || '');
      if (m) spotify.push({ id: m[1], multi: (r.media || []).length > 1, diff: Math.abs(total(r) - mode), date: r.date || '9999' });
    }
  }
  spotify.sort((a, b) => a.multi - b.multi || a.diff - b.diff || a.date.localeCompare(b.date));

  const full = await mbFetch(`/release/${best.id}?inc=recordings`);
  const discs = (full.media || []).map((m, i) => ({
    n: m.position || i + 1,
    format: m.format || '',
    title: m.title || '',
    tracks: (m.tracks || []).map((t) => ({ n: t.number || String(t.position), title: t.title, ms: t.length || t.recording?.length || 0 })),
  }));
  return { releaseId: best.id, discs, spotify: spotify[0]?.id || null };
}

// Alle Alben eines Interpreten (offizielle Veröffentlichungen)
export async function artistAlbums(artistMbid) {
  const out = [];
  let offset = 0;
  let total = 0;
  do {
    const d = await mbFetch(`/release-group?artist=${artistMbid}&type=album&release-group-status=website-default&limit=100&offset=${offset}`);
    total = d['release-group-count'] || 0;
    for (const rg of d['release-groups'] || []) {
      const date = rg['first-release-date'] || '';
      out.push({
        mbid: rg.id,
        title: rg.title,
        date,
        year: date.slice(0, 4),
        secondary: rg['secondary-types'] || [],
        cover: coverUrl(rg.id),
      });
    }
    offset += 100;
  } while (offset < total && offset < 600);
  return out;
}
