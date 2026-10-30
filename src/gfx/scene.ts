import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { R_EARTH, type Vec2 } from '../sim/physics';

/**
 * Scena świata: Ziemia (kula + szczegółowa czasza wokół kosmodromu), stanowisko startowe,
 * oświetlenie słoneczne z cieniami, proceduralne niebo ciemniejące z wysokością, gwiazdy
 * i poświata atmosfery widoczna z orbity.
 *
 * Układ świata: środek Ziemi w (0, -R, 0), stanowisko startowe w (0, 0, 0),
 * oś +X = kierunek lotu (downrange), oś +Y = lokalny pion nad stanowiskiem.
 */

export const EARTH_CENTER = new THREE.Vector3(0, -R_EARTH, 0);
/** Wysokość stołu startowego nad gruntem (spód rakiety). */
export const PAD_HEIGHT = 6;

/** Konwersja pozycji z fizyki (2D, środek Ziemi) do świata Three.js. */
export function simToWorld(p: Vec2, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p.x, p.y - R_EARTH + PAD_HEIGHT, 0);
}

// ---------------------------------------------------------------------------
// Szum wartości do proceduralnych tekstur
// ---------------------------------------------------------------------------

function hash(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 982451653;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    s += amp * valueNoise(x * f, y * f, seed + i * 17);
    amp *= 0.5;
    f *= 2;
  }
  return s;
}

