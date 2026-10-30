/**
 * Model fizyczny lotu Falcon 9.
 *
 * Lot liczony jest w płaszczyźnie 2D (płaszczyzna trajektorii) w układzie
 * związanym ze środkiem Ziemi: oś +Y przechodzi przez stanowisko startowe,
 * oś +X wskazuje kierunek lotu (downrange). Ziemia jest kulą bez rotacji.
 *
 * Uwzględnione zjawiska:
 *  - zmienna masa (spalanie paliwa, zrzut I stopnia i owiewki),
 *  - ciąg zależny od ciśnienia otoczenia (Isp poziom morza / próżnia) i przepustnicy,
 *  - grawitacja malejąca z kwadratem odległości od środka Ziemi,
 *  - opór aerodynamiczny (atmosfera wykładnicza, Cd zależne od liczby Macha),
 *  - trajektoria gravity turn dla I stopnia i prosta pętla naprowadzania II stopnia.
 */

export const G0 = 9.80665;
export const MU_EARTH = 3.986004418e14;
export const R_EARTH = 6_371_000;

const RHO0 = 1.225;
const SCALE_HEIGHT = 8_500;
const DEG = Math.PI / 180;

/** Parametry pojazdu (przybliżone wartości Falcon 9 Block 5). */
export const VEHICLE = {
  stage1: {
    dryMass: 25_600,
    propMass: 395_700,
    engines: 9,
    thrustSL: 845_000, // N na silnik
    thrustVac: 914_000,
    ispSL: 282,
    ispVac: 311,
  },
  stage2: {
    dryMass: 4_000,
    propMass: 92_670,
    engines: 1,
    thrustVac: 981_000,
    ispVac: 348,
  },
  fairingMass: 1_900,
  payloadMass: 12_000,
  /** Pole przekroju z owiewką (średnica 5,2 m) i bez (3,66 m). */
  areaFairing: Math.PI * 2.6 * 2.6,
  areaBody: Math.PI * 1.83 * 1.83,
  minThrottle: 0.4,
} as const;

export type FlightPhase =
  | 'PRELAUNCH'
  | 'IGNITION'
  | 'ASCENT'
  | 'COAST' // MECO -> separacja -> zapłon II stopnia
  | 'STAGE2'
  | 'ORBIT'
  | 'ABORT'
  | 'SCRUBBED'
  | 'IMPACT';

export type FlightEvent =
  | 'IGNITION'
  | 'LIFTOFF'
  | 'MAX_Q'
  | 'MECO'
  | 'STAGE_SEP'
  | 'SES1'
  | 'FAIRING_SEP'
  | 'SECO'
  | 'ORBIT'
  | 'ABORT'
  | 'SCRUB'
  | 'IMPACT'
  | 'BOOSTER_FLIP'
  | 'ENTRY_BURN'
  | 'ENTRY_BURN_END'
  | 'LANDING_BURN'
  | 'LANDED'
  | 'LANDING_FAIL';

export interface Vec2 {
  x: number;
  y: number;
}

export type BoosterPhase =
  | 'INACTIVE'
  | 'COAST' // chwilę po separacji
  | 'FLIP' // manewr obrotu silnikami do przodu (retrograde)
  | 'BALLISTIC' // lot balistyczny poza atmosferą
  | 'ENTRY_BURN' // hamowanie przed wejściem w gęste warstwy atmosfery (3 silniki)
  | 'DESCENT' // opadanie w atmosferze, sterowanie grid fins
  | 'LANDING_BURN' // hamowanie do lądowania (1 silnik)
  | 'LANDED'
  | 'DESTROYED';

/** Odzyskiwany I stopień: lot powrotny i lądowanie na barce na oceanie. */
export interface BoosterState {
  /** Czy I stopień jest jeszcze symulowany (w locie). */
  active: boolean;
  phase: BoosterPhase;
  pos: Vec2;
  vel: Vec2;
  /** Kąt osi rakiety względem lokalnego horyzontu [rad]. */
  pitch: number;
  timeSinceSep: number;
  /** Paliwo pozostałe w I stopniu [kg]. */
  prop: number;
  /** Liczba pracujących silników (0, 1 lub 3). */
  engines: number;
  throttle: number;
  throttleCmd: number;
  /** Silnik wyłączony w trakcie lądowania (zawis — minimalny ciąg > ciężar). */
  cutoff: boolean;
  gridFinsDeployed: boolean;
  legsDeployed: boolean;
  /** Pozycja barki (odległość od stanowiska po powierzchni Ziemi) [m]. */
  shipDownrange: number;
  /** Paliwo zużyte na entry burn i landing burn [kg]. */
  entryBurnProp: number;
  landingBurnProp: number;
  maxQ: number;
  touchdownVertical: number;
  touchdownHorizontal: number;
  touchdownMiss: number;
  /** Opis przyczyny utraty I stopnia (pusty przy sukcesie). */
  failure: string;
  /** Licznik czasu do kolejnego przeliczenia predykcji naprowadzania [s]. */
  guidanceTimer: number;
  /** Ostatni wynik predykcji: czy przy planowanym ciągu stopień nie zdąży wyhamować. */
  guidanceLate: boolean;
  /** Ostatni wynik: czy 1 silnik wystarczy do dokończenia hamowania. */
  guidanceOneEngineOk: boolean;
  // telemetria
  altitude: number;
  verticalSpeed: number;
  horizontalSpeed: number;
  speed: number;
  dynamicPressure: number;
  downrange: number;
  thrust: number;
}

