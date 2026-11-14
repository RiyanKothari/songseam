/**
 * Mood DJ planner. Pure functions only (no network, no DOM) so it is
 * unit-tested with `node --test`.
 *
 * Builds a set from a pool of analysed tracks:
 *  1. score every track against the mood (energy / valence / tempo windows),
 *  2. order the best ones to follow the mood's energy arc while keeping
 *     neighbours harmonically compatible (Camelot wheel) and close in tempo,
 *  3. plan each transition: style, fade length, exit point and the reason.
 *
 * Transitions are sequential fades (out, then in) — tracks never overlap.
 */

export interface DjTrack {
  id: string;
  uri: string;
  name: string;
  artist: string;
  durationMs: number;
  image?: string;
  tempo: number;
  key: number; // 0-11, -1 unknown
  mode: number; // 1 major, 0 minor
  energy: number;
  valence: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
}

export type Mood = 'chill' | 'focus' | 'happy' | 'party' | 'workout' | 'late-night' | 'heartbreak';

export interface MoodProfile {
  label: string;
  blurb: string;
  energy: [number, number];
  valence: [number, number];
  tempo: [number, number];
  /** Target energy at set position t (0 → 1). */
  arc: (t: number) => number;
  /** Extra per-track penalty (0 = ideal). */
  extra?: (t: DjTrack) => number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const MOODS: Record<Mood, MoodProfile> = {
  chill: {
    label: 'Chill',
    blurb: 'Laid-back, warm, unhurried',
    energy: [0.2, 0.55],
    valence: [0.3, 0.8],
    tempo: [70, 112],
    arc: (t) => 0.42 - 0.08 * t,
  },
  focus: {
    label: 'Focus',
    blurb: 'Steady and low on vocals',
    energy: [0.25, 0.6],
    valence: [0.2, 0.7],
    tempo: [80, 125],
    arc: () => 0.45,
    extra: (t) => (1 - t.instrumentalness) * 0.6,
  },
  happy: {
    label: 'Happy',
    blurb: 'Bright, upbeat, sing-along',
    energy: [0.55, 0.9],
    valence: [0.6, 1],
    tempo: [95, 135],
    arc: (t) => 0.62 + 0.15 * Math.sin(Math.PI * t),
  },
  party: {
    label: 'Party',
    blurb: 'Builds to a peak, then lands',
    energy: [0.65, 1],
    valence: [0.4, 1],
    tempo: [112, 132],
    arc: (t) => (t < 0.7 ? 0.68 + 0.3 * (t / 0.7) : 0.98 - 0.2 * ((t - 0.7) / 0.3)),
    extra: (t) => (1 - t.danceability) * 0.8,
  },
  workout: {
    label: 'Workout',
    blurb: 'Warm-up, push, cool-down',
    energy: [0.7, 1],
    valence: [0.3, 1],
    tempo: [118, 180],
    arc: (t) => (t < 0.15 ? 0.72 + 0.25 * (t / 0.15) : t < 0.85 ? 0.97 : 0.97 - 0.3 * ((t - 0.85) / 0.15)),
  },
  'late-night': {
    label: 'Late night',
    blurb: 'Moody, smooth, after midnight',
    energy: [0.3, 0.65],
    valence: [0.1, 0.5],
    tempo: [80, 120],
    arc: (t) => 0.55 - 0.15 * t,
  },
  heartbreak: {
    label: 'Heartbreak',
    blurb: 'Slow, aching, cathartic',
    energy: [0.15, 0.55],
    valence: [0, 0.38],
    tempo: [60, 115],
    arc: (t) => 0.32 + 0.12 * Math.sin(Math.PI * t),
    extra: (t) => t.acousticness < 0.2 ? 0.15 : 0,
  },
};

// ---------- Harmony & tempo ----------

/** Camelot wheel code: pitch class + mode → e.g. "8B" (C major), "8A" (A minor). */
export function camelot(key: number, mode: number): { num: number; letter: 'A' | 'B' } | null {
  if (key < 0 || key > 11) return null;
  const fifths = (key * 7) % 12;
  return mode === 1 ? { num: ((fifths + 7) % 12) + 1, letter: 'B' } : { num: ((fifths + 4) % 12) + 1, letter: 'A' };
}

export function camelotLabel(key: number, mode: number): string {
  const c = camelot(key, mode);
  return c ? `${c.num}${c.letter}` : '—';
}

const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function keyName(key: number, mode: number): string {
  return key < 0 ? '?' : KEY_NAMES[key] + (mode === 1 ? '' : 'm');
}

/**
 * Harmonic distance on the Camelot wheel: 0 same key, 1 neighbour or
 * relative major/minor, 2 energy-boost (+2) or diagonal, 3+ clash.
 */
export function keyDistance(a: DjTrack, b: DjTrack): number {
  const ca = camelot(a.key, a.mode);
  const cb = camelot(b.key, b.mode);
  if (!ca || !cb) return 1.5;
  const raw = Math.abs(ca.num - cb.num) % 12;
  const steps = Math.min(raw, 12 - raw);
  if (ca.letter === cb.letter) return steps;
  return steps === 0 ? 1 : steps + 1;
}

/** Relative tempo gap, treating half/double time as the same groove. */
export function tempoDistance(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0.2;
  return Math.min(...[b, b * 2, b / 2].map((x) => Math.abs(Math.log(x / a))));
}

// ---------- Mood fit ----------

const outside = (x: number, [lo, hi]: [number, number], scale: number) =>
  x < lo ? (lo - x) / scale : x > hi ? (x - hi) / scale : 0;

/** 0 = perfect fit; grows the further a track is from the mood. */
export function moodFit(t: DjTrack, mood: Mood): number {
  const m = MOODS[mood];
  const tempoGap = Math.min(
    ...[t.tempo, t.tempo * 2, t.tempo / 2].map((bpm) => outside(bpm, m.tempo, 20)),
  );
  return outside(t.energy, m.energy, 0.15) + outside(t.valence, m.valence, 0.2) + tempoGap * 0.7 + (m.extra?.(t) ?? 0);
}

// ---------- Transitions ----------

export type TransitionStyle = 'blend' | 'lift' | 'wind-down' | 'reset' | 'fade';

export interface Transition {
  style: TransitionStyle;
  fadeOutMs: number;
  fadeInMs: number;
  /** Position in the outgoing track where the fade-out starts. */
  exitAtMs: number;
  reason: string;
}

const STYLE_LABEL: Record<TransitionStyle, string> = {
  blend: 'Smooth blend',
  lift: 'Energy lift',
  'wind-down': 'Wind-down',
  reset: 'Quick reset',
  fade: 'Fade',
};
export const transitionLabel = (s: TransitionStyle) => STYLE_LABEL[s];

export function planTransition(from: DjTrack, to: DjTrack): Transition {
  const kd = keyDistance(from, to);
  const td = tempoDistance(from.tempo, to.tempo);
  const de = to.energy - from.energy;
  const bpm = `${Math.round(from.tempo)}→${Math.round(to.tempo)} BPM`;
  const keys = `${camelotLabel(from.key, from.mode)}→${camelotLabel(to.key, to.mode)}`;

  let style: TransitionStyle;
  let fadeOutMs: number;
  let fadeInMs: number;
  let reason: string;
  if (td <= 0.06 && kd <= 1) {
    style = 'blend';
    fadeOutMs = 9000;
    fadeInMs = 4000;
    reason = `Compatible keys (${keys}) at ${bpm}: long, smooth handover`;
  } else if (de >= 0.12) {
    style = 'lift';
    fadeOutMs = 2500;
    fadeInMs = 600;
    reason = `Energy jumps +${Math.round(de * 100)}%: short fade, next track hits straight in`;
  } else if (de <= -0.15) {
    style = 'wind-down';
    fadeOutMs = 11000;
    fadeInMs = 5000;
    reason = `Energy drops ${Math.round(de * 100)}%: slow fade to let the room breathe`;
  } else if (td > 0.12 || kd >= 3) {
    style = 'reset';
    fadeOutMs = 3500;
    fadeInMs = 800;
    reason = `Different groove (${bpm}, ${keys}): quick reset so they don't clash`;
  } else {
    style = 'fade';
    fadeOutMs = 6000;
    fadeInMs = 2500;
    reason = `${bpm}, ${keys}: standard fade`;
  }
  fadeOutMs = Math.min(fadeOutMs, Math.max(1500, from.durationMs * 0.08));
  return { style, fadeOutMs, fadeInMs, exitAtMs: Math.max(0, from.durationMs - fadeOutMs), reason };
}

// ---------- Sequencing ----------

export interface SetPlan {
  mood: Mood;
  tracks: DjTrack[];
  transitions: Transition[]; // transitions[i] goes tracks[i] → tracks[i+1]
  targetEnergy: number[];
  totalMs: number;
  /** Tracks that had analysis but didn't fit the mood well enough. */
  skipped: number;
  /** Per-track cue points (filled by withCues). */
  cues?: Cue[];
}

export function planSet(pool: DjTrack[], mood: Mood, length: number): SetPlan {
  const m = MOODS[mood];
  const unique = [...new Map(pool.map((t) => [t.id, t])).values()];
  const scored = unique.map((t) => ({ t, fit: moodFit(t, mood) })).sort((a, b) => a.fit - b.fit || a.t.id.localeCompare(b.t.id));

  // Keep good fits; if the library is thin, top up with the nearest misses.
  const good = scored.filter((s) => s.fit <= 1.2);
  const candidates = (good.length >= length ? good : scored).slice(0, Math.max(length * 2, length + 6));
  const n = Math.min(length, candidates.length);
  const target = Array.from({ length: n }, (_, i) => clamp01(m.arc(n <= 1 ? 0 : i / (n - 1))));

  const remaining = new Set(candidates);
  const order: { t: DjTrack; fit: number }[] = [];
  for (let i = 0; i < n; i++) {
    const prev = order[order.length - 1]?.t;
    let best: { t: DjTrack; fit: number } | null = null;
    let bestCost = Infinity;
    for (const c of remaining) {
      let cost = 2.5 * Math.abs(c.t.energy - target[i]) + 0.6 * c.fit;
      if (prev) {
        cost += tempoDistance(prev.tempo, c.t.tempo) / 0.08;
        cost += 0.55 * keyDistance(prev, c.t);
        if (prev.artist === c.t.artist) cost += 1.5;
      }
      if (cost < bestCost || (cost === bestCost && best && c.t.id < best.t.id)) {
        bestCost = cost;
        best = c;
      }
    }
    if (!best) break;
    order.push(best);
    remaining.delete(best);
  }

  const tracks = order.map((o) => o.t);
  const transitions = tracks.slice(1).map((t, i) => planTransition(tracks[i], t));
  const totalMs =
    tracks.reduce((sum, t) => sum + t.durationMs, 0) -
    transitions.reduce((sum, tr, i) => sum + (tracks[i].durationMs - tr.exitAtMs - tr.fadeOutMs), 0);
  return { mood, tracks, transitions, targetEnergy: target, totalMs, skipped: unique.length - good.length };
}

// ---------- Cue points ----------

export interface Cue {
  /** Start the track here (skips a long intro). */
  cueInMs: number;
  /** How much intro / outro the DJ skips, for display. */
  introCutMs: number;
  outroCutMs: number;
  /** When the last vocal ends (0 = unknown); the live engine listens for the outro after it. */
  vocalEndMs?: number;
}

/** Vocal timing of a track, from its lyrics: first line start and last line end. */
export interface VocalSpan {
  firstMs: number;
  lastMs: number;
}

const ENERGETIC: Mood[] = ['party', 'workout', 'happy'];

/**
 * Where a DJ would bring a track in and take it out. Uses the vocals: a
 * long instrumental outro is cut two bars after the last line; on energetic
 * moods a long intro is skipped to four bars before the first line.
 * Without lyrics, the track plays in full.
 */
export function cuesFor(t: DjTrack, vocals: VocalSpan | null, mood: Mood, fadeOutMs: number, isFirst: boolean): { cue: Cue; exitAtMs: number } {
  const bar = 240_000 / Math.max(60, Math.min(200, t.tempo || 120));
  const full = Math.max(0, t.durationMs - fadeOutMs);
  const cue: Cue = { cueInMs: 0, introCutMs: 0, outroCutMs: 0 };
  if (!vocals) return { cue, exitAtMs: full };

  // Outro: energetic sets cut anything over ~6 bars; calm sets only very long tails.
  const energetic = ENERGETIC.includes(mood);
  const tail = t.durationMs - vocals.lastMs;
  const allowTail = energetic ? 6 * bar + fadeOutMs : Math.max(30_000, 12 * bar);
  let exitAtMs = full;
  if (tail > allowTail) {
    exitAtMs = Math.min(full, Math.max(t.durationMs * 0.5, vocals.lastMs + 2 * bar));
    cue.outroCutMs = Math.max(0, full - exitAtMs);
  }

  // Intro: only on energetic sets, never for the opener.
  if (energetic && !isFirst && vocals.firstMs > 8 * bar + 6000) {
    cue.cueInMs = Math.max(0, Math.round(vocals.firstMs - 4 * bar));
    cue.introCutMs = cue.cueInMs;
  }
  return { cue, exitAtMs: Math.round(exitAtMs) };
}

/** Applies cue points to a plan (pure: returns a new plan). */
export function withCues(plan: SetPlan, vocals: Map<string, VocalSpan | null>): SetPlan {
  const cues: Cue[] = [];
  const transitions = plan.transitions.map((tr) => ({ ...tr }));
  plan.tracks.forEach((t, i) => {
    const fadeOut = transitions[i]?.fadeOutMs ?? 0;
    const { cue, exitAtMs } = cuesFor(t, vocals.get(t.id) ?? null, plan.mood, fadeOut, i === 0);
    cues.push({ ...cue, vocalEndMs: vocals.get(t.id)?.lastMs ?? 0 });
    if (transitions[i]) {
      transitions[i].exitAtMs = exitAtMs;
      if (cue.outroCutMs > 0) transitions[i].reason += ` · cuts ${Math.round(cue.outroCutMs / 1000)}s outro`;
    }
  });
  const totalMs = plan.tracks.reduce((sum, t, i) => {
    const start = cues[i].cueInMs;
    const end = transitions[i] ? transitions[i].exitAtMs + transitions[i].fadeOutMs : t.durationMs;
    return sum + Math.max(0, end - start);
  }, 0);
  return { ...plan, transitions, cues, totalMs };
}
