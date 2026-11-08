// TMDB: Filmdatenbank (optional, mit kostenlosem Schlüssel) – Poster, Filmreihen, Serien-Staffeln
// IDs in der App: Film „tmdb:movie:123“, Serie „tmdb:tv:123“, Filmreihe „tmdb:col:123“
import { getSetting } from './db.js';

const API = 'https://api.themoviedb.org/3';
export const img = (path, size = 'w342') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : '');
const num = (vid) => String(vid).split(':').pop();

export async function hasKey() {
  return !!(await getSetting('tmdbKey', '')).trim();
}

async function call(path, params = {}, keyOverride = null) {
  const key = (keyOverride ?? await getSetting('tmdbKey', '')).trim();
  if (!key) throw new Error('Für diese Daten brauchst du den TMDB-Schlüssel (Einstellungen).');
  const url = new URL(API + path);
  url.searchParams.set('language', 'de-DE');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = {};
  // Langer Schlüssel = „Lesezugriffstoken“, kurzer = „API-Schlüssel“ – beide gehen
  if (key.length > 60) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error('Der TMDB-Schlüssel ist ungültig.');
  if (!res.ok) throw new Error(`TMDB antwortet nicht (${res.status}).`);
  return res.json();
}

export async function testKey(key) {
  await call('/configuration', {}, key);
  return true;
}

function mapResult(r) {
  const kind = r.media_type || (r.first_air_date !== undefined ? 'tv' : 'movie');
  return {
    type: 'dvd',
    kind,
    vid: `tmdb:${kind}:${r.id}`,
    title: kind === 'tv' ? r.name : r.title,
    originalTitle: kind === 'tv' ? r.original_name : r.original_title,
    year: (r.release_date || r.first_air_date || '').slice(0, 4),
    cover: img(r.poster_path),
    artist: '',
  };
}

export async function search(title) {
  const d = await call('/search/multi', { query: title, include_adult: 'false' });
  return (d.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map(mapResult);
}

export async function movieDetails(vid) {
  const d = await call(`/movie/${num(vid)}`);
  const c = d.belongs_to_collection;
  return { collectionId: c ? `tmdb:col:${c.id}` : null, collectionName: c?.name || '' };
}

export async function collection(id) {
  const d = await call(`/collection/${num(id)}`);
  return {
    id: `tmdb:col:${d.id}`,
    name: d.name,
    parts: (d.parts || []).map((p) => ({
      vid: `tmdb:movie:${p.id}`,
      title: p.title,
      date: p.release_date || '',
      year: (p.release_date || '').slice(0, 4),
      cover: img(p.poster_path),
    })),
  };
}

export async function tvDetails(vid) {
  const d = await call(`/tv/${num(vid)}`);
  return {
    id: `tmdb:tv:${d.id}`,
    name: d.name,
    cover: img(d.poster_path),
    seasons: (d.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({
        number: s.season_number,
        name: s.name,
        date: s.air_date || '',
        year: (s.air_date || '').slice(0, 4),
        cover: img(s.poster_path) || img(d.poster_path),
      })),
  };
}
