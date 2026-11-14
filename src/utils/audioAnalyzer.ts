export interface AudioFrameMetrics {
  bass: number;     // 0 - 1
  mid: number;      // 0 - 1
  treble: number;   // 0 - 1
  volume: number;   // 0 - 1
  beatPulse: number;// 0 - 1 with fast attack, exponential decay
}

export class AudioEngine {
  private static ctx: AudioContext | null = null;
  private static analyser: AnalyserNode | null = null;
  private static sourceNode: MediaElementAudioSourceNode | MediaStreamAudioSourceNode | null = null;
  private static dataArray: Uint8Array | null = null;
  private static beatDecay = 0;
  private static lastBass = 0;
  private static bpmInterval: number | null = null;
  private static simulatedPulse = 0;

  public static getContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public static initAnalyser(): AnalyserNode {
    const ctx = this.getContext();
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    }
    return this.analyser;
  }

  /**
   * Connects an HTMLAudioElement to the analyzer for live demo preview playback
   */
  public static connectAudioElement(audioElement: HTMLAudioElement): void {
    try {
      const ctx = this.getContext();
      const analyser = this.initAnalyser();
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch {}
      }
      this.sourceNode = ctx.createMediaElementSource(audioElement);
      this.sourceNode.connect(analyser);
      analyser.connect(ctx.destination);
    } catch (e) {
      console.warn('Audio element connect warning:', e);
    }
  }

  /**
   * Connects microphone / stereo mix input so the lights can react to real audio.
   */
  public static async connectMicrophone(): Promise<boolean> {
    try {
      const ctx = this.getContext();
      const analyser = this.initAnalyser();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch {}
      }
      this.sourceNode = ctx.createMediaStreamSource(stream);
      this.sourceNode.connect(analyser);
      return true;
    } catch (e) {
      console.warn('Mic connect warning:', e);
      return false;
    }
  }

  /**
   * Start rhythmic procedural pulse for when real audio stream isn't tapped directly
   */
  public static startSimulatedBpm(bpm: number = 120): void {
    if (this.bpmInterval) clearInterval(this.bpmInterval);
    const msPerBeat = (60 / bpm) * 1000;
    this.bpmInterval = window.setInterval(() => {
      this.simulatedPulse = 1.0;
    }, msPerBeat);
  }

  public static getMetrics(): AudioFrameMetrics {
    // Decay simulated pulse
    this.simulatedPulse *= 0.88;

    if (!this.analyser || !this.dataArray) {
      // Return procedural breathing pulse if no audio device connected
      const time = performance.now() * 0.003;
      const wave = (Math.sin(time) + 1) * 0.5;
      const combinedPulse = Math.max(wave * 0.5, this.simulatedPulse);
      return {
        bass: combinedPulse * 0.8,
        mid: combinedPulse * 0.5,
        treble: combinedPulse * 0.4,
        volume: combinedPulse * 0.6,
        beatPulse: combinedPulse,
      };
    }

    this.analyser.getByteFrequencyData(this.dataArray as any);
    const len = this.dataArray.length;

    // Split into frequency ranges
    const bassEnd = Math.floor(len * 0.18);
    const midEnd = Math.floor(len * 0.55);

    let bassSum = 0;
    for (let i = 0; i < bassEnd; i++) bassSum += this.dataArray[i];
    const bass = bassSum / (bassEnd * 255);

    let midSum = 0;
    for (let i = bassEnd; i < midEnd; i++) midSum += this.dataArray[i];
    const mid = midSum / ((midEnd - bassEnd) * 255);

    let trebleSum = 0;
    for (let i = midEnd; i < len; i++) trebleSum += this.dataArray[i];
    const treble = trebleSum / ((len - midEnd) * 255);

    const volume = (bass * 0.5 + mid * 0.3 + treble * 0.2);

    // Detect sudden bass onset (kick drum transient)
    const bassDiff = bass - this.lastBass;
    if (bassDiff > 0.08 && bass > 0.4) {
      this.beatDecay = 1.0;
    } else {
      this.beatDecay *= 0.86;
    }
    this.lastBass = bass;

    const beatPulse = Math.max(this.beatDecay, this.simulatedPulse, bass * 0.6);

    return {
      bass: Math.min(1, bass),
      mid: Math.min(1, mid),
      treble: Math.min(1, treble),
      volume: Math.min(1, volume),
      beatPulse: Math.min(1, beatPulse),
    };
  }
}
