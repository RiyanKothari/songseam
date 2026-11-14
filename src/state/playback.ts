import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColorPalette, SpotifyTrack, SyncedLyrics } from '../types';
import { NativeMedia } from '../services/nativeMedia';
import * as Spotify from '../services/spotify';
import { fetchLyricsFromLrclib } from '../services/lrclib';
import { DEFAULT_PALETTE, extractPalette } from '../utils/color';
import { DEMO_BPM, DEMO_LYRICS, DEMO_TRACK } from '../data/demo';
import { SynthAudioPlayer } from '../utils/synthAudio';
import { log } from '../services/platform';

export type Source = 'windows' | 'spotify' | 'demo';
export type LyricsState = 'loading' | 'ready' | 'missing';

export interface Playback {
  source: Source;
  track: SpotifyTrack | null;
  isPlaying: boolean;
  progressMs: number; // updated ~5x/s for UI
  getPosition: () => number; // exact, for animation frames
  lyrics: SyncedLyrics | null;
  lyricsState: LyricsState;
  palette: ColorPalette;
  error: string | null;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
}

interface Clock {
  pos: number;
  at: number;
  playing: boolean;
  duration: number;
}

const trackKey = (t: SpotifyTrack | null) => (t ? `${t.name}\u001f${t.artists[0]?.name ?? ''}` : '');

