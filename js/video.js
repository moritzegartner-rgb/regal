// Filmdaten aus einer Hand: mit TMDB-Schlüssel von TMDB, sonst kostenlos von Wikidata/Wikipedia
import * as tmdb from './tmdb.js';
import * as wd from './wikidata.js';
import { norm } from './util.js';

const isTmdb = (id) => String(id).startsWith('tmdb:');
const wdId = (id) => String(id).replace(/^wd:/, '');

export async function search(title) {
  if (await tmdb.hasKey()) return tmdb.search(title);
  return wd.search(title);
}

// Besten Treffer wählen (Reihenfolge der Datenbank zählt, genauer Titel zählt mehr)
export function pickBest(list, title, wantTv) {
  const nt = norm(title);
  let best = null;
  let bestScore = -1;
  list.forEach((r, i) => {
    let s = 30 - i * 3;
    if (norm(r.title) === nt || norm(r.originalTitle) === nt) s += 50;
    if (wantTv && r.kind === 'tv') s += 25;
    if (!wantTv && r.kind === 'movie') s += 5;
    if (s > bestScore) { best = r; bestScore = s; }
  });
  if (!best) return null;
  return { ...best, sure: bestScore >= 70 };
}

// Gehört der Film zu einer Reihe? (Wikidata liefert das schon bei der Suche mit)
export async function enrich(m) {
  if (m.kind === 'movie' && m.vid && m.collectionId === undefined && isTmdb(m.vid)) {
    Object.assign(m, await tmdb.movieDetails(m.vid));
  }
  return m;
}

export function collection(id) {
  return isTmdb(id) ? tmdb.collection(id) : wd.collection(wdId(id));
}

export function tvDetails(vid) {
  return isTmdb(vid) ? tmdb.tvDetails(vid) : wd.tvDetails(wdId(vid));
}

export const sourceName = (id) => (isTmdb(id) ? 'TMDB' : 'Wikidata und Wikipedia');