export interface Telemetry {
  altitude: number;
  speed: number;
  verticalSpeed: number;
  horizontalSpeed: number;
  mach: number;
  dynamicPressure: number;
  gForce: number;
  thrust: number;
  /** Rzeczywisty ciąg względem maksymalnego [0..1]. */
  thrustFraction: number;
  /** Paliwo bieżącego stopnia [0..1]. */
  fuelFraction: number;
  mass: number;
  downrange: number;
  flightPathAngle: number;
  apoapsis: number;
  periapsis: number;
  airDensity: number;
}

export interface SimState {
  /** Czas misji względem startu (T-0) [s]; ujemny w trakcie odliczania. */
  t: number;
  phase: FlightPhase;
  stage: 1 | 2;
  pos: Vec2;
  vel: Vec2;
  /** Kąt osi rakiety względem lokalnego horyzontu [rad]; PI/2 = pionowo. */
  pitch: number;
  prop1: number;
  prop2: number;
  fairingAttached: boolean;
  throttleCmd: number;
  /** Rzeczywista przepustnica (z narastaniem ciągu przy zapłonie). */
  throttle: number;
  enginesOn: boolean;
  maxQReached: boolean;
  booster: BoosterState;
  telemetry: Telemetry;
}

type Listener = (ev: FlightEvent, t: number) => void;

// ---------------------------------------------------------------------------
// Atmosfera
// ---------------------------------------------------------------------------

export function airDensity(h: number): number {
  if (h > 150_000) return 0;
  return RHO0 * Math.exp(-Math.max(h, 0) / SCALE_HEIGHT);
}

/** Stosunek ciśnienia otoczenia do ciśnienia na poziomie morza. */
export function pressureRatio(h: number): number {
  if (h > 150_000) return 0;
  return Math.exp(-Math.max(h, 0) / 8_400);
}

/** Prędkość dźwięku wg uproszczonej atmosfery wzorcowej. */
export function speedOfSound(h: number): number {
  let T: number;
  if (h < 11_000) T = 288.15 - 0.0065 * h;
  else if (h < 20_000) T = 216.65;
  else if (h < 47_000) T = 216.65 + 0.0012 * (h - 20_000);
  else if (h < 51_000) T = 270.65;
  else if (h < 86_000) T = Math.max(186.9, 270.65 - 0.0024 * (h - 51_000));
  else T = 186.9;
  return Math.sqrt(1.4 * 287.05 * T);
}

/** Współczynnik oporu w funkcji liczby Macha (szczyt w zakresie transonicznym). */
export function dragCoefficient(mach: number): number {
  if (mach < 0.8) return 0.3;
  if (mach < 1.1) return 0.3 + ((mach - 0.8) / 0.3) * 0.45;
  if (mach < 2.0) return 0.75 - ((mach - 1.1) / 0.9) * 0.3;
  if (mach < 5.0) return 0.45 - ((mach - 2.0) / 3.0) * 0.2;
  return 0.25;
}

export function gravityAt(r: number): number {
  return MU_EARTH / (r * r);
}

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Lokalne wersory: "w górę" (radialny) i "na wschód" (styczny, kierunek lotu). */
export function localFrame(pos: Vec2): { up: Vec2; east: Vec2; r: number } {
  const r = Math.hypot(pos.x, pos.y);
  const up = { x: pos.x / r, y: pos.y / r };
  const east = { x: up.y, y: -up.x };
  return { up, east, r };
}

/** Kierunek osi rakiety (wersor) dla zadanego pochylenia względem horyzontu. */
export function attitudeVector(pos: Vec2, pitch: number): Vec2 {
  const { up, east } = localFrame(pos);
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  return { x: east.x * c + up.x * s, y: east.y * c + up.y * s };
}

function orbitApsides(pos: Vec2, vel: Vec2): { apo: number; peri: number } {
  const r = Math.hypot(pos.x, pos.y);
  const v2 = vel.x * vel.x + vel.y * vel.y;
  const energy = v2 / 2 - MU_EARTH / r;
  const h = pos.x * vel.y - pos.y * vel.x;
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (MU_EARTH * MU_EARTH)));
  if (energy >= 0) return { apo: Infinity, peri: (h * h) / MU_EARTH / (1 + e) - R_EARTH };
  const a = -MU_EARTH / (2 * energy);
  return { apo: a * (1 + e) - R_EARTH, peri: a * (1 - e) - R_EARTH };
}

// ---------------------------------------------------------------------------
// Symulacja
// ---------------------------------------------------------------------------

export interface GuidanceConfig {
  /** Prędkość rozpoczęcia manewru pitch-over [m/s]. */
  pitchKickSpeed: number;
  /** Wielkość odchylenia od pionu podczas manewru [deg]. */
  pitchKickAngle: number;
  /** Docelowa wysokość orbity [m]. */
  targetAltitude: number;
  /** Rezerwa paliwa I stopnia (na lądowanie) [ułamek]. */
  boosterReserve: number;
  /** Planowany ciąg silnika podczas landing burn [0.4..1] — decyduje o momencie zapłonu. */
  landingThrottle: number;
}

export const DEFAULT_GUIDANCE: GuidanceConfig = {
  pitchKickSpeed: 55,
  pitchKickAngle: 6.5,
  targetAltitude: 200_000,
  boosterReserve: 0.08,
  landingThrottle: 0.75,
};

export class FlightSim {
  state: SimState;
  readonly guidance: GuidanceConfig;
  private listeners: Listener[] = [];
  private phaseTimer = 0;
  private lastQ = 0;
  private kickProgress = 0;

  constructor(guidance: Partial<GuidanceConfig> = {}) {
    this.guidance = { ...DEFAULT_GUIDANCE, ...guidance };
    this.state = FlightSim.initialState();
  }

