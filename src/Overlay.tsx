import { useEffect } from 'react';
import { usePlayback } from './state/playback';
import { useSettings } from './state/settings';
import { useAudioLevels } from './state/levels';
import { EdgeGlow } from './components/EdgeGlow';
import { useMediaFallback } from './state/mediaFallback';
import { Lyrics } from './components/Lyrics';

/**
 * The full-display overlay window: transparent, click-through, always on top.
 * Follows whatever Windows media controls report (Spotify preferred).
 */
export function Overlay() {
  // Same fallback as the main window: Spotify's API while Windows media controls are hung.
  const media = useMediaFallback();
  const pb = usePlayback(media.source('windows'));
  media.useWatch(pb.error);
  const [settings] = useSettings();
  const levels = useAudioLevels();

  useEffect(() => {
    document.documentElement.classList.add('is-overlay');
  }, []);

  if (!pb.track) return null;
  return (
    <>
      {settings.lyrics.onOverlay && (
        <Lyrics lyrics={pb.lyrics} lyricsState={pb.lyricsState} getPosition={pb.getPosition} palette={pb.palette} settings={settings.lyrics} variant="overlay" isPlaying={pb.isPlaying} />
      )}
      <EdgeGlow palette={pb.palette} settings={settings.glow} levels={levels} isPlaying={pb.isPlaying} />
    </>
  );
}
