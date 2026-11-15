//! Reads and controls whatever is playing through Windows' System Media
//! Transport Controls (SMTC) — the same source the volume flyout uses.
//! Works with the Spotify desktop app without any Spotify login.

use serde::Serialize;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub source_app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub is_playing: bool,
    /// Unix ms at which `position_ms` was true; the frontend extrapolates from here.
    pub position_updated_at_ms: i64,
    /// Identifies the track; ask `now_playing_art` for its artwork when this changes.
    pub track_key: String,
}

#[cfg(windows)]
pub(crate) mod imp {
    use super::NowPlaying;
    use base64::Engine;
    use std::sync::Mutex;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    /// 100ns ticks between 1601-01-01 and 1970-01-01.
    const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;
    const MAX_THUMB_BYTES: u64 = 4 * 1024 * 1024;

    /// Artwork cache for the current track: (track key, data URL). Shared by all windows.
    static ART: Mutex<Option<(String, String)>> = Mutex::new(None);

    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    /// One session manager for the whole app (asking Windows for a new one on
    /// every poll is slow and piles work onto the shell).
    static MGR: Mutex<Option<Manager>> = Mutex::new(None);
    /// Only one SMTC query runs at a time; callers that arrive meanwhile get the
    /// last answer instead of queueing more blocked threads.
    static BUSY: AtomicBool = AtomicBool::new(false);
    static LAST: Mutex<Option<NowPlaying>> = Mutex::new(None);
    /// While Windows' media service is hung, don't call it again until this time (unix ms).
    static STUCK_UNTIL: AtomicI64 = AtomicI64::new(0);
    const STUCK_BACKOFF_MS: i64 = 20_000;
    /// RPC_E_CALL_CANCELED: the shell didn't answer within COM's timeout.
    const CALL_CANCELED: i32 = 0x80010002u32 as i32;
    pub const STUCK_MSG: &str = "media-stuck: Windows media controls aren't responding";

