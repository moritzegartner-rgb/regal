// Wikidata + Wikipedia: kostenlose Filmdaten, Filmreihen und Poster – ganz ohne Schlüssel
const WD = 'https://www.wikidata.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const WP = 'https://en.wikipedia.org/w/api.php';

const FILM = 'Q11424';
const TV_SERIES = 'Q5398426';
const SEASON = 'Q3464665';
// Film, Spielfilm, Fernsehfilm, Animationsfilm, Dokumentarfilm, Serie, Zeichentrickserie, Miniserie, Anime-Serie
const VIDEO_CLASSES = ['Q11424', 'Q24869', 'Q506240', 'Q202866', 'Q93204', 'Q5398426', 'Q581714', 'Q1259759', 'Q63952888'];

async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('Keine Verbindung zu Wikidata. Bist du online?');
  }
  if (!res.ok) throw new Error(`Wikidata antwortet nicht (${res.status}). Versuch es gleich nochmal.`);
  return res.json();
}

async function sparql(query) {
  const d = await getJson(`${SPARQL}?format=json&query=${encodeURIComponent(query)}`);
  return d.results?.bindings || [];
}

const qid = (uri) => String(uri || '').split('/').pop();
const val = (b, k) => b[k]?.value;
// „mul“ = sprachübergreifender Name (z. B. „Pulp Fiction“ gilt in allen Sprachen)
const LABELS = 'SERVICE wikibase:label { bd:serviceParam wikibase:language "de,mul,en". }';
const EN_ARTICLE = (v, out) => `OPTIONAL { ?${out}A schema:about ?${v} ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?${out} }`;

// Poster = Bild aus der Infobox der englischen Wikipedia
export async function posters(titles) {
  const out = {};
  const list = [...new Set(titles.filter(Boolean))];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const d = await getJson(`${WP}?action=query&prop=pageimages&piprop=thumbnail&pithumbsize=500&pilicense=any&redirects=1&format=json&origin=*&titles=${encodeURIComponent(chunk.join('|'))}`);
    const final = Object.fromEntries(chunk.map((t) => [t, t]));
    for (const step of [d.query?.normalized || [], d.query?.redirects || []]) {
      for (const n of step) for (const t of chunk) if (final[t] === n.from) final[t] = n.to;
    }
    const img = {};
    for (const p of Object.values(d.query?.pages || {})) {
      if (p.thumbnail?.source) img[p.title] = p.thumbnail.source.replace(/\?utm_.*$/, '');
    }
    for (const t of chunk) if (img[final[t]]) out[t] = img[final[t]];
  }
  return out;
}

// Infos zu einzelnen Filmen/Serien (deutscher Titel, Jahr, Filmreihe, Poster)
async function details(ids) {
  const rows = await sparql(`SELECT ?item ?itemLabel ?date ?start ?series ?seriesLabel ?seasons ?en ?isTv WHERE {
    VALUES ?item { ${ids.map((i) => `wd:${i}`).join(' ')} }
    OPTIONAL { ?item wdt:P577 ?date }
    OPTIONAL { ?item wdt:P580 ?start }
    OPTIONAL { ?item wdt:P179 ?series }
    OPTIONAL { ?item wdt:P2437 ?seasons }
    ${EN_ARTICLE('item', 'en')}
    BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:${TV_SERIES} } AS ?isTv)
    ${LABELS}
  }`);
  const by = {};
  for (const b of rows) {
    const id = qid(val(b, 'item'));
    if (!by[id]) by[id] = { id, title: val(b, 'itemLabel'), dates: [], series: {}, seasons: 0, en: val(b, 'en'), isTv: val(b, 'isTv') === 'true' };
    const e = by[id];
    const dt = val(b, 'date') || val(b, 'start');
    if (dt) e.dates.push(dt);
    if (val(b, 'series')) e.series[qid(val(b, 'series'))] = val(b, 'seriesLabel');
    if (val(b, 'seasons')) e.seasons = Math.max(e.seasons, parseInt(val(b, 'seasons'), 10) || 0);
  }
  // Gehört ein Film zu mehreren Reihen, nehmen wir die kleinste (z. B. Trilogie statt Franchise)
  const multi = [...new Set(Object.values(by).flatMap((e) => (Object.keys(e.series).length > 1 ? Object.keys(e.series) : [])))];
  const sizes = {};
  if (multi.length) {
    const r = await sparql(`SELECT ?series (COUNT(DISTINCT ?p) AS ?n) WHERE {
      VALUES ?series { ${multi.map((s) => `wd:${s}`).join(' ')} }
      ?p wdt:P179 ?series . ?p wdt:P31/wdt:P279* wd:${FILM} .
    } GROUP BY ?series`).catch(() => []);
    for (const b of r) sizes[qid(val(b, 'series'))] = Number(val(b, 'n'));
  }
  const pics = await posters(Object.values(by).map((e) => e.en)).catch(() => ({}));
  const out = {};
  for (const e of Object.values(by)) {
    const candidates = Object.keys(e.series).sort((a, b) => (sizes[a] ?? 50) - (sizes[b] ?? 50));
    const sid = e.isTv ? null : (candidates.find((s) => (sizes[s] ?? 2) >= 2) || null);
    e.dates.sort();
    out[e.id] = {
      type: 'dvd',
      kind: e.isTv ? 'tv' : 'movie',
      vid: `wd:${e.id}`,
      title: e.title,
      originalTitle: e.en || '',
      year: (e.dates[0] || '').slice(0, 4),
      cover: pics[e.en] || '',
      artist: '',
      collectionId: sid ? `wd:${sid}` : null,
      collectionName: sid ? e.series[sid] : '',
    };
  }
  return out;
}

