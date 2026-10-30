import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  FlightSim,
  R_EARTH,
  airDensity,
  attitudeVector,
  localFrame,
  type FlightEvent,
  type Vec2,
} from './sim/physics';
import { FalconRocket } from './gfx/rocket';
import { ExhaustSystem, type Emitter } from './gfx/particles';
import { World, EARTH_CENTER, simToWorld } from './gfx/scene';
import { DroneShip } from './gfx/droneship';
import { Hud, type CameraMode } from './ui/hud';

// ---------------------------------------------------------------------------
// Renderer i kamera
// ---------------------------------------------------------------------------

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.domElement.classList.add('gl');
app.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 3e7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 12;
controls.maxDistance = 2e6;
controls.zoomSpeed = 1.4;

// ---------------------------------------------------------------------------
// Świat, rakieta, efekty, symulacja
// ---------------------------------------------------------------------------

const world = new World();
const scene = world.scene;

const rocket = new FalconRocket();
scene.add(rocket.group);

const exhaust = new ExhaustSystem();
scene.add(exhaust.group);
// osobny system cząsteczek dla odzyskiwanego I stopnia (leci niezależnie od II stopnia)
const boosterExhaust = new ExhaustSystem(5000, 5000);
scene.add(boosterExhaust.group);

const droneShip = new DroneShip();
scene.add(droneShip.group);

const PAD_GROUND = new THREE.Vector3(0, 1.25, 0);
const UP = new THREE.Vector3(0, 1, 0);
const TRENCH_AXIS = new THREE.Vector3(0, 0, 1);

// Znacznik pozycji rakiety widoczny z dużej odległości (rakieta ma wtedy < 1 px)
function makeMarkerTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,240,200,1)');
  grd.addColorStop(0.25, 'rgba(255,190,90,0.9)');
  grd.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const marker = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: makeMarkerTexture(),
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }),
);
marker.scale.setScalar(0.035);
marker.renderOrder = 5;
scene.add(marker);

// Poświata płomienia oświetlająca stanowisko i kadłub
const flameLight = new THREE.PointLight(0xffa04a, 0, 0, 2);
scene.add(flameLight);

const sim = new FlightSim();
let warp = 1;
let cameraMode: CameraMode = 'chase';
let stage1Detached = false;
let rocketDestroyed = false;

interface Debris {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
}
const debris: Debris[] = [];

const hud = new Hud(document.body, {
  onLaunch: () => sim.launch(),
  onAbort: () => sim.abort(),
  onReset: () => resetAll(),
  onThrottle: (v) => sim.setThrottle(v),
  onCamera: (m) => setCameraMode(m),
  onWarp: (w) => (warp = w),
  onBoosterReserve: (f) => sim.setBoosterReserve(f),
  onLandingThrottle: (v) => sim.setLandingThrottle(v),
});

sim.on(handleEvent);

// ---------------------------------------------------------------------------
// Zdarzenia misji -> grafika
// ---------------------------------------------------------------------------

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function worldVel(v: Vec2, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.y, 0);
}

