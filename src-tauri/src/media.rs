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

    fn manager() -> windows::core::Result<Manager> {
        Manager::RequestAsync()?.join()
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

    pub fn now_playing() -> windows::core::Result<Option<NowPlaying>> {
        let mgr = manager()?;
        let Some(s) = session(&mgr)? else { return Ok(None) };

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
        let mgr = manager()?;
        let Some(s) = session(&mgr)? else { return Ok(None) };
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
        let mgr = manager()?;
        let Some(s) = session(&mgr)? else { return Ok(false) };
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
        let np = super::imp::now_playing().expect("SMTC query failed");
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