/** One now-playing source with lyrics, palette and a smooth position clock. */
export function usePlayback(source: Source): Playback {
  const [track, setTrack] = useState<SpotifyTrack | null>(source === 'demo' ? DEMO_TRACK : null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progressMs, setProgressMs] = useState(0);
  const [lyrics, setLyrics] = useState<SyncedLyrics | null>(null);
  const [lyricsState, setLyricsState] = useState<LyricsState>('missing');
  const [palette, setPalette] = useState<ColorPalette>(DEFAULT_PALETTE);
  const [error, setError] = useState<string | null>(null);
  const clock = useRef<Clock>({ pos: 0, at: Date.now(), playing: false, duration: 0 });
  const keyRef = useRef('');
  const seekAt = useRef(0); // when the user last seeked from this window

  const getPosition = useCallback(() => {
    const c = clock.current;
    const p = c.pos + (c.playing ? Date.now() - c.at : 0);
    if (source === 'demo' && c.duration > 0) return p % c.duration;
    return c.duration > 0 ? Math.min(p, c.duration) : p;
  }, [source]);

  const setClock = (pos: number, playing: boolean, duration: number, at = Date.now()) => {
    clock.current = { pos, at, playing, duration };
    setIsPlaying(playing);
  };

  // New track → fetch lyrics + palette once.
  const onTrack = useCallback((t: SpotifyTrack) => {
    const key = trackKey(t);
    if (key === keyRef.current) return;
    keyRef.current = key;
    setTrack(t);
    const art = t.album.images[0]?.url;
    if (art) extractPalette(art).then((p) => keyRef.current === key && setPalette(p));
    if (t.id === 'demo') {
      setLyrics(DEMO_LYRICS);
      setLyricsState('ready');
      return;
    }
    setLyrics(null);
    setLyricsState('loading');
    fetchLyricsFromLrclib(t.name, t.artists[0]?.name ?? '', t.duration_ms).then((l) => {
      if (keyRef.current !== key) return;
      setLyrics(l);
      setLyricsState(l && l.sync !== 'none' ? 'ready' : 'missing');
    });
  }, []);

  // Windows media controls (desktop app).
  useEffect(() => {
    if (source !== 'windows') return;
    let alive = true;
    let first = true;
    let artFor = ''; // track key whose artwork we have
    let artTries = 0;
    let artTrack = '';
    let emptyPolls = 0;
    const poll = async () => {
      try {
        const np = await NativeMedia.nowPlaying();
        if (first) log('info', 'windows media first poll:', np ? `${np.title} / ${np.artist} playing=${np.isPlaying}` : 'no session');
        first = false;
        if (!alive) return;
        setError(null);
        if (!np || !np.title) {
          // Spotify closed (or nothing playing anywhere): clear after ~3 s so the
          // overlay doesn't keep showing a song that's gone.
          if (++emptyPolls >= 3 && keyRef.current) {
            keyRef.current = '';
            artFor = '';
            setTrack(null);
            setLyrics(null);
            setLyricsState('missing');
            setClock(0, false, 0);
          }
          return;
        }
        emptyPolls = 0;
        // Spotify reports position every ~4.5 s, timestamped. Extrapolate from
        // the report; only re-anchor when it disagrees noticeably (seek, track
        // change, play/pause) so lyrics never jitter. Reports older than a
        // local seek are stale and ignored.
        const c = clock.current;
        const now = Date.now();
        const stale = np.positionUpdatedAtMs < seekAt.current && now - seekAt.current < 6000;
        const reported = np.positionMs + (np.isPlaying ? now - np.positionUpdatedAtMs : 0);
        const predicted = c.pos + (c.playing ? now - c.at : 0);
        const newTrack = keyRef.current !== `${np.title}\u001f${np.artist}`;
        if (!stale && (newTrack || c.playing !== np.isPlaying || c.duration !== np.durationMs || Math.abs(reported - predicted) > 250)) {
          setClock(np.positionMs, np.isPlaying, np.durationMs, np.positionUpdatedAtMs);
        }
        onTrack({
          id: `win:${np.title}\u001f${np.artist}`,
          name: np.title,
          artists: [{ name: np.artist }],
          album: { name: np.album, images: [] },
          duration_ms: np.durationMs,
          progress_ms: np.positionMs,
          is_playing: np.isPlaying,
        });

        // Artwork: fetched separately (it's large); Spotify sometimes sets it a beat late, so retry a few polls.
        if (artTrack !== np.trackKey) {
          artTrack = np.trackKey;
          artTries = 0;
        }
        if (artFor !== np.trackKey && artTries < 8) {
          artTries++;
          const art = await NativeMedia.art();
          if (alive && art && art.trackKey === np.trackKey) {
            artFor = art.trackKey;
            const url = art.dataUrl;
            setTrack((t) => (t && keyRef.current === trackKey(t) ? { ...t, album: { ...t.album, images: [{ url }] } } : t));
            const key = keyRef.current;
            extractPalette(url).then((p) => keyRef.current === key && setPalette(p));
          }
        }
      } catch (e) {
        log('warn', 'windows media poll failed:', String(e));
        if (alive) setError(String(e));
      }
    };
    poll();
    const id = window.setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source, onTrack]);

  // Spotify Web API (browser build, or desktop when the music plays elsewhere).
  useEffect(() => {
    if (source !== 'spotify') return;
    let alive = true;
    const poll = async () => {
      if (!Spotify.isLoggedIn()) return;
      try {
        const s = await Spotify.getPlayback();
        if (!alive) return;
        setError(null);
        if (!s) {
          setClock(clock.current.pos, false, clock.current.duration);
          return;
        }
        const predicted = clock.current.pos + (clock.current.playing ? Date.now() - clock.current.at : 0);
        // Ignore tiny drifts so the lyrics don't stutter on every poll.
        if (Math.abs(predicted - s.progressMs) > 700 || clock.current.playing !== s.isPlaying || trackKey(s.track) !== keyRef.current) {
          setClock(s.progressMs, s.isPlaying, s.track.duration_ms);
        }
        onTrack(s.track);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source, onTrack]);

  // Demo (browser): original song on a loop with the built-in synth.
  useEffect(() => {
    if (source !== 'demo') return;
    keyRef.current = '';
    onTrack(DEMO_TRACK);
    setClock(0, false, DEMO_TRACK.duration_ms);
    return () => SynthAudioPlayer.stop();
  }, [source, onTrack]);

  // UI progress (5 Hz).
  useEffect(() => {
    const id = window.setInterval(() => setProgressMs(getPosition()), 200);
    return () => clearInterval(id);
  }, [getPosition]);

  const toggle = useCallback(() => {
    const c = clock.current;
    const pos = getPosition();
    if (source === 'windows') {
      seekAt.current = Date.now(); // ignore reports from before this click
      void NativeMedia.control('toggle');
    }
    if (source === 'spotify') void (c.playing ? Spotify.player.pause() : Spotify.player.play()).catch((e) => setError(e.message));
    if (source === 'demo') {
      if (c.playing) SynthAudioPlayer.stop();
      else SynthAudioPlayer.start(DEMO_BPM);
    }
    setClock(pos, !c.playing, c.duration);
  }, [source, getPosition]);

  const next = useCallback(() => {
    if (source === 'windows') void NativeMedia.control('next');
    if (source === 'spotify') void Spotify.player.next().catch((e) => setError(e.message));
    if (source === 'demo') setClock(0, clock.current.playing, clock.current.duration);
  }, [source]);

  const previous = useCallback(() => {
    if (source === 'windows') void NativeMedia.control('previous');
    if (source === 'spotify') void Spotify.player.previous().catch((e) => setError(e.message));
    if (source === 'demo') setClock(0, clock.current.playing, clock.current.duration);
  }, [source]);

  const seek = useCallback(
    (ms: number) => {
      if (source === 'windows') {
        seekAt.current = Date.now();
        void NativeMedia.control('seek', ms);
      }
      if (source === 'spotify') void Spotify.player.seek(ms).catch((e) => setError(e.message));
      setClock(ms, clock.current.playing, clock.current.duration);
    },
    [source],
  );

  return { source, track, isPlaying, progressMs, getPosition, lyrics, lyricsState, palette, error, toggle, next, previous, seek };
}
