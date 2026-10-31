/**
 * Proceduralne dźwięki symulatora (Web Audio API, bez plików audio):
 *  - ryk silników: szum brązowy + filtr dolnoprzepustowy, niski "rumble" i trzaski;
 *    głośność i barwa zależą od ciągu, liczby silników, gęstości powietrza i odległości kamery,
 *  - wybuch: impuls szumu z opadającym filtrem, niski "thump" i pogłos,
 *  - drobne efekty: syk pneumatyki (separacja, owiewka), "klik" zapłonu.
 *
 * AudioContext powstaje dopiero po geście użytkownika (polityka autoplay przeglądarek).
 */

const STORAGE_KEY = 'f9sim.audio';
/** Prędkość dźwięku w powietrzu przy ziemi [m/s] — opóźnienie dla kamery naziemnej. */
const SPEED_OF_SOUND = 343;
const MAX_DELAY = 4;

function makeNoiseBuffer(ctx: AudioContext, seconds: number, kind: 'brown' | 'white' | 'crackle'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else if (kind === 'crackle') {
      // rzadkie, ostre impulsy (trzaski naddźwiękowego strumienia spalin)
      d[i] = Math.random() < 0.0016 ? w * (0.4 + Math.random() * 0.6) : 0;
    } else {
      d[i] = w;
    }
  }
  return buf;
}

/** Odpowiedź impulsowa pogłosu: zanikający szum stereo. */
function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/** Parametry jednego źródła ciągu w danej klatce. */
export interface EngineSoundParams {
  /** Ciąg względny 0..1 (0 = silniki wyłączone). */
  thrust: number;
  /** Liczba pracujących silników (9, 3, 1; MVac liczony jak 1 duży). */
  engines: number;
  /** Gęstość powietrza względem poziomu morza w miejscu pojazdu. */
  airRatio: number;
  /** Odległość kamery od pojazdu [m]. */
  distance: number;
  /** Kamera na kadłubie: dźwięk przenoszony przez konstrukcję (słyszalny także w próżni). */
  onboard: boolean;
  /** Opóźnienie dźwięku (kamera naziemna) [s]. */
  delay: number;
  /** Dodatkowy mnożnik głośności (np. ściszenie pojazdu, którego kamera nie śledzi). */
  emphasis: number;
}

