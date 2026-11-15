"use client";

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AdditiveBlending, BackSide, Vector3 } from "three";

const DEG = Math.PI / 180;
const CAMERA_DIST = 3.4;
const CAMERA_FOV = 36;
/** Sphere radius as a share of the canvas half-height, for turning drag pixels into degrees. */
const SPHERE_SCREEN = 1 / (CAMERA_DIST * Math.tan((CAMERA_FOV / 2) * DEG));
/** Pointer travel (px) below which a press counts as a click, not a drag. */
const CLICK_PX = 4;

/** Rows are the galactic x, y, z axes in ICRS equatorial coordinates. */
const GALACTIC = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];

/**
 * Sky direction as a scene vector (y = north). Seen from outside, with north up, RA grows to
 * the left just like on the map, so the globe never looks mirrored against it.
 */
function skyVector(ra: number, dec: number, r = 1) {
  const c = Math.cos(dec * DEG);
  return new Vector3(r * c * Math.cos(ra * DEG), r * Math.sin(dec * DEG), r * c * Math.sin(ra * DEG));
}

function skySpot(v: Vector3) {
  const n = v.clone().normalize();
  return {
    ra: ((Math.atan2(n.z, n.x) / DEG) % 360 + 360) % 360,
    dec: Math.asin(Math.max(-1, Math.min(1, n.y))) / DEG,
  };
}

function fromGalactic(l: number, b: number, r = 1) {
  const g = [Math.cos(b * DEG) * Math.cos(l * DEG), Math.cos(b * DEG) * Math.sin(l * DEG), Math.sin(b * DEG)];
  const [x, y, z] = [0, 1, 2].map((j) => GALACTIC[0][j] * g[0] + GALACTIC[1][j] * g[1] + GALACTIC[2][j] * g[2]);
  return new Vector3(x * r, z * r, y * r);
}

function galacticLatitude(ra: number, dec: number) {
  const c = Math.cos(dec * DEG);
  const e = [c * Math.cos(ra * DEG), c * Math.sin(ra * DEG), Math.sin(dec * DEG)];
  return Math.asin(GALACTIC[2][0] * e[0] + GALACTIC[2][1] * e[1] + GALACTIC[2][2] * e[2]) / DEG;
}

function milkyWayNote(ra: number, dec: number) {
  const b = Math.abs(galacticLatitude(ra, dec));
  if (b < 10) return "Inside the Milky Way band: packed with stars and dust";
  if (b < 30) return `${Math.round(b)}° from the Milky Way: stars, with galaxies peeking through`;
  return `${Math.round(b)}° from the Milky Way: a clear window to distant galaxies`;
}

/** Deterministic, so the Milky Way keeps its shape between visits. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pairs of points for `lineSegments`: latitude circles and meridians every 30°. */
function gridLines(equator: boolean) {
  const out: number[] = [];
  const add = (f: (t: number) => Vector3, n: number) => {
    for (let i = 0; i < n; i += 1) {
      const a = f(i / n);
      const b = f((i + 1) / n);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };
  if (equator) {
    add((t) => skyVector(t * 360, 0, 1.001), 120);
  } else {
    for (const dec of [-60, -30, 30, 60]) add((t) => skyVector(t * 360, dec, 1.001), 96);
    for (let ra = 0; ra < 360; ra += 30) add((t) => skyVector(ra, -90 + t * 180, 1.001), 48);
  }
  return new Float32Array(out);
}

/** Star dust along the galactic plane, densest and thickest toward the galactic center. */
function milkyWayDust(count: number) {
  const rand = mulberry32(7);
  const out: number[] = [];
  while (out.length < count * 3) {
    const l = rand() * 360;
    const dl = Math.min(l, 360 - l);
    if (rand() > 0.3 + 0.7 * Math.exp(-((dl / 60) ** 2))) continue;
    const spread = 3 + 5 * Math.exp(-((dl / 35) ** 2));
    const b = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand()) * spread;
    const v = fromGalactic(l, b, 1.004);
    out.push(v.x, v.y, v.z);
  }
  return new Float32Array(out);
}

/** Circle of angular radius `radius` degrees around a sky point, for `lineLoop`. */
function ringAround(ra: number, dec: number, radius: number) {
  const d = skyVector(ra, dec);
  const east = new Vector3(-Math.sin(ra * DEG), 0, Math.cos(ra * DEG));
  const north = d.clone().cross(east).negate().normalize();
  const out: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    const t = (i / 64) * 2 * Math.PI;
    const v = d
      .clone()
      .multiplyScalar(Math.cos(radius * DEG))
      .addScaledVector(east, Math.sin(radius * DEG) * Math.cos(t))
      .addScaledVector(north, Math.sin(radius * DEG) * Math.sin(t))
      .multiplyScalar(1.006);
    out.push(v.x, v.y, v.z);
  }
  return new Float32Array(out);
}

