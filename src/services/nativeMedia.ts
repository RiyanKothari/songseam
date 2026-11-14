import { invoke } from '@tauri-apps/api/core';

/** Mirrors `NowPlaying` in src-tauri/src/media.rs. */
export interface NativeNowPlaying {
  sourceApp: string;
  title: string;
  artist: string;
  album: string;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  positionUpdatedAtMs: number;
  trackKey: string;
}

export type NativeMediaAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek';

/** True when running inside the Tauri desktop shell (not a plain browser tab). */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const NativeMedia = {
  /** Reads Windows media controls (cheap; poll it). */
  nowPlaying(): Promise<NativeNowPlaying | null> {
    return invoke<NativeNowPlaying | null>('now_playing');
  },

  /** Album art of the current track as a data URL (cached in the app per track). */
  art(): Promise<{ trackKey: string; dataUrl: string } | null> {
    return invoke('now_playing_art');
  },

  control(action: NativeMediaAction, positionMs?: number): Promise<boolean> {
    return invoke<boolean>('media_control', { action, positionMs });
  },

  /**
   * Windows only reports position when it changes state, so estimate the live
   * position from the last report, clamped to the track length.
   */
  livePosition(np: NativeNowPlaying, now = Date.now()): number {
    const drift = np.isPlaying ? Math.max(0, now - np.positionUpdatedAtMs) : 0;
    const pos = np.positionMs + drift;
    return np.durationMs > 0 ? Math.min(pos, np.durationMs) : pos;
  },
};
