import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../types';
import { broadcast, on } from '../services/platform';

const KEY = 'songseam.settings.v1';
const EVENT = 'settings-changed';

export const DEFAULT_SETTINGS: AppSettings = {
  glow: {
    enabled: true,
    pattern: 'flow',
    thickness: 14,
    glow: 70,
    brightness: 1.25,
    reactivity: 1.2,
    speed: 1,
    colorMode: 'album',
    custom: ['#ff2d75', '#7c4dff', '#00d1ff'],
  },
  lyrics: {
    onOverlay: true,
    style: 'kinetic',
    position: 'bottom',
    size: 46,
    offsetMs: 0,
    showNext: true,
    backdrop: true,
    emoji: true,
  },
  blackout: false,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const s = JSON.parse(raw) as Partial<AppSettings>;
    return {
      glow: { ...DEFAULT_SETTINGS.glow, ...(s.glow ?? {}) },
      // Settings saved before Kinetic existed have no `emoji` key: move them to the new default style once.
      lyrics: { ...DEFAULT_SETTINGS.lyrics, ...(s.lyrics ?? {}), ...(s.lyrics && !('emoji' in s.lyrics) ? { style: 'kinetic' as const } : {}) },
      blackout: s.blackout ?? DEFAULT_SETTINGS.blackout,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Settings shared by every window: saved locally, and pushed live to the
 * overlay window (desktop) or other tabs (web) when changed.
 */
export function useSettings(): [AppSettings, (fn: (s: AppSettings) => AppSettings) => void] {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  useEffect(() => {
    let off: (() => void) | undefined;
    on<AppSettings>(EVENT, (s) => setSettings(s)).then((u) => (off = u));
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setSettings(loadSettings());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      off?.();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const update = useCallback((fn: (s: AppSettings) => AppSettings) => {
    setSettings((prev) => {
      const next = fn(prev);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage full or blocked: keep working in memory */
      }
      void broadcast(EVENT, next);
      return next;
    });
  }, []);

  return [settings, update];
}