class EngineVoice {
  private noiseGain: GainNode;
  private noiseFilter: BiquadFilterNode;
  private rumbleGain: GainNode;
  private rumbleOsc: OscillatorNode;
  private crackleGain: GainNode;
  private delay: DelayNode;
  private out: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode, brown: AudioBuffer, crackle: AudioBuffer) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.delay = ctx.createDelay(MAX_DELAY);
    this.out.connect(this.delay).connect(dest);

    // ryk: szum brązowy przez filtr dolnoprzepustowy
    const noise = ctx.createBufferSource();
    noise.buffer = brown;
    noise.loop = true;
    noise.playbackRate.value = 0.9 + Math.random() * 0.2;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'lowpass';
    this.noiseFilter.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.out);
    noise.start();

    // niskie dudnienie: piła ~38 Hz z wolną modulacją amplitudy
    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = 'sawtooth';
    this.rumbleOsc.frequency.value = 38;
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 110;
    this.rumbleGain = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain).connect(this.rumbleGain.gain);
    this.rumbleOsc.connect(rumbleLp).connect(this.rumbleGain).connect(this.out);
    this.rumbleOsc.start();
    lfo.start();

    // trzaski
    const crack = ctx.createBufferSource();
    crack.buffer = crackle;
    crack.loop = true;
    const crackHp = ctx.createBiquadFilter();
    crackHp.type = 'highpass';
    crackHp.frequency.value = 700;
    this.crackleGain = ctx.createGain();
    crack.connect(crackHp).connect(this.crackleGain).connect(this.out);
    crack.start();
  }

  set(ctx: AudioContext, p: EngineSoundParams) {
    const t = ctx.currentTime;
    const tc = 0.12; // stała czasowa wygładzania (bez trzasków przy zmianach)
    const on = p.thrust > 0.01 ? 1 : 0;
    // większa liczba silników = głośniej, ale nie liniowo
    const count = Math.min(1, 0.45 + 0.55 * Math.sqrt(p.engines / 9));
    // powietrze przenosi dźwięk; w próżni słychać go tylko przez konstrukcję (kamera pokładowa)
    const air = Math.sqrt(Math.min(1, p.airRatio));
    const medium = p.onboard ? 0.55 + 0.45 * air : air;
    // tłumienie z odległością (od ~150 m, kamera pościgowa) i pochłanianie wysokich tonów
    const distGain = Math.min(1, 160 / Math.max(p.distance, 1));
    const level = on * (0.25 + 0.75 * p.thrust) * count * medium * distGain * p.emphasis;
    let cutoff = 200 + 4200 * air * Math.min(1, 400 / Math.max(p.distance, 1));
    if (p.onboard) cutoff = Math.min(cutoff, 380 + 300 * air);

    this.out.gain.setTargetAtTime(level, t, tc);
    this.noiseFilter.frequency.setTargetAtTime(Math.max(120, cutoff), t, tc);
    this.noiseGain.gain.setTargetAtTime(0.9, t, tc);
    this.rumbleGain.gain.setTargetAtTime(p.onboard ? 0.9 : 0.5, t, tc);
    this.rumbleOsc.frequency.setTargetAtTime(34 + 10 * p.thrust, t, 0.3);
    this.crackleGain.gain.setTargetAtTime(air * distGain > 0.2 && !p.onboard ? 0.5 : 0, t, tc);
    this.delay.delayTime.setTargetAtTime(Math.min(MAX_DELAY - 0.05, p.delay), t, 0.3);
  }
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private fxBus: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private white: AudioBuffer | null = null;
  private main: EngineVoice | null = null;
  private booster: EngineVoice | null = null;
  private engineBus: GainNode | null = null;
  private voice: GainNode | null = null;
  private volume = 0.7;
  private muted = false;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw) as { volume?: number; muted?: boolean };
        if (typeof v.volume === 'number') this.volume = Math.min(1, Math.max(0, v.volume));
        if (typeof v.muted === 'boolean') this.muted = v.muted;
      }
    } catch {
      // brak dostępu do localStorage (tryb prywatny itp.) — zostają ustawienia domyślne
    }
  }

  get state(): { volume: number; muted: boolean; running: boolean } {
    return { volume: this.volume, muted: this.muted, running: this.ctx?.state === 'running' };
  }

  /** Tworzy/wznawia AudioContext; wywoływać w obsłudze gestu użytkownika. */
  unlock() {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      // kompresor: wybuch i ryk na pełnym ciągu nie przesterowują wyjścia
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(ctx.destination);
      this.applyVolume();

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeImpulse(ctx, 3.2, 2.6);
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      this.reverb.connect(wet).connect(this.master);
      this.fxBus = ctx.createGain();
      this.fxBus.connect(this.master);
      this.fxBus.connect(this.reverb);

      const brown = makeNoiseBuffer(ctx, 4, 'brown');
      const crackle = makeNoiseBuffer(ctx, 3, 'crackle');
      this.white = makeNoiseBuffer(ctx, 3, 'white');
      const engineBus = ctx.createGain();
      engineBus.gain.value = 0.8;
      engineBus.connect(this.master);
      engineBus.connect(this.reverb);
      this.engineBus = engineBus;
      // szyna komentarzy kontroli lotów (bez pogłosu, wspólna głośność i wyciszenie)
      this.voice = ctx.createGain();
      this.voice.gain.value = 0.9;
      this.voice.connect(this.master);
      this.main = new EngineVoice(ctx, engineBus, brown, crackle);
      this.booster = new EngineVoice(ctx, engineBus, brown, crackle);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** AudioContext (null przed pierwszym gestem użytkownika). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Wejście dla komentarzy (null przed odblokowaniem dźwięku). */
  get voiceBus(): GainNode | null {
    return this.voice;
  }

  /** Ściszenie ryku silników o ~6 dB na czas wypowiedzi (ducking). */
  duck(on: boolean) {
    if (!this.ctx || !this.engineBus) return;
    this.engineBus.gain.setTargetAtTime(on ? 0.4 : 0.8, this.ctx.currentTime, 0.15);
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyVolume();
    this.save();
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyVolume();
    this.save();
  }

  private applyVolume() {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    } catch {
      // ignorujemy — ustawienie obowiązuje do końca sesji
    }
  }

  /** Aktualizacja ryku silników (co klatkę). */
  update(main: EngineSoundParams, booster: EngineSoundParams) {
    if (!this.ctx || !this.main || !this.booster) return;
    this.main.set(this.ctx, main);
    this.booster.set(this.ctx, booster);
  }

  /** Wybuch: `distance` w metrach od kamery, `delay` w sekundach, `size` ~1. */
  explosion(distance: number, delay = 0, size = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.fxBus || !this.white) return;
    const t0 = ctx.currentTime + Math.min(MAX_DELAY, Math.max(0, delay));
    const g = Math.min(1.4, (400 / Math.max(distance, 50)) * size);
    const lowOnly = Math.min(1, 1500 / Math.max(distance, 1)); // z daleka słychać głównie basy

    const noise = ctx.createBufferSource();
    noise.buffer = this.white;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400 + 5000 * lowOnly, t0);
    lp.frequency.exponentialRampToValueAtTime(120, t0 + 2.5);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t0);
    ng.gain.linearRampToValueAtTime(g, t0 + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 2.8);
    noise.connect(lp).connect(ng).connect(this.fxBus);
    noise.start(t0);
    noise.stop(t0 + 3);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(70, t0);
    thump.frequency.exponentialRampToValueAtTime(22, t0 + 1.6);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, t0);
    tg.gain.linearRampToValueAtTime(g * 1.2, t0 + 0.015);
    tg.gain.exponentialRampToValueAtTime(0.001, t0 + 1.8);
    thump.connect(tg).connect(this.fxBus);
    thump.start(t0);
    thump.stop(t0 + 2);
  }

  /** Syk pneumatyki (popychacze separacji, zrzut owiewki). */
  hiss(level = 0.5) {
    const ctx = this.ctx;
    if (!ctx || !this.fxBus || !this.white) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level * 0.4, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
    src.connect(hp).connect(g).connect(this.fxBus);
    src.start(t0);
    src.stop(t0 + 1);
  }

  /** Krótki "klik"/łomot zapłonu silnika. */
  ignition(level = 0.6) {
    const ctx = this.ctx;
    if (!ctx || !this.fxBus || !this.white) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(110, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
    osc.connect(g).connect(this.fxBus);
    osc.start(t0);
    osc.stop(t0 + 0.4);
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(level * 0.5, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    src.connect(bp).connect(ng).connect(this.fxBus);
    src.start(t0);
    src.stop(t0 + 0.1);
  }
}

export { SPEED_OF_SOUND };
