import './hud.css';
import type { BoosterPhase, FlightEvent, FlightPhase, SimState } from '../sim/physics';
import { DEFAULT_GUIDANCE, VEHICLE } from '../sim/physics';

export type CameraMode = 'chase' | 'onboard' | 'ground' | 'wide' | 'booster' | 'earth';

export interface HudCallbacks {
  onLaunch(): void;
  onAbort(): void;
  onReset(): void;
  onThrottle(value: number): void;
  onCamera(mode: CameraMode): void;
  onWarp(factor: number): void;
  /** Rezerwa paliwa I stopnia na powrót [ułamek masy paliwa]. */
  onBoosterReserve(fraction: number): void;
  /** Planowany ciąg landing burn [0.4..1]. */
  onLandingThrottle(value: number): void;
  /** Głośność dźwięku 0..1. */
  onVolume(value: number): void;
  onMute(muted: boolean): void;
}

const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Pościg',
  onboard: 'Pokładowa',
  ground: 'Naziemna',
  wide: 'Panorama',
  booster: 'Booster',
  earth: 'Ziemia',
};

const BOOSTER_PHASE_LABELS: Record<BoosterPhase, string> = {
  INACTIVE: '—',
  COAST: 'SEPARACJA',
  FLIP: 'MANEWR OBROTU',
  BALLISTIC: 'LOT BALISTYCZNY',
  ENTRY_BURN: 'ENTRY BURN',
  DESCENT: 'OPADANIE — GRID FINS',
  LANDING_BURN: 'LANDING BURN',
  LANDED: 'WYLĄDOWAŁ',
  DESTROYED: 'UTRACONY',
};

const PHASE_LABELS: Record<FlightPhase, string> = {
  PRELAUNCH: 'GOTOWOŚĆ',
  IGNITION: 'ZAPŁON',
  ASCENT: 'WZNOSZENIE — I STOPIEŃ',
  COAST: 'SEPARACJA STOPNI',
  STAGE2: 'II STOPIEŃ',
  ORBIT: 'ORBITA / SECO',
  ABORT: 'PRZERWANIE LOTU',
  SCRUBBED: 'START WSTRZYMANY',
  IMPACT: 'ZDERZENIE Z ZIEMIĄ',
};

