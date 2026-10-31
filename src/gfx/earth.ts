import * as THREE from 'three';
import { R_EARTH } from '../sim/physics';

/**
 * Proceduralna Ziemia liczona na GPU.
 *
 * Kolor powierzchni wynika z szumu 3D liczonego na kierunku od środka Ziemi (bez zniekształceń
 * przy biegunach, jak przy teksturze equirectangular). Detal (liczba oktaw) rośnie, gdy kamera
 * się zbliża. Shader liczy też: biomy, głębię oceanu, odblask słońca na wodzie, rzeźbę terenu
 * (bump z pochodnych ekranowych), łunę terminatora, światła miast po nocnej stronie, cienie chmur
 * i mgłę. Osobna sfera chmur leży 6 km nad powierzchnią.
 *
 * Układ świata jak w scene.ts: środek Ziemi w (0, -R, 0), kosmodrom na "biegunie" +Y, lot na +X.
 */

/** Wysokość warstwy chmur nad powierzchnią [m]. */
export const CLOUD_ALTITUDE = 6_000;

// Szum simplex 3D (Ashima Arts / Stefan Gustavson, licencja MIT) + fbm.
const NOISE_GLSL = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
  // fbm o zmiennej liczbie oktaw (wynik ~[-1, 1])
  float fbm(vec3 p, float octaves) {
    float s = 0.0;
    float a = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= octaves) break;
      s += a * snoise(p);
      norm += a;
      p = p * 2.03 + vec3(1.7, -3.1, 2.3);
      a *= 0.5;
    }
    return s / norm;
  }
`;

// Wspólne funkcje: wysokość terenu i gęstość chmur (także do cieni chmur na powierzchni).
const TERRAIN_GLSL = /* glsl */ `
  uniform vec3 uNorth;     // oś "biegunów" (kosmodrom na ~28° szerokości)
  uniform vec3 uPadDir;    // kierunek kosmodromu od środka Ziemi
  uniform vec3 uEast;      // kierunek lotu (wschód nad kosmodromem)
  uniform float uTime;

  // Wysokość terenu: < 0 ocean, > 0 ląd. dir = wersor od środka Ziemi.
  float terrainHeight(vec3 dir, float octaves) {
    vec3 p = dir * 1.6;
    // domain warping: poszarpane linie brzegowe i łańcuchy górskie
    vec3 w = vec3(fbm(p + vec3(3.1, 0.0, 1.2), 2.0), fbm(p + vec3(-2.4, 5.2, 0.7), 2.0), fbm(p + vec3(1.1, -4.3, 2.9), 2.0));
    float h = fbm(p + w * 0.55, octaves) * 0.9 + 0.06;
    // grzbiety górskie
    float ridge = 1.0 - abs(snoise(p * 3.1 + w * 1.4));
    h += ridge * ridge * 0.18 * smoothstep(0.0, 0.25, h);
    // okolice kosmodromu: ląd na zachodzie, ocean na wschodzie (spójnie z mapą regionu)
    float padAng = acos(clamp(dot(dir, uPadDir), -1.0, 1.0));
    float local = 1.0 - smoothstep(0.07, 0.16, padAng);
    if (local > 0.0) {
      float x = dot(dir, uEast);                        // ~ odległość na wschód [rad]
      float coast = 0.0006 + snoise(dir * 40.0) * 0.006; // wybrzeże ~4 km na wschód od stanowiska
      float forced = x < coast ? 0.12 + fbm(dir * 30.0, min(octaves, 4.0)) * 0.08 : -0.25 - x * 2.0;
      h = mix(h, forced, local);
    }
    return h;
  }

  float cloudDensity(vec3 dir, float octaves) {
    vec3 drift = vec3(uTime * 0.0008, 0.0, uTime * 0.0005);
    float lat = dot(dir, uNorth);
    // pasy pogodowe: więcej chmur przy równiku i na średnich szerokościach
    float bands = 0.55 + 0.25 * cos(lat * 9.0);
    float n = fbm(dir * 4.5 + drift + vec3(snoise(dir * 2.0)) * 0.6, octaves) * 0.5 + 0.5;
    float d = smoothstep(1.05 - bands * 0.55, 1.0, n + 0.12);
    // przejaśnienie nad kosmodromem
    float padAng = acos(clamp(dot(dir, uPadDir), -1.0, 1.0));
    d *= smoothstep(0.015, 0.06, padAng);
    return d;
  }
