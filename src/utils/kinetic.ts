/**
 * Kinetic-typography layout for one lyric line: words of different sizes
 * stacked into staggered rows, a hero word, small "tucked" filler words, a
 * highlight box and an emoji accent. Seeded by the line text, so a repeated
 * chorus line always gets the same composition.
 */

export type KTone = 'dim' | 'hot' | 'light' | 'alt';

export interface KWord {
  /** Index into the line's words. */
  k: number;
  text: string;
  /** Size relative to the line's base font size. */
  size: number;
  tone: KTone;
  box: boolean;
  /** Small filler word set low or high next to its neighbour. */
  tuck: boolean;
  /** Vertical nudge in em (of the word's own size). */
  dy: number;
  /** Rotation in degrees. */
  rot: number;
  /** Direction the word flies in from, in em. */
  fx: number;
  fy: number;
  emoji?: string;
}

export interface KRow {
  justify: 'start' | 'center' | 'end';
  /** Horizontal shift in em of the base size. */
  shift: number;
  words: KWord[];
}

export interface KLayout {
  rows: KRow[];
  /** Multiply the base font size by this so the block fits. */
  scale: number;
}

const STOP = new Set(
  'a an the i you me my your we us our he she it its they them their to of in on at by for and or but so if is am are was be been do did not no oh ooh yeah ya la na im i\'m you\'re it\'s don\'t can\'t that this with just all up as like'.split(' '),
);

const EMOJI: [RegExp, string][] = [
  [/^(tell|told|say|said|says|talk|talking|speak|call|calling|words?)$/, '💬'],
  [/^(love|loving|lover|heart)$/, '❤️'],
  [/^(broken|heartbreak|break)$/, '💔'],
  [/^(fire|burn|burning|flames?|hot)$/, '🔥'],
  [/^(night|moon|midnight|dark)$/, '🌙'],
  [/^(sun|sunshine|summer|daylight)$/, '☀️'],
  [/^(stars?|shine|shining)$/, '⭐'],
  [/^(cry|crying|tears?|rain|raining)$/, '💧'],
  [/^(money|cash|rich|dollars?)$/, '💸'],
  [/^(phone|text|texts|ring)$/, '📱'],
  [/^(dance|dancing|party)$/, '🪩'],
  [/^(kiss|kissing|lips)$/, '💋'],
  [/^(world|earth)$/, '🌍'],
  [/^(time|clock|tonight|forever)$/, '⏳'],
  [/^(eyes|see|look|looking|watch)$/, '👀'],
  [/^(king|queen|crown)$/, '👑'],
  [/^(fly|flying|sky|high|heaven)$/, '☁️'],
  [/^(ocean|sea|waves?|water)$/, '🌊'],
  [/^(music|song|sing|singing)$/, '🎵'],
  [/^(car|drive|driving|ride)$/, '🚗'],
  [/^(ghost|haunt|haunted)$/, '👻'],
  [/^(angel|pray|praying)$/, '😇'],
];

export function clean(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, '');
}

