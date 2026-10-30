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
  | 'BOOSTER_IMPACT';

export interface Vec2 {
  x: number;
  y: number;
}

/** Odrzucony I stopień — prosta balistyka z oporem (do wizualizacji). */
export interface BoosterState {
  active: boolean;
  pos: Vec2;
  vel: Vec2;
  /** Kąt osi rakiety względem lokalnego horyzontu [rad]. */
  pitch: number;
  pitchRate: number;
  timeSinceSep: number;
  gridFinsDeployed: boolean;
  legsDeployed: boolean;
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
}

export const DEFAULT_GUIDANCE: GuidanceConfig = {
  pitchKickSpeed: 55,
  pitchKickAngle: 6.5,
  targetAltitude: 200_000,
  boosterReserve: 0.06,
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
      booster: {
        active: false,
        pos: { ...pos },
        vel: { x: 0, y: 0 },
        pitch: Math.PI / 2,
        pitchRate: 0,
        timeSinceSep: 0,
        gridFinsDeployed: false,
        legsDeployed: false,
      },
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
    const b = s.booster;
    b.active = true;
    b.pos = { ...s.pos };
    b.vel = { ...s.vel };
    b.pitch = s.pitch;
    b.pitchRate = 0;
    b.timeSinceSep = 0;
    b.gridFinsDeployed = false;
    b.legsDeployed = false;
    s.stage = 2;
    s.throttle = 0;
    // Popychacze pneumatyczne: niewielki przyrost prędkości II stopnia
    const dir = attitudeVector(s.pos, s.pitch);
    s.vel.x += dir.x * 1.5;
    s.vel.y += dir.y * 1.5;
    b.vel.x -= dir.x * 0.5;
    b.vel.y -= dir.y * 0.5;
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
    const s = this.state;
    const b = s.booster;
    if (!b.active) return;
    b.timeSinceSep += dt;
    const { up, r } = localFrame(b.pos);
    const alt = r - R_EARTH;
    const mass = VEHICLE.stage1.dryMass + s.prop1;
    const rho = airDensity(alt);
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const mach = speed / speedOfSound(alt);
    const drag = 0.5 * rho * speed * speed * dragCoefficient(mach) * VEHICLE.areaBody * 1.6;
    const g = gravityAt(r);
    let ax = -g * up.x;
    let ay = -g * up.y;
    if (speed > 1e-6) {
      ax -= (drag * b.vel.x) / speed / mass;
      ay -= (drag * b.vel.y) / speed / mass;
    }
    b.vel.x += ax * dt;
    b.vel.y += ay * dt;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;

    // Manewr obrotu (flip) po separacji, potem stabilizacja silnikami w dół
    if (b.timeSinceSep > 4 && b.timeSinceSep < 30) {
      b.pitchRate = 9 * DEG;
    } else if (b.timeSinceSep >= 30) {
      const retro = Math.atan2(
        -(b.vel.x * up.x + b.vel.y * up.y),
        -(b.vel.x * up.y - b.vel.y * up.x),
      );
      // silniki w kierunku lotu -> oś (nos) przeciwnie do prędkości
      b.pitchRate = clamp(wrapAngle(retro - b.pitch), -0.1, 0.1);
    }
    b.pitch = wrapAngle(b.pitch + b.pitchRate * dt);

    if (!b.gridFinsDeployed && b.timeSinceSep > 8) b.gridFinsDeployed = true;
    if (!b.legsDeployed && alt < 4_000 && b.timeSinceSep > 20) b.legsDeployed = true;

    if (alt <= 0) {
      b.active = false;
      this.emit('BOOSTER_IMPACT');
    }
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