`;

const EARTH_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  varying vec3 vRel;
  void main() {
    vDir = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vRel = wp.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const EARTH_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSun;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uCamAlt;
  uniform float uCapCos;   // cos kąta, poniżej którego glob zasłania nieprzezroczysta czasza regionu
  varying vec3 vDir;
  varying vec3 vRel;
  ${NOISE_GLSL}
  ${TERRAIN_GLSL}

  // Liczba oktaw dopasowana do rozmiaru piksela: szum drobniejszy niż piksel tylko by migotał
  float lodOctaves(vec3 dir, float baseFreq, float maxOct) {
    float fp = max(length(fwidth(dir)), 1e-7);
    return clamp(log2(0.5 / (baseFreq * fp)) + 1.0, 2.0, maxOct);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 dir = normalize(vDir);
    // pod środkiem czaszy regionu glob jest niewidoczny — oszczędzamy obliczenia
    if (dot(dir, uPadDir) > uCapCos) discard;
    float dist = length(vRel);
    vec3 V = -vRel / dist;
    float octaves = lodOctaves(dir, 1.6, 10.0);
    float h = terrainHeight(dir, octaves);
    float lat = dot(dir, uNorth);
    float absLat = abs(lat);

    // --- kolor powierzchni ---
    // wygładzona linia brzegowa: szerokość przejścia = zmiana wysokości na jeden piksel
    float aa = max(fwidth(h), 1e-4);
    float land = smoothstep(-aa, aa, h);
    float moist = fbm(dir * 3.3 + vec3(7.0), min(octaves, 3.0)) * 0.5 + 0.5 - absLat * 0.25;
    float depth = clamp(-h * 3.0, 0.0, 1.0);
    vec3 sea = mix(vec3(0.05, 0.32, 0.40), vec3(0.01, 0.05, 0.17), sqrt(depth));
    vec3 col = sea;
    {
      float e = clamp(h * 2.2, 0.0, 1.0);
      vec3 forest = vec3(0.05, 0.17, 0.04);
      vec3 grass = vec3(0.22, 0.33, 0.09);
      vec3 desert = vec3(0.72, 0.56, 0.33);
      vec3 rock = vec3(0.38, 0.34, 0.30);
      vec3 tundra = vec3(0.42, 0.42, 0.33);
      // pustynie w pasie zwrotnikowym, lasy przy wilgoci
      float dry = smoothstep(0.55, 0.35, moist) * (1.0 - smoothstep(0.55, 0.75, absLat));
      col = mix(grass, forest, smoothstep(0.45, 0.7, moist));
      col = mix(col, desert, dry);
      col = mix(col, tundra, smoothstep(0.62, 0.75, absLat));
      col = mix(col, rock, smoothstep(0.35, 0.6, e));
      col = mix(col, vec3(0.92), smoothstep(0.6, 0.8, e + absLat * 0.4)); // śnieg w górach
      // wybrzeża jaśniejsze (plaże)
      col = mix(vec3(0.72, 0.66, 0.52), col, smoothstep(0.0, 0.015, h));
      col = mix(sea, col, land);
    }
    // lód polarny (także lód morski)
    float ice = absLat > 0.8 ? smoothstep(0.86, 0.92, absLat + snoise(dir * 12.0) * 0.04) : 0.0;
    col = mix(col, vec3(0.93, 0.95, 0.98), ice);
    float waterAmt = (1.0 - land) * (1.0 - ice);

    // --- rzeźba terenu: bump z pochodnych ekranowych ---
    vec3 N = dir;
    if (land > 0.01) {
      vec3 dpdx = dFdx(vRel);
      vec3 dpdy = dFdy(vRel);
      float hScale = 9000.0; // amplituda rzeźby [m]
      float dhdx = dFdx(h) * hScale;
      float dhdy = dFdy(h) * hScale;
      vec3 r1 = cross(dpdy, N);
      vec3 r2 = cross(N, dpdx);
      float det = dot(dpdx, r1);
      if (abs(det) > 1e-6) {
        vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
        N = normalize(abs(det) * N - grad * land);
      }
    }

    // --- oświetlenie ---
    float ndlGeo = dot(dir, uSun);
    float day = smoothstep(-0.12, 0.18, ndlGeo);
    float diffuse = max(dot(N, uSun), 0.0);
    // cień chmur: gęstość chmur nad punktem przesuniętym w stronę słońca
    float shadow = 1.0;
    if (ndlGeo > -0.1) shadow -= 0.55 * cloudDensity(normalize(dir + uSun * 0.0012), min(octaves, 4.0));
    vec3 lit = col * (diffuse * 1.15 * shadow + 0.04) * day;

    // odblask słońca na wodzie
    if (waterAmt > 0.01) {
      vec3 H = normalize(uSun + V);
      float spec = pow(max(dot(dir, H), 0.0), 180.0) * 1.6 + pow(max(dot(dir, H), 0.0), 18.0) * 0.08;
      lit += vec3(1.0, 0.92, 0.75) * spec * day * shadow * waterAmt;
    }

    // łuna terminatora
    float term = smoothstep(-0.12, 0.0, ndlGeo) * (1.0 - smoothstep(0.0, 0.22, ndlGeo));
    lit += vec3(0.55, 0.22, 0.06) * term * 0.25;

    // światła miast po nocnej stronie (niziny przy wybrzeżach)
    if (land > 0.5 && day < 0.99) {
      float urban = smoothstep(0.55, 0.85, fbm(dir * 22.0, min(octaves, 5.0)) * 0.5 + 0.5);
      urban *= smoothstep(0.35, 0.05, h) * (1.0 - smoothstep(0.55, 0.7, absLat));
      float sparkle = smoothstep(0.3, 0.9, snoise(dir * 900.0) * 0.5 + 0.5);
      lit += vec3(1.0, 0.72, 0.38) * urban * (0.35 + 0.65 * sparkle) * (1.0 - day) * 0.9;
    }

    // rozproszenie atmosferyczne przy krawędzi tarczy (widok z orbity)
    float rim = pow(1.0 - max(dot(dir, V), 0.0), 5.0);
    vec3 haze = mix(vec3(0.85, 0.42, 0.18), vec3(0.42, 0.62, 1.0), smoothstep(-0.05, 0.3, ndlGeo));
    lit = mix(lit, haze * (0.15 + 0.85 * day), rim * 0.45 * smoothstep(-0.25, 0.1, ndlGeo));

    // mgła (gęsta przy ziemi, zanika z wysokością kamery)
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    lit = mix(lit, uFogColor, clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(lit, 1.0);
  }
`;

