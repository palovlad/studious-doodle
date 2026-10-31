import type { FlightEvent, SimState } from '../sim/physics';
import type { SoundEngine } from './sfx';

/**
 * Komentarze kontroli lotów (nagrania TTS z public/audio/vo, lista w manifest.json).
 *
 * - kwestie kluczowe przypięte do zdarzeń misji (MECO, separacja, lądowanie…),
 * - wywołania telemetrii (wysokość, Mach 1, odległość), wyzwalane raz na lot,
 * - "chunki" sytuacyjne losowane co 18–30 s, gdy nic się nie dzieje (zależne od fazy lotu).
 *
 * Dźwięk przechodzi przez filtr "radiowy" (pasmo 300–3400 Hz + lekka saturacja),
 * a przed i po kwestii słychać sygnały quindar (2525 / 2475 Hz) jak w pętlach NASA.
 * Brak plików lub manifestu = cisza bez błędów.
 */

type Category = 'key' | 'callout' | 'chunk';

interface VoLine {
  id: string;
  file: string;
  text: string;
  category: Category;
  trigger: string | null;
  phase: string | null;
  voice: string;
  duration: number;
}

interface Queued {
  line: VoLine;
  priority: number;
  /** performance.now() w chwili zgłoszenia — do odrzucania przeterminowanych kwestii. */
  at: number;
}

const BASE = './audio/vo/';
const STORAGE_KEY = 'f9sim.voice';
const PRIORITY: Record<Category, number> = { key: 3, callout: 2, chunk: 1 };
/** Jak długo kwestia może czekać w kolejce [ms]. */
const MAX_WAIT: Record<Category, number> = { key: 7000, callout: 5000, chunk: 500 };
const ALTITUDE_CALLOUTS: [number, string][] = [
  [10_000, 'ALT_10'],
  [50_000, 'ALT_50'],
  [100_000, 'ALT_100'],
  [150_000, 'ALT_150'],
];

export class MissionControl {
  private lines: VoLine[] = [];
  private byTrigger = new Map<string, VoLine>();
  private chunks = new Map<string, VoLine[]>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private queue: Queued[] = [];
  private current: { src: AudioBufferSourceNode; item: Queued } | null = null;
  private starting = false;
  private fired = new Set<string>();
  private chunkTimer = 10;
  private lastChunk = '';
  private radioIn: GainNode | null = null;
  private enabled = true;
  /** Historia odtworzonych kwestii (diagnostyka / testy). */
  readonly played: string[] = [];

