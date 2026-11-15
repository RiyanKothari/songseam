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

/** Emoji accents: each row is a list of words (base forms) and its emoji. */
const EMOJI_WORDS: [string, string][] = [
  ['tell say said talk speak call word words whisper conversation chat', '💬'],
  ['love lover loving heart hearts baby babe darling honey sweetheart', '❤️'],
  ['broken heartbreak heartbroken break breaking', '💔'],
  ['fire burn burning flame flames hot heat lit blaze', '🔥'],
  ['night moon midnight dark darkness', '🌙'],
  ['sun sunshine summer daylight sunny sunrise sunset', '☀️'],
  ['star stars shine shining sparkle glitter', '⭐'],
  ['cry crying tear tears sad', '😢'],
  ['rain raining storm thunder', '🌧️'],
  ['money cash rich dollar dollars paid pay bank', '💸'],
  ['phone text texting ring calling', '📱'],
  ['dance dancing party club', '🪩'],
  ['kiss kissing lips', '💋'],
  ['world earth planet globe', '🌍'],
  ['time clock forever minute minutes hour hours', '⏳'],
  ['eyes see look looking watch watching stare', '👀'],
  ['king queen crown royal', '👑'],
  ['fly flying sky skies high heaven cloud clouds', '☁️'],
  ['ocean sea wave waves water swim beach', '🌊'],
  ['music song songs sing singing melody radio beat', '🎵'],
  ['car drive driving ride riding road highway', '🚗'],
  ['ghost haunt haunted', '👻'],
  ['angel pray praying prayer god bless', '😇'],
  ['devil demon sin sins evil', '😈'],
  ['smile smiling laugh laughing happy joy', '😊'],
  ['crazy insane wild mad', '🤪'],
  ['cool chill ice cold freeze frozen snow winter', '❄️'],
  ['flower flowers rose roses bloom garden', '🌹'],
  ['home house room bed', '🏠'],
  ['city lights street streets town downtown', '🌃'],
  ['run running away escape', '🏃'],
  ['dream dreams dreaming sleep sleeping asleep', '💤'],
  ['wake awake morning', '⏰'],
  ['drink drinks drunk wine whiskey champagne bar', '🥂'],
  ['smoke smoking high', '💨'],
  ['gun shot shoot bullet bullets', '💥'],
  ['war fight fighting battle', '⚔️'],
  ['gold diamond diamonds ring jewel', '💎'],
  ['strong power powerful strength', '💪'],
  ['brain mind think thinking thought thoughts', '🧠'],
  ['crown win winning winner champion', '🏆'],
  ['rocket moonshot', '🚀'],
  ['electric lightning shock', '⚡'],
  ['magic spell', '✨'],
  ['hand hands touch hold holding', '🤝'],
  ['secret secrets quiet silence silent', '🤫'],
  ['lie lies liar lying', '🤥'],
  ['cold blood bleed bleeding', '🩸'],
  ['skin body', '💃'],
  ['money money', '💸'],
  ['cherry sweet sugar candy', '🍒'],
  ['butterfly butterflies', '🦋'],
  ['lion tiger wolf', '🐺'],
  ['crown', '👑'],
  ['door doors key keys lock', '🔑'],
  ['mirror reflection', '🪞'],
  ['wings wing bird birds', '🕊️'],
  ['tears', '😢'],
  ['ice', '🧊'],
  ['heat', '🔥'],
  ['sea', '🌊'],
  ['clock', '⏳'],
];
const EMOJI = new Map<string, string>();
for (const [list, e] of EMOJI_WORDS) for (const w of list.split(' ')) if (!EMOJI.has(w)) EMOJI.set(w, e);

export function clean(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, '');
}

/** Emoji for a word, also matching simple endings ("burnin'", "dreams", "cried"). */
export function emojiFor(word: string): string | undefined {
  const w = clean(word).replace(/'/g, '');
  if (w.length < 2) return undefined;
  const tries = [w, w.replace(/in$/, 'ing'), w.replace(/(ing|ed|es|s|y)$/, ''), w.replace(/ied$/, 'y'), w.replace(/(ing|ed)$/, 'e')];
  for (const t of tries) {
    const e = EMOJI.get(t);
    if (e) return e;
  }
  return undefined;
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

const MAX_W = 8; // row width budget, em of base size
const MAX_H = 5; // block height budget, em of base size
const MAX_UP = 1.5; // short lines may grow this much
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

  // Up to one emoji per line, two on long lines (different emoji, not side by side).
  const emojiOf = new Map<number, string>();
  if (opts.emoji !== false) {
    const limit = n >= 6 ? 2 : 1;
    for (let k = 0; k < n && emojiOf.size < limit; k++) {
      const e = emojiFor(words[k]);
      if (e && ![...emojiOf.values()].includes(e) && ![...emojiOf.keys()].some((j) => k - j < 3)) emojiOf.set(k, e);
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
      emoji: emojiOf.get(k),
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
