import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColorPalette, LyricLine, LyricsSettings, SyncedLyrics } from '../types';
import type { LyricsState } from '../state/playback';

interface Props {
  lyrics: SyncedLyrics | null;
  lyricsState: LyricsState;
  hasTrack?: boolean;
  getPosition: () => number;
  palette: ColorPalette;
  settings: LyricsSettings;
  variant: 'overlay' | 'stage' | 'panel';
  isPlaying: boolean;
}

const GAP_MS = 3500; // silence long enough to show the ♪ dots

function lineEnd(lines: LyricLine[], i: number): number {
  const l = lines[i];
  const lastWord = l.words?.[l.words.length - 1];
  return l.end_ms ?? lastWord?.end_ms ?? lines[i + 1]?.start_ms ?? l.start_ms + 4000;
}

/** Index of the line being sung at `pos` (-1 before the first line). */
function lineAt(lines: LyricLine[], pos: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start_ms <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Word-by-word lyrics. React re-renders only when the line changes; each
 * frame writes a 0..1 `--p` fill straight onto the word elements.
 */
export function Lyrics({ lyrics, lyricsState, hasTrack = true, getPosition, palette, settings, variant, isPlaying }: Props) {
  const lines = lyrics?.sync !== 'none' ? (lyrics?.lines ?? []) : [];
  const [idx, setIdx] = useState(-1);
  const [gap, setGap] = useState(false);
  const wordEls = useRef<(HTMLSpanElement | null)[]>([]);
  const lineEl = useRef<HTMLDivElement | null>(null);
  const live = useRef({ lines, offset: settings.offsetMs, idx, gap });
  live.current = { lines, offset: settings.offsetMs, idx, gap };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const { lines: ls, offset, idx: shown, gap: shownGap } = live.current;
      if (ls.length) {
        const pos = getPosition() - offset;
        const i = lineAt(ls, pos);
        const end = i >= 0 ? lineEnd(ls, i) : 0;
        const nextStart = ls[i + 1]?.start_ms ?? Infinity;
        const inGap = i < 0 ? ls[0].start_ms - pos > GAP_MS : pos > end + 600 && nextStart - pos > GAP_MS;
        if (i !== shown) setIdx(i);
        if (inGap !== shownGap) setGap(inGap);

        const line = ls[i];
        if (line && i === shown) {
          const words = line.words ?? [];
          words.forEach((w, k) => {
            const el = wordEls.current[k];
            if (!el) return;
            const wEnd = w.end_ms ?? words[k + 1]?.start_ms ?? end;
            const p = Math.max(0, Math.min(1, (pos - w.start_ms) / Math.max(80, wEnd - w.start_ms)));
            el.style.setProperty('--p', p.toFixed(3));
            const state = p >= 1 ? 'past' : p > 0 ? 'now' : 'future';
            if (el.dataset.s !== state) el.dataset.s = state;
          });
          if (lineEl.current) {
            const lp = Math.max(0, Math.min(1, (pos - line.start_ms) / Math.max(200, end - line.start_ms)));
            lineEl.current.style.setProperty('--lp', lp.toFixed(3));
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getPosition]);

  const colors = useMemo(
    () =>
      ({
        '--lyr-glow': palette.primary,
        '--lyr-glow2': palette.secondary,
        '--lyr-size': `${variant === 'panel' ? Math.min(30, settings.size * 0.6) : variant === 'stage' ? settings.size * 1.45 : settings.size}px`,
      }) as React.CSSProperties,
    [palette.primary, palette.secondary, settings.size, variant],
  );

  const cls = `lyr lyr-${variant} lyr-style-${settings.style} lyr-pos-${variant === 'overlay' ? settings.position : 'center'} ${
    settings.backdrop && variant === 'overlay' ? 'lyr-backdrop' : ''
  } ${isPlaying ? '' : 'lyr-paused'}`;

  if (!lines.length) {
    if (variant === 'overlay') return null;
    const msg = !hasTrack
      ? 'Lyrics appear here when a song plays'
      : lyricsState === 'loading'
        ? 'Finding lyrics…'
        : lyrics?.instrumental
          ? 'Instrumental'
          : lyrics
            ? 'Lyrics for this song aren’t time-synced yet'
            : 'No lyrics found for this song';
    return (
      <div className={cls} style={colors}>
        <div className="lyr-msg">{msg}</div>
      </div>
    );
  }

  const cur = idx >= 0 ? lines[idx] : null;
  const prev = idx > 0 ? lines[idx - 1] : null;
  const next = lines[idx + 1] ?? null;
  wordEls.current = [];

  return (
    <div className={cls} style={colors}>
      <div className="lyr-stack">
        {variant !== 'overlay' && (
          <div className="lyr-line lyr-prev" key={`p${idx}`}>
            {prev?.text ?? ' '}
          </div>
        )}
        {gap || !cur ? (
          <div className="lyr-line lyr-cur lyr-dots" key={`g${idx}`}>
            <span />
            <span />
            <span />
          </div>
        ) : (
          <div className="lyr-line lyr-cur" key={`c${idx}`} ref={lineEl}>
            {(cur.words?.length ? cur.words : [{ text: cur.text, start_ms: cur.start_ms }]).map((w, k, all) => (
              <span
                key={k}
                className="lyr-word"
                data-s="future"
                style={{ '--i': k - (all.length - 1) / 2 } as React.CSSProperties}
                ref={(el) => {
                wordEls.current[k] = el;
              }} data-text={w.text}>
                {w.text}
              </span>
            ))}
          </div>
        )}
        {settings.showNext && (
          <div className="lyr-line lyr-next" key={`n${idx}`}>
            {(gap || !cur ? lines[Math.max(0, idx + 1)]?.text : next?.text) ?? ' '}
          </div>
        )}
      </div>
    </div>
  );
}
