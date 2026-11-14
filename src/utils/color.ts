import type { ColorPalette } from '../types';

export const DEFAULT_PALETTE: ColorPalette = {
  primary: 'rgb(255, 61, 127)',
  secondary: 'rgb(124, 77, 255)',
  accent: 'rgb(0, 209, 255)',
  surface: 'rgb(14, 8, 16)',
  textColor: 'rgb(255, 255, 255)',
};

type HSL = [number, number, number]; // h 0-360, s 0-1, l 0-1

export function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const rgb = ([r, g, b]: [number, number, number]) => `rgb(${r}, ${g}, ${b})`;

export function hexToRgb(hex: string): string {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return DEFAULT_PALETTE.primary;
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

export function rgbToHex(color: string): string {
  const m = color.match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return '#ffffff';
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}

const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Makes a colour light-show ready: saturated and mid-bright, so it glows
 * instead of looking muddy. Keeps the hue of the album.
 */
export function vivid(h: number, s: number): [number, number, number] {
  return hslToRgb(h, Math.max(0.82, Math.min(1, s * 1.6)), 0.58);
}

/**
 * Picks the 3 most striking hues from pixel data (RGBA bytes).
 * Exported separately from the image loading so it can be unit-tested.
 */
export function paletteFromPixels(data: ArrayLike<number>): ColorPalette {
  const BINS = 36; // 10° hue buckets
  const weight = new Array<number>(BINS).fill(0);
  const satSum = new Array<number>(BINS).fill(0);
  const hueSum = new Array<number>(BINS).fill(0);
  let grey = 0;
  let total = 0;

  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    total++;
    if (l < 0.1 || l > 0.95 || s < 0.18) {
      grey++;
      continue;
    }
    // Favour colourful, mid-bright pixels: those are what the eye remembers.
    const w = s * s * (1 - Math.abs(l - 0.5) * 1.4);
    const bin = Math.floor(h / (360 / BINS)) % BINS;
    weight[bin] += w;
    satSum[bin] += s * w;
    hueSum[bin] += h * w;
  }

  const ranked = weight
    .map((w, bin) => ({ w, h: w > 0 ? hueSum[bin] / w : 0, s: w > 0 ? satSum[bin] / w : 0 }))
    .filter((b) => b.w > 0)
    .sort((a, b) => b.w - a.w);

  // Mostly black/white/grey art: one tasteful cool glow instead of mud.
  if (ranked.length === 0 || (total > 0 && grey / total > 0.97 && ranked[0].w < total * 0.002)) {
    return {
      primary: 'rgb(235, 240, 255)',
      secondary: 'rgb(120, 150, 255)',
      accent: 'rgb(200, 120, 255)',
      surface: 'rgb(10, 11, 16)',
      textColor: 'rgb(255, 255, 255)',
    };
  }

  const picks: { h: number; s: number }[] = [ranked[0]];
  for (const minGap of [45, 25]) {
    for (const b of ranked) {
      if (picks.length >= 3) break;
      if (picks.every((p) => hueGap(p.h, b.h) >= minGap) && b.w > ranked[0].w * 0.04) picks.push(b);
    }
  }
  // Single-hue covers: derive neighbours so the gradient still moves.
  while (picks.length < 3) {
    const base = picks[0];
    picks.push({ h: base.h + (picks.length === 1 ? 38 : -42), s: base.s });
  }

  const [p, s2, a] = picks.map((c) => vivid(c.h, c.s));
  const surface = hslToRgb(picks[0].h, 0.45, 0.06);
  return { primary: rgb(p), secondary: rgb(s2), accent: rgb(a), surface: rgb(surface), textColor: 'rgb(255, 255, 255)' };
}

const cache = new Map<string, ColorPalette>();

/** Loads album art (http(s) or data: URL) and extracts a vivid palette. */
export async function extractPalette(imageUrl: string): Promise<ColorPalette> {
  if (!imageUrl) return DEFAULT_PALETTE;
  const key = imageUrl.length > 200 ? imageUrl.slice(-200) + imageUrl.length : imageUrl;
  const hit = cache.get(key);
  if (hit) return hit;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image load failed'));
  });
  img.src = imageUrl;
  try {
    await loaded;
    const size = 72;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return DEFAULT_PALETTE;
    ctx.drawImage(img, 0, 0, size, size);
    const palette = paletteFromPixels(ctx.getImageData(0, 0, size, size).data);
    cache.set(key, palette);
    return palette;
  } catch {
    return DEFAULT_PALETTE;
  }
}