function handleEvent(ev: FlightEvent, t: number) {
  const s = sim.state;
  let detail: string | undefined;
  if (ev === 'LANDING_FAIL') detail = s.booster.failure;
  if (ev === 'LANDED') {
    const b = s.booster;
    detail = `${b.touchdownVertical.toFixed(1)} m/s, ${b.touchdownMiss.toFixed(0)} m od środka, zostało ${(b.prop / 1000).toFixed(1)} t paliwa`;
  }
  if (ev === 'LANDING_BURN') detail = `${s.booster.engines} ${s.booster.engines === 1 ? 'silnik' : 'silniki'}`;
  hud.event(ev, t, detail);
  switch (ev) {
    case 'STAGE_SEP':
      rocket.detachStage1(scene);
      stage1Detached = true;
      // barka czeka w przewidywanym miejscu lądowania
      droneShip.place(s.booster.shipDownrange);
      break;
    case 'FAIRING_SEP': {
      rocket.group.updateMatrixWorld(true);
      const q = rocket.group.getWorldQuaternion(new THREE.Quaternion());
      rocket.fairingHalves.forEach((half, i) => {
        scene.attach(half);
        const side = new THREE.Vector3(i === 0 ? 1 : -1, 0, 0).applyQuaternion(q);
        const vel = worldVel(s.vel).add(side.multiplyScalar(5));
        const spin = new THREE.Vector3(0, 0, (i === 0 ? -1 : 1) * 0.35).applyQuaternion(q);
        debris.push({ obj: half, vel, spin, age: 0 });
      });
      break;
    }
    case 'IMPACT':
      rocket.group.updateMatrixWorld(true);
      exhaust.burst(rocket.group.position.clone(), 2);
      rocket.group.visible = false;
      rocketDestroyed = true;
      break;
    case 'LANDING_FAIL': {
      // wybuch w środku zbiorników I stopnia
      const b = s.booster;
      const axis = attitudeVector(b.pos, b.pitch);
      const at = rocket.stage1.position.clone().add(tmpV.set(axis.x * 12, axis.y * 12, 0));
      boosterExhaust.burst(at, 1.6);
      rocket.stage1.visible = false;
      break;
    }
    default:
      break;
  }
}

function resetAll() {
  sim.reset();
  for (const d of debris) scene.remove(d.obj);
  debris.length = 0;
  rocket.reassemble();
  rocket.group.visible = true;
  rocket.stage1.visible = true;
  stage1Detached = false;
  rocketDestroyed = false;
  exhaust.clear();
  boosterExhaust.clear();
  droneShip.hide();
  hud.resetUi();
  sim.setThrottle(1);
  setCameraMode(cameraMode, true);
}

// ---------------------------------------------------------------------------
// Kamery
// ---------------------------------------------------------------------------

const focus = new THREE.Vector3();
const prevFocus = new THREE.Vector3();
const groundCamPos = new THREE.Vector3(260, 3.5, 820);
let wideDistance = 400;

function computeFocus(out: THREE.Vector3): THREE.Vector3 {
  const s = sim.state;
  if (cameraMode === 'booster' && stage1Detached) {
    // środek I stopnia (~22 m nad dyszami)
    const b = s.booster;
    const ax = attitudeVector(b.pos, b.pitch);
    return simToWorld(b.pos, out).add(tmpV2.set(ax.x * 22, ax.y * 22, 0));
  }
  const axis = attitudeVector(s.pos, s.pitch);
  // środek ciężkości wizualnej: ~35 m nad dyszami (całość) lub ~55 m (sam II stopień)
  const off = stage1Detached ? 55 : 35;
  return simToWorld(s.pos, out).add(tmpV2.set(axis.x * off, axis.y * off, 0));
}

function setCameraMode(m: CameraMode, force = false) {
  const changed = m !== cameraMode;
  cameraMode = m;
  hud.setCamera(m);
  computeFocus(focus);
  prevFocus.copy(focus);
  camera.up.set(0, 1, 0);
  const orbitable = m === 'chase' || m === 'booster';
  if (orbitable && (changed || force)) {
    const up = tmpV.copy(focus).sub(EARTH_CENTER).normalize();
    const offset = m === 'booster' ? new THREE.Vector3(-40, 0, 110) : new THREE.Vector3(60, 0, 150);
    camera.position.copy(focus).add(offset).addScaledVector(up, m === 'booster' ? 25 : -6);
    camera.up.copy(up);
    controls.target.copy(focus);
  }
  controls.enabled = orbitable;
  camera.fov = 50;
  camera.updateProjectionMatrix();
}

