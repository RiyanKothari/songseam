import { invoke } from '@tauri-apps/api/core';
import type { SetPlan } from './planner';
import * as Spotify from '../services/spotify';
import { isDesktop, on } from '../services/platform';

export interface NowInfo {
  name: string;
  artist: string;
  positionMs: number;
  isPlaying: boolean;
}

export interface RunnerStatus {
  state: 'idle' | 'starting' | 'playing' | 'transitioning' | 'off-plan' | 'done' | 'error';
  index: number;
  message: string;
  /** ms until the next planned fade starts (null if none). */
  nextFadeInMs: number | null;
  /** False when Spotify isn't playing on this PC, so fades can't run. */
  fadesAvailable?: boolean;
}

const IDLE: RunnerStatus = { state: 'idle', index: 0, message: '', nextFadeInMs: null };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s*-\s.*$/, '')
    .replace(/[^a-z0-9]+/g, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Steps for the Rust DJ engine (src-tauri/src/dj.rs). */
function toSteps(plan: SetPlan) {
  return plan.tracks.map((t, i) => {
    const out = plan.transitions[i];
    const into = plan.transitions[i - 1];
    return {
      title: t.name,
      durationMs: t.durationMs,
      cueInMs: i === 0 ? 0 : (plan.cues?.[i]?.cueInMs ?? 0),
      exitAtMs: out ? out.exitAtMs : t.durationMs,
      fadeOutMs: out?.fadeOutMs ?? 0,
      fadeInMs: into?.fadeInMs ?? 0,
      bpm: t.tempo,
      vocalEndMs: plan.cues?.[i]?.vocalEndMs ?? 0,
    };
  });
}

/**
 * Plays a planned set on Spotify and performs each transition.
 *
 * Desktop: the Rust engine does the timing on its own thread, so the set
 * keeps going when the panel is hidden or on another tab; this class only
 * starts it and relays its status. Browser: a fallback loop here that fades
 * with Spotify's volume API (needs this tab open).
 */
/**
 * Volume at t (0..1) of a fade that is linear in decibels over 48 dB, so it
 * sounds even to the ear. Same curve as the Windows-mixer fades.
 */
export function dbCurve(from: number, to: number, t: number): number {
  const FLOOR = 0.003981; // -48 dB
  const x = Math.min(1, Math.max(0, t));
  const shape = (u: number) => (10 ** (-2.4 * u) - FLOOR) / (1 - FLOOR);
  return to < from ? to + (from - to) * shape(x) : from + (to - from) * (1 - shape(1 - x));
}

export class SetRunner {
  private plan: SetPlan | null = null;
  private timer: number | null = null;
  private busy = false;
  private baseVolume = 0.8;
  private status: RunnerStatus = IDLE;
  private unlisten: (() => void) | null = null;
  private unlistenControl: (() => void) | null = null;
  private feedTimer: number | null = null;
  private getNow: () => NowInfo | null;
  private onStatus: (s: RunnerStatus) => void;

  constructor(getNow: () => NowInfo | null, onStatus: (s: RunnerStatus) => void) {
    this.getNow = getNow;
    this.onStatus = onStatus;
    if (isDesktop) {
      on<RunnerStatus>('dj-status', (s) => this.set(s)).then((u) => (this.unlisten = u));
      // The engine asks for skips/seeks here when Windows media controls are hung.
      on<{ action: string; positionMs: number | null }>('dj-control', (c) => {
        // fade-out / fade-in: Spotify plays on another device (no Windows mixer), so fade its volume remotely.
        const p =
          c.action === 'next'
            ? Spotify.player.next()
            : c.action === 'seek'
              ? Spotify.player.seek(c.positionMs ?? 0)
              : c.action === 'fade-out'
                ? this.fade(0, c.positionMs ?? 3000)
                : c.action === 'fade-in'
                  ? this.fade(this.baseVolume, c.positionMs ?? 2000)
                  : null;
        p?.catch((e) => this.set({ message: `Spotify didn’t take the ${c.action}: ${e instanceof Error ? e.message : e}` }));
      }).then((u) => (this.unlistenControl = u));
      // Re-attach to a set that is already running (panel reopened, tab switched back).
      invoke<RunnerStatus | null>('dj_status').then((s) => s && this.set(s));
    }
  }

  private set(s: Partial<RunnerStatus>) {
    this.status = { ...this.status, ...s };
    this.onStatus(this.status);
  }

  /** Stop listening. On desktop the set keeps playing; in the browser it stops. */
  dispose(): void {
    this.unlisten?.();
    this.unlistenControl?.();
    this.stopFeed();
    if (!isDesktop) this.stop();
  }

  async start(plan: SetPlan): Promise<void> {
    this.stop();
    if (!plan.tracks.length) return;
    this.plan = plan;
    this.set({ state: 'starting', index: 0, message: 'Starting your set on Spotify…', nextFadeInMs: null });
    try {
      const device = await Spotify.pickDevice();
      if (!device) throw new Error('Open Spotify on this PC first, then press Play set again.');
      await Spotify.playUris(
        plan.tracks.map((t) => t.uri),
        device.id,
      );
      if (isDesktop) {
        // Remember the listening volume: remote fades (other devices) return to it.
        const now = await Spotify.getPlayback().catch(() => null);
        this.baseVolume = (now?.volumePercent ?? 80) / 100 || 0.8;
        await invoke('dj_start', { steps: toSteps(plan) });
        this.startFeed();
        if (device.type !== 'Computer') {
          this.set({ message: `Playing on ${device.name} — fading with Spotify’s volume (in steps; smoothest when Spotify plays on this PC).` });
        }
        return;
      }
      const pb = await Spotify.getPlayback().catch(() => null);
      this.baseVolume = (pb?.volumePercent ?? 80) / 100;
      this.set({ state: 'playing', message: `Playing on ${device.name}` });
      this.timer = window.setInterval(() => void this.tick(), 250);
    } catch (e) {
      this.set({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Backup clock for the engine: Spotify's own idea of what's playing, sent
   * every 1.5 s. The engine uses it only while Windows media controls are hung.
   */
  private startFeed(): void {
    this.stopFeed();
    const feed = () =>
      Spotify.getPlayback()
        .then((p) => p && invoke('dj_feed', { title: p.track.name, positionMs: p.progressMs, isPlaying: p.isPlaying }))
        .catch(() => {});
    void feed();
    this.feedTimer = window.setInterval(feed, 1500);
  }

  private stopFeed(): void {
    if (this.feedTimer !== null) clearInterval(this.feedTimer);
    this.feedTimer = null;
  }

  stop(): void {
    this.stopFeed();
    if (isDesktop) {
      void invoke('dj_stop').catch(() => {});
    } else {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      if (this.plan) void Spotify.player.volume(this.baseVolume * 100).catch(() => {});
    }
    this.plan = null;
    this.busy = false;
    this.set(IDLE);
  }

  // ---------- Browser fallback ----------

  /** Stepped volume fade through Spotify's API (rate-limited, so ≤ 8 steps), on a decibel curve. */
  private async fade(to: number, ms: number) {
    const steps = Math.max(2, Math.min(8, Math.round(ms / 600)));
    const from = to === 0 ? this.baseVolume : 0;
    const t0 = Date.now();
    for (let i = 1; i <= steps; i++) {
      await Spotify.player.volume(dbCurve(from, to, i / steps) * 100).catch(() => {});
      await sleep(Math.max(0, t0 + (ms * i) / steps - Date.now()));
    }
  }

  private async tick() {
    const plan = this.plan;
    if (!plan || this.busy) return;
    const now = this.getNow();
    if (!now) return;
    const name = norm(now.name);
    const i = plan.tracks.findIndex((t) => norm(t.name) === name);
    if (i < 0) {
      this.set({ state: 'off-plan', message: 'Something outside the set is playing — the DJ is waiting.', nextFadeInMs: null });
      return;
    }
    const tr = plan.transitions[i];
    if (!tr) {
      this.set({ state: 'playing', index: i, message: 'Last track of the set', nextFadeInMs: null });
      return;
    }
    const until = tr.exitAtMs - now.positionMs;
    this.set({ state: 'playing', index: i, nextFadeInMs: Math.max(0, until), message: '' });
    if (until > 0 || !now.isPlaying) return;
    this.busy = true;
    this.set({ state: 'transitioning' });
    try {
      await this.fade(0, tr.fadeOutMs);
      await Spotify.player.next();
      await sleep(900);
      const cue = plan.cues?.[i + 1]?.cueInMs ?? 0;
      if (cue > 1500) await Spotify.player.seek(cue);
      await this.fade(this.baseVolume, tr.fadeInMs);
    } catch (e) {
      this.set({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }
}
