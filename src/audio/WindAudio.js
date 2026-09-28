// Procedural wind rush, no audio files: looping white noise through a band-pass (the rush)
// and a high band-pass (the whistle), mixed by player speed. A slow random "gust" LFO keeps
// it from sounding static. Browsers only allow audio after a user gesture: call start() from
// a keydown / pointerdown handler.

export class WindAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    // Two seconds of white noise, looped.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    this.rush = ctx.createBiquadFilter();
    this.rush.type = 'bandpass';
    this.rush.frequency.value = 300;
    this.rush.Q.value = 0.7;
    this.whistle = ctx.createBiquadFilter();
    this.whistle.type = 'bandpass';
    this.whistle.frequency.value = 1800;
    this.whistle.Q.value = 6;
    this.rushGain = ctx.createGain();
    this.whistleGain = ctx.createGain();
    this.rushGain.gain.value = 0;
    this.whistleGain.gain.value = 0;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;

    // Gusts: a slow oscillator wobbling the rush level.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    this.gust = ctx.createGain();
    this.gust.gain.value = 0;
    lfo.connect(this.gust).connect(this.rushGain.gain);

    noise.connect(this.rush).connect(this.rushGain).connect(this.master);
    noise.connect(this.whistle).connect(this.whistleGain).connect(this.master);
    this.master.connect(ctx.destination);
    noise.start();
    lfo.start();
  }

  /** @param {{speed:number, state:string}} snapshot */
  update(snapshot) {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    const airborne = snapshot.state === 'glide' || snapshot.state === 'air';
    const v = airborne ? snapshot.speed : snapshot.speed * 0.3;
    const level = Math.min(1, Math.max(0, (v - 3) / 35)) ** 1.4;
    this.rushGain.gain.setTargetAtTime(level * 0.55, t, 0.25);
    this.gust.gain.setTargetAtTime(level * 0.12, t, 0.5);
    this.rush.frequency.setTargetAtTime(220 + v * 38, t, 0.3);
    this.whistleGain.gain.setTargetAtTime(Math.max(0, level - 0.35) * 0.18, t, 0.3);
    this.whistle.frequency.setTargetAtTime(1200 + v * 55, t, 0.4);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    return this.muted;
  }
}