export const EVENT_LABELS: Record<FlightEvent, string> = {
  IGNITION: 'Zapłon silników Merlin',
  LIFTOFF: 'Start! Rakieta opuściła wieżę',
  MAX_Q: 'Max-Q — maksymalne ciśnienie dynamiczne',
  MECO: 'MECO — wyłączenie silników I stopnia',
  STAGE_SEP: 'Separacja stopni',
  SES1: 'SES-1 — zapłon silnika MVac',
  FAIRING_SEP: 'Zrzut owiewki ładunku',
  SECO: 'SECO — wyłączenie silnika II stopnia',
  ORBIT: 'Osiągnięto orbitę!',
  ABORT: 'ABORT — silniki wyłączone',
  SCRUB: 'Start wstrzymany na stole startowym',
  IMPACT: 'Zderzenie z powierzchnią',
  BOOSTER_FLIP: 'I stopień: manewr obrotu silnikami do przodu',
  ENTRY_BURN: 'I stopień: entry burn (3 silniki)',
  ENTRY_BURN_END: 'I stopień: koniec entry burn',
  LANDING_BURN: 'I stopień: landing burn',
  LANDED: 'I stopień wylądował na barce!',
  LANDING_FAIL: 'I stopień utracony',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtClock(t: number): string {
  const sign = t < 0 ? 'T−' : 'T+';
  const a = Math.abs(t);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = Math.floor(a % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtDist(m: number): string {
  if (!Number.isFinite(m)) return '∞';
  if (Math.abs(m) < 10_000) return `${m.toFixed(0)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

interface Readout {
  value: HTMLElement;
  sub?: HTMLElement;
}

export class Hud {
  private root: HTMLElement;
  private clock: HTMLElement;
  private phase: HTMLElement;
  private readouts: Record<string, Readout> = {};
  private fuelBar: HTMLElement;
  private thrustBar: HTMLElement;
  private gBar: HTMLElement;
  private logList: HTMLElement;
  private launchBtn: HTMLButtonElement;
  private abortBtn: HTMLButtonElement;
  private resetBtn: HTMLButtonElement;
  private throttle: HTMLInputElement;
  private throttleLabel: HTMLElement;
  private camButtons = new Map<CameraMode, HTMLButtonElement>();
  private warpSelect: HTMLSelectElement;
  private plot: HTMLCanvasElement;
  private plotCtx: CanvasRenderingContext2D;
  private track: { x: number; y: number }[] = [];
  private lastTrackT = -Infinity;
  private banner: HTMLElement;
  private bannerTimer = 0;
  private boosterPanel: HTMLElement;
  private boosterStatus: HTMLElement;
  private boosterResult: HTMLElement;
  private boosterReadouts: Record<string, HTMLElement> = {};
  private boosterFuelBar: HTMLElement;
  private reserve: HTMLInputElement;
  private reserveLabel: HTMLElement;
  private landingThrottle: HTMLInputElement;
  private landingThrottleLabel: HTMLElement;
  private muteBtn: HTMLButtonElement;
  private volume: HTMLInputElement;
  private muted = false;

  constructor(parent: HTMLElement, private cb: HudCallbacks) {
    this.root = el('div', 'hud');
    parent.appendChild(this.root);

    // --- górny pasek: zegar misji + faza ---
    const top = el('div', 'hud-top panel');
    const brand = el('div', 'brand');
    brand.innerHTML = '<span class="brand-mark">▲</span> FALCON 9 <small>SYMULATOR</small>';
    this.clock = el('div', 'clock', 'T−00:00:03');
    this.phase = el('div', 'phase', PHASE_LABELS.PRELAUNCH);
    top.append(brand, this.clock, this.phase);
    this.root.appendChild(top);

    // --- telemetria ---
    const tel = el('div', 'hud-telemetry panel');
    tel.appendChild(el('h3', undefined, 'Telemetria'));
    const grid = el('div', 'tel-grid');
    const add = (key: string, label: string, unit = '') => {
      const cell = el('div', 'tel-cell');
      cell.appendChild(el('div', 'tel-label', label));
      const value = el('div', 'tel-value', '—');
      cell.appendChild(value);
      const sub = el('div', 'tel-sub', unit);
      cell.appendChild(sub);
      grid.appendChild(cell);
      this.readouts[key] = { value, sub };
    };
    add('alt', 'Wysokość');
    add('speed', 'Prędkość');
    add('mach', 'Mach');
    add('vs', 'Pr. pionowa');
    add('g', 'Przeciążenie');
    add('q', 'Ciśn. dynam.');
    add('dr', 'Odległość');
    add('orbit', 'Apo / Peri');
    tel.appendChild(grid);

    const bars = el('div', 'bars');
    const bar = (label: string, cls: string) => {
      const row = el('div', 'bar-row');
      row.appendChild(el('span', 'bar-label', label));
      const track = el('div', 'bar-track');
      const fill = el('div', `bar-fill ${cls}`);
      track.appendChild(fill);
      row.appendChild(track);
      const val = el('span', 'bar-val', '0%');
      row.appendChild(val);
      bars.appendChild(row);
      return fill;
    };
    this.thrustBar = bar('Ciąg', 'thrust');
    this.fuelBar = bar('Paliwo', 'fuel');
    this.gBar = bar('G', 'gforce');
    tel.appendChild(bars);

    this.plot = el('canvas', 'plot');
    this.plot.width = 280;
    this.plot.height = 120;
    this.plotCtx = this.plot.getContext('2d')!;
    tel.appendChild(this.plot);
    this.root.appendChild(tel);

    // --- dziennik zdarzeń ---
    const log = el('div', 'hud-log panel');
    log.appendChild(el('h3', undefined, 'Zdarzenia'));
    this.logList = el('ul', 'log-list');
    log.appendChild(this.logList);
    this.root.appendChild(log);

    // --- odzysk I stopnia ---
    this.boosterPanel = el('div', 'hud-booster panel');
    const bHead = el('div', 'booster-head');
    bHead.appendChild(el('h3', undefined, 'Odzysk I stopnia'));
    this.boosterStatus = el('span', 'phase booster-status', '—');
    bHead.appendChild(this.boosterStatus);
    this.boosterPanel.appendChild(bHead);
    const bGrid = el('div', 'tel-grid');
    const addB = (key: string, label: string) => {
      const cell = el('div', 'tel-cell');
      cell.appendChild(el('div', 'tel-label', label));
      const value = el('div', 'tel-value small', '—');
      cell.appendChild(value);
      bGrid.appendChild(cell);
      this.boosterReadouts[key] = value;
    };
    addB('alt', 'Wysokość');
    addB('vs', 'Pr. pionowa');
    addB('speed', 'Prędkość');
    addB('ship', 'Do barki');
    addB('q', 'Ciśn. dynam.');
    addB('engines', 'Silniki');
    this.boosterPanel.appendChild(bGrid);
    const fuelRow = el('div', 'bar-row');
    fuelRow.appendChild(el('span', 'bar-label', 'Paliwo'));
    const fuelTrack = el('div', 'bar-track');
    this.boosterFuelBar = el('div', 'bar-fill fuel');
    fuelTrack.appendChild(this.boosterFuelBar);
    fuelRow.appendChild(fuelTrack);
    fuelRow.appendChild(el('span', 'bar-val', '—'));
    const bBars = el('div', 'bars');
    bBars.appendChild(fuelRow);
    this.boosterPanel.appendChild(bBars);
    this.boosterResult = el('div', 'booster-result');
    this.boosterPanel.appendChild(this.boosterResult);
    this.root.appendChild(this.boosterPanel);

    // --- baner zdarzeń ---
    this.banner = el('div', 'banner');
    this.root.appendChild(this.banner);

    // --- panel sterowania ---
    const ctl = el('div', 'hud-controls panel');
    const btnRow = el('div', 'btn-row');
    this.launchBtn = el('button', 'btn launch', 'START');
    this.abortBtn = el('button', 'btn abort', 'ABORT');
    this.resetBtn = el('button', 'btn reset', 'RESET');
    this.launchBtn.title = 'Start (spacja)';
    this.abortBtn.title = 'Przerwij lot (A)';
    this.resetBtn.title = 'Od nowa (R)';
    this.launchBtn.onclick = () => this.cb.onLaunch();
    this.abortBtn.onclick = () => this.cb.onAbort();
    this.resetBtn.onclick = () => this.cb.onReset();
    btnRow.append(this.launchBtn, this.abortBtn, this.resetBtn);
    ctl.appendChild(btnRow);

    const thr = el('div', 'throttle');
    const thrHead = el('div', 'ctl-head');
    thrHead.appendChild(el('span', undefined, 'Przepustnica'));
    this.throttleLabel = el('span', 'ctl-val', '100%');
    thrHead.appendChild(this.throttleLabel);
    thr.appendChild(thrHead);
    this.throttle = el('input');
    this.throttle.type = 'range';
    this.throttle.min = String(VEHICLE.minThrottle * 100);
    this.throttle.max = '100';
    this.throttle.step = '1';
    this.throttle.value = '100';
    this.throttle.oninput = () => {
      const v = Number(this.throttle.value) / 100;
      this.throttleLabel.textContent = `${this.throttle.value}%`;
      this.cb.onThrottle(v);
    };
    thr.appendChild(this.throttle);
    ctl.appendChild(thr);

    // ustawienia odzysku I stopnia
    const rec = el('div', 'recovery');
    const slider = (
      label: string,
      min: number,
      max: number,
      step: number,
      value: number,
      onInput: (v: number) => void,
    ): [HTMLInputElement, HTMLElement] => {
      const box = el('div', 'throttle');
      const head = el('div', 'ctl-head');
      head.appendChild(el('span', undefined, label));
      const val = el('span', 'ctl-val');
      head.appendChild(val);
      box.appendChild(head);
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.oninput = () => onInput(Number(input.value));
      box.appendChild(input);
      rec.appendChild(box);
      return [input, val];
    };
    [this.reserve, this.reserveLabel] = slider(
      'Rezerwa paliwa I st.',
      0,
      15,
      0.5,
      DEFAULT_GUIDANCE.boosterReserve * 100,
      (v) => {
        this.updateReserveLabel(v);
        this.cb.onBoosterReserve(v / 100);
      },
    );
    [this.landingThrottle, this.landingThrottleLabel] = slider(
      'Ciąg lądowania',
      VEHICLE.minThrottle * 100,
      100,
      1,
      DEFAULT_GUIDANCE.landingThrottle * 100,
      (v) => {
        this.landingThrottleLabel.textContent = `${v}%`;
        this.cb.onLandingThrottle(v / 100);
      },
    );
    this.updateReserveLabel(Number(this.reserve.value));
    this.landingThrottleLabel.textContent = `${this.landingThrottle.value}%`;
    rec.title =
      'Więcej rezerwy = bezpieczniejszy powrót, ale mniej paliwa na orbitę. ' +
      'Wyższy ciąg lądowania = późniejszy zapłon i mniejsze zużycie paliwa, ale mniejszy zapas na korekty.';
    ctl.appendChild(rec);

    const camRow = el('div', 'cam-row');
    camRow.appendChild(el('span', 'ctl-head-inline', 'Kamera'));
    const camBtns = el('div', 'seg');
    (Object.keys(CAMERA_LABELS) as CameraMode[]).forEach((m, i) => {
      const b = el('button', 'seg-btn', CAMERA_LABELS[m]);
      b.title = `Kamera: ${CAMERA_LABELS[m]} (${i + 1})`;
      b.onclick = () => {
        this.setCamera(m);
        this.cb.onCamera(m);
      };
      camBtns.appendChild(b);
      this.camButtons.set(m, b);
    });
    camRow.appendChild(camBtns);
    ctl.appendChild(camRow);

    const warpRow = el('div', 'cam-row');
    warpRow.appendChild(el('span', 'ctl-head-inline', 'Czas'));
    this.warpSelect = el('select', 'warp');
    for (const w of [1, 2, 5, 10, 25, 50]) {
      const o = el('option', undefined, `×${w}`);
      o.value = String(w);
      this.warpSelect.appendChild(o);
    }
    this.warpSelect.onchange = () => this.cb.onWarp(Number(this.warpSelect.value));
    warpRow.appendChild(this.warpSelect);
    // dźwięk: wyciszenie + głośność
    this.muteBtn = el('button', 'seg-btn mute', '🔊');
    this.muteBtn.title = 'Wycisz / włącz dźwięk (M)';
    this.muteBtn.onclick = () => this.toggleMute();
    this.volume = el('input', 'volume');
    this.volume.type = 'range';
    this.volume.min = '0';
    this.volume.max = '100';
    this.volume.step = '1';
    this.volume.value = '70';
    this.volume.title = 'Głośność';
    this.volume.oninput = () => {
      this.cb.onVolume(Number(this.volume.value) / 100);
      if (this.muted && Number(this.volume.value) > 0) this.toggleMute();
    };
    warpRow.append(this.muteBtn, this.volume);
    ctl.appendChild(warpRow);

    ctl.appendChild(
      el('div', 'hint', 'Spacja: start · A: abort · R: reset · ↑/↓: ciąg · 1–6: kamera · M: dźwięk · mysz: obrót/zoom'),
    );
    this.root.appendChild(ctl);

    this.setCamera('chase');
    this.bindKeys();
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        if (e.key !== ' ') return;
      }
      const modes = Object.keys(CAMERA_LABELS) as CameraMode[];
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.cb.onLaunch();
          break;
        case 'a':
        case 'A':
          this.cb.onAbort();
          break;
        case 'r':
        case 'R':
          this.cb.onReset();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.nudgeThrottle(5);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.nudgeThrottle(-5);
          break;
        case 'm':
        case 'M':
          this.toggleMute();
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6': {
          const m = modes[Number(e.key) - 1];
          this.setCamera(m);
          this.cb.onCamera(m);
          break;
        }
        default:
          break;
      }
    });
  }

  private nudgeThrottle(d: number) {
    const v = Math.min(100, Math.max(VEHICLE.minThrottle * 100, Number(this.throttle.value) + d));
    this.throttle.value = String(v);
    this.throttle.dispatchEvent(new Event('input'));
  }

  private toggleMute() {
    this.muted = !this.muted;
    this.muteBtn.textContent = this.muted ? '🔇' : '🔊';
    this.muteBtn.classList.toggle('active', this.muted);
    this.cb.onMute(this.muted);
  }

  /** Stan początkowy kontrolek dźwięku (zapamiętany przez silnik dźwięku). */
  setAudioState(volume: number, muted: boolean) {
    this.volume.value = String(Math.round(volume * 100));
    this.muted = muted;
    this.muteBtn.textContent = muted ? '🔇' : '🔊';
    this.muteBtn.classList.toggle('active', muted);
  }

  private updateReserveLabel(pct: number) {
    const tons = (VEHICLE.stage1.propMass * pct) / 100 / 1000;
    this.reserveLabel.textContent = `${pct.toFixed(1)}% · ${tons.toFixed(1)} t`;
  }

  setCamera(mode: CameraMode) {
    for (const [m, b] of this.camButtons) b.classList.toggle('active', m === mode);
  }

  resetUi() {
    this.logList.innerHTML = '';
    this.track = [];
    this.lastTrackT = -Infinity;
    this.throttle.value = '100';
    this.throttleLabel.textContent = '100%';
    this.banner.classList.remove('show');
    this.boosterResult.textContent = '';
    this.boosterResult.className = 'booster-result';
  }

  /** Dopisuje zdarzenie do dziennika i pokazuje baner. `detail` uzupełnia opis (np. przyczynę). */
  event(ev: FlightEvent, t: number, detail?: string) {
    const text = detail ? `${EVENT_LABELS[ev].replace(/!$/, '')} — ${detail}` : EVENT_LABELS[ev];
    const li = el('li');
    li.appendChild(el('span', 'log-t', fmtClock(t)));
    li.appendChild(el('span', 'log-msg', text));
    if (ev === 'ABORT' || ev === 'IMPACT' || ev === 'SCRUB' || ev === 'LANDING_FAIL') li.classList.add('warn');
    if (ev === 'ORBIT' || ev === 'LIFTOFF' || ev === 'LANDED') li.classList.add('good');
    this.logList.prepend(li);
    while (this.logList.children.length > 14) this.logList.lastChild?.remove();

    // drobne zdarzenia boostera tylko w dzienniku, ważne także na banerze
    if (ev !== 'ENTRY_BURN_END' && ev !== 'BOOSTER_FLIP') {
      this.banner.textContent = text;
      this.banner.className =
        'banner show' +
        (li.classList.contains('warn') ? ' warn' : '') +
        (li.classList.contains('good') ? ' good' : '');
      this.bannerTimer = ev === 'LANDED' || ev === 'LANDING_FAIL' ? 6 : 3.5;
    }
    if (ev === 'LANDED' || ev === 'LANDING_FAIL') {
      this.boosterResult.textContent = text;
      this.boosterResult.className = 'booster-result ' + (ev === 'LANDED' ? 'good' : 'warn');
    }
  }

  update(s: SimState, dt: number) {
    const T = s.telemetry;
    this.clock.textContent = fmtClock(s.t);
    this.phase.textContent = PHASE_LABELS[s.phase];
    this.phase.dataset.phase = s.phase;

    const r = this.readouts;
    r.alt.value.textContent = fmtDist(T.altitude);
    r.speed.value.textContent = `${(T.speed * 3.6).toFixed(0)}`;
    r.speed.sub!.textContent = `km/h · ${T.speed.toFixed(0)} m/s`;
    r.mach.value.textContent = T.mach.toFixed(2);
    r.mach.sub!.textContent = T.airDensity > 1e-4 ? (T.mach > 1 ? 'naddźwiękowa' : 'poddźwiękowa') : 'próżnia';
    r.vs.value.textContent = `${T.verticalSpeed.toFixed(0)}`;
    r.vs.sub!.textContent = 'm/s';
    r.g.value.textContent = T.gForce.toFixed(2);
    r.g.sub!.textContent = 'g';
    r.q.value.textContent = (T.dynamicPressure / 1000).toFixed(1);
    r.q.sub!.textContent = s.maxQReached ? 'kPa · po Max-Q' : 'kPa';
    r.dr.value.textContent = fmtDist(T.downrange);
    r.dr.sub!.textContent = 'downrange';
    const showOrbit = T.apoapsis > 1_000 && s.phase !== 'PRELAUNCH';
    r.orbit.value.textContent = showOrbit
      ? `${fmtDist(T.apoapsis)}`
      : '—';
    r.orbit.sub!.textContent = showOrbit
      ? `peri ${T.periapsis > 0 ? fmtDist(T.periapsis) : 'suborbit.'}`
      : 'suborbitalny';

    const setBar = (fill: HTMLElement, frac: number, text: string) => {
      fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      (fill.parentElement!.nextElementSibling as HTMLElement).textContent = text;
    };
    setBar(this.thrustBar, T.thrustFraction, `${(T.thrustFraction * 100).toFixed(0)}%`);
    setBar(this.fuelBar, T.fuelFraction, `${(T.fuelFraction * 100).toFixed(0)}% S${s.stage}`);
    setBar(this.gBar, T.gForce / 6, `${T.gForce.toFixed(1)}g`);
    this.gBar.classList.toggle('high', T.gForce > 4);

    this.updateBooster(s);

    const flying = s.phase !== 'PRELAUNCH' && s.phase !== 'SCRUBBED';
    this.launchBtn.disabled = s.phase !== 'PRELAUNCH';
    this.abortBtn.disabled = !['IGNITION', 'ASCENT', 'COAST', 'STAGE2'].includes(s.phase);
    this.resetBtn.disabled = !flying && s.phase !== 'SCRUBBED';

    // ślad trajektorii
    if (flying && s.t > 0 && s.t - this.lastTrackT > 0.5) {
      this.track.push({ x: T.downrange, y: T.altitude });
      this.lastTrackT = s.t;
      if (this.track.length > 2000) this.track.splice(0, this.track.length - 2000);
    }
    this.drawPlot();

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    }
  }

  private updateBooster(s: SimState) {
    const b = s.booster;
    const shown = b.phase !== 'INACTIVE';
    this.boosterPanel.classList.toggle('show', shown);
    // rezerwa ustalana do MECO, ciąg lądowania do zapłonu landing burn
    this.reserve.disabled = s.stage === 2 || s.phase === 'COAST';
    this.landingThrottle.disabled =
      b.phase === 'LANDING_BURN' || b.phase === 'LANDED' || b.phase === 'DESTROYED';
    if (!shown) return;
    this.boosterStatus.textContent =
      b.phase === 'LANDING_BURN' ? `LANDING BURN · ${b.engines || 0} SIL.` : BOOSTER_PHASE_LABELS[b.phase];
    this.boosterStatus.dataset.phase = b.phase;
    const r = this.boosterReadouts;
    r.alt.textContent = fmtDist(Math.max(0, b.altitude));
    r.vs.textContent = `${b.verticalSpeed.toFixed(0)} m/s`;
    r.speed.textContent = `${b.speed.toFixed(0)} m/s`;
    r.ship.textContent = fmtDist(Math.abs(b.shipDownrange - b.downrange));
    r.q.textContent = `${(b.dynamicPressure / 1000).toFixed(1)} kPa`;
    r.engines.textContent = b.engines > 0 ? `${b.engines} × ${(b.throttle * 100).toFixed(0)}%` : 'wył.';
    const frac = b.prop / VEHICLE.stage1.propMass;
    this.boosterFuelBar.style.width = `${Math.min(1, frac / 0.15) * 100}%`;
    (this.boosterFuelBar.parentElement!.nextElementSibling as HTMLElement).textContent =
      `${(b.prop / 1000).toFixed(1)} t`;
    this.boosterFuelBar.classList.toggle('low', b.prop < 2_000);
  }

  private drawPlot() {
    const g = this.plotCtx;
    const w = this.plot.width;
    const h = this.plot.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.04)';
    g.fillRect(0, 0, w, h);
    const maxX = Math.max(10_000, ...this.track.map((p) => p.x)) * 1.1;
    const maxY = Math.max(10_000, ...this.track.map((p) => p.y)) * 1.15;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    g.font = '9px ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    for (let i = 1; i < 4; i++) {
      const y = h - (i / 4) * (h - 14) - 12;
      g.beginPath();
      g.moveTo(26, y);
      g.lineTo(w, y);
      g.stroke();
      g.fillText(`${((maxY * i) / 4 / 1000).toFixed(0)}`, 2, y + 3);
    }
    g.fillText('km wys. / odległość', w - 96, h - 2);
    if (this.track.length < 2) return;
    g.strokeStyle = '#4fc3ff';
    g.lineWidth = 2;
    g.beginPath();
    this.track.forEach((p, i) => {
      const x = 26 + (p.x / maxX) * (w - 30);
      const y = h - 12 - (p.y / maxY) * (h - 18);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    const last = this.track[this.track.length - 1];
    g.fillStyle = '#ffd36b';
    g.beginPath();
    g.arc(26 + (last.x / maxX) * (w - 30), h - 12 - (last.y / maxY) * (h - 18), 3, 0, Math.PI * 2);
    g.fill();
  }
}
