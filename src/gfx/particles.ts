import * as THREE from 'three';

/**
 * Efekt smugi ognia i spalin. Dwa systemy punktów (THREE.Points):
 *  - ogień: mieszanie addytywne, krótkie życie, kolor biało-żółty -> pomarańczowy -> czerwony,
 *  - dym/spaliny: mieszanie normalne, długie życie, rosnące kłęby wytracające prędkość w powietrzu.
 *
 * Cząsteczki żyją we współrzędnych świata, dzięki czemu za lecącą rakietą zostaje smuga.
 * Przy ziemi płomień odbija się od stołu startowego i rozchodzi kanałem odprowadzającym.
 */

export interface Emitter {
  /** Pozycja wylotu dyszy w świecie. */
  position: THREE.Vector3;
  /** Kierunek wypływu spalin (wersor, zwykle przeciwnie do osi rakiety). */
  direction: THREE.Vector3;
  /** Prędkość pojazdu w świecie [m/s]. */
  velocity: THREE.Vector3;
  /** Intensywność 0..1 (ciąg względny). */
  intensity: number;
  /** Promień wylotu [m]. */
  radius: number;
}

export interface ExhaustContext {
  /** Gęstość powietrza względem poziomu morza (0 = próżnia). */
  airRatio: number;
  /** Wysokość podłoża w świecie (płaszczyzna stołu startowego). */
  groundY: number;
  /** Środek strefy odbicia płomienia (stół startowy). */
  padCenter: THREE.Vector3;
  /**
   * Punkt odniesienia pojazdu w świecie. Ogień liczony jest względem niego, więc pióropusz
   * zawsze trzyma się dyszy, niezależnie od prędkości (km/s) i nierównych klatek.
   */
  anchor: THREE.Vector3;
}

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 0.0, 512.0);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const FRAG_FIRE = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec4 vColor;
  uniform float uCover;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float a = vColor.a * pow(1.0 - d, 1.3);
    // premultiplied alpha: uCover = 1 -> zwykłe krycie, 0 -> czysto addytywne (próżnia)
    gl_FragColor = vec4(vColor.rgb * a, a * uCover);
  }
`;

const FRAG_SMOKE = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec4 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    // miękki kłąb z lekkim cieniowaniem od góry
    float a = smoothstep(1.0, 0.2, d);
    float shade = 0.85 + 0.15 * (0.5 - c.y);
    gl_FragColor = vec4(vColor.rgb * shade, vColor.a * a);
  }
`;

class ParticlePool {
  readonly count: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly color: Float32Array;
  readonly size: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly startSize: Float32Array;
  readonly endSize: Float32Array;
  readonly drag: Float32Array;
  readonly kind: Uint8Array;
  readonly points: THREE.Points;
  private cursor = 0;
  private geo: THREE.BufferGeometry;

  constructor(count: number, material: THREE.ShaderMaterial) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.color = new Float32Array(count * 4);
    this.size = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.startSize = new Float32Array(count);
    this.endSize = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.kind = new Uint8Array(count);
    this.life.fill(0);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(this.geo, material);
    this.points.frustumCulled = false;
  }

  spawn(
    p: THREE.Vector3,
    v: THREE.Vector3,
    life: number,
    startSize: number,
    endSize: number,
    drag: number,
    kind = 0,
  ): number {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.age[i] = 0;
    this.life[i] = life;
    this.startSize[i] = startSize;
    this.endSize[i] = endSize;
    this.drag[i] = drag;
    this.kind[i] = kind;
    this.size[i] = startSize;
    return i;
  }

  clear() {
    this.life.fill(0);
    this.size.fill(0);
    this.markDirty();
  }

  markDirty() {
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }
}

const tmpP = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

function randomPerpendicular(dir: THREE.Vector3, outA: THREE.Vector3, outB: THREE.Vector3) {
  outA.set(1, 0, 0);
  if (Math.abs(dir.x) > 0.9) outA.set(0, 1, 0);
  outA.cross(dir).normalize();
  outB.copy(dir).cross(outA).normalize();
}

export class ExhaustSystem {
  readonly group = new THREE.Group();
  private fire: ParticlePool;
  private smoke: ParticlePool;
  private fireMat: THREE.ShaderMaterial;
  private smokeMat: THREE.ShaderMaterial;
  private emitAccum = 0;
  private smokeAccum = 0;
  private lastSmokePos = new THREE.Vector3(NaN, NaN, NaN);
  /** Bieżący punkt odniesienia ognia (pozycja obiektu Points w świecie). */
  private anchor = new THREE.Vector3();

