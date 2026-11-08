// Gemini: liest die CD-/DVD-Rücken auf dem Foto (kostenloser Schlüssel aus Google AI Studio)
import { getSetting, setSetting } from './db.js';
import { blobToBase64 } from './util.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const PROMPT = `You are looking at a photo of a shelf, stack or box with music CDs.
Find EVERY music CD case whose spine or front is visible - left to right, top to bottom.
Spines are often rotated 90 degrees and printed small: read them carefully.
Ignore everything that is not a music CD (DVDs, Blu-rays, games, books, vinyl).

For each CD return:
- "artist": the performer/band ("Various Artists" for compilations of many artists)
- "title": the album title as printed on the case (keep the printed language, no extras like "CD" or "Deluxe Edition")
- "confidence": "high" if clearly readable, "low" if only partly readable or guessed

Do not invent anything. Skip cases you cannot read. List each physical case only once.
Answer ONLY with JSON in exactly this form:
{"items":[{"artist":"Green Day","title":"Dookie","confidence":"high"}]}`;

// Fehlermeldungen von Google in verständliches Deutsch übersetzen
function explain(status, data) {
  const msg = data?.error?.message || '';
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Der Gemini-Schlüssel ist ungültig. Bitte in den Einstellungen prüfen.';
  if (/location is not supported/i.test(msg)) return 'Gemini ist von deinem Standort aus über die Gratis-API nicht erreichbar.';
  if (status === 403) return `Der Gemini-Schlüssel hat keinen Zugriff (403). ${msg}`;
  if (status === 429) return 'Das Gratis-Limit von Gemini ist gerade erreicht. Warte etwa eine Minute (oder bis morgen, falls das Tageslimit voll ist).';
  if (status >= 500) return 'Gemini ist gerade überlastet. Versuch es gleich nochmal.';
  return `Gemini-Fehler (${status}): ${msg || 'unbekannt'}`;
}

// Alle Modelle abrufen und sinnvoll sortieren: neuestes „Flash“ zuerst, „Flash-Lite“ als Ausweichmodell
export async function listModels(key) {
  const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explain(res.status, data));
  const names = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-/.test(n) && /flash/.test(n)
      && !/(image|tts|audio|live|embedding|thinking|exp|8b|computer|robotics|native|dialog)/.test(n));
  const score = (n) => {
    const v = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    let s = v * 100;
    if (/lite/.test(n)) s -= 1000;
    if (/preview/.test(n)) s -= 30;
    if (/latest/.test(n)) s = /lite/.test(n) ? -1500 : -500;
    if (/-\d{3}$/.test(n) || /\d{2}-\d{2,4}$/.test(n)) s -= 5;
    return s;
  };
  return [...new Set(names)].sort((a, b) => score(b) - score(a));
}

// Modelle, deren Gratis-Kontingent gerade aufgebraucht ist, kurz überspringen
const blockedUntil = {};

function parseItems(json) {
  const cand = json.candidates?.[0];
  if (!cand) {
    const why = json.promptFeedback?.blockReason;
    throw new Error(why ? `Gemini hat das Foto abgelehnt (${why}).` : 'Gemini hat keine Antwort geliefert.');
  }
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.search(/[[{]/);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(s); } catch {
    throw new Error('Gemini hat unlesbar geantwortet. Versuch es mit einem neuen Foto.');
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed.items || []);
  return arr
    .filter((x) => x && typeof x.title === 'string' && x.title.trim() && x.type !== 'dvd')
    .map((x) => ({
      type: 'cd',
      artist: String(x.artist || '').trim(),
      title: x.title.trim(),
      confidence: x.confidence === 'low' ? 'low' : 'high',
    }));
}

// Foto an Gemini schicken und erkannte Hüllen zurückgeben
export async function recognize(blob, onStatus) {
  const key = (await getSetting('geminiKey', '')).trim();
  if (!key) throw new Error('Kein Gemini-Schlüssel eingetragen (Einstellungen).');
  let models = await getSetting('geminiModels', null);
  if (!models?.length) {
    models = await listModels(key);
    await setSetting('geminiModels', models);
  }
  if (!models.length) throw new Error('Mit diesem Schlüssel ist kein passendes Gemini-Modell verfügbar.');
  const preferred = await getSetting('geminiModel', 'auto');
  const order = preferred && preferred !== 'auto' && models.includes(preferred)
    ? [preferred, ...models.filter((m) => m !== preferred)]
    : models;

  const data = await blobToBase64(blob);
  const makeBody = (highRes) => ({
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data } },
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(highRes ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}),
    },
  });

  let lastErr = null;
  let tried = 0;
  for (const model of order) {
    if (tried >= 5) break;
    if ((blockedUntil[model] || 0) > Date.now()) continue;
    tried++;
    onStatus?.(`Gemini liest die Rücken … (${model}, dauert meist 10–40 Sekunden)`);
    let highRes = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(`${BASE}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(makeBody(highRes)),
        });
      } catch {
        throw new Error('Keine Verbindung zu Gemini. Bist du online?');
      }
      const json = await res.json().catch(() => ({}));
      if (res.ok) return { items: parseItems(json), model };
      const msg = json?.error?.message || '';
      // Manche Modelle kennen die Einstellung „hohe Bildauflösung“ nicht – dann ohne
      if (res.status === 400 && highRes && /media|resolution/i.test(msg)) { highRes = false; continue; }
      lastErr = new Error(explain(res.status, json));
      if (res.status === 429) {
        const daily = /PerDay|limit: 0/i.test(JSON.stringify(json));
        blockedUntil[model] = Date.now() + (daily ? 6 * 3600e3 : 65e3);
      } else if (res.status === 404 || (res.status === 400 && /not (found|supported)/i.test(msg))) {
        blockedUntil[model] = Date.now() + 24 * 3600e3;
      } else if (res.status < 500) {
        throw lastErr; // z. B. falscher Schlüssel – anderes Modell hilft nicht
      }
      break; // nächstes Modell probieren
    }
  }
  throw lastErr || new Error('Gerade ist kein Gemini-Modell frei. Warte eine Minute und versuch es nochmal.');
}
