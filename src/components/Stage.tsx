import { useEffect, useState, type MutableRefObject } from 'react';
import type { AppSettings, AudioLevels } from '../types';
import type { Playback } from '../state/playback';
import { EdgeGlow } from './EdgeGlow';
import { Lyrics } from './Lyrics';
import { setFullscreen } from '../services/platform';

/** Full-screen idle mode: album-tinted backdrop, edge glow and big lyrics. */
export function Stage({ pb, settings, levels, onExit }: { pb: Playback; settings: AppSettings; levels: MutableRefObject<AudioLevels>; onExit: () => void }) {
  const [clock, setClock] = useState(() => new Date());
  const art = pb.track?.album.images[0]?.url;

  useEffect(() => {
    void setFullscreen(true);
    const id = window.setInterval(() => setClock(new Date()), 10_000);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onExit();
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(id);
      window.removeEventListener('keydown', onKey);
      void setFullscreen(false);
    };
  }, [onExit]);

  return (
    <div className="stage" style={{ background: pb.palette.surface }} onDoubleClick={onExit}>
      {art && <div className="stage-art" style={{ backgroundImage: `url("${art}")` }} />}
      <div className="stage-shade" />
      <div className="stage-clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      <button className="stage-exit" onClick={onExit}>
        Exit · Esc
      </button>
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
        <div className="stage-lyrics">
          <Lyrics lyrics={pb.lyrics} lyricsState={pb.lyricsState} hasTrack={!!pb.track} getPosition={pb.getPosition} palette={pb.palette} settings={settings.lyrics} variant="stage" isPlaying={pb.isPlaying} />
        </div>
      </div>
      <EdgeGlow palette={pb.palette} settings={settings.glow} levels={levels} isPlaying={pb.isPlaying} />
    </div>
  );
}