  static initialState(): SimState {
    const pos = { x: 0, y: R_EARTH };
    const s: SimState = {
      t: -3,
      phase: 'PRELAUNCH',
      stage: 1,
      pos,
      vel: { x: 0, y: 0 },
      pitch: Math.PI / 2,
      prop1: VEHICLE.stage1.propMass,
      prop2: VEHICLE.stage2.propMass,
      fairingAttached: true,
      throttleCmd: 1,
      throttle: 0,
      enginesOn: false,
      maxQReached: false,
      booster: createBoosterState(pos),
      telemetry: {
        altitude: 0,
        speed: 0,
        verticalSpeed: 0,
        horizontalSpeed: 0,
        mach: 0,
        dynamicPressure: 0,
        gForce: 1,
        thrust: 0,
        thrustFraction: 0,
        fuelFraction: 1,
        mass: 0,
        downrange: 0,
        flightPathAngle: Math.PI / 2,
        apoapsis: 0,
        periapsis: -R_EARTH,
        airDensity: RHO0,
      },
    };
    s.telemetry.mass = FlightSim.massOf(s);
    return s;
  }

  static massOf(s: SimState): number {
    let m = VEHICLE.stage2.dryMass + s.prop2 + VEHICLE.payloadMass;
    if (s.fairingAttached) m += VEHICLE.fairingMass;
    if (s.stage === 1) m += VEHICLE.stage1.dryMass + s.prop1;
    return m;
  }

