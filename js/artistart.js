// TheAudioDB: Logos (Schriftzüge) von Interpreten
// Kostenloser öffentlicher Schlüssel „123“ – ohne Anmeldung, höchstens 30 Anfragen pro Minute.
import { norm, sleep } from './util.js';

const ADB = 'https://www.theaudiodb.com/api/v1/json/123';

// Warteschlange: eine Anfrage alle gut 2 Sekunden (bleibt sicher unter dem Limit)
let last = 0;
let chain = Promise.resolve();

function adbFetch(path) {
  const job = async () => {
    const wait = Math.max(0, last + 2100 - Date.now());
    if (wait) await sleep(wait);
    last = Date.now();
    const res = await fetch(ADB + path);
    if (!res.ok) throw new Error(`TheAudioDB antwortet nicht (${res.status}).`);
    return res.json();
  };
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
}

// Logo und Foto eines Interpreten – über die MusicBrainz-ID, sonst über den Namen
export async function artistArt({ mbid, name }) {
  const d = await adbFetch(mbid ? `/artist-mb.php?i=${mbid}` : `/search.php?s=${encodeURIComponent(name)}`);
  const a = d?.artists?.[0];
  if (!a) return { logo: '', thumb: '' };
  if (!mbid && norm(a.strArtist) !== norm(name)) return { logo: '', thumb: '' };
  return { logo: a.strArtistLogo || '', thumb: a.strArtistThumb || '' };
}

// Kleinere Fassungen der Bilder (TheAudioDB hängt /small bzw. /medium an)
export const small = (url) => (url ? `${url}/small` : '');
export const medium = (url) => (url ? `${url}/medium` : '');
