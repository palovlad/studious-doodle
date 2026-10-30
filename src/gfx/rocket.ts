import * as THREE from 'three';

/**
 * Proceduralny model Falcon 9 w skali 1:1 (metry), zbudowany z prymitywów Three.js.
 * Początek układu (0,0,0) leży na wylotach dysz silników I stopnia, oś +Y to oś rakiety.
 *
 * Wymiary (przybliżone):
 *   - I stopień: 41 m, średnica 3,66 m, 9 silników Merlin 1D w układzie Octaweb
 *   - interstage: ~6,5 m (czarny kompozyt) + 4 tytanowe grid fins
 *   - II stopień: ~8 m + dysza MVac schowana w interstage
 *   - owiewka: średnica 5,2 m, wysokość ~13 m
 */

export const STAGE1_TOP = 42.6;
export const INTERSTAGE_TOP = 49.2;
export const ROCKET_HEIGHT = 70;
const R = 1.83;

const mat = {
  white: new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.45, metalness: 0.05 }),
  black: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.6, metalness: 0.2 }),
  darkGrey: new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.5, metalness: 0.6 }),
  engine: new THREE.MeshStandardMaterial({
    color: 0x3b3430,
    roughness: 0.35,
    metalness: 0.85,
    side: THREE.DoubleSide,
  }),
  mvac: new THREE.MeshStandardMaterial({
    color: 0x4a3f36,
    roughness: 0.3,
    metalness: 0.9,
    side: THREE.DoubleSide,
  }),
  titanium: new THREE.MeshStandardMaterial({ color: 0x8a8d93, roughness: 0.35, metalness: 0.9 }),
  leg: new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.55, metalness: 0.3 }),
  glow: new THREE.MeshBasicMaterial({ color: 0xffc27a }),
};

function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return o;
}

/** Tekstura kadłuba I stopnia z pionowym napisem i paskami. */
function makeBodyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 2048;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f3f5';
  g.fillRect(0, 0, c.width, c.height);
  // delikatne szwy sekcji zbiorników
  g.fillStyle = 'rgba(0,0,0,0.06)';
  for (let y = 120; y < c.height; y += 260) g.fillRect(0, y, c.width, 4);
  // ślady sadzy u dołu (po locie wielokrotnym)
  const grd = g.createLinearGradient(0, c.height, 0, c.height - 500);
  grd.addColorStop(0, 'rgba(40,36,32,0.35)');
  grd.addColorStop(1, 'rgba(40,36,32,0)');
  g.fillStyle = grd;
  g.fillRect(0, c.height - 500, c.width, 500);
  // napis pionowy
  g.save();
  g.translate(c.width * 0.25, c.height * 0.55);
  g.rotate(-Math.PI / 2);
  g.fillStyle = '#16171a';
  g.font = 'bold 120px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('FALCON 9', 0, 0);
  g.restore();
  // flaga / znacznik
  g.fillStyle = '#16171a';
  g.fillRect(c.width * 0.75 - 40, 300, 80, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Dzwon dyszy jako bryła obrotowa (LatheGeometry). */
function nozzleGeometry(exitR: number, throatR: number, length: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // profil paraboliczny od gardła (góra) do wylotu (dół)
    const r = throatR + (exitR - throatR) * Math.pow(t, 0.7);
    pts.push(new THREE.Vector2(r, length * (1 - t)));
  }
  return new THREE.LatheGeometry(pts, 32);
}

function makeGridFin(): THREE.Group {
  const fin = new THREE.Group();
  const w = 1.2;
  const h = 1.5;
  const bar = 0.06;
  const depth = 0.25;
  const frameParts: [number, number, number, number][] = [
    [0, h / 2, w, bar],
    [0, -h / 2, w, bar],
    [-w / 2, 0, bar, h],
    [w / 2, 0, bar, h],
  ];
  for (const [x, y, sw, sh] of frameParts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, depth), mat.titanium);
    m.position.set(x, y, 0);
    fin.add(m);
  }
  // kratownica (pochylona o 45°)
  const lattice = new THREE.Group();
  const lw = 0.025;
  for (let i = -5; i <= 5; i++) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(lw, 2.2, depth * 0.9), mat.titanium);
    a.position.x = i * 0.18;
    a.rotation.z = Math.PI / 4;
    const b = a.clone();
    b.rotation.z = -Math.PI / 4;
    lattice.add(a, b);
  }
  // przycinamy kratę do ramki przez clipping lokalny — zamiast tego skalujemy grupę
  lattice.scale.set(0.5, 0.62, 1);
  fin.add(lattice);
  // ramię mocujące
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.6), mat.darkGrey);
  arm.position.set(0, -h / 2 - 0.05, -0.3);
  fin.add(arm);
  return fin;
}