function updateCamera(dt: number) {
  computeFocus(focus);
  const up = tmpV.copy(focus).sub(EARTH_CENTER).normalize();

  switch (cameraMode) {
    case 'booster':
    case 'chase': {
      // kamera porusza się razem z rakietą; użytkownik może obracać i przybliżać
      camera.position.add(tmpV2.copy(focus).sub(prevFocus));
      controls.target.copy(focus);
      camera.up.lerp(up, Math.min(1, dt * 2)).normalize();
      controls.update();
      if (camera.fov !== 50) {
        camera.fov = 50;
        camera.updateProjectionMatrix();
      }
      break;
    }
    case 'onboard': {
      const g = rocket.group;
      g.updateMatrixWorld(true);
      // kamera na zewnątrz kadłuba patrząca w dół wzdłuż rakiety (jak transmisje SpaceX)
      const localPos = stage1Detached ? new THREE.Vector3(2.5, 58, 0.6) : new THREE.Vector3(2.4, 47, 0.6);
      const localLook = stage1Detached ? new THREE.Vector3(1.0, 35, 0) : new THREE.Vector3(1.2, 0, 0);
      camera.position.copy(localPos).applyMatrix4(g.matrixWorld);
      const look = localLook.applyMatrix4(g.matrixWorld);
      camera.up.set(1, 0, 0).transformDirection(g.matrixWorld);
      camera.lookAt(look);
      if (camera.fov !== 75) {
        camera.fov = 75;
        camera.updateProjectionMatrix();
      }
      break;
    }
    case 'ground': {
      // stała kamera śledząca z teleobiektywem dobieranym do odległości
      camera.position.copy(groundCamPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(focus);
      const dist = groundCamPos.distanceTo(focus);
      const fov = THREE.MathUtils.clamp((2 * Math.atan(60 / dist) * 180) / Math.PI, 0.4, 50);
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
      camera.updateProjectionMatrix();
      break;
    }
    case 'wide': {
      // widok z boku trajektorii; oddala się wraz z wysokością, pokazując krzywiznę Ziemi
      const alt = sim.state.telemetry.altitude;
      const target = THREE.MathUtils.clamp(300 + alt * 2.2, 300, 900_000);
      wideDistance += (target - wideDistance) * Math.min(1, dt * 1.5);
      const { east } = localFrame(sim.state.pos);
      camera.position
        .copy(focus)
        .add(new THREE.Vector3(0, 0, wideDistance))
        .addScaledVector(up, wideDistance * 0.12)
        .addScaledVector(new THREE.Vector3(east.x, east.y, 0), -wideDistance * 0.25);
      camera.up.copy(up);
      camera.lookAt(focus);
      if (camera.fov !== 50) {
        camera.fov = 50;
        camera.updateProjectionMatrix();
      }
      break;
    }
  }
  prevFocus.copy(focus);
}

// ---------------------------------------------------------------------------
// Synchronizacja grafiki ze stanem symulacji
// ---------------------------------------------------------------------------

const nozzleBuf: THREE.Vector3[] = [];
const emitters: Emitter[] = [];

function placeBody(obj: THREE.Object3D, pos: Vec2, pitch: number) {
  simToWorld(pos, obj.position);
  const axis = attitudeVector(pos, pitch);
  obj.rotation.set(0, 0, Math.atan2(-axis.x, axis.y));
}

function syncGraphics(realDt: number) {
  const s = sim.state;
  if (!rocketDestroyed) placeBody(rocket.group, s.pos, s.pitch);

  // odłączony I stopień
  const b = s.booster;
  if (stage1Detached && rocket.stage1.visible) {
    placeBody(rocket.stage1, b.pos, b.pitch);
    rocket.setGridFins(b.gridFinsDeployed);
    rocket.setLegs(b.legsDeployed);
  }
  rocket.update(realDt);

  // dysze i cząsteczki
  const intensity = rocketDestroyed ? 0 : s.telemetry.thrustFraction * (s.throttle > 0 ? 1 : 0);
  const boosterBurning = stage1Detached && rocket.stage1.visible && b.engines > 0 && b.throttle > 0.01;
  if (stage1Detached) {
    rocket.setEngineGlow(boosterBurning ? b.throttle : 0, s.stage === 2 ? intensity : 0, b.engines);
  } else {
    rocket.setEngineGlow(s.stage === 1 ? intensity : 0, 0);
  }
  updateBoosterExhaust(realDt, boosterBurning);

  emitters.length = 0;
  if (intensity > 0.01) {
    rocket.nozzleWorldPositions(s.stage, nozzleBuf);
    const axis = attitudeVector(s.pos, s.pitch);
    const dir = new THREE.Vector3(-axis.x, -axis.y, 0);
    const vel = worldVel(s.vel).multiplyScalar(warp);
    for (const p of nozzleBuf) {
      emitters.push({ position: p, direction: dir, velocity: vel, intensity, radius: s.stage === 1 ? 0.45 : 1.4 });
    }
  }
  const air = s.telemetry.airDensity / 1.225;
  exhaust.update(realDt, emitters, {
    airRatio: air,
    groundPoint: PAD_GROUND,
    groundNormal: UP,
    deflectAxis: TRENCH_AXIS,
    steam: true,
    anchor: rocket.group.position,
  });

  // światło płomienia
  if (intensity > 0.01 && nozzleBuf.length) {
    flameLight.position.copy(nozzleBuf[0]).add(tmpV.set(0, -8, 0));
    flameLight.intensity = 2500 * intensity * (s.stage === 1 ? 1 : 0.4);
  } else {
    flameLight.intensity = 0;
  }

  // szczątki (połówki owiewki)
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    const simDt = realDt * warp;
    d.age += simDt;
    const g = tmpV.copy(d.obj.position).sub(EARTH_CENTER).normalize().multiplyScalar(-9.6 * simDt);
    d.vel.add(g);
    d.obj.position.addScaledVector(d.vel, simDt);
    d.obj.rotateOnWorldAxis(tmpV2.copy(d.spin).normalize(), d.spin.length() * simDt);
    if (d.age > 40) {
      scene.remove(d.obj);
      debris.splice(i, 1);
    }
  }
}