/** Turns the camera so the current view faces it, easing along the sphere on jumps. */
function Rig({ ra, dec }: { ra: number; dec: number }) {
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const want = useMemo(() => skyVector(ra, dec), [ra, dec]);
  useEffect(() => invalidate(), [want, invalidate]);
  useFrame(() => {
    const cur = camera.position.clone().normalize();
    const angle = cur.angleTo(want);
    if (angle > 1e-4) {
      const axis = cur.clone().cross(want);
      if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
      cur.applyAxisAngle(axis.normalize(), angle > 0.003 ? angle * 0.2 : angle);
      invalidate();
    }
    camera.position.copy(cur.multiplyScalar(CAMERA_DIST));
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

function Globe({
  ra,
  dec,
  fov,
  target,
  onPick,
}: {
  ra: number;
  dec: number;
  fov: number;
  target: { ra: number; dec: number } | null;
  onPick: (ra: number, dec: number) => void;
}) {
  const grid = useMemo(() => gridLines(false), []);
  const equator = useMemo(() => gridLines(true), []);
  const dust = useMemo(() => milkyWayDust(2600), []);
  const center = useMemo(() => fromGalactic(0, 0, 1.008), []);
  // At map zooms the true field is a speck on the globe; keep the marker readable.
  const ring = useMemo(() => ringAround(ra, dec, Math.max(5, fov * 0.75)), [ra, dec, fov]);
  const targetAt = useMemo(() => (target ? skyVector(target.ra, target.dec, 1.01) : null), [target]);

  return (
    <>
      <Rig ra={ra} dec={dec} />
      <mesh
        onClick={(event: ThreeEvent<MouseEvent>) => {
          if (event.delta > CLICK_PX) return;
          event.stopPropagation();
          const spot = skySpot(event.point);
          onPick(spot.ra, spot.dec);
        }}
      >
        <sphereGeometry args={[1, 48, 32]} />
        <meshBasicMaterial color="#08131c" />
      </mesh>
      <mesh raycast={() => null}>
        <sphereGeometry args={[1.07, 48, 32]} />
        <meshBasicMaterial color="#5ce1ff" transparent opacity={0.07} side={BackSide} depthWrite={false} />
      </mesh>
      <lineSegments raycast={() => null}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[grid, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#5ce1ff" transparent opacity={0.13} />
      </lineSegments>
      <lineSegments raycast={() => null}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[equator, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#5ce1ff" transparent opacity={0.35} />
      </lineSegments>
      <points raycast={() => null}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dust, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color="#d9e6ff"
          size={0.016}
          sizeAttenuation
          transparent
          opacity={0.55}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </points>
      <mesh position={center} raycast={() => null}>
        <sphereGeometry args={[0.028, 12, 8]} />
        <meshBasicMaterial color="#ffd59a" />
      </mesh>
      {targetAt ? (
        <mesh position={targetAt} raycast={() => null}>
          <sphereGeometry args={[0.022, 12, 8]} />
          <meshBasicMaterial color="#ffb050" />
        </mesh>
      ) : null}
      <lineLoop key={`${ra}|${dec}|${fov}`} raycast={() => null}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[ring, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#5ce1ff" />
      </lineLoop>
    </>
  );
}

/**
 * Small celestial globe showing where the map is pointing: grid, Milky Way, galactic center.
 * Drag it to turn the sky under the map; click a spot to fly there.
 */
export default function SkyGlobe({
  ra,
  dec,
  fov,
  target,
  onNavigate,
}: {
  ra: number;
  dec: number;
  fov: number;
  target: { ra: number; dec: number } | null;
  onNavigate: (ra: number, dec: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [initial] = useState(() => skyVector(ra, dec, CAMERA_DIST));

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY, ra, dec };
    const radiusPx = ((box.current?.clientWidth ?? 150) / 2) * SPHERE_SCREEN;
    let dragging = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < CLICK_PX) return;
      dragging = true;
      const cos = Math.max(0.2, Math.cos(start.dec * DEG));
      onNavigate(start.ra + dx / radiusPx / DEG / cos, start.dec + dy / radiusPx / DEG);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return (
    <figure
      className="sky-map-globe"
      data-tour="globe"
      onPointerDown={onPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div ref={box} className="sky-map-globe-view" title="Drag to turn the sky · click to fly there">
        <Canvas
          frameloop="demand"
          dpr={[1, 2]}
          camera={{ position: initial, fov: CAMERA_FOV, near: 0.1, far: 20 }}
          gl={{ antialias: true, alpha: true }}
        >
          <Globe ra={ra} dec={dec} fov={fov} target={target} onPick={onNavigate} />
        </Canvas>
      </div>
      <figcaption>{milkyWayNote(ra, dec)}</figcaption>
    </figure>
  );
}