  constructor(maxFire = 9000, maxSmoke = 9000) {
    const common = {
      uniforms: { uScale: { value: 600 } },
      vertexShader: VERT,
      transparent: true,
      depthWrite: false,
    };
    this.fireMat = new THREE.ShaderMaterial({
      ...common,
      uniforms: { uScale: { value: 600 }, uCover: { value: 0.6 } },
      fragmentShader: FRAG_FIRE,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.smokeMat = new THREE.ShaderMaterial({
      ...common,
      uniforms: { uScale: { value: 600 } },
      fragmentShader: FRAG_SMOKE,
      blending: THREE.NormalBlending,
    });
    this.fire = new ParticlePool(maxFire, this.fireMat);
    this.smoke = new ParticlePool(maxSmoke, this.smokeMat);
    this.smoke.points.renderOrder = 1;
    this.fire.points.renderOrder = 2;
    this.group.add(this.smoke.points, this.fire.points);
  }

  /** Skala rozmiaru punktów zależna od wysokości viewportu i FOV kamery. */
  setViewport(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.fireMat.uniforms.uScale.value = s;
    this.smokeMat.uniforms.uScale.value = s;
  }

  clear() {
    this.fire.clear();
    this.smoke.clear();
    this.lastSmokePos.set(NaN, NaN, NaN);
  }

  /**
   * Przesuwa układ odniesienia ognia. Cząstki "przypięte do świata" (rodzaj 1: wybuchy,
   * płomień odbity od stołu startowego) są kompensowane, żeby zostały w miejscu.
   */
  private moveAnchor(next: THREE.Vector3) {
    const dx = next.x - this.anchor.x;
    const dy = next.y - this.anchor.y;
    const dz = next.z - this.anchor.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      const f = this.fire;
      for (let i = 0; i < f.count; i++) {
        if (f.life[i] <= 0 || f.kind[i] !== 1) continue;
        f.pos[i * 3] -= dx;
        f.pos[i * 3 + 1] -= dy;
        f.pos[i * 3 + 2] -= dz;
      }
    }
    this.anchor.copy(next);
    this.fire.points.position.copy(next);
  }

  /** Wybuch (np. uderzenie w ziemię). */
  burst(at: THREE.Vector3, scale = 1) {
    for (let i = 0; i < 600 * scale; i++) {
      tmpV.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      tmpV.multiplyScalar(40 + Math.random() * 120 * scale);
      tmpP.copy(at).sub(this.anchor);
      this.fire.spawn(tmpP, tmpV, 0.6 + Math.random() * 1.2, 6 * scale, 18 * scale, 1.5, 1);
    }
    for (let i = 0; i < 400 * scale; i++) {
      tmpV.set(Math.random() - 0.5, Math.random() * 0.6 + 0.2, Math.random() - 0.5).normalize();
      tmpV.multiplyScalar(10 + Math.random() * 50 * scale);
      this.smoke.spawn(at, tmpV, 6 + Math.random() * 8, 10 * scale, 60 * scale, 0.6, 1);
    }
  }

  update(dt: number, emitters: Emitter[], ctx: ExhaustContext) {
    if (dt <= 0) return;
    this.fireMat.uniforms.uCover.value = 0.15 + 0.6 * Math.min(1, ctx.airRatio * 6);
    this.moveAnchor(ctx.anchor);
    this.emit(dt, emitters, ctx);
    this.simulateFire(dt, ctx);
    this.simulateSmoke(dt, ctx);
    this.fire.markDirty();
    this.smoke.markDirty();
  }

  private emit(dt: number, emitters: Emitter[], ctx: ExhaustContext) {
    const active = emitters.filter((e) => e.intensity > 0.01);
    if (active.length === 0) {
      this.lastSmokePos.set(NaN, NaN, NaN);
      return;
    }
    const vac = 1 - Math.min(1, ctx.airRatio * 4); // 0 przy ziemi, 1 w próżni
    // Liczba cząstek ognia na sekundę na cały pojazd
    // W próżni mniej, ale ciaśniej skupionych cząstek (inaczej pojedyncza dysza MVac "wybiela" się)
    const fireRate = 4200 - vac * 1800;
    this.emitAccum += fireRate * dt;
    const nFire = Math.floor(this.emitAccum);
    this.emitAccum -= nFire;

    for (let k = 0; k < nFire; k++) {
      const e = active[(Math.random() * active.length) | 0];
      randomPerpendicular(e.direction, tmpA, tmpB);
      // Rozpraszanie: w próżni pióropusz rozszerza się tylko nieznacznie (zwarty, skupiony płomień)
      const spread = 0.05 + vac * 0.07;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random());
      const sx = Math.cos(ang) * rad;
      const sy = Math.sin(ang) * rad;
      const speed = (110 + Math.random() * 40) * (0.6 + 0.4 * e.intensity);
      // prędkość względem pojazdu (układ ognia porusza się razem z rakietą)
      tmpV.copy(e.direction).multiplyScalar(speed);
      tmpV.addScaledVector(tmpA, sx * speed * spread);
      tmpV.addScaledVector(tmpB, sy * speed * spread);
      // losowy wiek początkowy w obrębie klatki, by uniknąć "schodków"
      const back = Math.random() * dt;
      tmpP.copy(e.position)
        .sub(this.anchor)
        .addScaledVector(tmpA, sx * e.radius * 0.7)
        .addScaledVector(tmpB, sy * e.radius * 0.7)
        .addScaledVector(tmpV, back);
      const life = (0.22 + Math.random() * 0.18) * (1 + vac * 0.35);
      // w próżni: mniejsze cząstki u wylotu, umiarkowany wzrost -> wąski, długi stożek
      const s0 = e.radius * (3.6 + Math.random() * 1.2) * (0.7 + 0.3 * e.intensity) * (1 - vac * 0.35);
      const s1 = s0 * (2.6 - vac * 0.6);
      this.fire.spawn(tmpP, tmpV, life, s0, s1, 0, 0);
    }

    // Dym — tylko w atmosferze; emisja proporcjonalna do przebytej drogi
    if (ctx.airRatio > 0.01) {
      const lead = active[0];
      let center = tmpP.set(0, 0, 0);
      for (const e of active) center.add(e.position);
      center = center.multiplyScalar(1 / active.length);
      const avgI = active.reduce((a, e) => a + e.intensity, 0) / active.length;
      const puffSize = (6 + (1 - ctx.airRatio) * 30) * (0.6 + 0.4 * avgI);
      const spacing = Math.max(1.5, puffSize * 0.25);
      let dist = 0;
      if (!Number.isNaN(this.lastSmokePos.x)) dist = this.lastSmokePos.distanceTo(center);
      this.smokeAccum += dist / spacing + 60 * dt;
      const n = Math.min(Math.floor(this.smokeAccum), 120);
      this.smokeAccum -= Math.floor(this.smokeAccum);
      const from = Number.isNaN(this.lastSmokePos.x) ? center.clone() : this.lastSmokePos.clone();
      for (let i = 0; i < n; i++) {
        const t = (i + Math.random()) / Math.max(n, 1);
        tmpB.lerpVectors(from, center, t);
        tmpB.addScaledVector(lead.direction, 8 + Math.random() * 25);
        tmpB.x += (Math.random() - 0.5) * 3;
        tmpB.z += (Math.random() - 0.5) * 3;
        // dym niemal nie dziedziczy prędkości pojazdu (szybko hamowany przez powietrze)
        tmpV.copy(lead.velocity).multiplyScalar(0.05);
        tmpV.addScaledVector(lead.direction, 20 + Math.random() * 20);
        tmpV.x += (Math.random() - 0.5) * 6;
        tmpV.z += (Math.random() - 0.5) * 6;
        const life = 8 + Math.random() * 10 * ctx.airRatio + 4;
        this.smoke.spawn(tmpB, tmpV, life, puffSize * 0.5, puffSize * (2.5 + Math.random()), 0.9, 0);
      }
      this.lastSmokePos.copy(center);
    } else {
      this.lastSmokePos.set(NaN, NaN, NaN);
    }
  }

