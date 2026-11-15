import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { NativeMedia } from '../services/nativeMedia';
import * as Spotify from '../services/spotify';
import { isDesktop } from '../services/platform';
import type { Source } from './playback';

/**
 * The desktop app reads Spotify through Windows media controls. When Windows'
 * media service hangs ("Call was canceled by the message filter"), follow
 * playback through Spotify's Web API instead (if connected), keep checking
 * whether Windows has recovered, and offer to restart Explorer, which hosts it.
 *
 * Usage: `const media = useMediaFallback(); const pb = usePlayback(media.source(...)); media.watch(pb.error);`
 */
export function useMediaFallback() {
  const [stuck, setStuck] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!stuck) return;
    const id = window.setInterval(() => {
      NativeMedia.nowPlaying()
        .then(() => setStuck(false))
        .catch(() => {});
    }, 20_000);
    return () => clearInterval(id);
  }, [stuck]);

  return {
    stuck,
    restarting,
    /** Source to read from: Windows normally, Spotify's API while Windows is hung. */
    source(preferred: Source): Source {
      if (!isDesktop) return preferred;
      return stuck && Spotify.isLoggedIn() ? 'spotify' : 'windows';
    },
    /** Call with the playback error each render. */
    useWatch(error: string | null) {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useEffect(() => {
        if (isDesktop && error?.includes('media-stuck')) setStuck(true);
      }, [error]);
    },
    async restart() {
      setRestarting(true);
      try {
        await invoke('restart_explorer');
        await NativeMedia.nowPlaying();
        setStuck(false);
      } catch {
        /* still hung: keep the fallback */
      } finally {
        setRestarting(false);
      }
    },
  };
}
