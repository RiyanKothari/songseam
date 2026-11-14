import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './platform';
import type { SpotifyTrack } from '../types';

/**
 * Spotify Web API with Authorization Code + PKCE (no client secret).
 * Desktop: login opens the system browser and a loopback listener on
 * 127.0.0.1 catches the redirect. Web: the page itself is the redirect.
 *
 * Endpoint shapes follow Spotify's February 2026 dev-mode changes:
 * playlist contents via /playlists/{id}/items (entry.item), and only for
 * playlists the user owns or collaborates on.
 */

const API = 'https://api.spotify.com/v1';
const TOKEN_KEY = 'songseam.spotify.token';
const CLIENT_KEY = 'songseam.spotify.clientId';
const PKCE_KEY = 'songseam.spotify.pkce';
export const DESKTOP_PORT = 43821;

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'playlist-modify-private',
  'playlist-modify-public',
].join(' ');

interface Token {
  access: string;
  refresh?: string;
  expiresAt: number;
  scope?: string;
}

export function redirectUri(): string {
  return isDesktop ? `http://127.0.0.1:${DESKTOP_PORT}/callback` : `${window.location.origin}/callback`;
}

export const getClientId = () => localStorage.getItem(CLIENT_KEY) ?? '';
export const setClientId = (id: string) => localStorage.setItem(CLIENT_KEY, id.trim());

function loadToken(): Token | null {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as Token | null;
    return t?.access ? t : null;
  } catch {
    return null;
  }
}
const saveToken = (t: Token) => localStorage.setItem(TOKEN_KEY, JSON.stringify(t));

export const isLoggedIn = () => loadToken() !== null;

/** True if the current login allows creating playlists (older logins need a reconnect). */
export const canSavePlaylists = () => (loadToken()?.scope ?? '').includes('playlist-modify-private');
export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}

function randomString(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function tokenRequest(body: Record<string, string>): Promise<Token> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Spotify token error ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const prev = loadToken();
  const t: Token = {
    access: j.access_token,
    refresh: j.refresh_token ?? prev?.refresh,
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
    scope: j.scope ?? prev?.scope,
  };
  saveToken(t);
  return t;
}

/** Starts login. Desktop: resolves when done. Web: navigates away. */
export async function login(): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error('Add your Spotify Client ID first.');
  const verifier = randomString(64);
  const state = randomString(16);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope: SCOPES,
    state,
  });
  const url = `https://accounts.spotify.com/authorize?${params}`;

  if (!isDesktop) {
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    window.location.href = url;
    return;
  }

  // Rust starts the loopback listener, then opens the browser, then waits for the redirect.
  const r = await invoke<{ code?: string; state?: string; error?: string }>('spotify_login', { url, port: DESKTOP_PORT });
  if (r.error) throw new Error(`Spotify login refused: ${r.error}`);
  if (!r.code || r.state !== state) throw new Error('Spotify login failed (state mismatch).');
  await tokenRequest({
    grant_type: 'authorization_code',
    code: r.code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier,
  });
}

/** Web only: finishes login when Spotify redirects back to /callback. */
export async function handleWebCallback(): Promise<boolean> {
  if (isDesktop || !window.location.pathname.startsWith('/callback')) return false;
  const q = new URLSearchParams(window.location.search);
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as { verifier: string; state: string } | null;
  window.history.replaceState({}, '', '/');
  sessionStorage.removeItem(PKCE_KEY);
  const code = q.get('code');
  if (!code || !saved || q.get('state') !== saved.state) return false;
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: getClientId(),
    code_verifier: saved.verifier,
  });
  return true;
}

async function accessToken(): Promise<string> {
  const t = loadToken();
  if (!t) throw new Error('Not connected to Spotify');
  if (Date.now() < t.expiresAt) return t.access;
  if (!t.refresh) throw new Error('Spotify session expired — connect again');
  return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: getClientId() })).access;
}

export class SpotifyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(path: string, init: RequestInit = {}, retry = 0): Promise<T | null> {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 429 && retry < 3) {
    const wait = Number(res.headers.get('Retry-After') ?? '2');
    await new Promise((r) => setTimeout(r, Math.min(wait, 20) * 1000));
    return api<T>(path, init, retry + 1);
  }
  if (res.status === 401 && retry === 0) {
    const t = loadToken();
    if (t) saveToken({ ...t, expiresAt: 0 });
    return api<T>(path, init, 1);
  }
  if (res.status === 204 || res.status === 202) return null;
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error?.message ?? j.error_description ?? msg;
    } catch {
      /* body not JSON */
    }
    throw new SpotifyError(res.status, msg);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

// ---------- Library ----------

export interface PlaylistSummary {
  id: string;
  name: string;
  total: number;
  image?: string;
}

interface RawTrack {
  id: string | null;
  uri: string;
  name: string;
  type?: string;
  is_local?: boolean;
  duration_ms: number;
  artists: { name: string; id?: string }[];
  album: { name: string; images: { url: string }[] };
}

