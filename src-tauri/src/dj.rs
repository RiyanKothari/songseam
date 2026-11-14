//! The DJ engine. Runs on its own thread so transitions happen on time no
//! matter what the panel window is doing (other tab, minimised, in the tray).
//!
//! For each planned step it watches Spotify through Windows media controls
//! and, at the cue-out point, waits for a beat, fades Spotify down with the
//! Windows mixer, skips, cues the next track to its cue-in point and fades
//! it up. One track at a time — Spotify's audio is never layered or altered.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub title: String,
    pub duration_ms: i64,
    /// Where to start this track (skips a long intro); 0 = from the top.
    pub cue_in_ms: i64,
    /// Where the fade-out to the next track starts.
    pub exit_at_ms: i64,
    pub fade_out_ms: u64,
    pub fade_in_ms: u64,
    pub bpm: f32,
    /// When the last vocal line ends (from lyrics); 0 = unknown.
    #[serde(default)]
    pub vocal_end_ms: i64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DjStatus {
    pub state: String, // idle | playing | transitioning | off-plan | done | error
    pub index: usize,
    pub next_fade_in_ms: Option<i64>,
    pub message: String,
    /// False when Spotify isn't playing on this PC (fades need the local mixer).
    pub fades_available: bool,
}

static RUN: AtomicU64 = AtomicU64::new(0);
static STATUS: Mutex<Option<DjStatus>> = Mutex::new(None);

fn norm(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in s.to_lowercase().chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth > 0 => {}
            c if c.is_alphanumeric() => out.push(c),
            _ => {}
        }
    }
    // Drop " - Remastered 2011" style suffixes.
    if let Some(i) = s.find(" - ") {
        let head = norm(&s[..i]);
        if !head.is_empty() {
            return head;
        }
    }
    out
}

fn unix_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn publish(app: &AppHandle, s: DjStatus) {
    *STATUS.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.clone());
    let _ = app.emit("dj-status", s);
}

#[cfg(windows)]
mod run {
    use super::*;
    use crate::audio::{now_ms, raw_level, LAST_BEAT_MS};
    use crate::media::imp as media;
    use crate::volume::imp as volume;

    struct Live {
        title: String,
        pos: i64,
        playing: bool,
    }

    fn live() -> Option<Live> {
        let np = media::now_playing().ok()??;
        let pos = np.position_ms + if np.is_playing { unix_ms() - np.position_updated_at_ms } else { 0 };
        Some(Live { title: np.title, pos, playing: np.is_playing })
    }

    fn still(run: u64) -> bool {
        RUN.load(Ordering::SeqCst) == run
    }