  constructor(private sound: SoundEngine) {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v !== null) this.enabled = v === '1';
    } catch {
      // brak localStorage — domyślnie włączone
    }
    void this.loadManifest();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get loaded(): number {
    return this.lines.length;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      // ignorujemy
    }
    if (!on) this.stop();
  }

  private async loadManifest() {
    try {
      const res = await fetch(`${BASE}manifest.json`);
      if (!res.ok) return;
      const data = (await res.json()) as { lines: VoLine[] };
      this.lines = data.lines;
      for (const l of this.lines) {
        if (l.trigger) this.byTrigger.set(l.trigger, l);
        if (l.category === 'chunk' && l.phase) {
          const list = this.chunks.get(l.phase) ?? [];
          list.push(l);
          this.chunks.set(l.phase, list);
        }
      }
    } catch {
      // brak nagrań — komentarz po prostu milczy
    }
  }

  /** Dekodowanie nagrania przy pierwszym użyciu (wynik w pamięci podręcznej). */
  private buffer(line: VoLine): Promise<AudioBuffer | null> {
    const ctx = this.sound.context;
    if (!ctx) return Promise.resolve(null);
    let p = this.buffers.get(line.id);
    if (!p) {
      p = fetch(BASE + line.file)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => ctx.decodeAudioData(b))
        .catch(() => null);
      this.buffers.set(line.id, p);
    }
    return p;
  }

  /** Wstępne dekodowanie kwestii kluczowych (po odblokowaniu dźwięku). */
  prefetch() {
    for (const l of this.lines) if (l.category === 'key') void this.buffer(l);
  }

  onEvent(ev: FlightEvent) {
    this.trigger(ev);
  }

  private trigger(name: string) {
    if (this.fired.has(name)) return;
    const line = this.byTrigger.get(name);
    if (!line) return;
    this.fired.add(name);
    this.enqueue(line);
  }

  private enqueue(line: VoLine) {
    if (!this.enabled || !this.sound.context) return;
    const item: Queued = { line, priority: PRIORITY[line.category], at: performance.now() };
    // kwestia ważniejsza przerywa trwający chunk
    if (this.current && this.current.item.priority < item.priority && this.current.item.line.category === 'chunk') {
      this.stopCurrent();
    }
    this.queue.push(item);
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    // przy gęstych zdarzeniach (przyspieszony czas) nie budujemy zaległości: zostają 3 kwestie,
    // a najstarsze z najniższym priorytetem odpadają
    while (this.queue.length > 3) {
      let drop = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const q = this.queue[i];
        const d = this.queue[drop];
        if (q.priority < d.priority || (q.priority === d.priority && q.at < d.at)) drop = i;
      }
      this.queue.splice(drop, 1);
    }
  }

  /** Wywoływać co klatkę. */
  update(s: SimState, warp: number, dt: number) {
    if (!this.enabled || this.lines.length === 0) return;
    const T = s.telemetry;
    const flying = s.phase === 'ASCENT' || s.phase === 'COAST' || s.phase === 'STAGE2' || s.phase === 'ORBIT';
    const fast = warp > 2;

    // wywołania telemetrii (przy przyspieszonym czasie tylko kwestie kluczowe)
    if (flying && !fast) {
      if (s.phase === 'ASCENT' && T.mach > 1) this.trigger('SUPERSONIC');
      for (const [alt, name] of ALTITUDE_CALLOUTS) if (T.altitude > alt) this.trigger(name);
      if (T.downrange > 500_000) this.trigger('DOWNRANGE_500');
    } else if (flying) {
      // oznacz jako wykonane, żeby nie odtworzyć ich z opóźnieniem po zwolnieniu czasu
      if (T.mach > 1) this.fired.add('SUPERSONIC');
      for (const [alt, name] of ALTITUDE_CALLOUTS) if (T.altitude > alt) this.fired.add(name);
      if (T.downrange > 500_000) this.fired.add('DOWNRANGE_500');
    }
    const b = s.booster;
    if (b.legsDeployed && b.active) this.trigger('LEGS');

    // chunki sytuacyjne, gdy nic się nie dzieje
    if (!this.current && !this.starting && this.queue.length === 0 && !fast) {
      this.chunkTimer -= dt;
      if (this.chunkTimer <= 0) {
        this.chunkTimer = 18 + Math.random() * 12;
        const phase = this.chunkPhase(s);
        const list = phase ? this.chunks.get(phase) : undefined;
        if (list && list.length) {
          const pool = list.length > 1 ? list.filter((l) => l.id !== this.lastChunk) : list;
          const pick = pool[Math.floor(Math.random() * pool.length)];
          this.lastChunk = pick.id;
          this.enqueue(pick);
        }
      }
    }

    void this.pump();
  }

  /** Faza lotu dla chunków (null = brak komentarza sytuacyjnego). */
  private chunkPhase(s: SimState): string | null {
    const b = s.booster;
    const boosterBusy = b.active && b.phase !== 'COAST';
    switch (s.phase) {
      case 'PRELAUNCH':
        return 'prelaunch';
      case 'ASCENT':
        return 'ascent';
      case 'COAST':
      case 'STAGE2':
        return boosterBusy && Math.random() < 0.5 ? 'booster' : 'stage2';
      case 'ORBIT':
        return boosterBusy && Math.random() < 0.6 ? 'booster' : 'orbit';
      default:
        return null;
    }
  }

  private async pump() {
    if (this.current || this.starting) return;
    const ctx = this.sound.context;
    const bus = this.sound.voiceBus;
    if (!ctx || !bus || ctx.state !== 'running') return;
    const now = performance.now();
    this.queue = this.queue.filter((q) => now - q.at <= MAX_WAIT[q.line.category]);
    const item = this.queue.shift();
    if (!item) return;
    this.starting = true;
    const buf = await this.buffer(item.line);
    this.starting = false;
    if (!buf || !this.enabled) return;
    this.play(ctx, bus, buf, item);
  }

  private radioChain(ctx: AudioContext, bus: GainNode): GainNode {
    if (this.radioIn) return this.radioIn;
    const input = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    // łagodna saturacja (charakter łącza radiowego)
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.8) / Math.tanh(1.8);
    }
    shaper.curve = curve;
    const out = ctx.createGain();
    out.gain.value = 1.1;
    input.connect(hp).connect(lp).connect(shaper).connect(out).connect(bus);
    this.radioIn = input;
    return input;
  }

  /** Sygnał quindar (krótki ton otwierający / zamykający transmisję). */
  private quindar(ctx: AudioContext, bus: GainNode, at: number, freq: number) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.08, at + 0.01);
    g.gain.setValueAtTime(0.08, at + 0.24);
    g.gain.linearRampToValueAtTime(0, at + 0.25);
    osc.connect(g).connect(bus);
    osc.start(at);
    osc.stop(at + 0.26);
  }

  private play(ctx: AudioContext, bus: GainNode, buf: AudioBuffer, item: Queued) {
    const input = this.radioChain(ctx, bus);
    const t0 = ctx.currentTime + 0.05;
    this.quindar(ctx, bus, t0, 2525);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(input);
    src.start(t0 + 0.3);
    this.quindar(ctx, bus, t0 + 0.32 + buf.duration, 2475);
    this.current = { src, item };
    this.played.push(item.line.id);
    this.sound.duck(true);
    src.onended = () => {
      if (this.current?.src === src) {
        this.current = null;
        this.sound.duck(false);
        void this.pump();
      }
    };
  }

  private stopCurrent() {
    if (!this.current) return;
    const { src } = this.current;
    this.current = null;
    try {
      src.stop();
    } catch {
      // już zatrzymane
    }
    this.sound.duck(false);
  }

  private stop() {
    this.queue = [];
    this.stopCurrent();
  }

  /** Nowy lot: czyszczenie kolejki i flag jednorazowych wywołań. */
  reset() {
    this.stop();
    this.fired.clear();
    this.chunkTimer = 8;
  }
}
