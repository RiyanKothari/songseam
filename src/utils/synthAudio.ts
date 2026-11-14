import { AudioEngine } from './audioAnalyzer';

/**
 * Procedural Web Audio Synthesizer:
 * Generates rhythmic bass, kick pulses, and synth chords for the browser demo.
 * Connects directly to the AudioEngine analyzer so the edge lighting responds in the browser demo.
 */
export class SynthAudioPlayer {
  private static isPlaying = false;
  private static timerId: number | null = null;
  private static beatIndex = 0;
  private static currentBpm = 171;
  private static isMuted = false;
  private static masterGain: GainNode | null = null;

  public static setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.masterGain) {
      this.masterGain.gain.setValueAtTime(muted ? 0 : 0.45, AudioEngine.getContext().currentTime);
    }
  }

  public static getIsMuted(): boolean {
    return this.isMuted;
  }

  public static start(bpm: number = 171): void {
    this.stop();
    this.currentBpm = bpm;
    this.isPlaying = true;
    this.beatIndex = 0;

    const ctx = AudioEngine.getContext();
    const analyser = AudioEngine.initAnalyser();

    if (!this.masterGain) {
      this.masterGain = ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : 0.45, ctx.currentTime);
      this.masterGain.connect(analyser);
      analyser.connect(ctx.destination);
    }

    const intervalMs = (60 / this.currentBpm / 2) * 1000; // 8th note grid

    this.timerId = window.setInterval(() => {
      if (!this.isPlaying) return;
      this.tick();
      this.beatIndex = (this.beatIndex + 1) % 16;
    }, intervalMs);
  }

  public static stop(): void {
    this.isPlaying = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private static tick(): void {
    const ctx = AudioEngine.getContext();
    const now = ctx.currentTime;
    if (!this.masterGain) return;

    // Kick drum on beats 0, 4, 8, 12 (4-on-the-floor)
    if (this.beatIndex % 4 === 0) {
      this.playKick(now);
    }

    // Snare / Clap on beats 4, 12 (backbeat)
    if (this.beatIndex % 8 === 4) {
      this.playSnare(now);
    }

    // Hi-hat on every 8th note
    this.playHiHat(now, this.beatIndex % 2 === 1);

    // Synth Bass note
    if (this.beatIndex % 2 === 0) {
      const notes = [65.41, 65.41, 77.78, 87.31]; // C2, C2, Eb2, F2
      const noteFreq = notes[Math.floor(this.beatIndex / 4) % notes.length];
      this.playBass(now, noteFreq);
    }

    // Synth Lead / Pad Chord
    if (this.beatIndex === 0 || this.beatIndex === 8) {
      this.playChords(now);
    }
  }

  private static playKick(time: number): void {
    const ctx = AudioEngine.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(38, time + 0.12);

    gain.gain.setValueAtTime(1.0, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

    osc.connect(gain);
    gain.connect(this.masterGain!);

    osc.start(time);
    osc.stop(time + 0.19);
  }

  private static playSnare(time: number): void {
    const ctx = AudioEngine.getContext();
    // Noise buffer
    const bufferSize = ctx.sampleRate * 0.12;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.5;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(1000, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.12);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain!);

    noise.start(time);
    noise.stop(time + 0.12);
  }

  private static playHiHat(time: number, accent: boolean): void {
    const ctx = AudioEngine.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(8000, time);

    const level = accent ? 0.22 : 0.09;
    gain.gain.setValueAtTime(level, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

    osc.connect(gain);
    gain.connect(this.masterGain!);

    osc.start(time);
    osc.stop(time + 0.05);
  }

  private static playBass(time: number, freq: number): void {
    const ctx = AudioEngine.getContext();
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(380, time);
    filter.frequency.exponentialRampToValueAtTime(160, time + 0.22);

    gain.gain.setValueAtTime(0.42, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain!);

    osc.start(time);
    osc.stop(time + 0.26);
  }

  private static playChords(time: number): void {
    const ctx = AudioEngine.getContext();
    const chordFreqs = [261.63, 311.13, 392.0]; // C minor triad
    chordFreqs.forEach((freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);

      gain.gain.setValueAtTime(0.12, time);
      gain.gain.linearRampToValueAtTime(0.18, time + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.9);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      osc.start(time);
      osc.stop(time + 0.92);
    });
  }
}
