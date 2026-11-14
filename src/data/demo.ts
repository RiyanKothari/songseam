import type { LyricLine, SpotifyTrack, SyncedLyrics } from '../types';

/** Original demo song (words and "art" written for Afterglow) for the browser preview. */

const LINES: [number, string][] = [
  [2000, 'City lights are humming low'],
  [6000, 'Every window starts to glow'],
  [10000, 'Turn it up and let it show'],
  [14000, "We're the colour of the radio"],
  [19000, 'Hold the moment, keep it slow'],
  [23000, "Paint the dark in afterglow"],
  [28000, 'Afterglow, afterglow'],
  [32000, 'Light the edges, let it flow'],
  [37000, 'Every heartbeat, every echo'],
  [41000, 'Burning bright in afterglow'],
];

function timed(start: number, text: string, durMs: number): LyricLine {
  const words = text.split(' ');
  const total = words.reduce((s, w) => s + w.length + 1, 0);
  let t = start;
  return {
    text,
    start_ms: start,
    end_ms: start + durMs,
    words: words.map((w) => {
      const d = (durMs * (w.length + 1)) / total;
      const word = { text: w, start_ms: Math.round(t), end_ms: Math.round(t + d) };
      t += d;
      return word;
    }),
  };
}

export const DEMO_LYRICS: SyncedLyrics = {
  trackName: 'Afterglow (demo)',
  artistName: 'Afterglow',
  instrumental: false,
  hasWordSync: true,
  sync: 'word',
  lines: LINES.map(([start, text], i) => timed(start, text, Math.min(3400, (LINES[i + 1]?.[0] ?? start + 4000) - start - 300))),
};

const ART =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff2d75"/><stop offset="0.55" stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="150" r="70" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="10"/></svg>`,
  );

export const DEMO_TRACK: SpotifyTrack = {
  id: 'demo',
  name: 'Afterglow (demo)',
  artists: [{ name: 'Afterglow' }],
  album: { name: 'Demo', images: [{ url: ART }] },
  duration_ms: 46000,
  progress_ms: 0,
  is_playing: false,
};

export const DEMO_BPM = 120;
