import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AppSettings, AudioLevels } from '../types';
import type { Playback } from '../state/playback';
import { EdgeGlow } from './EdgeGlow';
import { Lyrics } from './Lyrics';
import { setFullscreen } from '../services/platform';

type Update = (fn: (s: AppSettings) => AppSettings) => void;

/** Keys TV remotes send for "Back" (browser, Samsung Tizen, LG webOS). */
const isBack = (e: KeyboardEvent) => e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.keyCode === 10009 || e.keyCode === 461;

/**
 * Full-screen mode. Normal: big album art, title and lyrics over an
 * album-tinted backdrop. Blackout: pure black, only the edge glow and lyrics.
 * Works with a mouse, a keyboard or a TV remote:
 *   OK/Enter or B → blackout · ◀ ▶ → previous/next · ▲ ▼ → text size · Back/Esc → exit
 */
export function Stage({ pb, settings, update, levels, onExit }: { pb: Playback; settings: AppSettings; update: Update; levels: MutableRefObject<AudioLevels>; onExit: () => void }) {
  const [clock, setClock] = useState(() => new Date());
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<number | null>(null);
  const blackout = settings.blackout;
  const art = pb.track?.album.images[0]?.url;
  const live = useRef({ pb, settings });
  live.current = { pb, settings };

  // Controls appear on any input and fade away after 3 s, so nothing sits on screen.
  const poke = useCallback(() => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControls(false), 3000);
  }, []);

  const toggleBlackout = useCallback(() => update((s) => ({ ...s, blackout: !s.blackout })), [update]);

  useEffect(() => {
    void setFullscreen(true);
    poke();
    const id = window.setInterval(() => setClock(new Date()), 10_000);

    // Keep TVs and laptops from dimming or sleeping while lyrics are up.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const takeLock = () => nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    void takeLock();
    const onVisible = () => document.visibilityState === 'visible' && void takeLock();
    document.addEventListener('visibilitychange', onVisible);

    const onKey = (e: KeyboardEvent) => {
      poke();
      const { pb: p, settings: s } = live.current;
      if (isBack(e)) {
        e.preventDefault();
        onExit();
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        toggleBlackout();
      } else if (e.key === 'ArrowRight' || e.key === 'MediaTrackNext') {
        p.next();
      } else if (e.key === 'ArrowLeft' || e.key === 'MediaTrackPrevious') {
        p.previous();
      } else if (e.key === 'MediaPlayPause') {
        p.toggle();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const size = Math.max(24, Math.min(96, s.lyrics.size + (e.key === 'ArrowUp' ? 4 : -4)));
        update((x) => ({ ...x, lyrics: { ...x.lyrics, size } }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(id);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
      void setFullscreen(false);
    };
  }, [onExit, poke, toggleBlackout, update]);

  const lyrics = (
    <Lyrics lyrics={pb.lyrics} lyricsState={pb.lyricsState} hasTrack={!!pb.track} getPosition={pb.getPosition} palette={pb.palette} settings={settings.lyrics} variant="stage" isPlaying={pb.isPlaying} />
  );

  return (
    <div
      className={`stage ${blackout ? 'stage-blackout' : ''} ${controls ? '' : 'stage-idle'}`}
      style={{ background: blackout ? '#000' : pb.palette.surface }}
      onMouseMove={poke}
      onDoubleClick={onExit}
    >
      {!blackout && (
        <>
          {art && <div className="stage-art" style={{ backgroundImage: `url("${art}")` }} />}
          <div className="stage-shade" />
          <div className="stage-clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </>
      )}

      {blackout ? (
        <div className="stage-lyrics stage-lyrics-full">{lyrics}</div>
      ) : (
        <div className="stage-body" style={{ '--stage-glow': pb.palette.primary } as React.CSSProperties}>
          <div className="stage-cover">
            {art ? <img src={art} alt="" key={art.slice(-64)} /> : <div className="stage-cover-empty">♪</div>}
            {pb.track && (
              <div className="min-w-0">
                <div className="stage-title">{pb.track.name}</div>
                <div className="stage-artist truncate">{pb.track.artists.map((a) => a.name).join(', ')}</div>
              </div>
            )}
          </div>
          <div className="stage-lyrics">{lyrics}</div>
        </div>
      )}

      <div className="stage-controls" onMouseMove={(e) => e.stopPropagation()}>
        <button className={`stage-btn ${blackout ? 'stage-btn-on' : ''}`} onClick={toggleBlackout} onDoubleClick={(e) => e.stopPropagation()}>
          {blackout ? '● Blackout on' : '○ Blackout'}
        </button>
        <button className="stage-btn" onClick={onExit} onDoubleClick={(e) => e.stopPropagation()}>
          Exit
        </button>
        <span className="stage-hint">OK: blackout · ◀ ▶ tracks · ▲ ▼ text size · Back: exit</span>
      </div>

      <EdgeGlow palette={pb.palette} settings={settings.glow} levels={levels} isPlaying={pb.isPlaying} />
    </div>
  );
}