    fn unix_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    /// Forget the hung state and the cached manager (after the shell restarts).
    pub fn reset() {
        STUCK_UNTIL.store(0, Ordering::Relaxed);
        *MGR.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// True while the Windows media service is known to be hung.
    pub fn stuck() -> bool {
        STUCK_UNTIL.load(Ordering::Relaxed) > unix_ms()
    }

    fn stuck_err() -> windows::core::Error {
        windows::core::Error::new(windows::core::HRESULT(CALL_CANCELED), STUCK_MSG)
    }

    /// Runs an SMTC call with the circuit breaker: fail fast while the service is
    /// hung, and trip the breaker when a call times out or is cancelled.
    fn guarded<T>(f: impl FnOnce(&Manager) -> windows::core::Result<T>) -> windows::core::Result<T> {
        if stuck() {
            return Err(stuck_err());
        }
        let t0 = unix_ms();
        let mgr = {
            let mut g = MGR.lock().unwrap_or_else(|e| e.into_inner());
            match g.as_ref() {
                Some(m) => m.clone(),
                None => {
                    let m = Manager::RequestAsync().and_then(|a| a.join());
                    match m {
                        Ok(m) => {
                            *g = Some(m.clone());
                            m
                        }
                        Err(e) => {
                            trip(&e, t0);
                            return Err(e);
                        }
                    }
                }
            }
        };
        let r = f(&mgr);
        if let Err(e) = &r {
            trip(e, t0);
            // A broken manager is rebuilt next time.
            *MGR.lock().unwrap_or_else(|e| e.into_inner()) = None;
        } else if unix_ms() - t0 > 4000 {
            // Answered, but very slowly: back off briefly so polls don't pile up.
            STUCK_UNTIL.store(unix_ms() + 3000, Ordering::Relaxed);
        }
        r
    }

    fn trip(e: &windows::core::Error, t0: i64) {
        if e.code().0 == CALL_CANCELED || unix_ms() - t0 > 4000 {
            STUCK_UNTIL.store(unix_ms() + STUCK_BACKOFF_MS, Ordering::Relaxed);
        }
    }

    /// Prefer a Spotify session; fall back to whatever Windows considers current.
    fn session(mgr: &Manager) -> windows::core::Result<Option<Session>> {
        for s in mgr.GetSessions()? {
            if s.SourceAppUserModelId()?.to_string().to_lowercase().contains("spotify") {
                return Ok(Some(s));
            }
        }
        Ok(mgr.GetCurrentSession().ok())
    }

    fn read_thumbnail(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
        let size = stream.Size().ok()?;
        if size == 0 || size > MAX_THUMB_BYTES {
            return None;
        }
        let mime = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        reader.LoadAsync(size as u32).ok()?.join().ok()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).ok()?;
        let mime = if mime.is_empty() { "image/png".to_string() } else { mime };
        Some(format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(buf)))
    }

    /// Now playing, single-flight: if a query is already running, returns the last answer.
    pub fn now_playing() -> windows::core::Result<Option<NowPlaying>> {
        if stuck() {
            return Err(stuck_err());
        }
        if BUSY.swap(true, Ordering::AcqRel) {
            return Ok(LAST.lock().unwrap_or_else(|e| e.into_inner()).clone());
        }
        let r = guarded(read_now_playing);
        BUSY.store(false, Ordering::Release);
        if let Ok(np) = &r {
            *LAST.lock().unwrap_or_else(|e| e.into_inner()) = np.clone();
        }
        r
    }

    fn read_now_playing(mgr: &Manager) -> windows::core::Result<Option<NowPlaying>> {
        let Some(s) = session(mgr)? else { return Ok(None) };

        let props = s.TryGetMediaPropertiesAsync()?.join()?;
        let timeline = s.GetTimelineProperties()?;
        let status = s.GetPlaybackInfo()?.PlaybackStatus()?;

        let title = props.Title()?.to_string();
        let artist = props.Artist()?.to_string();
        let key = format!("{title}\u{1f}{artist}");

        let updated = timeline.LastUpdatedTime()?.UniversalTime;
        Ok(Some(NowPlaying {
            source_app: s.SourceAppUserModelId()?.to_string(),
            title,
            artist,
            album: props.AlbumTitle()?.to_string(),
            position_ms: timeline.Position()?.Duration / 10_000,
            duration_ms: (timeline.EndTime()?.Duration - timeline.StartTime()?.Duration) / 10_000,
            is_playing: status == Status::Playing,
            position_updated_at_ms: (updated - EPOCH_DIFF_TICKS) / 10_000,
            track_key: key,
        }))
    }

    /// Artwork of the current track as a data URL. Read once per track and
    /// cached; a failed read (Spotify sets art a moment late) isn't cached.
    pub fn art() -> windows::core::Result<Option<(String, String)>> {
        guarded(read_art)
    }

    fn read_art(mgr: &Manager) -> windows::core::Result<Option<(String, String)>> {
        let Some(s) = session(mgr)? else { return Ok(None) };
        let props = s.TryGetMediaPropertiesAsync()?.join()?;
        let key = format!("{}{}", props.Title()?, props.Artist()?);
        if let Some((k, data)) = ART.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if *k == key {
                return Ok(Some((k.clone(), data.clone())));
            }
        }
        let Some(data) = read_thumbnail(&props) else { return Ok(None) };
        *ART.lock().unwrap_or_else(|e| e.into_inner()) = Some((key.clone(), data.clone()));
        Ok(Some((key, data)))
    }

    pub fn control(action: &str, position_ms: Option<i64>) -> windows::core::Result<bool> {
        guarded(|mgr| control_with(mgr, action, position_ms))
    }

    fn control_with(mgr: &Manager, action: &str, position_ms: Option<i64>) -> windows::core::Result<bool> {
        let Some(s) = session(mgr)? else { return Ok(false) };
        let op = match action {
            "play" => s.TryPlayAsync()?,
            "pause" => s.TryPauseAsync()?,
            "toggle" => s.TryTogglePlayPauseAsync()?,
            "next" => s.TrySkipNextAsync()?,
            "previous" => s.TrySkipPreviousAsync()?,
            "seek" => s.TryChangePlaybackPositionAsync(position_ms.unwrap_or(0).max(0) * 10_000)?,
            _ => return Ok(false),
        };
        op.join()
    }
}

#[tauri::command]
pub async fn now_playing() -> Result<Option<NowPlaying>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| imp::now_playing().map_err(|e| e.message().to_string()))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    Ok(None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Art {
    pub track_key: String,
    pub data_url: String,
}

#[tauri::command]
pub async fn now_playing_art() -> Result<Option<Art>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            imp::art()
                .map(|o| o.map(|(track_key, data_url)| Art { track_key, data_url }))
                .map_err(|e| e.message().to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    Ok(None)
}

#[tauri::command]
pub async fn media_control(action: String, position_ms: Option<i64>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            imp::control(&action, position_ms).map_err(|e| e.message().to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (action, position_ms);
        Ok(false)
    }
}

#[cfg(all(test, windows))]
mod tests {
    /// Smoke test against the live machine: prints what Windows reports.
    /// Run with `cargo test -- --nocapture`.
    #[test]
    fn reads_now_playing_without_error() {
        let np = match super::imp::now_playing() {
            Ok(np) => np,
            // The machine's media service being hung is not a bug in this code.
            Err(e) if super::imp::stuck() => return println!("SMTC hung on this machine, skipped: {}", e.message()),
            Err(e) => panic!("SMTC query failed: {e:?}"),
        };
        match np {
            Some(n) => println!(
                "app={} title={:?} artist={:?} pos={}ms dur={}ms playing={} updated={} art={}",
                n.source_app, n.title, n.artist, n.position_ms, n.duration_ms, n.is_playing,
                n.position_updated_at_ms,
                super::imp::art().ok().flatten().map(|(_, d)| d.len()).unwrap_or(0)
            ),
            None => println!("no media session open"),
        }
    }
}