const CLOUD_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSun;
  uniform float uOpacity;
  varying vec3 vDir;
  varying vec3 vRel;
  ${NOISE_GLSL}
  ${TERRAIN_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    vec3 dir = normalize(vDir);
    float fp = max(length(fwidth(dir)), 1e-7);
    float d = cloudDensity(dir, clamp(log2(0.5 / (4.5 * fp)) + 1.0, 2.0, 7.0));
    if (d < 0.01) discard;
    float ndl = dot(dir, uSun);
    float day = smoothstep(-0.15, 0.2, ndl);
    // chmury przy terminatorze różowo-pomarańczowe
    vec3 tint = mix(vec3(1.0, 0.62, 0.42), vec3(1.0), smoothstep(0.0, 0.3, ndl));
    vec3 col = tint * (0.08 + 0.95 * day);
    gl_FragColor = vec4(col, d * 0.9 * uOpacity);
  }
`;

export class Earth {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly cloudMaterial: THREE.ShaderMaterial;
  private clouds: THREE.Mesh;

  constructor(sunDir: THREE.Vector3) {
    // Kosmodrom na 28,5° szerokości: oś biegunów nachylona w płaszczyźnie Y-Z
    const lat = (28.5 * Math.PI) / 180;
    const north = new THREE.Vector3(0, Math.sin(lat), Math.cos(lat));
    const shared = {
      uNorth: { value: north },
      uPadDir: { value: new THREE.Vector3(0, 1, 0) },
      uEast: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0 },
      uSun: { value: sunDir },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
      uniforms: {
        ...shared,
        uFogColor: { value: new THREE.Color() },
        uFogDensity: { value: 0 },
        uCamAlt: { value: 0 },
        // czasza regionu ma 0,05 rad, w pełni kryje do ~0,036 rad (dalej zanika alfą)
        uCapCos: { value: Math.cos(0.034) },
      },
      fog: false,
    });
    // geometria wyśrodkowana w zerze (pozycja = kierunek * promień); przesunięcie w mesh.position
    const globe = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH - 40, 384, 192), this.material);
    globe.name = 'Globe';
    globe.frustumCulled = false;
    this.group.add(globe);

    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: EARTH_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: { ...shared, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH + CLOUD_ALTITUDE, 256, 128), this.cloudMaterial);
    this.clouds.name = 'Clouds';
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 1;
    this.group.add(this.clouds);

    this.group.position.set(0, -R_EARTH, 0);
  }

  /** Aktualizacja mgły, czasu (dryf chmur) i widoczności chmur zależnie od wysokości kamery. */
  update(time: number, cameraAltitude: number, fogColor: THREE.Color, fogDensity: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uFogColor.value.copy(fogColor);
    u.uFogDensity.value = fogDensity;
    u.uCamAlt.value = cameraAltitude;
    // chmury widoczne z góry; z dołu (kamera pod warstwą) ich nie rysujemy
    const op = THREE.MathUtils.smoothstep(cameraAltitude, CLOUD_ALTITUDE + 500, CLOUD_ALTITUDE + 9_000);
    this.cloudMaterial.uniforms.uOpacity.value = op;
    this.clouds.visible = op > 0.001;
  }
}
