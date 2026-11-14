import type { SyncedLyrics } from '../types';
import {
  parseWordSyncYaml,
  parseLrcWithInterpolation,
  parsePlainLyricsWithEstimatedSync,
} from '../utils/lyricParser';

const LYRIC_CACHE = new Map<string, SyncedLyrics>();

/**
 * Fetches time-synced lyrics from LRCLIB for any Spotify track.
 * Supports exact match, fuzzy search, word-level YAML, line-level LRC,
 * and intelligent plain-text sync fallback.
 */
export async function fetchLyricsFromLrclib(
  trackName: string,
  artistName: string,
  durationMs?: number
): Promise<SyncedLyrics | null> {
  if (!trackName) return null;

  const cacheKey = `${trackName.toLowerCase()}_${(artistName || '').toLowerCase()}`;
  if (LYRIC_CACHE.has(cacheKey)) {
    return LYRIC_CACHE.get(cacheKey)!;
  }

  try {
    // Clean track name: remove "(feat. ...)", "- Remastered ...", "[Radio Edit]", etc.
    const cleanTrack = trackName
      .replace(/\s*[\(\[].*?[\)\]]/g, '')
      .replace(/\s*-\s*(remastered|live|mono|stereo|radio edit).*$/i, '')
      .trim();

    const cleanArtist = (artistName || '').split(',')[0].replace(/feat\..*/i, '').trim();

    let url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTrack)}&artist_name=${encodeURIComponent(cleanArtist)}`;
    if (durationMs) {
      url += `&duration=${Math.round(durationMs / 1000)}`;
    }

    const res = await fetch(url);

    let best: SyncedLyrics | null = null;
    if (res.ok) best = formatLrclibResponse(await res.json(), trackName, artistName, durationMs);

    // No exact match, or only untimed text: a synced copy often exists under
    // another album/edition, so search before settling.
    if (!best || best.sync === 'none') {
      const fallback = await searchLrclibFallback(cleanTrack, cleanArtist, durationMs);
      if (fallback && (!best || fallback.sync !== 'none')) best = fallback;
    }

    if (best) LYRIC_CACHE.set(cacheKey, best);
    return best;
  } catch (err) {
    console.warn('LRCLIB fetch error:', err);
    return null;
  }
}

async function searchLrclibFallback(
  trackName: string,
  artistName: string,
  durationMs?: number
): Promise<SyncedLyrics | null> {
  try {
    const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const list = await res.json();
    if (Array.isArray(list) && list.length > 0) {
      // Prefer the same length of recording (timings only fit the right edit),
      // then word-level sync, then line sync, then plain text.
      const secs = durationMs ? durationMs / 1000 : null;
      const fits = (item: any) => secs === null || !item.duration || Math.abs(item.duration - secs) <= 4;
      const pool = list.filter(fits).length ? list.filter(fits) : list;
      const best =
        pool.find((item: any) => item.hasWordSync || (item.lyricsfile && item.lyricsfile.length > 20)) ||
        pool.find((item: any) => item.syncedLyrics && item.syncedLyrics.length > 10) ||
        pool[0];

      return formatLrclibResponse(best, trackName, artistName, durationMs);
    }
    return null;
  } catch {
    return null;
  }
}

function formatLrclibResponse(
  data: any,
  trackName: string,
  artistName: string,
  durationMs?: number
): SyncedLyrics | null {
  if (!data) return null;

  let parsedLines: any[] = [];
  let hasWordSync = false;
  let sync: SyncedLyrics['sync'] = 'none';

  // 1. Word-level sync via YAML lyricsfile
  if (data.lyricsfile && typeof data.lyricsfile === 'string' && data.lyricsfile.length > 30) {
    try {
      parsedLines = parseWordSyncYaml(data.lyricsfile);
      if (parsedLines.length > 0) {
        hasWordSync = true;
        sync = 'word';
      }
    } catch (e) {
      console.warn('YAML parse error, falling back to LRC:', e);
    }
  }

  // 2. Line-level sync with character interpolation
  if (parsedLines.length === 0 && data.syncedLyrics) {
    parsedLines = parseLrcWithInterpolation(data.syncedLyrics);
    if (parsedLines.length > 0) sync = 'line';
  }

  // 3. Fallback: un-synced plain lyrics evenly mapped across duration
  if (parsedLines.length === 0 && data.plainLyrics) {
    const totalDuration = durationMs || (data.duration ? data.duration * 1000 : 200000);
    parsedLines = parsePlainLyricsWithEstimatedSync(data.plainLyrics, totalDuration);
  }

  if (parsedLines.length === 0) return null;

  return {
    id: data.id,
    trackName: data.trackName || trackName,
    artistName: data.artistName || artistName,
    albumName: data.albumName,
    duration: data.duration,
    instrumental: Boolean(data.instrumental),
    hasWordSync,
    sync,
    lines: parsedLines,
  };
}
