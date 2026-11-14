/**
 * Tempo / key / energy / mood for Spotify tracks from ReccoBeats
 * (free, no key). Spotify stopped serving audio features to new apps in
 * November 2024, so this is the stand-in. Results are cached locally.
 */

export interface AudioFeatures {
  tempo: number; // BPM
  key: number; // pitch class 0-11, -1 unknown
  mode: number; // 1 major, 0 minor
  energy: number; // 0-1
  valence: number; // 0-1 (sad → happy)
  danceability: number; // 0-1
  acousticness: number; // 0-1
  instrumentalness: number; // 0-1
}

const CACHE_KEY = 'afterglow.features.v1';
const BATCH = 40;
const MISSING = 0;

type Cache = Record<string, AudioFeatures | typeof MISSING>;

function loadCache(): Cache {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveCache(c: Cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota: fine, it's only a cache */
  }
}

const spotifyIdFromHref = (href: string) => href.match(/track\/([A-Za-z0-9]{22})/)?.[1];

export async function getAudioFeatures(
  ids: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, AudioFeatures>> {
  const cache = loadCache();
  const out = new Map<string, AudioFeatures>();
  const todo: string[] = [];
  for (const id of new Set(ids)) {
    const hit = cache[id];
    if (hit === undefined) todo.push(id);
    else if (hit !== MISSING) out.set(id, hit);
  }

  let done = ids.length - todo.length;
  onProgress?.(done, ids.length);
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    try {
      const res = await fetch(`https://api.reccobeats.com/v1/audio-features?ids=${chunk.join(',')}`);
      if (res.ok) {
        const body = await res.json();
        const found = new Set<string>();
        for (const f of body?.content ?? []) {
          const id = spotifyIdFromHref(f.href ?? '');
          if (!id || typeof f.tempo !== 'number') continue;
          const feat: AudioFeatures = {
            tempo: f.tempo,
            key: typeof f.key === 'number' ? f.key : -1,
            mode: typeof f.mode === 'number' ? f.mode : 1,
            energy: f.energy ?? 0.5,
            valence: f.valence ?? 0.5,
            danceability: f.danceability ?? 0.5,
            acousticness: f.acousticness ?? 0.3,
            instrumentalness: f.instrumentalness ?? 0,
          };
          cache[id] = feat;
          out.set(id, feat);
          found.add(id);
        }
        for (const id of chunk) if (!found.has(id)) cache[id] = MISSING;
      }
    } catch {
      /* network hiccup: leave uncached so the next plan retries */
    }
    done += chunk.length;
    onProgress?.(done, ids.length);
  }
  saveCache(cache);
  return out;
}
