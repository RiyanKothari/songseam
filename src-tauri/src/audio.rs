//! Listens to what the PC is playing (WASAPI loopback on the default output
//! device — never the microphone) and turns it into light-friendly levels.
//!
//! Emits `audio-frame` events (~60/s) with bass / mid / treble / level in 0..1
//! after automatic gain control, plus a `beat` flag on bass onsets.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Copy, Default)]
pub struct AudioFrame {
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub level: f32,
    pub beat: bool,
}

/// Raw band energies for one ~16ms block, before gain control.
struct Block {
    bass: f32,
    mid: f32,
    treble: f32,
    level: f32,
}

/// One-pole low-pass filter.
struct OnePole {
    a: f32,
    y: f32,
}

impl OnePole {
    fn new(cutoff_hz: f32, sample_rate: f32) -> Self {
        let a = 1.0 - (-2.0 * std::f32::consts::PI * cutoff_hz / sample_rate).exp();
        Self { a, y: 0.0 }
    }
    fn run(&mut self, x: f32) -> f32 {
        self.y += self.a * (x - self.y);
        self.y
    }
}

/// Splits mono samples into three bands and sums energy per block.
struct Analyzer {
    bass_lp: OnePole,
    bass_lp2: OnePole,
    mid_lp: OnePole,
    block_len: usize,
    n: usize,
    acc: [f32; 4],
}

impl Analyzer {
    fn new(sample_rate: f32) -> Self {
        Self {
            bass_lp: OnePole::new(160.0, sample_rate),
            bass_lp2: OnePole::new(160.0, sample_rate),
            mid_lp: OnePole::new(3500.0, sample_rate),
            block_len: (sample_rate / 60.0) as usize,
            n: 0,
            acc: [0.0; 4],
        }
    }

    fn push(&mut self, x: f32) -> Option<Block> {
        let bass = self.bass_lp2.run(self.bass_lp.run(x));
        let below_mid = self.mid_lp.run(x);
        let mid = below_mid - bass;
        let treble = x - below_mid;
        self.acc[0] += bass * bass;
        self.acc[1] += mid * mid;
        self.acc[2] += treble * treble;
        self.acc[3] += x * x;
        self.n += 1;
        if self.n < self.block_len {
            return None;
        }
        let n = self.n as f32;
        let b = Block {
            bass: (self.acc[0] / n).sqrt(),
            mid: (self.acc[1] / n).sqrt(),
            treble: (self.acc[2] / n).sqrt(),
            level: (self.acc[3] / n).sqrt(),
        };
        self.n = 0;
        self.acc = [0.0; 4];
        Some(b)
    }
}

/// Automatic gain: tracks a slowly decaying peak so quiet and loud songs both
/// fill the 0..1 range.
struct Agc {
    peak: f32,
}

impl Agc {
    fn run(&mut self, x: f32) -> f32 {
        self.peak = (self.peak * 0.997).max(x).max(1e-4);
        (x / self.peak).clamp(0.0, 1.0)
    }
}

/// Bass onset detector: a beat is a bass block well above the recent average.
struct BeatDetector {
    history: [f32; 43],
    i: usize,
    last_beat: Instant,
}

