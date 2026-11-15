import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColorPalette, LyricLine, LyricsSettings, SyncedLyrics } from '../types';
import type { LyricsState } from '../state/playback';
import { layoutLine } from '../utils/kinetic';

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

const GAP_MS = 6000; // silence long enough to show the ♪ dots
const HOLD_MS = 2500; // keep a finished line up this long before a pause
/** Show each line this much before it is sung, so it can be read in time. */
const LEAD_MS = 450;
/** Light words a touch early to cover drawing + display latency. */
const WORD_LEAD_MS = 90;

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
        const pos = getPosition() - offset + WORD_LEAD_MS;
        // The line switches a little before it's sung (lead), words light on time.
        const sung = lineAt(ls, pos);
        const early = lineAt(ls, pos + LEAD_MS);
        // ...unless the current line's last word is still being sung.
        const i = early !== sung && sung >= 0 && lineEnd(ls, sung) > pos ? sung : early;
        const end = i >= 0 ? lineEnd(ls, i) : 0;
        const nextStart = ls[i + 1]?.start_ms ?? Infinity;
        const inGap = i < 0 ? ls[0].start_ms - pos > GAP_MS : pos > end + HOLD_MS && nextStart - pos > GAP_MS;
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

  if (settings.style === 'kinetic') {
    return (
      <div className={cls} style={colors}>
        <div className="lyr-k-wrap">
          {gap || !cur ? (
            <div className="lyr-line lyr-cur lyr-dots" key={`g${idx}`}>
              <span />
              <span />
              <span />
            </div>
          ) : (
            <Kinetic line={cur} emoji={settings.emoji} key={`c${idx}`} lineRef={lineEl} wordRef={(k, el) => (wordEls.current[k] = el)} />
          )}
          {settings.showNext && variant !== 'overlay' && (
            <div className="lyr-k-next" key={`n${idx}`}>
              {(gap || !cur ? lines[Math.max(0, idx + 1)]?.text : next?.text) ?? ' '}
            </div>
          )}
        </div>
      </div>
    );
  }

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

/**
 * One line as kinetic type: staggered rows, a hero word, tucked filler words,
 * a highlight box that wipes in, and an emoji accent. Words fly in as they
 * are sung (driven by data-s / --p from the frame loop above).
 */
function Kinetic({
  line,
  emoji,
  className = '',
  lineRef,
  wordRef,
}: {
  line: LyricLine;
  emoji: boolean;
  className?: string;
  lineRef?: React.Ref<HTMLDivElement>;
  wordRef?: (k: number, el: HTMLSpanElement | null) => void;
}) {
  const words = line.words?.length ? line.words.map((w) => w.text) : line.text.split(/s+/).filter(Boolean);
  const layout = useMemo(() => layoutLine(words, { emoji }), [words.join(' '), emoji]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = !wordRef; // outgoing line: everything already sung
  return (
    <div className={`lyr-k ${className}`} ref={lineRef} style={{ '--ks': layout.scale } as React.CSSProperties} aria-label={line.text}>
      {layout.rows.map((row, r) => (
        <div key={r} className={`lyr-k-row lyr-k-${row.justify}`} style={{ '--shift': `${row.shift.toFixed(2)}em` } as React.CSSProperties}>
          {row.words.map((w) => (
            <span
              key={w.k}
              ref={wordRef ? (el) => wordRef(w.k, el) : undefined}
              data-s={done ? 'past' : 'future'}
              className={`lyr-kw lyr-kt-${w.tone}${w.box ? ' lyr-kbox' : ''}${w.tuck ? ' lyr-ktuck' : ''}`}
              style={
                {
                  '--sz': w.size.toFixed(2),
                  '--rot': `${w.rot.toFixed(1)}deg`,
                  '--fx': w.fx.toFixed(2),
                  '--fy': w.fy.toFixed(2),
                  '--dy': w.dy.toFixed(2),
                  '--k': w.k,
                  ...(done ? { '--p': 1 } : {}),
                } as React.CSSProperties
              }
            >
              {w.text}
              {w.emoji && <span className="lyr-kemoji">{w.emoji}</span>}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
