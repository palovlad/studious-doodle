import * as THREE from 'three';
import { R_EARTH } from '../sim/physics';
import { EARTH_CENTER, PAD_HEIGHT } from './scene';

/**
 * Autonomiczna barka lądowiskowa (ASDS) na oceanie: kadłub, pokład z oznaczeniem celu,
 * ściany osłonowe, pędniki i fragment oceanu wokół (globus ma zbyt mało szczegółów).
 *
 * Pokład leży na wysokości PAD_HEIGHT nad poziomem morza — tak samo jak stół startowy,
 * więc "wysokość 0" z fizyki oznacza poziom pokładu w obu miejscach.
 */

const DECK_LENGTH = 91;
const DECK_WIDTH = 52;

function makeDeckTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 586;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3b3d42';
  g.fillRect(0, 0, c.width, c.height);
  // ślady i przebarwienia po wcześniejszych lądowaniach
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`;
    const r = 10 + Math.random() * 60;
    g.beginPath();
    g.arc(Math.random() * c.width, Math.random() * c.height, r, 0, Math.PI * 2);
    g.fill();
  }
  const cx = c.width / 2;
  const cy = c.height / 2;
  const R = c.height * 0.36;
  g.strokeStyle = '#f2f2f2';
  g.lineWidth = 16;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.stroke();
  // znak X w kole
  g.lineWidth = 26;
  const k = R * 0.55;
  g.beginPath();
  g.moveTo(cx - k, cy - k);
  g.lineTo(cx + k, cy + k);
  g.moveTo(cx + k, cy - k);
  g.lineTo(cx - k, cy + k);
  g.stroke();
  // pasy ostrzegawcze przy krawędziach
  g.fillStyle = '#d9b11c';
  for (let x = 0; x < c.width; x += 48) {
    g.fillRect(x, 0, 24, 10);
    g.fillRect(x + 24, c.height - 10, 24, 10);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Radialna maska przezroczystości: lokalny ocean łagodnie przechodzi w globus. */
function makeFadeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.6, '#ffffff');
  grd.addColorStop(1, '#000000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export class DroneShip {
  readonly group = new THREE.Group();
  /** Środek pokładu w świecie (aktualizowany przez place()). */
  readonly deckCenter = new THREE.Vector3();
  /** Normalna pokładu w świecie. */
  readonly deckNormal = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = 'DroneShip';
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.7, metalness: 0.3 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a4d54, roughness: 0.6, metalness: 0.4 });
    const deckMat = new THREE.MeshStandardMaterial({ map: makeDeckTexture(), roughness: 0.8 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xd9b11c, roughness: 0.6 });

    // kadłub (oś długości wzdłuż X = kierunek lotu)
    const hull = new THREE.Mesh(new THREE.BoxGeometry(DECK_LENGTH, PAD_HEIGHT + 1.5, DECK_WIDTH), hullMat);
    hull.position.y = (PAD_HEIGHT - 1.5) / 2;
    hull.castShadow = hull.receiveShadow = true;
    this.group.add(hull);

    const deck = new THREE.Mesh(new THREE.PlaneGeometry(DECK_LENGTH - 1, DECK_WIDTH - 1), deckMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = PAD_HEIGHT + 0.02;
    deck.receiveShadow = true;
    this.group.add(deck);

    // ściany osłonowe na końcach pokładu
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 4.5, DECK_WIDTH * 0.8), wallMat);
      wall.position.set(sx * (DECK_LENGTH / 2 - 1), PAD_HEIGHT + 2.25, 0);
      wall.castShadow = true;
      this.group.add(wall);
    }
    // relingi wzdłuż burt
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(DECK_LENGTH - 4, 0.9, 0.2), accent);
      rail.position.set(0, PAD_HEIGHT + 0.45, sz * (DECK_WIDTH / 2 - 0.3));
      this.group.add(rail);
    }
    // pędniki azymutalne w narożnikach
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const pod = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 6), wallMat);
        pod.position.set(sx * (DECK_LENGTH / 2 - 4), PAD_HEIGHT + 2.5, sz * (DECK_WIDTH / 2 - 4));
        pod.castShadow = true;
        this.group.add(pod);
      }
    }
    // maszt z antenami
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 14, 8), wallMat);
    mast.position.set(-DECK_LENGTH / 2 + 3, PAD_HEIGHT + 7, DECK_WIDTH / 2 - 8);
    this.group.add(mast);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    );
    lamp.position.set(mast.position.x, PAD_HEIGHT + 14.2, mast.position.z);
    this.group.add(lamp);

    // lokalny ocean wokół barki (płynnie zanika na krawędziach)
    const ocean = new THREE.Mesh(
      new THREE.CircleGeometry(6_000, 64),
      new THREE.MeshStandardMaterial({
        color: 0x0f3a66,
        roughness: 0.35,
        metalness: 0.1,
        transparent: true,
        alphaMap: makeFadeTexture(),
        depthWrite: false,
      }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.receiveShadow = true;
    ocean.renderOrder = -1;
    this.group.add(ocean);
    // piana wokół kadłuba
    const foam = new THREE.Mesh(
      new THREE.RingGeometry(DECK_WIDTH * 0.55, DECK_WIDTH * 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0xdfe8ef, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    foam.rotation.x = -Math.PI / 2;
    foam.scale.set(1.4, 1, 1);
    foam.position.y = 0.05;
    this.group.add(foam);

    this.group.visible = false;
  }

  /** Ustawia barkę w punkcie oddalonym o `downrange` metrów od stanowiska (po powierzchni). */
  place(downrange: number) {
    const theta = downrange / R_EARTH;
    this.group.position.set(
      EARTH_CENTER.x + R_EARTH * Math.sin(theta),
      EARTH_CENTER.y + R_EARTH * Math.cos(theta),
      0,
    );
    this.group.rotation.set(0, 0, -theta);
    this.deckNormal.set(Math.sin(theta), Math.cos(theta), 0);
    this.deckCenter.copy(this.group.position).addScaledVector(this.deckNormal, PAD_HEIGHT);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}
