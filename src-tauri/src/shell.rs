//! Windows, tray menu and the Spotify login callback listener.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY: &str = "overlay";

/// Serialises overlay create/show/hide so two quick requests can't create two windows.
static OVERLAY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Creates the full-display overlay (transparent, click-through, always on
/// top, not in the taskbar) on the primary monitor, or shows/hides it.
pub fn set_overlay(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    let _guard = OVERLAY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window(OVERLAY) {
        if visible {
            w.show()?;
            w.set_ignore_cursor_events(true)?;
        } else {
            w.hide()?;
        }
    } else if visible {
        // Size it to the primary display up front (logical units); resizing a
        // hidden transparent window afterwards leaves the web view the wrong size.
        let (pos, size) = match app.primary_monitor()? {
            Some(m) => {
                let k = m.scale_factor();
                (
                    (m.position().x as f64 / k, m.position().y as f64 / k),
                    (m.size().width as f64 / k, m.size().height as f64 / k),
                )
            }
            None => ((0.0, 0.0), (1920.0, 1080.0)),
        };
        let w = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("index.html".into()))
            .title("Afterglow overlay")
            .position(pos.0, pos.1)
            .inner_size(size.0, size.1)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(true)
            .build()?;
        w.set_ignore_cursor_events(true)?;
    }
    let _ = app.emit("overlay-visibility", visible);
    Ok(())
}

pub fn overlay_visible(app: &AppHandle) -> bool {
    app.get_webview_window(OVERLAY).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Afterglow", true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", "Toggle screen glow + lyrics", true, None::<&str>)?;
    let stage = MenuItem::with_id(app, "stage", "Full-screen stage", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &overlay, &stage, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Afterglow")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "overlay" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let v = !overlay_visible(&app);
                    let _ = set_overlay(&app, v);
                });
            }
            "stage" => {
                show_main(app);
                let _ = app.emit("enter-stage", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// Must be async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn overlay_set(app: AppHandle, visible: bool) -> Result<bool, String> {
    set_overlay(&app, visible).map_err(|e| e.to_string())?;
    Ok(visible)
}

#[tauri::command]
pub fn overlay_is_visible(app: AppHandle) -> bool {
    overlay_visible(&app)
}

#[derive(serde::Serialize)]
pub struct OAuthResult {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Each login attempt gets a number; starting a new one cancels the old wait.
static LOGIN_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Spotify login on desktop: listens on http://127.0.0.1:{port}/callback,
/// opens the authorize page in the user's browser, and waits (up to 3 min)
/// for the redirect carrying `code`/`state`. Only Spotify's authorize URL
/// can be opened, and only the loopback interface is bound.
#[tauri::command]
pub async fn spotify_login(app: AppHandle, url: String, port: u16) -> Result<OAuthResult, String> {
    use std::sync::atomic::Ordering;
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://accounts.spotify.com/authorize?") {
        return Err("refusing to open a non-Spotify login URL".into());
    }
    let attempt = LOGIN_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        // A previous attempt may still hold the port for up to ~100 ms after being cancelled.
        let mut bound = None;
        for _ in 0..20 {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(l) => {
                    bound = Some(l);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        let listener = bound.ok_or_else(|| format!("Port {port} is in use by another program, so Spotify can't send you back here."))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        app.opener()
            .open_url(&url, None::<&str>)
            .map_err(|e| format!("Couldn't open your browser: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if LOGIN_GEN.load(Ordering::SeqCst) != attempt {
                return Err("Login restarted".into());
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).ok();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                    let mut first = String::new();
                    BufReader::new(&stream).read_line(&mut first).ok();
                    // "GET /callback?code=...&state=... HTTP/1.1"
                    let path = first.split_whitespace().nth(1).unwrap_or("");
                    if !path.starts_with("/callback") {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                        continue;
                    }
                    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
                    let result = OAuthResult {
                        code: query_param(query, "code"),
                        state: query_param(query, "state"),
                        error: query_param(query, "error"),
                    };
                    let body = "<!doctype html><meta charset=utf-8><title>Afterglow</title>\
                        <body style=\"background:#0b0b10;color:#fff;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0\">\
                        <div style=\"text-align:center\"><h2>Connected to Afterglow</h2><p>You can close this tab.</p></div>";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    return Ok(result);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() > deadline {
                        return Err("Timed out waiting for Spotify login".into());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_query_params() {
        let q = "code=AQB%2Fx_y&state=abc+def&error=";
        assert_eq!(query_param(q, "code").as_deref(), Some("AQB/x_y"));
        assert_eq!(query_param(q, "state").as_deref(), Some("abc def"));
        assert_eq!(query_param(q, "error").as_deref(), Some(""));
        assert_eq!(query_param(q, "missing"), None);
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}

/// Lets the web views write to the app log (visible in `npm run desktop` output).
#[tauri::command]
pub fn client_log(window: tauri::Window, level: String, message: String) {
    let msg: String = message.chars().take(2000).collect();
    match level.as_str() {
        "error" => log::error!("[{}] {}", window.label(), msg),
        "warn" => log::warn!("[{}] {}", window.label(), msg),
        _ => log::info!("[{}] {}", window.label(), msg),
    }
}