  private simulateFire(dt: number, ctx: ExhaustContext) {
    const f = this.fire;
    for (let i = 0; i < f.count; i++) {
      if (f.life[i] <= 0) {
        f.size[i] = 0;
        continue;
      }
      f.age[i] += dt;
      const t = f.age[i] / f.life[i];
      if (t >= 1) {
        f.life[i] = 0;
        f.size[i] = 0;
        continue;
      }
      const i3 = i * 3;
      if (f.drag[i] > 0) {
        const k = Math.exp(-f.drag[i] * dt);
        f.vel[i3] *= k;
        f.vel[i3 + 1] *= k;
        f.vel[i3 + 2] *= k;
      }
      f.pos[i3] += f.vel[i3] * dt;
      f.pos[i3 + 1] += f.vel[i3 + 1] * dt;
      f.pos[i3 + 2] += f.vel[i3 + 2] * dt;

      // Odbicie od stołu startowego: płomień rozchodzi się na boki (kanał wzdłuż osi Z)
      const groundRel = ctx.groundY - this.anchor.y;
      if (f.pos[i3 + 1] < groundRel && f.vel[i3 + 1] < 0) {
        const vy = -f.vel[i3 + 1];
        f.pos[i3 + 1] = groundRel;
        f.kind[i] = 1; // od teraz cząstka zostaje przy stanowisku
        const side = Math.random() < 0.5 ? -1 : 1;
        f.vel[i3] = (Math.random() - 0.5) * vy * 0.4;
        f.vel[i3 + 1] = vy * 0.08 * Math.random();
        f.vel[i3 + 2] = side * vy * (0.5 + Math.random() * 0.3);
        f.drag[i] = 2.5;
        f.life[i] *= 2.2;
        // kłęby pary wodnej z systemu zraszania
        if (Math.random() < 0.08) {
          tmpP.set(f.pos[i3] + this.anchor.x, ctx.groundY + 2, f.pos[i3 + 2] + this.anchor.z);
          tmpV.set(f.vel[i3] * 0.5, 4 + Math.random() * 10, f.vel[i3 + 2] * 0.6);
          this.smoke.spawn(tmpP, tmpV, 10 + Math.random() * 8, 8, 45 + Math.random() * 30, 0.45, 1);
        }
      }

      f.size[i] = f.startSize[i] + (f.endSize[i] - f.startSize[i]) * t;
      // kolor: biało-żółty -> pomarańczowy -> ciemnoczerwony
      const c = i * 4;
      const vac = 1 - Math.min(1, ctx.airRatio * 4);
      if (t < 0.15) {
        f.color[c] = 1;
        f.color[c + 1] = 0.95;
        f.color[c + 2] = 0.8 + vac * 0.2;
      } else if (t < 0.5) {
        const u = (t - 0.15) / 0.35;
        f.color[c] = 1;
        f.color[c + 1] = 0.95 - 0.45 * u;
        f.color[c + 2] = (0.8 + vac * 0.2) * (1 - u) + 0.15 * u;
      } else {
        const u = (t - 0.5) / 0.5;
        f.color[c] = 1 - 0.5 * u;
        f.color[c + 1] = 0.5 - 0.35 * u;
        f.color[c + 2] = 0.15;
      }
      f.color[c + 3] = (1 - t) * (0.95 - vac * 0.65);
    }
  }

