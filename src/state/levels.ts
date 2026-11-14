import { useEffect, useRef } from 'react';
import type { AudioLevels } from '../types';
import { isDesktop, on } from '../services/platform';
import { AudioEngine } from '../utils/audioAnalyzer';

interface Frame {
  bass: number;
  mid: number;
  treble: number;
  level: number;
  beat: boolean;
}

/**
 * Live audio levels for the lights, as a ref (read it inside requestAnimationFrame;
 * it never re-renders React). Desktop: system audio from the Rust loopback
 * analyser. Browser: the demo synth through Web Audio.
 */
export function useAudioLevels() {
  const ref = useRef<AudioLevels>({ bass: 0, mid: 0, treble: 0, level: 0, beat: 0 });

  useEffect(() => {
    const target = { bass: 0, mid: 0, treble: 0, level: 0 };
    let lastFrame = 0;
    let off: (() => void) | undefined;

    if (isDesktop) {
      on<Frame>('audio-frame', (f) => {
        target.bass = f.bass;
        target.mid = f.mid;
        target.treble = f.treble;
        target.level = f.level;
        if (f.beat) ref.current.beat = 1;
        lastFrame = performance.now();
      }).then((u) => (off = u));
    }

    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const l = ref.current;

      if (!isDesktop) {
        const m = AudioEngine.getMetrics();
        target.bass = m.bass;
        target.mid = m.mid;
        target.treble = m.treble;
        target.level = m.volume;
        if (m.beatPulse > 0.85 && l.beat < 0.4) l.beat = 1;
        lastFrame = now;
      }
      // Silence (nothing playing → no loopback packets): fall to zero.
      if (now - lastFrame > 250) {
        target.bass = target.mid = target.treble = target.level = 0;
      }
      // Fast attack, slower release: punchy but not flickery.
      const follow = (cur: number, to: number) => cur + (to - cur) * (to > cur ? 0.55 : 1 - Math.exp(-dt * 6));
      l.bass = follow(l.bass, target.bass);
      l.mid = follow(l.mid, target.mid);
      l.treble = follow(l.treble, target.treble);
      l.level = follow(l.level, target.level);
      l.beat *= Math.exp(-dt * 5.5);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      off?.();
    };
  }, []);

  return ref;
}