impl BeatDetector {
    fn run(&mut self, bass: f32) -> bool {
        let avg = self.history.iter().sum::<f32>() / self.history.len() as f32;
        self.history[self.i] = bass;
        self.i = (self.i + 1) % self.history.len();
        let now = Instant::now();
        if bass > avg * 1.45 && bass > 0.002 && now.duration_since(self.last_beat) > Duration::from_millis(240) {
            self.last_beat = now;
            return true;
        }
        false
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Milliseconds (since app start) of the last detected beat; the DJ uses it to cut on the beat.
pub static LAST_BEAT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Latest raw loudness (RMS, before gain control) as f32 bits; the DJ uses it to hear outros.
pub static LEVEL_BITS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// When LEVEL_BITS was last written (app ms); stale = silence.
pub static LEVEL_AT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Current raw loudness, 0 if no audio arrived in the last 300 ms.
pub fn raw_level() -> f32 {
    if now_ms().saturating_sub(LEVEL_AT_MS.load(Ordering::Relaxed)) > 300 {
        return 0.0;
    }
    f32::from_bits(LEVEL_BITS.load(Ordering::Relaxed))
}
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Milliseconds since the app started (monotonic).
pub fn now_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Starts the capture thread once. Rebuilds the stream if the default output
/// device changes or the stream dies (e.g. headphones unplugged).
pub fn start(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (tx, rx) = mpsc::sync_channel::<Block>(32);

    // Emitter thread: gain control + beat detection, then send to every window.
    let emit_app = app.clone();
    std::thread::Builder::new()
        .name("audio-emit".into())
        .spawn(move || {
            let mut agc = [Agc { peak: 0.01 }, Agc { peak: 0.01 }, Agc { peak: 0.005 }, Agc { peak: 0.01 }];
            let mut beat = BeatDetector { history: [0.0; 43], i: 0, last_beat: Instant::now() };
            for b in rx {
                LEVEL_BITS.store(b.level.to_bits(), Ordering::Relaxed);
                LEVEL_AT_MS.store(now_ms(), Ordering::Relaxed);
                let is_beat = beat.run(b.bass);
                if is_beat {
                    LAST_BEAT_MS.store(now_ms(), Ordering::Relaxed);
                }
                let frame = AudioFrame {
                    bass: agc[0].run(b.bass),
                    mid: agc[1].run(b.mid),
                    treble: agc[2].run(b.treble),
                    level: agc[3].run(b.level),
                    beat: is_beat,
                };
                let _ = emit_app.emit("audio-frame", frame);
            }
        })
        .expect("spawn audio-emit thread");

    std::thread::Builder::new()
        .name("audio-capture".into())
        .spawn(move || capture_loop(tx))
        .expect("spawn audio-capture thread");
}

fn capture_loop(tx: mpsc::SyncSender<Block>) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    loop {
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        let device_id = device.id().ok();
        let Ok(config) = device.default_output_config() else {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        let channels = config.channels() as usize;
        let sample_rate = config.sample_rate() as f32;
        let failed = std::sync::Arc::new(AtomicBool::new(false));
        let failed_cb = failed.clone();
        let tx_cb = tx.clone();
        let mut analyzer = Analyzer::new(sample_rate);

        // Building an *input* stream on an *output* device = WASAPI loopback.
        let stream = device.build_input_stream(
            config.config(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                for frame in data.chunks(channels.max(1)) {
                    let mono = frame.iter().sum::<f32>() / frame.len() as f32;
                    if let Some(block) = analyzer.push(mono) {
                        let _ = tx_cb.try_send(block);
                    }
                }
            },
            move |err: cpal::Error| {
                // Glitches (xruns) are harmless for light levels: keep the stream.
                // Anything else means the device went away or changed: rebuild.
                if err.kind() != cpal::ErrorKind::Xrun {
                    log::warn!("audio capture error, reopening: {err}");
                    failed_cb.store(true, Ordering::SeqCst);
                }
            },
            None,
        );

        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                log::warn!("could not open loopback stream: {e}");
                std::thread::sleep(Duration::from_secs(3));
                continue;
            }
        };
        if let Err(e) = stream.play() {
            log::warn!("could not start loopback stream: {e}");
            std::thread::sleep(Duration::from_secs(3));
            continue;
        }

        // Watch for failure or a change of default device, then rebuild.
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if failed.load(Ordering::SeqCst) {
                break;
            }
            let current = cpal::default_host().default_output_device().and_then(|d| d.id().ok());
            if current != device_id {
                break;
            }
        }
        drop(stream);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzer_splits_bands() {
        let sr = 48_000.0;
        let mut low = Analyzer::new(sr);
        let mut high = Analyzer::new(sr);
        let (mut lb, mut hb) = (None, None);
        for i in 0..4800 {
            let t = i as f32 / sr;
            if let Some(b) = low.push((2.0 * std::f32::consts::PI * 60.0 * t).sin()) { lb = Some(b); }
            if let Some(b) = high.push((2.0 * std::f32::consts::PI * 8000.0 * t).sin()) { hb = Some(b); }
        }
        let (lb, hb) = (lb.unwrap(), hb.unwrap());
        assert!(lb.bass > lb.treble * 5.0, "60Hz tone should be bass");
        assert!(hb.treble > hb.bass * 5.0, "8kHz tone should be treble");
    }

    /// Live check: opens WASAPI loopback for 1.5s and counts analysed blocks.
    #[test]
    fn loopback_delivers_blocks() {
        let (tx, rx) = mpsc::sync_channel::<Block>(1024);
        std::thread::spawn(move || capture_loop(tx));
        std::thread::sleep(Duration::from_millis(1500));
        let blocks: Vec<Block> = rx.try_iter().collect();
        let peak = blocks.iter().map(|b| b.level).fold(0.0f32, f32::max);
        println!("loopback blocks in 1.5s: {} (peak level {peak:.4})", blocks.len());
    }
}

#[cfg(test)]
mod live_tone {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    /// Plays a quiet 1.2s 80Hz tone and checks loopback hears it as bass.
    #[test]
    #[ignore = "makes a short quiet sound; run with --ignored"]
    fn loopback_hears_tone() {
        let (tx, rx) = mpsc::sync_channel::<Block>(1024);
        std::thread::spawn(move || capture_loop(tx));
        std::thread::sleep(Duration::from_millis(400));
        let dev = cpal::default_host().default_output_device().unwrap();
        let cfg = dev.default_output_config().unwrap();
        let (ch, sr) = (cfg.channels() as usize, cfg.sample_rate() as f32);
        let mut t = 0f32;
        let out = dev.build_output_stream(cfg.config(), move |d: &mut [f32], _: &cpal::OutputCallbackInfo| {
            for f in d.chunks_mut(ch) {
                let s = 0.05 * (2.0 * std::f32::consts::PI * 80.0 * t).sin();
                t += 1.0 / sr;
                for x in f { *x = s; }
            }
        }, |_| {}, None).unwrap();
        let _ = rx.try_iter().count();
        out.play().unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        drop(out);
        let blocks: Vec<Block> = rx.try_iter().collect();
        let bass = blocks.iter().map(|b| b.bass).fold(0.0f32, f32::max);
        let treble = blocks.iter().map(|b| b.treble).fold(0.0f32, f32::max);
        println!("blocks={} bass={bass:.4} treble={treble:.4}", blocks.len());
        assert!(blocks.len() > 30 && bass > treble * 3.0);
    }
}