export interface LibraryTrack {
  id: string;
  uri: string;
  name: string;
  artist: string;
  durationMs: number;
  image?: string;
}

function toLibraryTrack(t: RawTrack | null | undefined): LibraryTrack | null {
  if (!t || !t.id || t.is_local || (t.type && t.type !== 'track')) return null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    durationMs: t.duration_ms,
    image: t.album?.images?.[t.album.images.length > 1 ? 1 : 0]?.url,
  };
}

export async function getMe(): Promise<{ id: string; display_name: string; product?: string }> {
  return (await api('/me'))!;
}

/** Playlists whose tracks Spotify will return to this app: owned or collaborative. */
export async function getReadablePlaylists(): Promise<PlaylistSummary[]> {
  const me = await getMe();
  const out: PlaylistSummary[] = [];
  let url: string | null = '/me/playlists?limit=50';
  while (url && out.length < 500) {
    const page: any = await api(url);
    for (const p of page?.items ?? []) {
      if (!p) continue;
      if (p.owner?.id !== me.id && !p.collaborative) continue;
      const total = p.items?.total ?? p.tracks?.total ?? 0;
      out.push({ id: p.id, name: p.name, total, image: p.images?.[0]?.url });
    }
    url = page?.next ?? null;
  }
  return out;
}

export async function getPlaylistTracks(id: string, max = 400): Promise<LibraryTrack[]> {
  const out: LibraryTrack[] = [];
  let url: string | null = `/playlists/${id}/items?limit=50`;
  while (url && out.length < max) {
    const page: any = await api(url);
    for (const e of page?.items ?? []) {
      const t = toLibraryTrack(e?.item ?? e?.track);
      if (t) out.push(t);
    }
    url = page?.next ?? null;
  }
  return out;
}

export async function getLikedTracks(max = 500): Promise<LibraryTrack[]> {
  const out: LibraryTrack[] = [];
  let url: string | null = '/me/tracks?limit=50';
  while (url && out.length < max) {
    const page: any = await api(url);
    for (const e of page?.items ?? []) {
      const t = toLibraryTrack(e?.track ?? e?.item);
      if (t) out.push(t);
    }
    url = page?.next ?? null;
  }
  return out;
}

// ---------- Player ----------

export interface Device {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}

export async function getDevices(): Promise<Device[]> {
  return ((await api<{ devices: Device[] }>('/me/player/devices'))?.devices ?? []).filter((d) => d.id);
}

/** Prefers a device on this computer, then whatever is active. */
export async function pickDevice(): Promise<Device | null> {
  const devices = await getDevices();
  return devices.find((d) => d.type === 'Computer' && d.is_active) ?? devices.find((d) => d.type === 'Computer') ?? devices.find((d) => d.is_active) ?? devices[0] ?? null;
}

export async function playUris(uris: string[], deviceId?: string): Promise<void> {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await api(`/me/player/play${q}`, { method: 'PUT', body: JSON.stringify({ uris }) });
}

export const player = {
  play: () => api('/me/player/play', { method: 'PUT' }),
  pause: () => api('/me/player/pause', { method: 'PUT' }),
  next: () => api('/me/player/next', { method: 'POST' }),
  previous: () => api('/me/player/previous', { method: 'POST' }),
  seek: (ms: number) => api(`/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`, { method: 'PUT' }),
  volume: (pct: number) =>
    api(`/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(pct)))}`, { method: 'PUT' }),
};

export interface PlaybackState {
  track: SpotifyTrack;
  isPlaying: boolean;
  progressMs: number;
  volumePercent: number | null;
  deviceName: string;
}

export async function getPlayback(): Promise<PlaybackState | null> {
  const s: any = await api('/me/player?additional_types=track');
  if (!s?.item || s.item.type !== 'track') return null;
  const i = s.item;
  return {
    track: {
      id: i.id,
      uri: i.uri,
      name: i.name,
      artists: i.artists,
      album: { name: i.album?.name ?? '', images: i.album?.images ?? [] },
      duration_ms: i.duration_ms,
      progress_ms: s.progress_ms ?? 0,
      is_playing: s.is_playing,
    },
    isPlaying: s.is_playing,
    progressMs: s.progress_ms ?? 0,
    volumePercent: s.device?.volume_percent ?? null,
    deviceName: s.device?.name ?? '',
  };
}

// ---------- Save a set ----------

/** Creates a private playlist with the set in order and returns its Spotify URL. */
export async function savePlaylist(name: string, description: string, uris: string[]): Promise<string> {
  const pl = await api<{ id: string; external_urls?: { spotify?: string } }>('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name, description, public: false }),
  });
  if (!pl?.id) throw new Error('Spotify did not create the playlist');
  for (let i = 0; i < uris.length; i += 100) {
    await api(`/playlists/${pl.id}/items`, { method: 'POST', body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
  }
  return pl.external_urls?.spotify ?? `https://open.spotify.com/playlist/${pl.id}`;
}
