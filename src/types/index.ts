export interface SpotifyTrack {
  id: string;
  uri?: string;
  name: string;
  artists: { name: string; id?: string }[];
  album: {
    name: string;
    images: { url: string; height?: number; width?: number }[];
  };
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
}

export interface LyricWord {
  text: string;
  start_ms: number;
  end_ms?: number;
}

export interface LyricLine {
  text: string;
  start_ms: number;
  end_ms?: number;
  words?: LyricWord[];
}

/** How precise the timings are: per word, per line (words estimated), or not timed at all. */
export type LyricSync = 'word' | 'line' | 'none';

export interface SyncedLyrics {
  id?: number | string;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental: boolean;
  hasWordSync: boolean;
  sync: LyricSync;
  lines: LyricLine[];
}

export interface ColorPalette {
  primary: string; // vivid rgb()
  secondary: string;
  accent: string;
  surface: string; // very dark tint of primary, for backgrounds
  textColor: string;
}

/** Live loudness of what's playing, 0..1 each. `beat` decays from 1 after an onset. */
export interface AudioLevels {
  bass: number;
  mid: number;
  treble: number;
  level: number;
  beat: number;
}

export type GlowPattern = 'flow' | 'pulse' | 'breathe' | 'still';

export interface GlowSettings {
  enabled: boolean;
  pattern: GlowPattern;
  thickness: number; // px of the solid band
  glow: number; // px of bloom spread
  brightness: number; // 0.4 - 2
  reactivity: number; // 0 - 2
  speed: number; // 0.2 - 3 rotation speed multiplier
  colorMode: 'album' | 'custom';
  custom: [string, string, string];
}

export type LyricStyle = 'sweep' | 'pop' | 'line';

export interface LyricsSettings {
  onOverlay: boolean;
  style: LyricStyle;
  position: 'bottom' | 'center' | 'top';
  size: number; // px, current line
  offsetMs: number; // positive = lyrics later
  showNext: boolean;
  backdrop: boolean;
}

export interface AppSettings {
  glow: GlowSettings;
  lyrics: LyricsSettings;
  /** Stage shows only the edge glow and lyrics on pure black. */
  blackout: boolean;
}