  on(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(ev: FlightEvent) {
    for (const l of this.listeners) l(ev, this.state.t);
  }

  // --- sterowanie --------------------------------------------------------

  launch(): boolean {
    if (this.state.phase !== 'PRELAUNCH') return false;
    this.state.phase = 'IGNITION';
    this.state.t = -3;
    this.state.enginesOn = true;
    this.phaseTimer = 0;
    this.emit('IGNITION');
    return true;
  }

  abort(): boolean {
    const s = this.state;
    if (s.phase === 'IGNITION') {
      s.enginesOn = false;
      s.phase = 'SCRUBBED';
      this.emit('SCRUB');
      return true;
    }
    if (s.phase === 'ASCENT' || s.phase === 'STAGE2' || s.phase === 'COAST') {
      s.enginesOn = false;
      s.phase = 'ABORT';
      this.emit('ABORT');
      return true;
    }
    return false;
  }

  reset() {
    this.state = FlightSim.initialState();
    this.phaseTimer = 0;
    this.lastQ = 0;
    this.kickProgress = 0;
  }

  setThrottle(x: number) {
    this.state.throttleCmd = clamp(x, VEHICLE.minThrottle, 1);
  }

  /** Rezerwa paliwa na powrót I stopnia; działa do momentu MECO. */
  setBoosterReserve(f: number) {
    if (this.state.stage === 1 && this.state.phase !== 'COAST') {
      this.guidance.boosterReserve = clamp(f, 0, 0.2);
    }
  }

  /** Planowany ciąg landing burn; działa do zapłonu silnika do lądowania. */
  setLandingThrottle(x: number) {
    const b = this.state.booster;
    if (b.phase === 'LANDING_BURN' || b.phase === 'LANDED' || b.phase === 'DESTROYED') return;
    this.guidance.landingThrottle = clamp(x, VEHICLE.minThrottle, 1);
  }

  // --- krok całkowania ---------------------------------------------------

  /** Przesuwa symulację o `dt` sekund (wewnętrznie dzieli na małe kroki). */
  step(dt: number) {
    const h = 1 / 120;
    let remaining = dt;
    while (remaining > 1e-9) {
      const d = Math.min(h, remaining);
      this.integrate(d);
      remaining -= d;
    }
  }

  private integrate(dt: number) {
    const s = this.state;
    if (s.phase === 'PRELAUNCH' || s.phase === 'SCRUBBED') {
      this.updateTelemetry(0, 0);
      return;
    }

    s.t += dt;
    this.phaseTimer += dt;

    // Narastanie / zanik ciągu (spool-up ok. 1,5 s)
    const target = s.enginesOn ? s.throttleCmd : 0;
    const rate = s.enginesOn ? 0.8 : 4;
    s.throttle += clamp(target - s.throttle, -rate * dt, rate * dt);
    if (s.throttle < 1e-3 && !s.enginesOn) s.throttle = 0;

    this.updateSequence();

    const { up, east, r } = localFrame(s.pos);
    const alt = r - R_EARTH;

    // --- siły ------------------------------------------------------------
    const thrust = this.computeThrust(alt, dt);
    const mass = FlightSim.massOf(s);

    this.updateAttitude(dt, alt);
    const dir = attitudeVector(s.pos, s.pitch);

    const rho = airDensity(alt);
    const speed = Math.hypot(s.vel.x, s.vel.y);
    const mach = speed / speedOfSound(alt);
    const area = s.fairingAttached ? VEHICLE.areaFairing : VEHICLE.areaBody;
    const dragMag = 0.5 * rho * speed * speed * dragCoefficient(mach) * area;

    let ax = (thrust * dir.x) / mass;
    let ay = (thrust * dir.y) / mass;
    if (speed > 1e-6) {
      ax -= (dragMag * s.vel.x) / speed / mass;
      ay -= (dragMag * s.vel.y) / speed / mass;
    }
    const properAccel = Math.hypot(ax, ay);

    const g = gravityAt(r);
    ax -= g * up.x;
    ay -= g * up.y;

    // Przytrzymanie na stole startowym do momentu, gdy ciąg > ciężar
    const onPad = s.phase === 'IGNITION';
    if (onPad) {
      ax = 0;
      ay = 0;
    }

    // Półniejawny Euler
    s.vel.x += ax * dt;
    s.vel.y += ay * dt;
    s.pos.x += s.vel.x * dt;
    s.pos.y += s.vel.y * dt;

    // Kontakt z ziemią
    const newR = Math.hypot(s.pos.x, s.pos.y);
    if (newR < R_EARTH) {
      const vr = s.vel.x * up.x + s.vel.y * up.y;
      const impactSpeed = Math.hypot(s.vel.x, s.vel.y);
      const k = R_EARTH / newR;
      s.pos.x *= k;
      s.pos.y *= k;
      if (s.phase !== 'IMPACT' && (vr < -3 || impactSpeed > 5) && s.t > 1) {
        s.phase = 'IMPACT';
        s.enginesOn = false;
        s.throttle = 0;
        this.emit('IMPACT');
      }
      s.vel.x = 0;
      s.vel.y = 0;
    }

    this.updateBooster(dt);

    const gForce = onPad ? 1 : properAccel / G0;
    this.updateTelemetry(thrust, gForce, east);
  }

  /** Ciąg bieżącego stopnia oraz spalanie paliwa. */
  private computeThrust(alt: number, dt: number): number {
    const s = this.state;
    if (s.throttle <= 0) return 0;
    if (s.stage === 1) {
      const st = VEHICLE.stage1;
      const p = pressureRatio(alt);
      const perEngine = st.thrustVac - (st.thrustVac - st.thrustSL) * p;
      const mdot = (s.throttle * st.engines * st.thrustVac) / (st.ispVac * G0);
      const burn = Math.min(s.prop1, mdot * dt);
      s.prop1 -= burn;
      if (s.prop1 <= 0) return 0;
      return s.throttle * st.engines * perEngine;
    }
    const st = VEHICLE.stage2;
    const mdot = (s.throttle * st.thrustVac) / (st.ispVac * G0);
    const burn = Math.min(s.prop2, mdot * dt);
    s.prop2 -= burn;
    if (s.prop2 <= 0) return 0;
    // Niewielka strata ciągu MVac w gęstej atmosferze
    return s.throttle * st.thrustVac * (1 - 0.3 * pressureRatio(alt));
  }

  /** Sekwencja misji: start, MECO, separacja, SES, owiewka, SECO. */
  private updateSequence() {
    const s = this.state;
    const alt = Math.hypot(s.pos.x, s.pos.y) - R_EARTH;

    switch (s.phase) {
      case 'IGNITION': {
        const st = VEHICLE.stage1;
        const thrust = s.throttle * st.engines * st.thrustSL;
        const weight = FlightSim.massOf(s) * G0;
        if (s.t >= 0 && thrust > weight * 1.02) {
          s.phase = 'ASCENT';
          this.phaseTimer = 0;
          this.emit('LIFTOFF');
        }
        break;
      }
      case 'ASCENT': {
        const reserve = VEHICLE.stage1.propMass * this.guidance.boosterReserve;
        if (s.prop1 <= reserve) {
          s.enginesOn = false;
          s.phase = 'COAST';
          this.phaseTimer = 0;
          this.emit('MECO');
        }
        break;
      }
      case 'COAST': {
        if (s.stage === 1 && this.phaseTimer > 3) {
          this.separateStage();
        }
        if (s.stage === 2 && this.phaseTimer > 10) {
          s.enginesOn = true;
          s.phase = 'STAGE2';
          this.phaseTimer = 0;
          this.emit('SES1');
        }
        break;
      }
      case 'STAGE2': {
        if (s.fairingAttached && alt > 110_000) {
          s.fairingAttached = false;
          this.emit('FAIRING_SEP');
        }
        const { peri } = orbitApsides(s.pos, s.vel);
        const target = this.guidance.targetAltitude;
        const { east, r } = localFrame(s.pos);
        const vt = s.vel.x * east.x + s.vel.y * east.y;
        const circular = vt >= Math.sqrt(MU_EARTH / r) && peri > 120_000;
        if (peri > Math.min(target - 25_000, alt - 15_000) || circular || s.prop2 <= 0) {
          s.enginesOn = false;
          s.phase = 'ORBIT';
          this.emit('SECO');
          if (peri > 120_000) this.emit('ORBIT');
        }
        break;
      }
      case 'ABORT':
        if (s.fairingAttached && alt > 110_000) s.fairingAttached = false;
        break;
      default:
        break;
    }
  }

  private separateStage() {
    const s = this.state;
    const b = createBoosterState(s.pos);
    b.active = true;
    b.phase = 'COAST';
    b.vel = { ...s.vel };
    b.pitch = s.pitch;
    b.prop = s.prop1;
    s.booster = b;
    s.stage = 2;
    s.throttle = 0;
    // Popychacze pneumatyczne: niewielki przyrost prędkości II stopnia
    const dir = attitudeVector(s.pos, s.pitch);
    s.vel.x += dir.x * 1.5;
    s.vel.y += dir.y * 1.5;
    b.vel.x -= dir.x * 0.5;
    b.vel.y -= dir.y * 0.5;
    // Barka czeka w punkcie przewidywanego lądowania (obliczonym dla bieżących ustawień)
    b.shipDownrange = predictBoosterLanding(b, this.guidance.landingThrottle);
    this.phaseTimer = 0;
    this.emit('STAGE_SEP');
  }

  /** Naprowadzanie: pion, pitch-over, gravity turn (I st.), pętla wysokości (II st.). */
  private updateAttitude(dt: number, alt: number) {
    const s = this.state;
    const { up, east, r } = localFrame(s.pos);
    const vr = s.vel.x * up.x + s.vel.y * up.y;
    const vt = s.vel.x * east.x + s.vel.y * east.y;
    const speed = Math.hypot(vr, vt);
    const fpa = speed > 1 ? Math.atan2(vr, vt) : Math.PI / 2;

    let cmd = s.pitch;
    let maxRate = 1.5 * DEG;

    if (s.phase === 'IGNITION') {
      cmd = Math.PI / 2;
    } else if (s.phase === 'ASCENT') {
      const kickStart = this.guidance.pitchKickSpeed;
      const kickAngle = this.guidance.pitchKickAngle * DEG;
      if (speed < kickStart) {
        cmd = Math.PI / 2;
      } else if (this.kickProgress < 1) {
        // Manewr pitch-over trwa ok. 8 s
        this.kickProgress = Math.min(1, this.kickProgress + dt / 8);
        cmd = Math.PI / 2 - kickAngle * this.kickProgress;
      } else {
        // Gravity turn: oś rakiety podąża za wektorem prędkości (zerowy kąt natarcia)
        cmd = Math.min(fpa, Math.PI / 2 - kickAngle);
        maxRate = 2 * DEG;
      }
    } else if (s.phase === 'STAGE2') {
      // Pętla wysokości: zadana prędkość pionowa -> wymagane przyspieszenie pionowe
      const thrustAcc = (s.throttle * VEHICLE.stage2.thrustVac) / FlightSim.massOf(s);
      const target = this.guidance.targetAltitude;
      const vrCmd = clamp((target - alt) / 80, -150, 250);
      const arCmd = (vrCmd - vr) / 15;
      const g = gravityAt(r);
      const centripetal = (vt * vt) / r;
      const sinP = thrustAcc > 0.1 ? clamp((arCmd + g - centripetal) / thrustAcc, -0.35, 0.85) : 0;
      cmd = Math.asin(sinP);
      maxRate = 3 * DEG;
    } else {
      // Bez ciągu: rakieta stabilizuje się wzdłuż wektora prędkości w atmosferze
      if (alt < 80_000 && speed > 50) {
        cmd = fpa;
        maxRate = 4 * DEG;
      } else {
        maxRate = 0;
      }
    }

    const diff = wrapAngle(cmd - s.pitch);
    s.pitch += clamp(diff, -maxRate * dt, maxRate * dt);
  }

  private updateBooster(dt: number) {
    const b = this.state.booster;
    if (!b.active) return;
    const events = stepBooster(b, dt, this.guidance.landingThrottle, true);
    for (const e of events) this.emit(e);
  }

  private updateTelemetry(thrust: number, gForce: number, eastIn?: Vec2) {
    const s = this.state;
    const tel = s.telemetry;
    const { up, east: e, r } = localFrame(s.pos);
    const east = eastIn ?? e;
    const alt = r - R_EARTH;
    const vr = s.vel.x * up.x + s.vel.y * up.y;
    const vt = s.vel.x * east.x + s.vel.y * east.y;
    const speed = Math.hypot(s.vel.x, s.vel.y);
    const rho = airDensity(alt);
    const q = 0.5 * rho * speed * speed;

    let maxThrust: number;
    if (s.stage === 1) {
      const st = VEHICLE.stage1;
      const p = pressureRatio(alt);
      maxThrust = st.engines * (st.thrustVac - (st.thrustVac - st.thrustSL) * p);
    } else {
      maxThrust = VEHICLE.stage2.thrustVac;
    }

    tel.altitude = alt;
    tel.speed = speed;
    tel.verticalSpeed = vr;
    tel.horizontalSpeed = vt;
    tel.mach = speed / speedOfSound(alt);
    tel.dynamicPressure = q;
    tel.gForce = s.phase === 'PRELAUNCH' || s.phase === 'SCRUBBED' ? 1 : gForce;
    tel.thrust = thrust;
    tel.thrustFraction = maxThrust > 0 ? thrust / maxThrust : 0;
    tel.fuelFraction =
      s.stage === 1 ? s.prop1 / VEHICLE.stage1.propMass : s.prop2 / VEHICLE.stage2.propMass;
    tel.mass = FlightSim.massOf(s);
    tel.downrange = Math.atan2(s.pos.x, s.pos.y) * R_EARTH;
    tel.flightPathAngle = speed > 1 ? Math.atan2(vr, vt) : Math.PI / 2;
    const ap = orbitApsides(s.pos, s.vel);
    tel.apoapsis = ap.apo;
    tel.periapsis = ap.peri;
    tel.airDensity = rho;

    // Detekcja Max-Q
    if (!s.maxQReached && s.phase === 'ASCENT') {
      if (q < this.lastQ && this.lastQ > 10_000) {
        s.maxQReached = true;
        this.emit('MAX_Q');
      }
      this.lastQ = q;
    }
  }
}

// ---------------------------------------------------------------------------
// Odzysk I stopnia: obrót, entry burn, landing burn, lądowanie na barce
// ---------------------------------------------------------------------------

export const RECOVERY = {
  /** Prędkość kątowa manewru obrotu [rad/s]. */
  flipRate: 10 * DEG,
  /** Wysokość rozpoczęcia entry burn (podczas opadania) [m]. */
  entryStartAltitude: 70_000,
  /** Entry burn kończy się po wyhamowaniu do tej prędkości [m/s]. */
  entryEndSpeed: 900,
  /** Entry burn nie hamuje poniżej tej prędkości [m/s]. */
  entryMinSpeed: 450,
  /** Paliwo zostawiane na landing burn (nadwyżkę zużywa entry burn) [kg]. */
  landingBudget: 6_000,
  /** Masa odniesienia dla prędkości końcowej entry burn [kg]. */
  entryRefMass: 34_000,
  /** Graniczne ciśnienie dynamiczne — powyżej I stopień rozpada się [Pa]. */
  qLimit: 100_000,
  /** Prześwit nóg pod dyszami (dyszami nad pokładem przy przyziemieniu) [m]. */
  legClearance: 2.4,
  /** Połowa długości pokładu barki (tolerancja chybienia) [m]. */
  deckHalfSize: 40,
  /** Maksymalna bezpieczna prędkość pionowa / pozioma przy przyziemieniu [m/s]. */
  maxTouchdownVertical: 4,
  maxTouchdownHorizontal: 3,
  /** Szybkość narastania ciągu przy zapłonie [1/s]. */
  spoolRate: 1.6,
  /** Okres przeliczania predykcji naprowadzania [s]. */
  guidancePeriod: 0.05,
  /** Poniżej tej wysokości działa regulator przyziemienia [m]. */
  terminalAltitude: 150,
  /** Docelowa wysokość zatrzymania przy planowaniu zapłonu landing burn [m]. */
  ignitionMargin: 12,
  /** Mnożnik oporu I stopnia lecącego silnikami do przodu z rozłożonymi grid fins. */
  dragFactor: 3.2,
  /** Landing burn nie startuje powyżej tej wysokości [m]. */
  landingBurnMaxAltitude: 6_000,
  /** Maksymalne pochylenie od pionu przy korekcie toru podczas lądowania [rad]. */
  maxTilt: 14 * DEG,
};

export function createBoosterState(pos: Vec2): BoosterState {
  return {
    active: false,
    phase: 'INACTIVE',
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    pitch: Math.PI / 2,
    timeSinceSep: 0,
    prop: 0,
    engines: 0,
    throttle: 0,
    throttleCmd: 0,
    cutoff: false,
    gridFinsDeployed: false,
    legsDeployed: false,
    shipDownrange: 0,
    entryBurnProp: 0,
    landingBurnProp: 0,
    maxQ: 0,
    touchdownVertical: 0,
    touchdownHorizontal: 0,
    touchdownMiss: 0,
    failure: '',
    guidanceTimer: 0,
    guidanceLate: false,
    guidanceOneEngineOk: false,
    altitude: 0,
    verticalSpeed: 0,
    horizontalSpeed: 0,
    speed: 0,
    dynamicPressure: 0,
    downrange: 0,
    thrust: 0,
  };
}

function engineThrust1(alt: number): number {
  const st = VEHICLE.stage1;
  return st.thrustVac - (st.thrustVac - st.thrustSL) * pressureRatio(alt);
}

/**
 * Jeden krok lotu powrotnego I stopnia. Funkcja czysta względem `b` — używana zarówno
 * w symulacji, jak i do przewidzenia punktu lądowania (ustawienie barki).
 *
 * @param landingThrottle planowany ciąg landing burn: wyższy = późniejszy zapłon i mniej paliwa
 *   (mniejsze straty grawitacyjne), ale mniejszy zapas na korekty; niższy = wcześniejszy zapłon,
 *   dłuższe hamowanie i większe zużycie paliwa.
 * @param lateral czy korygować tor w stronę barki (wyłączone przy predykcji).
 */
export function stepBooster(
  b: BoosterState,
  dt: number,
  landingThrottle: number,
  lateral: boolean,
): FlightEvent[] {
  const events: FlightEvent[] = [];
  if (!b.active) return events;
  b.timeSinceSep += dt;
  // Predykcje (symulacja w przód) przeliczane 20 razy na sekundę czasu lotu
  b.guidanceTimer -= dt;
  const replan = b.guidanceTimer <= 0;
  if (replan) b.guidanceTimer = RECOVERY.guidancePeriod;

  const st = VEHICLE.stage1;
  const { up, east, r } = localFrame(b.pos);
  const altCenter = r - R_EARTH;
  const alt = altCenter - RECOVERY.legClearance;
  const vr = b.vel.x * up.x + b.vel.y * up.y;
  const vh = b.vel.x * east.x + b.vel.y * east.y;
  const speed = Math.hypot(vr, vh);
  const mass = st.dryMass + b.prop;
  const g = gravityAt(r);
  const T1 = engineThrust1(altCenter);
  const downrange = Math.atan2(b.pos.x, b.pos.y) * R_EARTH;
  // oś przeciwna do prędkości: silniki skierowane w kierunku lotu
  const retro = speed > 1 ? Math.atan2(-vr, -vh) : Math.PI / 2;
  const rho = airDensity(altCenter);
  const mach = speed / speedOfSound(altCenter);
  // I stopień leci silnikami do przodu z rozłożonymi grid fins -> większy opór
  const dragMag = 0.5 * rho * speed * speed * dragCoefficient(mach) * VEHICLE.areaBody * RECOVERY.dragFactor;
  const dragAcc = dragMag / mass;

  let cmd = b.pitch;
  let rate = 5 * DEG;
  let aReq = 0;

  switch (b.phase) {
    case 'COAST':
      if (b.timeSinceSep > 2.5) {
        b.phase = 'FLIP';
        events.push('BOOSTER_FLIP');
      }
      break;
    case 'FLIP':
      cmd = retro;
      rate = RECOVERY.flipRate;
      if (Math.abs(wrapAngle(retro - b.pitch)) < 2 * DEG) b.phase = 'BALLISTIC';
      break;
    case 'BALLISTIC':
      cmd = retro;
      if (b.timeSinceSep > 8) b.gridFinsDeployed = true;
      if (vr < 0 && altCenter < RECOVERY.entryStartAltitude) {
        if (b.prop > 0 && speed > RECOVERY.entryEndSpeed) {
          b.phase = 'ENTRY_BURN';
          b.engines = 3;
          b.throttleCmd = 1;
          events.push('ENTRY_BURN');
        } else {
          b.phase = 'DESCENT';
        }
      }
      break;
    case 'ENTRY_BURN': {
      cmd = retro;
      // Cięższy stopień słabiej hamuje w atmosferze (współczynnik balistyczny ~ m),
      // więc entry burn trwa dłużej: prędkość końcowa skaluje się jak sqrt(m_ref / m).
      const endSpeed = RECOVERY.entryEndSpeed * Math.sqrt(RECOVERY.entryRefMass / mass);
      // Nadwyżkę paliwa ponad budżet lądowania zużywamy na dodatkowe hamowanie (łagodniejsze wejście)
      const reachedNominal = speed <= endSpeed;
      const keepLandingBudget = b.prop <= RECOVERY.landingBudget;
      const reachedMinimum = speed <= RECOVERY.entryMinSpeed;
      if ((reachedNominal && (keepLandingBudget || reachedMinimum)) || b.prop <= 0) {
        b.engines = 0;
        b.phase = 'DESCENT';
        events.push('ENTRY_BURN_END');
      }
      break;
    }
    case 'DESCENT': {
      cmd = retro;
      // Zapłon "hoverslam": komputer przelicza w przód hamowanie przy planowanym ciągu
      // i odpala silnik, gdy przewidywany punkt zatrzymania schodzi do poziomu pokładu.
      let ignite = false;
      let engines = 1;
      if (altCenter < RECOVERY.landingBurnMaxAltitude && b.prop > 0 && replan) {
        // Ciężki stopień (duża rezerwa) nie wyhamuje na jednym silniku -> 3 silniki
        if (predictStopAltitude(b, 1, 1) < 50) engines = 3;
        // margines obejmuje drogę przebytą między kolejnymi przeliczeniami
        const m = RECOVERY.ignitionMargin + speed * RECOVERY.guidancePeriod;
        const planned = predictStopAltitude(b, engines, landingThrottle);
        // Gdy plan jest niewykonalny (za mało paliwa lub ciągu), zapłon w ostatniej chwili na pełnym ciągu
        ignite = (planned <= m && planned > -m) || predictStopAltitude(b, engines, 1) <= m;
      }
      if (ignite) {
        b.phase = 'LANDING_BURN';
        b.engines = engines;
        b.throttleCmd = landingThrottle;
        events.push('LANDING_BURN');
      }
      break;
    }
    case 'LANDING_BURN': {
      b.legsDeployed = b.legsDeployed || alt < 1_500;
      if (b.engines > 0) {
        if (vr >= 0 && alt > 0.3) {
          // Minimalny ciąg przewyższa ciężar — silnik musi zostać wyłączony nad pokładem
          b.engines = 0;
          b.cutoff = true;
        } else if (alt > RECOVERY.terminalAltitude) {
          // Faza główna: zaplanowany ciąg; pełny ciąg, jeśli predykcja pokazuje, że nie zdąży wyhamować
          aReq = (vr * vr) / (2 * Math.max(alt, 0.3)) + g;
          // 3 -> 1 silnik, gdy jeden silnik na pełnym ciągu wystarczy do dokończenia hamowania
          if (replan) {
            b.guidanceOneEngineOk =
              b.engines === 3 && predictStopAltitude(b, 1, 0.95, Math.min(1, b.throttle * 3)) > 0;
            b.guidanceLate = predictStopAltitude(b, b.engines, landingThrottle, b.throttle) < 0;
          }
          if (b.engines === 3 && b.guidanceOneEngineOk) {
            b.engines = 1;
            b.throttle = Math.min(1, b.throttle * 3);
            b.guidanceOneEngineOk = false;
          }
          b.throttleCmd = b.guidanceLate ? 1 : landingThrottle;
        } else {
          // Faza końcowa: regulator przyziemienia (stałe opóźnienie do pokładu)
          aReq = (vr * vr) / (2 * Math.max(alt, 0.3)) + g;
          const force = (aReq - dragAcc) * mass;
          b.throttleCmd = clamp(force / (b.engines * T1), VEHICLE.minThrottle, 1);
        }
      }
      // Korekta toru: pochylenie ciągu, by wytracić prędkość poziomą i trafić w barkę
      const tgo = Math.max(alt / Math.max(-vr, 1), 1);
      const dx = downrange - b.shipDownrange;
      // w końcowej fazie priorytetem jest wyzerowanie prędkości poziomej
      const terminal = clamp((alt - 20) / 400, 0, 1);
      const vhCmd = lateral ? clamp(-dx / tgo, -30, 30) * terminal : 0;
      const ah = (vhCmd - vh) / (1 + 1.5 * terminal);
      const av = Math.max(aReq, g);
      const tilt = clamp(Math.atan2(ah, av), -RECOVERY.maxTilt, RECOVERY.maxTilt);
      cmd = b.engines > 0 ? Math.PI / 2 - tilt : Math.PI / 2;
      rate = 12 * DEG;
      break;
    }
    default:
      break;
  }

  // Dynamika przepustnicy (narastanie ciągu po zapłonie)
  const target = b.engines > 0 ? b.throttleCmd : 0;
  b.throttle += clamp(target - b.throttle, -4 * dt, RECOVERY.spoolRate * dt);
  if (b.engines === 0 && b.throttle < 0.02) b.throttle = 0;

  // Spalanie paliwa
  let thrust = 0;
  if (b.engines > 0 && b.throttle > 0) {
    const mdot = (b.engines * b.throttle * st.thrustVac) / (st.ispVac * G0);
    const burn = Math.min(b.prop, mdot * dt);
    b.prop -= burn;
    if (b.phase === 'ENTRY_BURN') b.entryBurnProp += burn;
    else b.landingBurnProp += burn;
    thrust = b.engines * b.throttle * T1;
    if (b.prop <= 0) {
      b.prop = 0;
      b.engines = 0;
    }
  }

  // Orientacja
  b.pitch = wrapAngle(b.pitch + clamp(wrapAngle(cmd - b.pitch), -rate * dt, rate * dt));

  // Siły: ciąg wzdłuż osi, opór (I stopień silnikami do przodu + grid fins), grawitacja
  const axis = attitudeVector(b.pos, b.pitch);
  let ax = (thrust * axis.x) / mass - g * up.x;
  let ay = (thrust * axis.y) / mass - g * up.y;
  if (speed > 1e-6) {
    ax -= (dragMag * b.vel.x) / speed / mass;
    ay -= (dragMag * b.vel.y) / speed / mass;
  }
  b.vel.x += ax * dt;
  b.vel.y += ay * dt;
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;

  const q = 0.5 * rho * speed * speed;
  b.maxQ = Math.max(b.maxQ, q);

  // telemetria
  const newR = Math.hypot(b.pos.x, b.pos.y);
  b.altitude = newR - R_EARTH - RECOVERY.legClearance;
  b.verticalSpeed = b.vel.x * up.x + b.vel.y * up.y;
  b.horizontalSpeed = b.vel.x * east.x + b.vel.y * east.y;
  b.speed = Math.hypot(b.vel.x, b.vel.y);
  b.dynamicPressure = q;
  b.downrange = Math.atan2(b.pos.x, b.pos.y) * R_EARTH;
  b.thrust = thrust;

  // Przeciążenie aerodynamiczne/termiczne bez entry burn
  if (q > RECOVERY.qLimit) {
    b.failure = `Rozpad w atmosferze (q = ${(q / 1000).toFixed(0)} kPa) — za mało paliwa na entry burn`;
    b.phase = 'DESTROYED';
    b.active = false;
    b.engines = 0;
    events.push('LANDING_FAIL');
    return events;
  }

  // Przyziemienie
  if (b.altitude <= 0) {
    const k = (R_EARTH + RECOVERY.legClearance) / newR;
    b.pos.x *= k;
    b.pos.y *= k;
    const tv = Math.max(0, -b.verticalSpeed);
    const th = Math.abs(b.horizontalSpeed);
    const miss = Math.abs(b.downrange - b.shipDownrange);
    b.touchdownVertical = tv;
    b.touchdownHorizontal = th;
    b.touchdownMiss = miss;
    b.altitude = 0;
    b.engines = 0;
    b.throttle = 0;
    b.thrust = 0;
    b.vel = { x: 0, y: 0 };
    b.active = false;
    const tiltOk = Math.abs(wrapAngle(b.pitch - Math.PI / 2)) < 10 * DEG;
    if (
      miss <= RECOVERY.deckHalfSize &&
      tv <= RECOVERY.maxTouchdownVertical &&
      th <= RECOVERY.maxTouchdownHorizontal &&
      tiltOk &&
      b.legsDeployed
    ) {
      b.phase = 'LANDED';
      b.pitch = Math.PI / 2;
      events.push('LANDED');
    } else {
      b.phase = 'DESTROYED';
      if (miss > RECOVERY.deckHalfSize) {
        b.failure = `Uderzenie w ocean ${(miss / 1000).toFixed(miss > 10_000 ? 0 : 2)} km od barki`;
      } else if (tv > RECOVERY.maxTouchdownVertical) {
        b.failure = `Twarde przyziemienie: ${tv.toFixed(1)} m/s`;
      } else if (th > RECOVERY.maxTouchdownHorizontal) {
        b.failure = `Poślizg po pokładzie: ${th.toFixed(1)} m/s w poziomie`;
      } else {
        b.failure = 'Przewrócenie na pokładzie';
      }
      if (b.prop <= 0) b.failure += ' (zabrakło paliwa)';
      else if (b.cutoff) b.failure += ' (wyłączenie silnika w zawisie)';
      events.push('LANDING_FAIL');
    }
  }
  return events;
}

/**
 * Symuluje w przód hamowanie od bieżącego stanu (ciąg przeciwny do prędkości, narastanie ciągu,
 * opór, grawitacja) i zwraca wysokość, na której prędkość pionowa spadnie do zera.
 * Wartość ujemna oznacza, że stopień nie zdąży wyhamować przed pokładem.
 */
function predictStopAltitude(
  b: BoosterState,
  engines: number,
  throttle: number,
  initialThrottle = 0,
): number {
  const st = VEHICLE.stage1;
  let px = b.pos.x;
  let py = b.pos.y;
  let vx = b.vel.x;
  let vy = b.vel.y;
  let prop = b.prop;
  let thr = initialThrottle;
  const dt = 0.05;
  for (let i = 0; i < 1600; i++) {
    const r = Math.hypot(px, py);
    const ux = px / r;
    const uy = py / r;
    const altC = r - R_EARTH;
    const alt = altC - RECOVERY.legClearance;
    const vr = vx * ux + vy * uy;
    if (vr >= 0) return alt;
    if (alt <= 0) return vr; // ujemne: prędkość uderzenia
    thr = thr < throttle ? Math.min(throttle, thr + RECOVERY.spoolRate * dt) : throttle;
    const v = Math.hypot(vx, vy);
    const m = st.dryMass + prop;
    const thrust = prop > 0 ? engines * thr * engineThrust1(altC) : 0;
    prop = Math.max(0, prop - ((engines * thr * st.thrustVac) / (st.ispVac * G0)) * dt);
    const rho = airDensity(altC);
    const drag =
      0.5 * rho * v * v * dragCoefficient(v / speedOfSound(altC)) * VEHICLE.areaBody * RECOVERY.dragFactor;
    const g = gravityAt(r);
    const decel = (thrust + drag) / m / Math.max(v, 1e-3);
    vx += (-vx * decel - g * ux) * dt;
    vy += (-vy * decel - g * uy) * dt;
    px += vx * dt;
    py += vy * dt;
  }
  return 0;
}

/** Przewiduje miejsce lądowania (odległość po powierzchni) dla zadanych ustawień. */
export function predictBoosterLanding(b: BoosterState, landingThrottle: number): number {
  const copy: BoosterState = { ...b, pos: { ...b.pos }, vel: { ...b.vel } };
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 1200 && copy.active; i++) {
    stepBooster(copy, dt, landingThrottle, false);
  }
  return copy.downrange;
}