/** Tekstura globu (equirectangular) z proceduralnymi kontynentami i chmurami. */
function makeGlobeTexture(): THREE.Texture {
  const w = 1024;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const lat = Math.abs(y / h - 0.5) * 2; // 0 równik, 1 biegun (tu: daleko od kosmodromu)
    for (let x = 0; x < w; x++) {
      // zawijanie szumu w poziomie
      const ang = (x / w) * Math.PI * 2;
      const nx = Math.cos(ang) * 2.2 + 10;
      const nz = Math.sin(ang) * 2.2 + 10;
      const ny = (y / h) * 4.4;
      let n = fbm(nx + ny * 0.3, nz + ny, 3, 6);
      const nearPad = 1 - THREE.MathUtils.smoothstep(y / h, 0.05, 0.16);
      if (nearPad > 0) {
        // u = 0.5 to kierunek +X (wschód, ocean), u = 0/1 to zachód (ląd)
        const westness = Math.cos(ang) * 0.5 + 0.5;
        const local = westness > 0.42 + (n - 0.5) * 0.4 ? 0.62 : 0.3;
        n = n * (1 - nearPad) + local * nearPad;
      }
      const cloud = fbm(nx * 2.5 + 40, nz * 2.5 + ny * 2, 9, 5);
      let r: number, gg: number, b: number;
      if (n > 0.53) {
        const k = (n - 0.53) * 4;
        r = 70 + k * 90;
        gg = 105 + k * 40;
        b = 55 + k * 20;
        if (lat > 0.85 && y > h / 2) {
          r = gg = b = 235; // czapa lodowa tylko na biegunie przeciwległym do kosmodromu
        }
      } else {
        const k = n / 0.53;
        r = 10 + k * 20;
        gg = 40 + k * 50;
        b = 95 + k * 70;
      }
      const cl = Math.max(0, (cloud - 0.55) * 3.2) * THREE.MathUtils.smoothstep(y / h, 0.04, 0.2);
      r = r + (255 - r) * Math.min(1, cl);
      gg = gg + (255 - gg) * Math.min(1, cl);
      b = b + (255 - b) * Math.min(1, cl);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Linia brzegowa (x w metrach) w funkcji współrzędnej z — wybrzeże na wschód od stanowiska. */
function coastX(z: number): number {
  return 3_500 + Math.sin(z / 9_000) * 1_500 + (fbm(z / 6_000, 0.5, 21, 4) - 0.5) * 6_000 + z * 0.08;
}

/** Planarna tekstura terenu wokół kosmodromu (wybrzeże, laguny, ocean). */
function makeRegionTexture(sizeMeters: number): THREE.Texture {
  const px = 1536;
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  const img = g.createImageData(px, px);
  const m = sizeMeters / px;
  for (let j = 0; j < px; j++) {
    const z = (j - px / 2) * m;
    const coast = coastX(z);
    for (let i = 0; i < px; i++) {
      const x = (i - px / 2) * m;
      const k = (j * px + i) * 4;
      const n = fbm(x / 4_000, z / 4_000, 5, 5);
      let r: number, gg: number, b: number;
      // laguna (Banana River / Indian River) na zachód od stanowiska
      const lagoon =
        Math.abs(x - (-4_000 + Math.sin(z / 7_000) * 1_200)) < 900 + n * 500 ||
        Math.abs(x - (-14_000 + Math.sin(z / 11_000) * 2_500)) < 1_400 + n * 700;
      if (x > coast) {
        const d = x - coast;
        const shallow = Math.exp(-d / 2_500);
        r = 12 + shallow * 40;
        gg = 55 + shallow * 90;
        b = 105 + shallow * 60;
        if (d < 120) {
          r = 225;
          gg = 210;
          b = 170; // plaża
        }
      } else if (lagoon) {
        r = 30 + n * 20;
        gg = 85 + n * 30;
        b = 105 + n * 20;
      } else {
        r = 70 + n * 60;
        gg = 95 + n * 50;
        b = 50 + n * 25;
        // pola i zabudowa dalej w głębi lądu
        if (x < -25_000 && fbm(x / 1_500, z / 1_500, 8, 3) > 0.62) {
          r += 60;
          gg += 50;
          b += 40;
        }
      }
      img.data[k] = r;
      img.data[k + 1] = gg;
      img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeGrassTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const n = fbm(x / 32, y / 32, 2, 4) * 0.7 + hash(x, y, 1) * 0.3;
      const k = (y * 256 + x) * 4;
      img.data[k] = 70 + n * 50;
      img.data[k + 1] = 92 + n * 45;
      img.data[k + 2] = 48 + n * 22;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(120, 120);
  return tex;
}

// ---------------------------------------------------------------------------
// Shadery nieba i atmosfery
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vDir = wp.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const SKY_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uUp;
  uniform vec3 uSun;
  uniform float uSpace;     // 0 = przy ziemi, 1 = przestrzeń kosmiczna
  uniform float uHorizon;   // sinus kąta depresji horyzontu (ujemny)
  varying vec3 vDir;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 dir = normalize(vDir);
    float e = dot(dir, uUp) - uHorizon;
    vec3 zenithDay = vec3(0.16, 0.38, 0.82);
    vec3 horizonDay = vec3(0.72, 0.84, 0.96);
    vec3 zenith = mix(zenithDay, vec3(0.0, 0.0, 0.006), smoothstep(0.0, 1.0, pow(uSpace, 0.55)));
    vec3 horizon = mix(horizonDay, vec3(0.30, 0.55, 1.0) * 0.75, smoothstep(0.0, 1.0, uSpace));
    float band = mix(0.55, 0.035, uSpace);
    vec3 col = mix(horizon, zenith, smoothstep(0.0, band, max(e, 0.0)));
    if (e < 0.0) col = mix(horizon, horizon * 0.55, smoothstep(0.0, -0.2, e));
    float sd = max(dot(dir, uSun), 0.0);
    col += vec3(1.0, 0.95, 0.85) * (pow(sd, 900.0) * 6.0 + pow(sd, 60.0) * 0.35 + pow(sd, 6.0) * 0.18 * (1.0 - uSpace));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const ATMO_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uCamRel;    // kamera względem środka Ziemi
  uniform vec3 uSun;
  uniform float uR;
  uniform float uThickness;
  uniform float uStrength;
  varying vec3 vDir;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 dir = normalize(vDir);
    // najmniejsza odległość promienia widzenia od środka Ziemi
    float tc = -dot(uCamRel, dir);
    vec3 closest = uCamRel + dir * max(tc, 0.0);
    float d = length(closest);
    float glow;
    if (d < uR) glow = 0.18;
    else glow = pow(clamp(1.0 - (d - uR) / uThickness, 0.0, 1.0), 2.2);
    float lit = 0.35 + 0.65 * clamp(dot(normalize(closest), uSun) + 0.3, 0.0, 1.0);
    vec3 col = vec3(0.35, 0.6, 1.0) * glow * lit * uStrength;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Stanowisko startowe
// ---------------------------------------------------------------------------

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Kratownicowa wieża serwisowa (geometria scalona dla wydajności). */
function latticeTower(width: number, height: number, level: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const t = 0.5;
  const hw = width / 2;
  for (const [x, z] of [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]]) {
    parts.push(box(t, height, t, x, height / 2, z));
  }
  const diagLen = Math.hypot(width, level);
  const diagAng = Math.atan2(level, width);
  for (let y = level; y <= height + 0.01; y += level) {
    parts.push(box(width, t * 0.6, t * 0.6, 0, y, -hw));
    parts.push(box(width, t * 0.6, t * 0.6, 0, y, hw));
    parts.push(box(t * 0.6, t * 0.6, width, -hw, y, 0));
    parts.push(box(t * 0.6, t * 0.6, width, hw, y, 0));
    // stężenia ukośne na dwóch ścianach
    for (const z of [-hw, hw]) {
      const d = new THREE.BoxGeometry(diagLen, 0.25, 0.25);
      d.rotateZ(((y / level) % 2 === 0 ? 1 : -1) * diagAng);
      d.translate(0, y - level / 2, z);
      parts.push(d);
    }
    for (const x of [-hw, hw]) {
      const d = new THREE.BoxGeometry(0.25, 0.25, diagLen);
      d.rotateX(((y / level) % 2 === 0 ? 1 : -1) * diagAng);
      d.translate(x, y - level / 2, 0);
      parts.push(d);
    }
  }
  return mergeGeometries(parts)!;
}

function buildLaunchPad(): THREE.Group {
  const pad = new THREE.Group();
  pad.name = 'LaunchPad';
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a95, roughness: 0.95 });
  const darkConcrete = new THREE.MeshStandardMaterial({ color: 0x55534f, roughness: 0.95 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8c3b2a, roughness: 0.7, metalness: 0.4 });
  const greySteel = new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.6, metalness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.6 });

  // trawa wokół
  const grass = new THREE.Mesh(
    new THREE.CircleGeometry(1_500, 64),
    new THREE.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 1 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = 0.05;
  grass.receiveShadow = true;
  pad.add(grass);

  // utwardzony plac (ośmiokąt)
  const hard = new THREE.Mesh(new THREE.CylinderGeometry(110, 115, 1.2, 8), concrete);
  hard.position.y = 0.6;
  hard.rotation.y = Math.PI / 8;
  hard.receiveShadow = true;
  pad.add(hard);

  // kanał odprowadzający płomienie (wzdłuż osi Z)
  const trench = new THREE.Mesh(new THREE.BoxGeometry(12, 0.1, 140), darkConcrete);
  trench.position.set(0, 1.25, 0);
  trench.receiveShadow = true;
  pad.add(trench);

  // stół startowy: 4 filary + rama
  const mountParts: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-4, -4], [4, -4], [4, 4], [-4, 4]]) {
    mountParts.push(box(1.6, PAD_HEIGHT - 1.2, 1.6, x, 1.2 + (PAD_HEIGHT - 1.2) / 2, z));
  }
  mountParts.push(box(9.6, 1.0, 1.4, 0, PAD_HEIGHT - 0.5, -4));
  mountParts.push(box(9.6, 1.0, 1.4, 0, PAD_HEIGHT - 0.5, 4));
  mountParts.push(box(1.4, 1.0, 9.6, -4, PAD_HEIGHT - 0.5, 0));
  mountParts.push(box(1.4, 1.0, 9.6, 4, PAD_HEIGHT - 0.5, 0));
  const mount = new THREE.Mesh(mergeGeometries(mountParts)!, greySteel);
  mount.castShadow = mount.receiveShadow = true;
  pad.add(mount);

  // wieża serwisowa z ramieniem dostępu
  const towerX = -24;
  const tower = new THREE.Mesh(latticeTower(10, 84, 6), steel);
  tower.position.set(towerX, 1.2, 0);
  tower.castShadow = tower.receiveShadow = true;
  pad.add(tower);
  const deckParts: THREE.BufferGeometry[] = [];
  for (let y = 12; y <= 84; y += 12) deckParts.push(box(11, 0.4, 11, 0, y, 0));
  deckParts.push(box(13, 6, 13, 0, 87, 0));
  const decks = new THREE.Mesh(mergeGeometries(deckParts)!, greySteel);
  decks.position.set(towerX, 1.2, 0);
  decks.castShadow = true;
  pad.add(decks);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(17, 2.6, 2.4), white);
  arm.position.set(towerX + 5 + 8.5, 62, 0);
  arm.castShadow = true;
  pad.add(arm);

  // maszty odgromowe z przewodami
  const poleGeo = new THREE.CylinderGeometry(0.6, 1.0, 110, 8);
  const polePos: [number, number][] = [
    [-60, -60],
    [60, -60],
    [-60, 60],
    [60, 60],
  ];
  const tops: THREE.Vector3[] = [];
  for (const [x, z] of polePos) {
    const p = new THREE.Mesh(poleGeo, greySteel);
    p.position.set(x, 55, z);
    p.castShadow = true;
    pad.add(p);
    tops.push(new THREE.Vector3(x, 110, z));
  }
  const wireMat = new THREE.LineBasicMaterial({ color: 0x333333 });
  const center = new THREE.Vector3(0, 100, 0);
  for (const t of tops) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      const p = new THREE.Vector3().lerpVectors(t, center, u);
      p.y -= Math.sin(u * Math.PI) * 8;
      pts.push(p);
    }
    pad.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 14, 8), greySteel);
  cap.position.set(towerX, 97, 0);
  pad.add(cap);

  // wieża wodna systemu zraszania
  const waterTower = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 16), white);
  tank.position.y = 72;
  waterTower.add(tank);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 66, 6), greySteel);
    leg.position.set(Math.cos(a) * 6, 33, Math.sin(a) * 6);
    waterTower.add(leg);
  }
  waterTower.position.set(-180, 0, -220);
  waterTower.traverse((o) => (o.castShadow = true));
  pad.add(waterTower);

  // zbiorniki kriogeniczne (LOX / RP-1)
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(11, 24, 16), white);
    s.position.set(-200 + i * 30, 11, 180);
    s.castShadow = true;
    pad.add(s);
  }
  // hangar HIF
  const hangar = new THREE.Mesh(new THREE.BoxGeometry(60, 30, 120), new THREE.MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.8 }));
  hangar.position.set(-420, 15, 0);
  hangar.castShadow = hangar.receiveShadow = true;
  pad.add(hangar);
  // droga / tor transportowy
  const road = new THREE.Mesh(new THREE.BoxGeometry(320, 0.1, 14), darkConcrete);
  road.position.set(-270, 0.12, 0);
  road.receiveShadow = true;
  pad.add(road);

  return pad;
}