export function emojiFor(word: string): string | undefined {
  const w = clean(word).replace(/'/g, '');
  return EMOJI.find(([re]) => re.test(w))?.[1];
}

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rough width of a word in em of the base size (bold display font). */
export function widthOf(text: string, size: number): number {
  return (text.length * 0.56 + 0.1) * size;
}

const MAX_W = 10; // row width budget, em of base size
const MAX_H = 5.2; // block height budget, em of base size
const MAX_UP = 1.35; // short lines may grow this much
const LINE_H = 0.92;

export function layoutLine(words: string[], opts: { emoji?: boolean } = {}): KLayout {
  const r = rng(words.join(' '));
  const n = words.length;
  if (!n) return { rows: [], scale: 1 };

  // Score words: long, content words and the line's last word get emphasis.
  const score = words.map((w, k) => {
    const c = clean(w);
    if (STOP.has(c)) return 0;
    return c.length + (k === n - 1 ? 2.5 : 0) + r() * 2;
  });
  const order = score.map((s, k) => [s, k] as const).sort((a, b) => b[0] - a[0]);
  const hero = order[0][0] > 0 ? order[0][1] : -1;
  const second = order[1] && order[1][0] > 0 ? order[1][1] : -1;
  const boxed = hero >= 0 && r() < 0.55 ? (r() < 0.6 ? hero : second) : -1;

  let emojiAt = -1;
  let emoji: string | undefined;
  if (opts.emoji !== false) {
    for (let k = 0; k < n && emojiAt < 0; k++) {
      const e = emojiFor(words[k]);
      if (e) {
        emojiAt = k;
        emoji = e;
      }
    }
  }

  const out: KWord[] = words.map((text, k) => {
    const stop = score[k] === 0;
    const size = k === hero ? 2.1 + r() * 0.4 : k === second ? 1.35 + r() * 0.25 : stop ? 0.62 + r() * 0.12 : 0.9 + r() * 0.35;
    const tone: KTone = k === boxed ? 'light' : k === hero ? 'hot' : stop ? 'dim' : r() < 0.5 ? 'light' : 'alt';
    const angle = r() * Math.PI * 2;
    return {
      k,
      text,
      size,
      tone,
      box: k === boxed,
      tuck: false,
      dy: 0,
      rot: !stop && r() < 0.3 ? (r() - 0.5) * 14 : 0,
      fx: Math.cos(angle) * 0.9,
      fy: Math.sin(angle) * 0.9,
      emoji: k === emojiAt ? emoji : undefined,
    };
  });

  // Very long single words shrink to fit a row on their own.
  for (const w of out) {
    const extra = w.emoji ? 1.3 * Math.min(1.4, w.size) : 0;
    const width = widthOf(w.text, w.size) + extra;
    if (width > MAX_W) w.size *= MAX_W / width;
  }

  // Pack into rows: at most 3 words, within the width budget. Short filler words
  // right after a big word get tucked next to it, small and set low or high.
  const rows: KRow[] = [];
  let row: KWord[] = [];
  let rowW = 0;
  const flush = () => {
    if (!row.length) return;
    const pick = r();
    const justify = pick < 0.34 ? 'start' : pick < 0.67 ? 'end' : 'center';
    // Offsets push rows inward, never past the block's edge.
    const amt = r() * 1.1;
    rows.push({ justify, shift: justify === 'start' ? amt : justify === 'end' ? -amt : (r() - 0.5) * 1.2, words: row });
    row = [];
    rowW = 0;
  };
  for (const w of out) {
    const prev = row[row.length - 1];
    if (prev && w.tone === 'dim' && w.text.length <= 3 && prev.size >= 1.25 && !prev.tuck) {
      w.tuck = true;
      w.size = Math.min(w.size, 0.62);
      w.dy = r() < 0.6 ? 0.55 : -0.7;
    }
    const width = widthOf(w.text, w.size) + 0.25 * w.size + (w.emoji ? 1.3 * Math.min(1.4, w.size) : 0);
    const big = w.size >= 1.6;
    // The hero word gets a row to itself (plus any tucked filler).
    const rowHasBig = row.some((x) => x.size >= 1.6);
    if (row.length && !w.tuck && (rowW + width > MAX_W || row.filter((x) => !x.tuck).length >= 2 || big || rowHasBig)) flush();
    row.push(w);
    rowW += width;
  }
  flush();

  // Fit width per row and height overall.
  let maxW = 0;
  let h = 0;
  for (const rw of rows) {
    const w = rw.words.reduce((s, x) => s + widthOf(x.text, x.size) + 0.25 * x.size + (x.emoji ? 1.3 * Math.min(1.4, x.size) : 0), 0) + Math.abs(rw.shift);
    maxW = Math.max(maxW, w);
    h += Math.max(...rw.words.filter((x) => !x.tuck).map((x) => x.size), 0.7) * LINE_H;
  }
  const scale = Math.min(MAX_UP, MAX_W / Math.max(maxW, 0.01), MAX_H / Math.max(h, 0.01));
  return { rows, scale };
}
