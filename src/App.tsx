import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayback, type Source } from './state/playback';
import { useSettings } from './state/settings';
import { useAudioLevels } from './state/levels';
import { EdgeGlow } from './components/EdgeGlow';
import { Lyrics } from './components/Lyrics';
import { GlowControls, LyricsControls } from './components/Controls';
import { DjPanel } from './components/DjPanel';
import { Stage } from './components/Stage';
import { Overlay, isDesktop, on } from './services/platform';
import * as Spotify from './services/spotify';
import type { NowInfo } from './dj/runner';

type Tab = 'glow' | 'lyrics' | 'dj';

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const WEB_SOURCE_KEY = 'songseam.webSource';
const OVERLAY_KEY = 'songseam.overlay';

export default function App() {
  const [webSource, setWebSource] = useState<Source>(() => (localStorage.getItem(WEB_SOURCE_KEY) as Source) || 'demo');
  const source: Source = isDesktop ? 'windows' : webSource;
  const pb = usePlayback(source);
  const [settings, update] = useSettings();
  const levels = useAudioLevels();
  const [tab, setTab] = useState<Tab>('glow');
  const [overlayOn, setOverlayOn] = useState(false);
  const [stage, setStage] = useState(false);
  const pbRef = useRef(pb);
  pbRef.current = pb;

  // Desktop: restore the user's screen-glow choice, keep it in sync with the tray, open stage from the tray.
  const stageRef = useRef(false);
  stageRef.current = stage;
  useEffect(() => {
    if (!isDesktop) return;
    const offs: (() => void)[] = [];
    Overlay.set(localStorage.getItem(OVERLAY_KEY) !== 'off').then(setOverlayOn);
    on<boolean>('overlay-visibility', (v) => {
      // Stage hides the overlay temporarily; that isn't the user's choice.
      if (stageRef.current) return;
      setOverlayOn(v);
      localStorage.setItem(OVERLAY_KEY, v ? 'on' : 'off');
    }).then((u) => offs.push(u));
    on('enter-stage', () => setStage(true)).then((u) => offs.push(u));
    return () => offs.forEach((u) => u());
  }, []);

  // Stage fills the screen itself, so the overlay steps aside while it's open.
  useEffect(() => {
    if (!isDesktop) return;
    if (stage) void Overlay.set(false);
    else if (localStorage.getItem(OVERLAY_KEY) !== 'off') void Overlay.set(true).then(setOverlayOn);
  }, [stage]);

  // Web: finish Spotify login after the redirect back to /callback.
  useEffect(() => {
    Spotify.handleWebCallback()
      .then((ok) => {
        if (ok) {
          localStorage.setItem(WEB_SOURCE_KEY, 'spotify');
          setWebSource('spotify');
          setTab('dj');
        }
      })
      .catch(() => {});
  }, []);

  const getNow = useCallback((): NowInfo | null => {
    const p = pbRef.current;
    if (!p.track) return null;
    return { name: p.track.name, artist: p.track.artists[0]?.name ?? '', positionMs: p.getPosition(), isPlaying: p.isPlaying };
  }, []);

  const exitStage = useCallback(() => setStage(false), []);

  const toggleOverlay = async () => {
    const v = await Overlay.set(!overlayOn);
    setOverlayOn(v);
    localStorage.setItem(OVERLAY_KEY, v ? 'on' : 'off');
  };

  const art = pb.track?.album.images[0]?.url;
  const dur = pb.track?.duration_ms ?? 0;

  if (stage) return <Stage pb={pb} settings={settings} levels={levels} onExit={exitStage} />;

  return (
    <div className="app" style={{ '--surface': pb.palette.surface, '--accent': pb.palette.primary, '--accent2': pb.palette.secondary } as React.CSSProperties}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          SongSeam
        </div>
        <div className="flex items-center gap-2">
          {!isDesktop && (
            <div className="seg seg-sm">
              {(['demo', 'spotify'] as Source[]).map((s) => (
                <button
                  key={s}
                  className={webSource === s ? 'seg-on' : ''}
                  onClick={() => {
                    localStorage.setItem(WEB_SOURCE_KEY, s);
                    setWebSource(s);
                    if (s === 'spotify' && !Spotify.isLoggedIn()) setTab('dj');
                  }}
                >
                  {s === 'demo' ? 'Demo' : 'Spotify'}
                </button>
              ))}
            </div>
          )}
          {isDesktop && (
            <button className={`btn ${overlayOn ? 'btn-primary' : ''}`} onClick={toggleOverlay} title="Edge lighting and lyrics over your whole screen">
              {overlayOn ? 'Screen glow: on' : 'Screen glow: off'}
            </button>
          )}
          <button className="btn" onClick={() => setStage(true)}>
            ⛶ Stage
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="col-left">
          <div className="card now">
            <div className="now-art-wrap">
              {art ? <img className="now-art" src={art} alt="" /> : <div className="now-art now-art-empty">♪</div>}
            </div>
            <div className="min-w-0 flex-1">
              <div className="label">
                {source === 'windows' ? 'Now playing · Windows' : source === 'spotify' ? 'Now playing · Spotify' : 'Demo song'}
              </div>
              <div className="now-title truncate">{pb.track?.name ?? (source === 'windows' ? 'Play something in Spotify' : 'Nothing playing')}</div>
              <div className="muted truncate">{pb.track?.artists.map((a) => a.name).join(', ') ?? ''}</div>
              <input
                className="scrub"
                type="range"
                min={0}
                max={Math.max(1, dur)}
                value={Math.min(pb.progressMs, dur)}
                onChange={(e) => pb.seek(Number(e.target.value))}
                disabled={!pb.track}
                aria-label="Seek"
                style={{ '--fill': `${dur ? (pb.progressMs / dur) * 100 : 0}%` } as React.CSSProperties}
              />
              <div className="flex justify-between muted text-xs">
                <span>{fmt(pb.progressMs)}</span>
                <span>{fmt(dur)}</span>
              </div>
              <div className="transport">
                <button onClick={pb.previous} aria-label="Previous">
                  ⏮
                </button>
                <button className="play" onClick={pb.toggle} aria-label={pb.isPlaying ? 'Pause' : 'Play'}>
                  {pb.isPlaying ? '❚❚' : '▶'}
                </button>
                <button onClick={pb.next} aria-label="Next">
                  ⏭
                </button>
              </div>
            </div>
          </div>
          {pb.error && <p className="error">{pb.error}</p>}
          {source === 'spotify' && !Spotify.isLoggedIn() && <p className="muted text-sm">Connect Spotify in the Mood DJ tab to follow your playback.</p>}

          <div className="preview" aria-label="Preview of your screen">
            {art && <div className="preview-bg" style={{ backgroundImage: `url("${art}")` }} />}
            <Lyrics lyrics={pb.lyrics} lyricsState={pb.lyricsState} hasTrack={!!pb.track} getPosition={pb.getPosition} palette={pb.palette} settings={settings.lyrics} variant="panel" isPlaying={pb.isPlaying} />
            <EdgeGlow contained scale={0.45} palette={pb.palette} settings={settings.glow} levels={levels} isPlaying={pb.isPlaying} />
          </div>
          <p className="muted text-xs text-center">
            {isDesktop
              ? 'Lights react to the sound your PC is playing. Colours come from the album art.'
              : 'Browser preview. The Windows app lights up your whole screen and follows the Spotify app directly.'}
          </p>
        </section>

        <section className="col-right">
          <nav className="tabs">
            {(
              [
                ['glow', 'Lighting'],
                ['lyrics', 'Lyrics'],
                ['dj', 'Mood DJ'],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button key={t} className={tab === t ? 'tab-on' : ''} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'glow' && <GlowControls settings={settings} update={update} palette={pb.palette} />}
          {tab === 'lyrics' && <LyricsControls settings={settings} update={update} desktop={isDesktop} />}
          {tab === 'dj' && <DjPanel palette={pb.palette} getNow={getNow} />}
        </section>
      </main>
    </div>
  );
}