// Film oder Serie suchen
export async function search(title) {
  const clean = String(title).replace(/["\\]/g, ' ').trim();
  if (!clean) return [];
  const filter = VIDEO_CLASSES.map((q) => `P31=${q}`).join('|');
  const d = await getJson(`${WD}?action=query&list=search&srlimit=8&format=json&origin=*&srsearch=${encodeURIComponent(`${clean} haswbstatement:${filter}`)}`);
  const ids = (d.query?.search || []).map((x) => x.title).filter((t) => /^Q\d+$/.test(t));
  if (!ids.length) return [];
  const info = await details(ids);
  return ids.map((id) => info[id]).filter(Boolean);
}

// Alle Filme einer Reihe
export async function collection(sid) {
  const [rows, nameRows] = await Promise.all([
    sparql(`SELECT ?film ?filmLabel (MIN(?d) AS ?date) (SAMPLE(?t) AS ?en) WHERE {
      ?film wdt:P179 wd:${sid} . ?film wdt:P31/wdt:P279* wd:${FILM} .
      OPTIONAL { ?film wdt:P577 ?d }
      ${EN_ARTICLE('film', 't')}
      ${LABELS}
    } GROUP BY ?film ?filmLabel ORDER BY ?date`),
    sparql(`SELECT ?sLabel WHERE { BIND(wd:${sid} AS ?s) ${LABELS} }`),
  ]);
  const pics = await posters(rows.map((b) => val(b, 'en'))).catch(() => ({}));
  return {
    id: `wd:${sid}`,
    name: val(nameRows[0] || {}, 'sLabel') || 'Filmreihe',
    parts: rows.map((b) => {
      const date = (val(b, 'date') || '').slice(0, 10);
      return { vid: `wd:${qid(val(b, 'film'))}`, title: val(b, 'filmLabel'), date, year: date.slice(0, 4), cover: pics[val(b, 'en')] || '' };
    }),
  };
}

// Staffeln einer Serie
export async function tvDetails(id) {
  const [info, seasonRows] = await Promise.all([
    sparql(`SELECT ?sLabel ?n ?en WHERE {
      BIND(wd:${id} AS ?s)
      OPTIONAL { ?s wdt:P2437 ?n }
      ${EN_ARTICLE('s', 'en')}
      ${LABELS}
    }`),
    sparql(`SELECT ?season ?num ?date WHERE {
      ?season p:P179 ?st . ?st ps:P179 wd:${id} .
      ?season wdt:P31 wd:${SEASON} .
      OPTIONAL { ?st pq:P1545 ?num }
      OPTIONAL { ?season wdt:P580 ?date }
      OPTIONAL { ?season wdt:P577 ?date }
    }`).catch(() => []),
  ]);
  const i = info[0] || {};
  const en = val(i, 'en');
  const cover = en ? (await posters([en]).catch(() => ({})))[en] || '' : '';
  const seasons = new Map();
  for (const b of seasonRows) {
    const n = parseInt(val(b, 'num'), 10);
    if (!(n > 0) || seasons.has(n)) continue;
    const date = (val(b, 'date') || '').slice(0, 10);
    seasons.set(n, { number: n, name: `Staffel ${n}`, date, year: date.slice(0, 4), cover });
  }
  const count = Math.max(...info.map((b) => parseInt(val(b, 'n'), 10) || 0), 0);
  for (let n = 1; n <= count; n++) {
    if (!seasons.has(n)) seasons.set(n, { number: n, name: `Staffel ${n}`, date: '', year: '', cover });
  }
  return {
    id: `wd:${id}`,
    name: val(i, 'sLabel') || 'Serie',
    cover,
    seasons: [...seasons.values()].sort((a, b) => a.number - b.number),
  };
}