const boosterNozzles: THREE.Vector3[] = [];
const boosterEmitters: Emitter[] = [];

/** Płomień silników I stopnia podczas entry burn (3 silniki) i landing burn (1 silnik). */
function updateBoosterExhaust(realDt: number, burning: boolean) {
  const b = sim.state.booster;
  boosterEmitters.length = 0;
  if (burning) {
    rocket.nozzleWorldPositions(1, boosterNozzles, b.engines);
    const axis = attitudeVector(b.pos, b.pitch);
    const dir = new THREE.Vector3(-axis.x, -axis.y, 0);
    const vel = worldVel(b.vel).multiplyScalar(warp);
    for (const p of boosterNozzles) {
      boosterEmitters.push({ position: p, direction: dir, velocity: vel, intensity: b.throttle, radius: 0.45 });
    }
  }
  const alt = Math.hypot(b.pos.x, b.pos.y) - R_EARTH;
  const shipVisible = droneShip.group.visible;
  boosterExhaust.update(realDt, boosterEmitters, {
    airRatio: airDensity(alt) / 1.225,
    groundPoint: shipVisible ? droneShip.deckCenter : PAD_GROUND,
    groundNormal: shipVisible ? droneShip.deckNormal : UP,
    anchor: rocket.stage1.position,
  });
}

function updateMarker() {
  const target = rocketDestroyed ? null : rocket.group;
  if (!target) {
    marker.visible = false;
    return;
  }
  marker.position.copy(focus);
  const d = camera.position.distanceTo(focus);
  // widoczny, gdy rakieta jest mniejsza niż kilka pikseli
  const pxHeight = (70 / d) * (renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360)));
  marker.visible = pxHeight < 6;
}

// ---------------------------------------------------------------------------
// Pętla
// ---------------------------------------------------------------------------

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // przesunięcie kadru w górę, by rakieta nie chowała się za panelem sterowania
  camera.setViewOffset(w, h, 0, Math.round(h * 0.1), w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

onResize();
setCameraMode('chase', true);

const timer = new THREE.Timer();
function frame(time: number) {
  timer.update(time);
  const realDt = Math.min(timer.getDelta(), 0.1);
  sim.step(realDt * warp);
  syncGraphics(realDt);
  updateCamera(realDt);
  updateMarker();
  world.update(camera, focus);
  exhaust.setViewport(renderer.domElement.height, camera.fov);
  hud.update(sim.state, realDt);
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(frame);
document.querySelector('.loading')?.classList.add('done');
setTimeout(() => document.querySelector('.loading')?.remove(), 700);

// Dostęp z konsoli przeglądarki (debug)
Object.assign(window as unknown as Record<string, unknown>, { falconSim: sim });