    /// Waits for the next detected beat (max ~2 beats) so the cut lands in time.
    fn wait_for_beat(bpm: f32, run: u64) {
        let beat_ms = if bpm > 40.0 { 60_000.0 / bpm } else { 500.0 } as u64;
        let since = now_ms();
        while now_ms() - since < beat_ms * 2 && still(run) {
            if LAST_BEAT_MS.load(Ordering::Relaxed) > since {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn main(app: AppHandle, steps: Vec<Step>, run: u64) {
        let keys: Vec<String> = steps.iter().map(|s| norm(&s.title)).collect();
        let base = match volume::get("spotify") {
            Ok(Some(v)) if v > 0.05 => v,
            _ => 1.0,
        };
        let mut index = 0usize;
        let mut cued: Option<usize> = None; // last index whose cue-in we applied
        let mut status = DjStatus { state: "playing".into(), ..Default::default() };
        // Per-song loudness memory for outro detection.
        let mut level_sum = 0f64;
        let mut level_n = 0u32;
        let mut quiet_ms = 0i64;
        let mut level_for: Option<usize> = None;

        while still(run) {
            std::thread::sleep(Duration::from_millis(100));
            let Some(now) = live() else { continue };
            let key = norm(&now.title);
            let fades = volume::get("spotify").ok().flatten().is_some();

            let found = (0..keys.len()).map(|k| (index + k) % keys.len()).find(|&i| keys[i] == key);
            let Some(i) = found else {
                status = DjStatus {
                    state: "off-plan".into(),
                    index,
                    message: "Something outside the set is playing — the DJ is waiting.".into(),
                    fades_available: fades,
                    next_fade_in_ms: None,
                };
                publish(&app, status.clone());
                continue;
            };
            index = i;
            let step = &steps[i];

            // New track in the set: jump to its cue-in (skips a long intro).
            if cued != Some(i) {
                cued = Some(i);
                if step.cue_in_ms > now.pos + 1500 {
                    let _ = media::control("seek", Some(step.cue_in_ms));
                }
            }

            let Some(next) = steps.get(i + 1) else {
                status = DjStatus { state: "playing".into(), index: i, message: "Last track of the set".into(), fades_available: fades, next_fade_in_ms: None };
                publish(&app, status.clone());
                if now.pos > step.duration_ms - 1500 {
                    publish(&app, DjStatus { state: "done".into(), index: i, message: "Set finished".into(), fades_available: fades, next_fade_in_ms: None });
                    return;
                }
                continue;
            };

            // Learn this song's normal loudness while it plays (ignore the first 15 s).
            if level_for != Some(i) {
                level_for = Some(i);
                level_sum = 0.0;
                level_n = 0;
                quiet_ms = 0;
            }
            let lvl = raw_level();
            let bar_ms = (240_000.0 / step.bpm.clamp(60.0, 200.0)) as i64;
            let after_vocals = if step.vocal_end_ms > 0 { now.pos > step.vocal_end_ms + bar_ms } else { now.pos > step.duration_ms * 4 / 5 };
            let mut outro = false;
            if now.playing && lvl > 0.0 {
                if now.pos > 15_000 && !after_vocals {
                    level_sum += lvl as f64;
                    level_n += 1;
                }
                let avg = if level_n > 50 { (level_sum / level_n as f64) as f32 } else { 0.0 };
                // The outro has started when the music stays well below the song's
                // normal level for two bars after the vocals end.
                if avg > 0.0 && after_vocals && now.pos < step.exit_at_ms {
                    quiet_ms = if lvl < avg * 0.5 { quiet_ms + 100 } else { 0 };
                    outro = quiet_ms >= 2 * bar_ms;
                }
            }

            let until = step.exit_at_ms - now.pos;
            status = DjStatus { state: "playing".into(), index: i, message: String::new(), fades_available: fades, next_fade_in_ms: Some(until.max(0)) };
            publish(&app, status.clone());
            if (until > 0 && !outro) || !now.playing {
                continue;
            }

            // ---- Transition ----
            let why = if outro && until > 0 { format!("Heard the outro start — mixing out {}s early, on the beat", until / 1000) } else { "Mixing out on the beat".to_string() };
            publish(&app, DjStatus { state: "transitioning".into(), index: i, message: why, fades_available: fades, next_fade_in_ms: Some(0) });
            wait_for_beat(step.bpm, run);
            if fades {
                let _ = volume::fade("spotify", 0.0, step.fade_out_ms);
            }
            if !still(run) {
                break;
            }
            // Skip unless Spotify already moved on by itself.
            if live().map(|l| norm(&l.title) == key).unwrap_or(true) {
                let _ = media::control("next", None);
            }
            // Wait (≤6 s) for the next track to start, then cue it before fading in.
            let t0 = now_ms();
            while now_ms() - t0 < 6000 && still(run) {
                if live().map(|l| norm(&l.title) != key).unwrap_or(false) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            if next.cue_in_ms > 1500 {
                let _ = media::control("seek", Some(next.cue_in_ms));
                std::thread::sleep(Duration::from_millis(250));
            }
            cued = Some(i + 1);
            index = i + 1;
            if fades {
                let _ = volume::fade("spotify", base, next.fade_in_ms);
            }
        }
        // Stopped: never leave Spotify silent.
        let _ = volume::set("spotify", base);
        let _ = status;
    }
}

#[tauri::command]
pub fn dj_start(app: AppHandle, steps: Vec<Step>) -> Result<(), String> {
    if steps.is_empty() {
        return Err("empty set".into());
    }
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    #[cfg(windows)]
    {
        std::thread::Builder::new()
            .name("dj".into())
            .spawn(move || run::main(app, steps, run))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (app, run);
    Ok(())
}

#[tauri::command]
pub fn dj_stop(app: AppHandle) {
    RUN.fetch_add(1, Ordering::SeqCst);
    publish(&app, DjStatus { state: "idle".into(), ..Default::default() });
}

#[tauri::command]
pub fn dj_status() -> Option<DjStatus> {
    STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::norm;

    #[test]
    fn titles_match_across_sources() {
        assert_eq!(norm("Heaven"), norm("heaven"));
        assert_eq!(norm("Sweet Child O' Mine - Remastered 2011"), norm("Sweet Child O' Mine"));
        assert_eq!(norm("Levitating (feat. DaBaby)"), norm("Levitating"));
        assert_ne!(norm("Heaven"), norm("Heavenly"));
    }
}