  private simulateSmoke(dt: number, ctx: ExhaustContext) {
    const s = this.smoke;
    for (let i = 0; i < s.count; i++) {
      if (s.life[i] <= 0) {
        s.size[i] = 0;
        continue;
      }
      s.age[i] += dt;
      const t = s.age[i] / s.life[i];
      if (t >= 1) {
        s.life[i] = 0;
        s.size[i] = 0;
        continue;
      }
      const i3 = i * 3;
      const k = Math.exp(-s.drag[i] * dt);
      s.vel[i3] *= k;
      s.vel[i3 + 1] = s.vel[i3 + 1] * k + 0.6 * dt; // lekka wyporność ciepłych gazów
      s.vel[i3 + 2] *= k;
      // wiatr
      s.pos[i3] += (s.vel[i3] + 2.5) * dt;
      s.pos[i3 + 1] += s.vel[i3 + 1] * dt;
      s.pos[i3 + 2] += s.vel[i3 + 2] * dt;
      if (s.pos[i3 + 1] < ctx.groundY + 1) {
        s.pos[i3 + 1] = ctx.groundY + 1;
        if (s.vel[i3 + 1] < 0) s.vel[i3 + 1] = 0;
      }
      // rozmiar: szybki wzrost na początku, potem powolny
      const g = 1 - Math.pow(1 - t, 3);
      s.size[i] = s.startSize[i] + (s.endSize[i] - s.startSize[i]) * g;
      const c = i * 4;
      const glow = s.kind[i] === 0 ? Math.max(0, 1 - s.age[i] * 3) : 0;
      const base = s.kind[i] === 1 ? 0.92 : 0.82;
      s.color[c] = base + glow * 0.18;
      s.color[c + 1] = base + glow * 0.05;
      s.color[c + 2] = base - glow * 0.2;
      const fadeIn = Math.min(1, t * 12);
      s.color[c + 3] = fadeIn * Math.pow(1 - t, 1.5) * 0.55;
    }
  }
}