// ---------------------------------------------------------------------------
// Świat
// ---------------------------------------------------------------------------

export class World {
  readonly scene = new THREE.Scene();
  readonly sun: THREE.DirectionalLight;
  readonly sunDir = new THREE.Vector3(0.45, 0.55, 0.7).normalize();
  private hemi: THREE.HemisphereLight;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private atmo: THREE.Mesh;
  private atmoMat: THREE.ShaderMaterial;
  private fog: THREE.FogExp2;
  private tmp = new THREE.Vector3();
  private horizonDay = new THREE.Color(0.72, 0.84, 0.96);
  private horizonSpace = new THREE.Color(0.02, 0.03, 0.06);

  constructor() {
    const scene = this.scene;
    scene.background = new THREE.Color(0x000000);
    this.fog = new THREE.FogExp2(this.horizonDay.getHex(), 1.6e-5);
    scene.fog = this.fog;

    // --- oświetlenie ---
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 1;
    sc.far = 800;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x5a5040, 0.9);
    scene.add(this.hemi);
    scene.add(new THREE.AmbientLight(0xffffff, 0.08));

    // --- niebo ---
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSun: { value: this.sunDir },
        uSpace: { value: 0 },
        uHorizon: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9e6, 48, 24), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // --- gwiazdy ---
    const n = 4000;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(8e6);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -5;
    scene.add(this.stars);

    // --- Ziemia ---
    // Kula globalna (nieco mniejsza, by nie kolidować z czaszą szczegółową)
    const globeGeo = new THREE.SphereGeometry(R_EARTH - 40, 256, 128);
    globeGeo.translate(0, -R_EARTH, 0);
    const globe = new THREE.Mesh(
      globeGeo,
      new THREE.MeshStandardMaterial({ map: makeGlobeTexture(), roughness: 0.9, metalness: 0 }),
    );
    globe.name = 'Globe';
    scene.add(globe);

    // Czasza szczegółowa wokół kosmodromu (~320 km promienia), tekstura planarna
    const capAngle = 0.05;
    const capGeo = new THREE.SphereGeometry(R_EARTH, 256, 160, 0, Math.PI * 2, 0, capAngle);
    capGeo.translate(0, -R_EARTH, 0);
    const regionSize = 2 * R_EARTH * Math.sin(capAngle);
    const p = capGeo.attributes.position as THREE.BufferAttribute;
    const uv = capGeo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      uv.setXY(i, p.getX(i) / regionSize + 0.5, 0.5 - p.getZ(i) / regionSize);
    }
    uv.needsUpdate = true;
    const cap = new THREE.Mesh(
      capGeo,
      new THREE.MeshStandardMaterial({ map: makeRegionTexture(regionSize), roughness: 0.92 }),
    );
    cap.receiveShadow = true;
    cap.name = 'RegionCap';
    scene.add(cap);

    // Poświata atmosfery widoczna z wysokiej orbity
    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: ATMO_FRAG,
      uniforms: {
        uCamRel: { value: new THREE.Vector3() },
        uSun: { value: this.sunDir },
        uR: { value: R_EARTH },
        uThickness: { value: 90_000 },
        uStrength: { value: 0 },
      },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const atmoGeo = new THREE.SphereGeometry(R_EARTH + 100_000, 128, 64);
    atmoGeo.translate(0, -R_EARTH, 0);
    this.atmo = new THREE.Mesh(atmoGeo, this.atmoMat);
    this.atmo.frustumCulled = false;
    scene.add(this.atmo);

    scene.add(buildLaunchPad());
  }

  /**
   * Aktualizuje niebo, mgłę, gwiazdy i cienie dla bieżącej pozycji kamery i obiektu śledzonego.
   */
  update(camera: THREE.Camera, focus: THREE.Vector3) {
    const camPos = camera.position;
    const rel = this.tmp.copy(camPos).sub(EARTH_CENTER);
    const r = rel.length();
    const alt = Math.max(0, r - R_EARTH);
    const up = rel.clone().normalize();

    // 0 przy ziemi -> 1 powyżej ~80 km (ciemnienie nieba do czerni kosmosu)
    const space = THREE.MathUtils.smoothstep(alt, 0, 80_000);
    const horizonDip = -Math.sqrt(Math.max(0, 1 - (R_EARTH / Math.max(r, R_EARTH)) ** 2));

    this.sky.position.copy(camPos);
    this.stars.position.copy(camPos);
    const u = this.skyMat.uniforms;
    u.uUp.value.copy(up);
    u.uSpace.value = space;
    u.uHorizon.value = horizonDip;

    this.starMat.opacity = THREE.MathUtils.smoothstep(alt, 25_000, 70_000);

    // Mgła: gęsta przy ziemi, zanika z wysokością; kolor zbliżony do horyzontu
    this.fog.density = 1.4e-5 * Math.exp(-alt / 7_000);
    this.fog.color.copy(this.horizonDay).lerp(this.horizonSpace, space);

    // Światło rozproszone nieba słabnie w próżni
    this.hemi.intensity = 0.9 * (1 - space) + 0.15;
    this.sun.intensity = 2.8 + space * 0.6;

    this.atmoMat.uniforms.uCamRel.value.copy(rel);
    this.atmoMat.uniforms.uStrength.value = THREE.MathUtils.smoothstep(alt, 40_000, 140_000) * 1.4;

    // Cień podąża za śledzonym obiektem
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 400);
    this.sun.target.updateMatrixWorld();
  }
}