function makeLandingLeg(): THREE.Group {
  const leg = new THREE.Group();
  const length = 9.5;
  // płaska, lekko zwężająca się noga z włókna węglowego
  const shape = new THREE.Shape();
  shape.moveTo(-0.45, 0);
  shape.lineTo(0.45, 0);
  shape.lineTo(0.3, length);
  shape.lineTo(-0.3, length);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false });
  geo.translate(0, 0, -0.175);
  const m = new THREE.Mesh(geo, mat.leg);
  leg.add(m);
  // stopa
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.2, 16), mat.darkGrey);
  foot.position.y = length;
  leg.add(foot);
  // teleskopowy amortyzator
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6, 8), mat.titanium);
  strut.position.set(0, length * 0.55, -0.35);
  leg.add(strut);
  return leg;
}

export class FalconRocket {
  readonly group = new THREE.Group();
  readonly stage1 = new THREE.Group();
  readonly stage2 = new THREE.Group();
  readonly fairingHalves: THREE.Group[] = [];
  readonly gridFins: THREE.Group[] = [];
  readonly legs: THREE.Group[] = [];
  /** Lokalne pozycje wylotów dysz I stopnia (względem stage1). */
  readonly stage1Nozzles: THREE.Vector3[] = [];
  /** Lokalna pozycja wylotu dyszy MVac (względem stage2). */
  readonly mvacNozzle = new THREE.Vector3(0, STAGE1_TOP + 0.4, 0);

  private finDeploy = 0;
  private legDeploy = 0;
  private finTarget = 0;
  private legTarget = 0;
  private engineGlows: THREE.Mesh[] = [];
  private mvacGlow: THREE.Mesh;

  constructor() {
    this.group.name = 'Falcon9';
    this.buildStage1();
    this.mvacGlow = this.buildStage2();
    this.group.add(this.stage1, this.stage2);
    shadowed(this.group);
  }

