import { invoke } from '@tauri-apps/api/core';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';

/** True inside the Windows desktop app (Tauri), false in a normal browser tab. */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Label of the current desktop window ("main" or "overlay"); "web" in a browser. */
export async function windowLabel(): Promise<string> {
  if (!isDesktop) return 'web';
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().label;
}

export async function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isDesktop) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}

export async function broadcast<T>(event: string, payload: T): Promise<void> {
  if (isDesktop) await emit(event, payload);
}

export const Overlay = {
  set: (visible: boolean) => (isDesktop ? invoke<boolean>('overlay_set', { visible }) : Promise.resolve(false)),
  isVisible: () => (isDesktop ? invoke<boolean>('overlay_is_visible') : Promise.resolve(false)),
};

/** Windows per-app mixer volume (0..1). Used for DJ fades on this PC. */
export const AppVolume = {
  get: (app: string) => invoke<number | null>('get_app_volume', { app }),
  set: (app: string, level: number) => invoke<boolean>('set_app_volume', { app, level }),
  fade: (app: string, to: number, ms: number) => invoke<boolean>('fade_app_volume', { app, to, ms }),
};

export async function setFullscreen(on: boolean): Promise<void> {
  if (isDesktop) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setFullscreen(on);
    return;
  }
  if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
}

export async function openExternal(url: string): Promise<void> {
  if (isDesktop) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/** Writes to the desktop app's log (no-op in the browser). */
export function log(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  const message = parts.map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  if (!isDesktop) return void console[level](message);
  void invoke('client_log', { level, message }).catch(() => {});
}
