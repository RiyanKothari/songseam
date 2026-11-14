//! Per-app volume through the Windows mixer (the same sliders as the
//! "Volume mixer" settings page). Used by the DJ to fade Spotify out at the
//! end of a track and back in on the next one — one track at a time, never
//! overlapping, so Spotify's own audio is never mixed with anything.

#[cfg(windows)]
pub(crate) mod imp {
    use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::core::{Interface, PWSTR};

    fn process_name(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; MAX_PATH as usize];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().map(|s| s.to_lowercase())
        }
    }

    /// All mixer sessions whose process exe contains `app` (e.g. "spotify").
    fn sessions_for(app: &str) -> windows::core::Result<Vec<ISimpleAudioVolume>> {
        let app = app.to_lowercase();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let list = manager.GetSessionEnumerator()?;
            let mut out = Vec::new();
            for i in 0..list.GetCount()? {
                let control = list.GetSession(i)?;
                let control2: IAudioSessionControl2 = control.cast()?;
                let pid = control2.GetProcessId().unwrap_or(0);
                if pid == 0 {
                    continue;
                }
                if process_name(pid).is_some_and(|n| n.contains(&app)) {
                    out.push(control.cast::<ISimpleAudioVolume>()?);
                }
            }
            Ok(out)
        }
    }

    pub fn get(app: &str) -> windows::core::Result<Option<f32>> {
        let s = sessions_for(app)?;
        match s.first() {
            Some(v) => Ok(Some(unsafe { v.GetMasterVolume()? })),
            None => Ok(None),
        }
    }

    pub fn set(app: &str, level: f32) -> windows::core::Result<bool> {
        let s = sessions_for(app)?;
        for v in &s {
            unsafe { v.SetMasterVolume(level.clamp(0.0, 1.0), std::ptr::null())? };
        }
        Ok(!s.is_empty())
    }

    /// Smoothly ramps to `to` over `ms` with an equal-power style curve.
    pub fn fade(app: &str, to: f32, ms: u64) -> windows::core::Result<bool> {
        let s = sessions_for(app)?;
        let Some(first) = s.first() else { return Ok(false) };
        let from = unsafe { first.GetMasterVolume()? };
        let steps = (ms / 25).max(1);
        for i in 1..=steps {
            let t = i as f32 / steps as f32;
            // Sine ease: gentle at both ends, so fades sound natural.
            let e = 0.5 - 0.5 * (std::f32::consts::PI * t).cos();
            let level = from + (to - from) * e;
            for v in &s {
                unsafe { v.SetMasterVolume(level.clamp(0.0, 1.0), std::ptr::null())? };
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        Ok(true)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_app_volume(app: String) -> Result<Option<f32>, String> {
    #[cfg(windows)]
    return blocking(move || imp::get(&app).map_err(|e| e.message().to_string())).await;
    #[cfg(not(windows))]
    return blocking(move || { let _ = app; Ok(None) }).await;
}

#[tauri::command]
pub async fn set_app_volume(app: String, level: f32) -> Result<bool, String> {
    #[cfg(windows)]
    return blocking(move || imp::set(&app, level).map_err(|e| e.message().to_string())).await;
    #[cfg(not(windows))]
    return blocking(move || { let _ = (app, level); Ok(false) }).await;
}

#[tauri::command]
pub async fn fade_app_volume(app: String, to: f32, ms: u64) -> Result<bool, String> {
    #[cfg(windows)]
    return blocking(move || imp::fade(&app, to, ms.min(30_000)).map_err(|e| e.message().to_string())).await;
    #[cfg(not(windows))]
    return blocking(move || { let _ = (app, to, ms); Ok(false) }).await;
}

#[cfg(all(test, windows))]
mod tests {
    /// Live check: finds Spotify in the Windows mixer and re-sets its current level (no audible change).
    #[test]
    fn finds_spotify_session() {
        match super::imp::get("spotify").expect("mixer query failed") {
            Some(v) => {
                println!("spotify mixer volume = {v}");
                assert!(super::imp::set("spotify", v).unwrap());
            }
            None => println!("spotify has no audio session right now"),
        }
    }
}
