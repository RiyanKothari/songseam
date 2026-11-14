import { useEffect, useRef, type MutableRefObject } from 'react';
import type { AudioLevels, ColorPalette, GlowSettings } from '../types';
import { hexToRgb } from '../utils/color';

interface Props {
  palette: ColorPalette;
  settings: GlowSettings;
  levels: MutableRefObject<AudioLevels>;
  /** Fill the parent (preview) instead of the whole window. */
  contained?: boolean;
  /** Scale band/bloom sizes down for small previews. */
  scale?: number;
  isPlaying: boolean;
}

/**
 * Rim lighting around the display.
 *
 * Built so that each animation frame only changes `transform` and `opacity`,
 * which the GPU compositor applies without repainting: a big conic-gradient
 * square spins behind three static masks (crisp band, soft bloom, wide bass
 * bloom). No blur filters, so it stays smooth at 60 fps even full-screen.
 */
export function EdgeGlow({ palette, settings, levels, contained, scale = 1, isPlaying }: Props) {
  const spins = useRef<(HTMLDivElement | null)[]>([]);
  const core = useRef<HTMLDivElement>(null);
  const bloom = useRef<HTMLDivElement>(null);
  const wide = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const live = useRef({ settings, isPlaying });
  live.current = { settings, isPlaying };

  const [c1, c2, c3] =
    settings.colorMode === 'custom' ? settings.custom.map(hexToRgb) : [palette.primary, palette.secondary, palette.accent];

  useEffect(() => {
    let raf = 0;
    let angle = Math.random() * 360;
    let prev = performance.now();
    let idle = 0; // 0 playing → 1 paused
    const shown = { core: -1, bloom: -1, wide: -1, flash: -1 };
    const setOpacity = (el: HTMLDivElement | null, key: keyof typeof shown, v: number) => {
      const r = Math.round(v * 200) / 200; // skip sub-visible changes
      if (el && shown[key] !== r) {
        el.style.opacity = String(r);
        shown[key] = r;
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const { settings: s, isPlaying: playing } = live.current;
      const l = levels.current;
      const react = s.pattern === 'breathe' || s.pattern === 'still' ? 0 : s.reactivity;
      idle += ((playing ? 0 : 1) - idle) * Math.min(1, dt * 2);
      const awake = 1 - idle;

      const breath = 0.5 + 0.5 * Math.sin((now / 1000) * (s.pattern === 'breathe' ? 1.1 : 0.6));
      const energy = l.level * 0.5 + l.bass * 0.5;
      const beat = l.beat * (s.pattern === 'pulse' ? 1.5 : 1);

      if (s.pattern !== 'still') {
        const base = s.pattern === 'pulse' ? 9 : s.pattern === 'breathe' ? 7 : 22;
        const push = 1 + react * (l.bass * 1.8 + beat * 1.2) * awake;
        angle = (angle + dt * base * s.speed * push * (1 - idle * 0.75)) % 360;
        const t = `rotate(${angle.toFixed(2)}deg)`;
        for (const el of spins.current) if (el) el.style.transform = t;
      }

      const b = Math.min(1.2, s.brightness);
      let coreO: number;
      let bloomO: number;
      if (s.pattern === 'breathe') {
        coreO = 0.55 + 0.45 * breath;
        bloomO = 0.35 + 0.55 * breath;
      } else if (s.pattern === 'still') {
        coreO = 1;
        bloomO = 0.8;
      } else {
        coreO = 0.72 + 0.28 * Math.min(1, energy * react + beat * 0.5);
        bloomO = 0.45 + 0.55 * Math.min(1, energy * react * 0.9 + beat * react * 0.6);
      }
      const idleO = 0.45 + 0.2 * breath;
      setOpacity(core.current, 'core', Math.min(1, (coreO * awake + idleO * idle) * b));
      setOpacity(bloom.current, 'bloom', Math.min(1, (bloomO * awake + idleO * 0.7 * idle) * b));
      setOpacity(wide.current, 'wide', Math.min(1, (react ? l.bass * react * 0.85 : 0) * awake * b));
      setOpacity(flash.current, 'flash', Math.min(1, beat * react * 0.7 * awake * b));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levels]);

  if (!settings.enabled) return null;

  const t = Math.max(2, settings.thickness * scale);
  const g = Math.max(8, settings.glow * scale * Math.max(0.6, settings.brightness));
  const spin = (i: number) => <div className="eg-spin" ref={(el) => void (spins.current[i] = el)} />;

  return (
    <div
      className={`eg-root ${contained ? 'eg-contained' : ''}`}
      style={{ '--eg-c1': c1, '--eg-c2': c2, '--eg-c3': c3, '--eg-t': `${t}px`, '--eg-g': `${g}px`, '--eg-w': `${g * 2.4}px` } as React.CSSProperties}
      aria-hidden
    >
      <div ref={wide} className="eg-frame eg-wide">
        {spin(0)}
      </div>
      <div ref={bloom} className="eg-frame eg-bloom">
        {spin(1)}
      </div>
      <div ref={flash} className="eg-frame eg-flash">
        {spin(2)}
      </div>
      <div ref={core} className="eg-frame eg-core">
        {spin(3)}
      </div>
    </div>
  );
}