  private buildStage1() {
    const s1 = this.stage1;
    s1.name = 'Stage1';

    // Kadłub z teksturą
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, STAGE1_TOP - 1.4, 48, 1, true),
      new THREE.MeshStandardMaterial({ map: makeBodyTexture(), roughness: 0.45, metalness: 0.05 }),
    );
    body.position.y = 1.4 + (STAGE1_TOP - 1.4) / 2;
    s1.add(body);

    // Osłona termiczna / Octaweb (dno)
    const octaweb = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.98, 1.0, 48), mat.darkGrey);
    octaweb.position.y = 1.9;
    s1.add(octaweb);
    const heatShield = new THREE.Mesh(new THREE.CircleGeometry(R * 0.98, 48), mat.black);
    heatShield.rotation.x = Math.PI / 2;
    heatShield.position.y = 1.4;
    s1.add(heatShield);

    // 9 silników Merlin: 8 po okręgu + 1 centralny
    const positions: [number, number][] = [[0, 0]];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      positions.push([Math.cos(a) * 1.22, Math.sin(a) * 1.22]);
    }
    const nozzleGeo = nozzleGeometry(0.46, 0.18, 1.5);
    for (const [x, z] of positions) {
      const n = new THREE.Mesh(nozzleGeo, mat.engine);
      n.position.set(x, 0, z);
      s1.add(n);
      // żarząca się wewnętrzna część dyszy (widoczna przy pracy silników)
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), mat.glow.clone());
      glow.rotation.x = Math.PI / 2;
      glow.position.set(x, 0.05, z);
      glow.visible = false;
      s1.add(glow);
      this.engineGlows.push(glow);
      this.stage1Nozzles.push(new THREE.Vector3(x, -0.05, z));
    }

    // Interstage
    const inter = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, INTERSTAGE_TOP - STAGE1_TOP, 48, 1, true),
      mat.black,
    );
    inter.position.y = (STAGE1_TOP + INTERSTAGE_TOP) / 2;
    s1.add(inter);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.03, R + 0.03, 0.3, 48), mat.darkGrey);
    ring.position.y = STAGE1_TOP;
    s1.add(ring);

    // Grid fins (4 szt.) na górze interstage
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const pivot = new THREE.Group();
      pivot.position.set(Math.cos(a) * (R + 0.05), INTERSTAGE_TOP - 1.0, Math.sin(a) * (R + 0.05));
      pivot.rotation.y = -a + Math.PI / 2;
      const fin = makeGridFin();
      // złożona: płasko przy kadłubie, rozłożona: prostopadle (oś zawiasu u dołu)
      fin.position.set(0, -0.75, 0.15);
      const hinge = new THREE.Group();
      hinge.add(fin);
      fin.position.y = 0.75;
      hinge.position.y = -1.5;
      pivot.add(hinge);
      s1.add(pivot);
      this.gridFins.push(hinge);
    }

    // Nogi do lądowania (4 szt.) — zawias u podstawy, złożone wzdłuż kadłuba
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const pivot = new THREE.Group();
      pivot.position.set(Math.cos(a) * (R + 0.18), 1.6, Math.sin(a) * (R + 0.18));
      pivot.rotation.y = -a + Math.PI / 2;
      const hinge = new THREE.Group();
      hinge.add(makeLandingLeg());
      pivot.add(hinge);
      s1.add(pivot);
      this.legs.push(hinge);
      // obudowa zawiasu
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.4), mat.darkGrey);
      box.position.set(Math.cos(a) * (R + 0.1), 1.7, Math.sin(a) * (R + 0.1));
      box.rotation.y = -a + Math.PI / 2;
      s1.add(box);
    }

    // Raceway — przewody biegnące wzdłuż kadłuba
    const raceway = new THREE.Mesh(new THREE.BoxGeometry(0.25, STAGE1_TOP - 3, 0.18), mat.white);
    raceway.position.set(0, STAGE1_TOP / 2 + 1.2, R + 0.05);
    s1.add(raceway);

    this.applyDeploy();
  }

  private buildStage2(): THREE.Mesh {
    const s2 = this.stage2;
    s2.name = 'Stage2';

    // Dysza MVac — duża, ukryta w interstage
    const mvac = new THREE.Mesh(nozzleGeometry(1.5, 0.3, 5.6), mat.mvac);
    mvac.position.y = STAGE1_TOP + 0.4;
    s2.add(mvac);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(1.4, 32), mat.glow.clone());
    glow.rotation.x = Math.PI / 2;
    glow.position.y = STAGE1_TOP + 0.5;
    glow.visible = false;
    s2.add(glow);

    const engineBlock = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.45, 1.2, 16), mat.darkGrey);
    engineBlock.position.y = STAGE1_TOP + 6.4;
    s2.add(engineBlock);

    // Kadłub II stopnia
    const top2 = INTERSTAGE_TOP + 7.6;
    const body2 = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, top2 - (INTERSTAGE_TOP - 1.2), 48),
      mat.white,
    );
    body2.position.y = (top2 + INTERSTAGE_TOP - 1.2) / 2;
    s2.add(body2);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.02, R + 0.02, 0.4, 48), mat.black);
    band.position.y = top2 - 0.6;
    s2.add(band);

    // Owiewka: dwie połówki (cylinder + ogiwa + przejście stożkowe)
    const fR = 2.6;
    const baseY = top2;
    const pts: THREE.Vector2[] = [];
    pts.push(new THREE.Vector2(R, 0));
    pts.push(new THREE.Vector2(fR, 0.9));
    pts.push(new THREE.Vector2(fR, 7.4));
    const ogiveLen = 5.6;
    const n = 20;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      // profil ogiwy stycznej
      const r = fR * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.08 * t);
      pts.push(new THREE.Vector2(Math.max(r, 0.001), 7.4 + ogiveLen * t));
    }
    for (let h = 0; h < 2; h++) {
      const geo = new THREE.LatheGeometry(pts, 32, h * Math.PI, Math.PI);
      const half = new THREE.Group();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0xf4f5f7,
        roughness: 0.4,
        metalness: 0.05,
        side: THREE.DoubleSide,
      }));
      half.add(mesh);
      half.position.y = baseY;
      s2.add(half);
      this.fairingHalves.push(half);
    }
    // ładunek (widoczny po zrzuceniu owiewki)
    const payload = new THREE.Group();
    const adapter = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.6, 1.2, 24), mat.darkGrey);
    adapter.position.y = baseY + 0.6;
    const sat = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 4.0, 2.6),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.8 }),
    );
    sat.position.y = baseY + 3.3;
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 3.6, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x1b2a55, roughness: 0.2, metalness: 0.6 }),
    );
    panel.position.set(1.4, baseY + 3.3, 0);
    const panel2 = panel.clone();
    panel2.position.x = -1.4;
    payload.add(adapter, sat, panel, panel2);
    s2.add(payload);

    return glow;
  }

  setGridFins(deployed: boolean) {
    this.finTarget = deployed ? 1 : 0;
  }

  setLegs(deployed: boolean) {
    this.legTarget = deployed ? 1 : 0;
  }

  /** Włącza poświatę dysz proporcjonalnie do ciągu. */
  setEngineGlow(stage1: number, stage2: number) {
    for (const g of this.engineGlows) {
      g.visible = stage1 > 0.01;
      (g.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.6 + 0.3 * stage1, 0.3 + 0.4 * stage1);
    }
    this.mvacGlow.visible = stage2 > 0.01;
  }

  /** Animacja rozkładania elementów; wywoływać co klatkę. */
  update(dt: number) {
    const k = Math.min(1, dt * 1.2);
    this.finDeploy += (this.finTarget - this.finDeploy) * k;
    this.legDeploy += (this.legTarget - this.legDeploy) * Math.min(1, dt * 0.8);
    this.applyDeploy();
  }

  private applyDeploy() {
    for (const f of this.gridFins) f.rotation.x = (Math.PI / 2) * this.finDeploy;
    // nogi: złożone wzdłuż kadłuba (w górę), rozłożone ~ 115° na zewnątrz i w dół
    for (const l of this.legs) l.rotation.x = (115 * Math.PI) / 180 * this.legDeploy;
  }

  /** Odłącza I stopień jako osobny obiekt (zachowując transformację świata). */
  detachStage1(scene: THREE.Object3D): THREE.Group {
    scene.attach(this.stage1);
    return this.stage1;
  }

  /** Przywraca kompletną rakietę (reset symulacji). */
  reassemble() {
    this.group.add(this.stage1);
    this.stage1.position.set(0, 0, 0);
    this.stage1.quaternion.identity();
    this.stage1.scale.set(1, 1, 1);
    for (const h of this.fairingHalves) {
      this.stage2.add(h);
      h.position.set(0, h.position.y, 0);
      h.quaternion.identity();
    }
    this.fairingHalves.forEach((h) => (h.position.y = INTERSTAGE_TOP + 7.6));
    this.finDeploy = this.finTarget = 0;
    this.legDeploy = this.legTarget = 0;
    this.applyDeploy();
  }

  /** Zwraca światowe pozycje wylotów dysz danego stopnia. */
  nozzleWorldPositions(stage: 1 | 2, out: THREE.Vector3[] = []): THREE.Vector3[] {
    out.length = 0;
    if (stage === 1) {
      this.stage1.updateWorldMatrix(true, false);
      for (const p of this.stage1Nozzles) out.push(p.clone().applyMatrix4(this.stage1.matrixWorld));
    } else {
      this.stage2.updateWorldMatrix(true, false);
      out.push(this.mvacNozzle.clone().applyMatrix4(this.stage2.matrixWorld));
    }
    return out;
  }
}
