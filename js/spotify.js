// Spotify als Fernbedienung (Spotify Connect über die Web-API, braucht Premium)
// Anmeldung per „PKCE“: kein Geheimnis in der App, nur die öffentliche Client ID.
// Weil iOS die Anmeldung oft in Safari statt in der Home-Bildschirm-App beendet, gibt es einen
// „Verbindungs-Code“, den man von dort in die App kopiert.
import { getSetting, setSetting } from './db.js';
import { norm } from './util.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state';

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
const encodeJson = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
const decodeJson = (s) => { try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(fromB64url(s), (c) => c.charCodeAt(0)))); } catch { return null; } };

export const redirectUri = () => location.origin + location.pathname;

export class NotConnected extends Error {
  constructor() { super('Spotify ist nicht verbunden.'); }
}

// ---------- Anmeldung ----------
export async function authorizeUrl(clientId) {
  const raw = new Uint8Array(48);
  crypto.getRandomValues(raw);
  const verifier = b64url(raw);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  // Client ID und Prüfschlüssel reisen im „state“ mit – so klappt der Abschluss auch in Safari
  const state = encodeJson({ c: clientId, v: verifier });
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  return `${ACCOUNTS}/authorize?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(d.error === 'invalid_grant'
      ? 'Die Spotify-Verbindung ist abgelaufen. Bitte neu verbinden.'
      : `Spotify-Anmeldung fehlgeschlagen: ${d.error_description || d.error || res.status}`);
    err.code = d.error;
    throw err;
  }
  return d;
}

// Rückkehr von Spotify: Code gegen Schlüssel tauschen, Verbindungs-Code zurückgeben
export async function finishLogin(code, state) {
  const st = decodeJson(state);
  if (!st?.c || !st?.v) throw new Error('Die Anmeldung ist unvollständig. Bitte nochmal verbinden.');
  const d = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: st.c, code_verifier: st.v,
  });
  await saveTokens(d, st.c);
  return `REGAL-${encodeJson({ c: st.c, r: d.refresh_token })}`;
}

// Verbindungs-Code in der App einfügen
export async function useConnectCode(text) {
  const m = /REGAL-([A-Za-z0-9_-]+)/.exec(String(text || ''));
  const data = m && decodeJson(m[1]);
  if (!data?.c || !data?.r) throw new Error('Das ist kein gültiger Verbindungs-Code.');
  await setSetting('spClientId', data.c);
  await setSetting('spRefresh', data.r);
  await setSetting('spAccess', '');
  await setSetting('spExpires', 0);
  await accessToken(); // gleich prüfen
}

async function saveTokens(d, clientId) {
  if (clientId) await setSetting('spClientId', clientId);
  if (d.refresh_token) await setSetting('spRefresh', d.refresh_token);
  await setSetting('spAccess', d.access_token);
  await setSetting('spExpires', Date.now() + ((d.expires_in || 3600) - 60) * 1000);
}

export async function isConnected() {
  return !!(await getSetting('spRefresh', ''));
}

export async function disconnect() {
  for (const k of ['spRefresh', 'spAccess', 'spExpires', 'spUser', 'spDevice']) await setSetting(k, '');
}

async function accessToken() {
  const tok = await getSetting('spAccess', '');
  if (tok && Date.now() < (await getSetting('spExpires', 0))) return tok;
  const refresh = await getSetting('spRefresh', '');
  const clientId = await getSetting('spClientId', '');
  if (!refresh || !clientId) throw new NotConnected();
  try {
    const d = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    await saveTokens(d);
    return d.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') await setSetting('spRefresh', '');
    throw e;
  }
}

// ---------- Web-API ----------
function explain(status, d) {
  const reason = d?.error?.reason || '';
  if (reason === 'NO_ACTIVE_DEVICE' || status === 404) return 'Spotify läuft gerade auf keinem Gerät.';
  if (reason === 'PREMIUM_REQUIRED') return 'Für die Fernsteuerung braucht Spotify ein Premium-Konto.';
  if (status === 401) return 'Die Spotify-Verbindung ist abgelaufen. Bitte neu verbinden.';
  if (status === 403) return `Spotify erlaubt das gerade nicht (${d?.error?.message || 'kein Zugriff'}).`;
  if (status === 429) return 'Spotify bremst gerade – versuch es gleich nochmal.';
  return `Spotify-Fehler (${status}): ${d?.error?.message || 'unbekannt'}`;
}

async function api(method, path, body) {
  const tok = await accessToken();
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204 || res.status === 202) return null;
  const d = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(explain(res.status, d));
    err.status = res.status;
    err.reason = d?.error?.reason || '';
    throw err;
  }
  return d;
}

export async function me() {
  const d = await api('GET', '/me');
  return d?.display_name || d?.id || '';
}

export async function devices() {
  return ((await api('GET', '/me/player/devices'))?.devices || []).filter((d) => !d.is_restricted);
}

// Gerät wählen: gewünschtes → gerade aktives → iPhone → irgendeins
export async function pickDevice() {
  const list = await devices();
  const pref = await getSetting('spDevice', '');
  return list.find((d) => d.id === pref) || list.find((d) => d.is_active)
    || list.find((d) => d.type === 'Smartphone') || list[0] || null;
}

// Album bei Spotify suchen, falls MusicBrainz keinen Link kennt
export async function findAlbum(artist, title) {
  const q = `album:${title} artist:${artist}`;
  const d = await api('GET', `/search?type=album&limit=5&q=${encodeURIComponent(q)}`);
  const items = d?.albums?.items || [];
  const nt = norm(title);
  const best = items.find((a) => norm(a.name) === nt) || items.find((a) => norm(a.name).startsWith(nt)) || items[0];
  return best?.id || null;
}

export async function albumTracks(id) {
  return (await api('GET', `/albums/${id}/tracks?limit=50`))?.items || [];
}

// ---------- Steuerung (Play/Pause, vor, zurück) ----------
const dev = (id) => (id ? `?device_id=${encodeURIComponent(id)}` : '');
export const playerState = () => api('GET', '/me/player'); // null, wenn gerade nichts aktiv ist
export const pause = (deviceId) => api('PUT', `/me/player/pause${dev(deviceId)}`);
export const resume = (deviceId) => api('PUT', `/me/player/play${dev(deviceId)}`);
export const next = (deviceId) => api('POST', `/me/player/next${dev(deviceId)}`);
export const previous = (deviceId) => api('POST', `/me/player/previous${dev(deviceId)}`);

// ---------- Profilbild eines Interpreten ----------
// Spotify-ID von MusicBrainz (sicherer Treffer) oder Suche nach dem Namen
export async function artistImage({ spotifyId, name }) {
  let a = null;
  if (spotifyId) {
    try { a = await api('GET', `/artists/${spotifyId}`); } catch (e) { if (e instanceof NotConnected) throw e; }
  }
  if (!a && name) {
    const d = await api('GET', `/search?type=artist&limit=5&q=${encodeURIComponent(name)}`);
    const n = norm(name);
    a = (d?.artists?.items || []).find((x) => norm(x.name) === n) || null;
  }
  const imgs = (a?.images || []).slice().sort((x, y) => (x.width || 0) - (y.width || 0));
  if (!imgs.length) return { id: a?.id || '', img: '', big: '' };
  const mid = imgs.find((i) => (i.width || 0) >= 300) || imgs[imgs.length - 1];
  return { id: a.id, img: mid.url, big: imgs[imgs.length - 1].url };
}

export async function play({ deviceId, contextUri, offset }) {
  await api('PUT', `/me/player/play${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''}`, {
    context_uri: contextUri, ...(offset ? { offset } : {}),
  });
}
