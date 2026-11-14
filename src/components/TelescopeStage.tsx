"use client";

import { Center, Environment, useGLTF, useProgress, useTexture } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  NearestFilter,
  SRGBColorSpace,
  Vector3,
  type Group,
  type Mesh,
  type PointLight,
} from "three";

type Drag = { x: number; y: number; active: boolean };

const STORY = 0.8;

function smooth(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

const STAR_COLORS = ["#f4fafc", "#7ee7ff", "#5ce1ff", "#3aa7c4", "#e2cfea"].map((hex) => new Color(hex));

function scatter(count: number, near: number, far: number) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const radius = near + Math.random() * (far - near);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta) * 0.78;
    positions[index * 3 + 2] = radius * Math.cos(phi);
    const color = STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)].clone();
    color.multiplyScalar(0.45 + Math.random() * 0.55);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  return { positions, colors };
}

function useSquareTexture() {
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 4, 4);
    const texture = new CanvasTexture(canvas);
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.needsUpdate = true;
    return texture;
  }, []);
}

function useCrossTexture() {
  return useMemo(() => {
    const size = 16;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const pixel = (x: number, y: number, alpha: number) => {
      context.fillStyle = `rgba(255,255,255,${alpha})`;
      context.fillRect(x, y, 1, 1);
    };
    pixel(7, 7, 1);
    pixel(8, 7, 1);
    pixel(7, 8, 1);
    pixel(8, 8, 1);
    for (let step = 1; step <= 6; step += 1) {
      const alpha = Math.max(0.12, 1 - step * 0.15);
      pixel(8, 8 - step, alpha);
      pixel(8, 7 + step, alpha);
      pixel(8 - step, 8, alpha);
      pixel(7 + step, 8, alpha);
    }
    pixel(5, 5, 0.4);
    pixel(10, 10, 0.34);
    pixel(4, 11, 0.28);
    pixel(12, 3, 0.22);
    pixel(3, 6, 0.18);
    const texture = new CanvasTexture(canvas);
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.needsUpdate = true;
    return texture;
  }, []);
}

type GlowStop = [number, string];
type GlowLayer = { x: number; y: number; radius: number; stops: GlowStop[] };

function useNebulaTexture(layers: readonly GlowLayer[]) {
  return useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.globalCompositeOperation = "lighter";
    for (const layer of layers) {
      const glow = context.createRadialGradient(layer.x, layer.y, layer.radius * 0.06, layer.x, layer.y, layer.radius);
      for (const [offset, color] of layer.stops) glow.addColorStop(offset, color);
      context.fillStyle = glow;
      context.beginPath();
      context.arc(layer.x, layer.y, layer.radius, 0, Math.PI * 2);
      context.fill();
    }
    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, [layers]);
}

const AURORA: readonly GlowLayer[] = [
  {
    x: 190,
    y: 280,
    radius: 240,
    stops: [
      [0, "rgba(92, 196, 176, 0.55)"],
      [0.32, "rgba(24, 120, 112, 0.34)"],
      [0.66, "rgba(16, 62, 88, 0.16)"],
      [1, "rgba(16, 43, 63, 0)"],
    ],
  },
  {
    x: 360,
    y: 160,
    radius: 170,
    stops: [
      [0, "rgba(186, 160, 224, 0.42)"],
      [0.4, "rgba(98, 71, 170, 0.2)"],
      [1, "rgba(98, 71, 170, 0)"],
    ],
  },
];

const BLOOM: readonly GlowLayer[] = [
  {
    x: 270,
    y: 230,
    radius: 220,
    stops: [
      [0, "rgba(226, 207, 234, 0.62)"],
      [0.28, "rgba(160, 108, 213, 0.4)"],
      [0.62, "rgba(98, 71, 170, 0.18)"],
      [1, "rgba(16, 43, 63, 0)"],
    ],
  },
  {
    x: 140,
    y: 340,
    radius: 150,
    stops: [
      [0, "rgba(72, 132, 186, 0.4)"],
      [0.55, "rgba(16, 43, 63, 0.14)"],
      [1, "rgba(3, 0, 4, 0)"],
    ],
  },
];

const DUST: readonly GlowLayer[] = [
  {
    x: 300,
    y: 250,
    radius: 230,
    stops: [
      [0, "rgba(64, 128, 176, 0.5)"],
      [0.36, "rgba(98, 71, 170, 0.26)"],
      [0.7, "rgba(16, 43, 63, 0.1)"],
      [1, "rgba(3, 0, 4, 0)"],
    ],
  },
  {
    x: 150,
    y: 180,
    radius: 140,
    stops: [
      [0, "rgba(46, 150, 136, 0.36)"],
      [0.6, "rgba(6, 39, 38, 0.1)"],
      [1, "rgba(3, 0, 4, 0)"],
    ],
  },
];

function PixelPoints({
  count,
  near,
  far,
  size,
  map,
  cutoff = 0.35,
}: {
  count: number;
  near: number;
  far: number;
  size: number;
  map: CanvasTexture | null;
  cutoff?: number;
}) {
  const data = useMemo(() => scatter(count, near, far), [count, near, far]);
  if (!map) return null;

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        map={map}
        size={size}
        sizeAttenuation
        transparent
        alphaTest={cutoff}
        vertexColors
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  );
}

function Nebula({
  map,
  position,
  scale,
  opacity,
}: {
  map: CanvasTexture | null;
  position: [number, number, number];
  scale: [number, number, number];
  opacity: number;
}) {
  if (!map) return null;
  return (
    <sprite position={position} scale={scale}>
      <spriteMaterial map={map} transparent depthWrite={false} opacity={opacity} blending={AdditiveBlending} />
    </sprite>
  );
}

function Sky({ progress }: { progress: RefObject<number> }) {
  const field = useRef<Group>(null);
  const near = useRef<Group>(null);
  const far = useRef<Group>(null);
  const square = useSquareTexture();
  const cross = useCrossTexture();
  const aurora = useNebulaTexture(AURORA);
  const bloom = useNebulaTexture(BLOOM);
  const dust = useNebulaTexture(DUST);

  useFrame(({ clock }) => {
    const scroll = Math.min(1, (progress.current ?? 0) / STORY);
    const travel = scroll * scroll * (3 - 2 * scroll);
    const lift = Math.sin(travel * Math.PI * 2);
    if (field.current) {
      field.current.rotation.y = scroll * 1.15 + clock.elapsedTime * 0.008;
      field.current.rotation.x = lift * 0.28;
    }
    if (near.current) {
      near.current.position.x = Math.sin(scroll * Math.PI * 2) * 1.25;
      near.current.position.y = Math.cos(travel * Math.PI * 2) * 0.85;
      near.current.rotation.z = scroll * 0.35;
    }
    if (far.current) {
      far.current.position.x = Math.sin(scroll * Math.PI) * -1.4;
      far.current.position.y = -lift * 0.7;
      far.current.rotation.z = -scroll * 0.4;
    }
  });

  return (
    <group ref={field}>
      <PixelPoints count={520} near={4.2} far={13} size={0.034} map={square} />
      <PixelPoints count={48} near={5.2} far={10.5} size={0.34} map={cross} cutoff={0.08} />
      <PixelPoints count={14} near={5.8} far={9} size={0.72} map={cross} cutoff={0.08} />
      <group ref={far}>
        <Nebula map={aurora} position={[-3.6, -0.15, -5.4]} scale={[7.6, 4.8, 1]} opacity={0.78} />
        <Nebula map={dust} position={[3.4, -1.15, -5.6]} scale={[7.2, 4.4, 1]} opacity={0.7} />
      </group>
      <group ref={near}>
        <Nebula map={bloom} position={[2.6, 1.45, -3.8]} scale={[5.6, 3.8, 1]} opacity={0.58} />
        <Nebula map={aurora} position={[-1.8, 1.85, -3.2]} scale={[3.6, 2.4, 1]} opacity={0.36} />
      </group>
    </group>
  );
}

function SpectralLight({ progress }: { progress: RefObject<number> }) {
  const light = useRef<PointLight>(null);
  const color = useMemo(() => new Color("#5ce1ff"), []);

  useFrame(({ clock }) => {
    if (!light.current) return;
    const p = progress.current ?? 0;
    const story = Math.min(1, p / STORY);
    const travel = story * story * (3 - 2 * story);
    const t = clock.elapsedTime * 0.25;
    let height = 0.75 + Math.sin(travel * Math.PI * 2) * 1.15;
    if (p > STORY) height += (1.8 - height) * smooth((p - STORY) / 0.13);
    light.current.position.set(Math.cos(t) * 2.4, height, Math.sin(t) * 2.4);
    light.current.color.copy(color);
  });

  return <pointLight ref={light} intensity={22} distance={9} decay={2} />;
}

function Earth({ progress }: { progress: RefObject<number> }) {
  const group = useRef<Group>(null);
  const glow = useRef<Mesh>(null);
  const map = useTexture("/textures/earth.jpg");

  useEffect(() => {
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = 8;
    map.needsUpdate = true;
  }, [map]);

  useFrame(({ clock }) => {
    if (!group.current) return;
    const p = progress.current ?? 0;
    const u = p > STORY ? Math.min(1, (p - STORY) / 0.18) : 0;
    const overhead = smooth(Math.min(1, u / 0.35));
    const plunge = smooth(Math.max(0, (u - 0.55) / 0.45));
    // Pull Earth into the wide top shot, then let it fall away as we dive inside.
    const earthLift = overhead * (1 - plunge) * 1.35;
    group.current.rotation.y = 0.55 + clock.elapsedTime * 0.02;
    group.current.position.y = -7.8 + earthLift;
    if (glow.current) {
      const mat = glow.current.material as { opacity: number };
      mat.opacity = 0.16 + earthLift * 0.14;
    }
  });

  return (
    <group ref={group} position={[0.15, -7.8, 0.2]} scale={4.8} rotation={[0.35, 0.9, 0.08]}>
      <mesh>
        <sphereGeometry args={[1, 64, 64]} />
        <meshStandardMaterial map={map} roughness={0.86} metalness={0.04} />
      </mesh>
      <mesh ref={glow} scale={1.035}>
        <sphereGeometry args={[1, 48, 48]} />
        <meshBasicMaterial color="#7eb8e8" transparent opacity={0.16} depthWrite={false} side={DoubleSide} />
      </mesh>
      <directionalLight position={[2.8, 2.2, 1.6]} intensity={2.8} color="#f4fafc" />
    </group>
  );
}

function Telescope({ progress, drag }: { progress: RefObject<number>; drag: RefObject<Drag> }) {
  const { scene } = useGLTF("/models/spherex.glb");
  const group = useRef<Group>(null);
  const trapRef = useRef<Group>(null);
  const deepRef = useRef<Group>(null);
  const trapPos = useMemo(() => new Vector3(), []);
  const deepPos = useMemo(() => new Vector3(), []);

  useFrame((state, delta) => {
    const p = progress.current ?? 0;
    const offset = drag.current ?? { x: 0, y: 0, active: false };
    if (!offset.active) {
      const settle = 1 - Math.exp(-2.4 * delta);
      offset.x += (0 - offset.x) * settle;
      offset.y += (0 - offset.y) * settle;
    }

    if (trapRef.current) trapRef.current.getWorldPosition(trapPos);
    if (deepRef.current) deepRef.current.getWorldPosition(deepPos);

    const story = Math.min(1, p / STORY);
    const diveIn = p > STORY ? smooth((p - STORY) / 0.08) : 0;
    const yaw = 0.65 + story * Math.PI * 1.4 + offset.x * (1 - diveIn);
    const travel = story * story * (3 - 2 * story);
    const pitch = Math.max(-0.38, Math.min(0.72, Math.sin(travel * Math.PI * 2) * 0.48 + 0.16 - offset.y * (1 - diveIn)));
    const dist = 2.55;
    const lookY = -0.1;
    const horizontal = Math.cos(pitch) * dist;
    let x = Math.sin(yaw) * horizontal;
    let y = lookY + Math.sin(pitch) * dist;
    let z = Math.cos(yaw) * horizontal;
    let lx = 0;
    let ly = lookY;
    let lz = 0;
    let fov = 32;

    if (p > STORY) {
      const u = Math.min(1, (p - STORY) / 0.18);
      const rise = smooth(Math.min(1, u / 0.34));
      const hold = smooth(Math.max(0, Math.min(1, (u - 0.2) / 0.32)));
      const plunge = smooth(Math.max(0, (u - 0.55) / 0.45));

      const tx = trapPos.x;
      const ty = trapPos.y;
      const tz = trapPos.z;
      const dx = deepPos.x;
      const dy = deepPos.y;
      const dz = deepPos.z;

      // Wide top-down: far above the aperture so Earth fills the frame behind SPHEREx.
      const topY = ty + 2.85;
      const rx = x + (tx - x) * rise;
      const ry = y + (topY - y) * rise;
      const rz = z + (tz - z) * rise;
      const rlx = lx + (tx - lx) * rise;
      const rly = ly + (ty - 0.35 - ly) * rise;
      const rlz = lz + (tz - lz) * rise;

      // Settle a touch higher and look through toward Earth.
      const hx = rx;
      const hy = ry + hold * 0.45;
      const hz = rz;
      const hlx = rlx;
      const hly = rly - hold * 0.45;
      const hlz = rlz;

      // Then drop through the square mouth into the dark cavity.
      x = hx + (tx - hx) * plunge;
      y = hy + (ty - 0.04 - hy) * plunge;
      z = hz + (tz - hz) * plunge;
      lx = hlx + (dx - hlx) * plunge;
      ly = hly + (dy - hly) * plunge;
      lz = hlz + (dz - hlz) * plunge;
      fov = 32 + hold * 8 + plunge * 22;
    }

    const camera = state.camera;
    const blend = 1 - Math.exp(-5 * delta);
    camera.position.x += (x - camera.position.x) * blend;
    camera.position.y += (y - camera.position.y) * blend;
    camera.position.z += (z - camera.position.z) * blend;
    const upBlend = p > STORY ? smooth((p - STORY) / 0.05) : 0;
    camera.up.set(0, 1 - upBlend, upBlend > 0.01 ? -upBlend : 0);
    camera.lookAt(lx, ly, lz);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    if (group.current) {
      group.current.position.y = Math.sin(state.clock.elapsedTime * 0.55) * 0.02 * (1 - diveIn);
    }
  });

  return (
    <group ref={group}>
      <Center>
        <group>
          <primitive object={scene} />
          {/* Mouth of the square instrument opening, then a point deeper inside it. */}
          <group ref={trapRef} position={[0.095, 0.27, 0.055]} />
          <group ref={deepRef} position={[0.095, -0.12, 0.055]} />
        </group>
      </Center>
    </group>
  );
}

function Scene({ progress, drag }: { progress: RefObject<number>; drag: RefObject<Drag> }) {
  return (
    <>
      <color attach="background" args={["#030004"]} />
      <ambientLight intensity={0.38} />
      <directionalLight position={[3.2, 4.4, 2.2]} intensity={2.6} color="#f4fafc" />
      <directionalLight position={[-3.4, 1.1, -1.4]} intensity={1.8} color="#5ce1ff" />
      <directionalLight position={[0.2, -1.4, 2.6]} intensity={0.7} color="#7ee7ff" />
      <SpectralLight progress={progress} />
      <Sky progress={progress} />
      <Suspense fallback={null}>
        <Earth progress={progress} />
        <Telescope progress={progress} drag={drag} />
        <Environment preset="studio" environmentIntensity={0.5} />
      </Suspense>
    </>
  );
}

function Loader() {
  const { active, progress } = useProgress();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!active && progress === 100) setDone(true);
  }, [active, progress]);

  if (done) return null;

  return (
    <div className="flight-status" role="status">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Loading SPHEREx</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.max(progress, 8)}%` }} />
      </div>
    </div>
  );
}

export default function TelescopeStage({ progress }: { progress: RefObject<number> }) {
  const drag = useRef<Drag>({ x: 0, y: 0, active: false });
  const last = useRef({ x: 0, y: 0 });

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    drag.current.active = true;
    last.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current.active) return;
    const dx = event.clientX - last.current.x;
    const dy = event.clientY - last.current.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      drag.current.x += dx * 0.005;
    }
    drag.current.y += dy * 0.0015;
    last.current = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp() {
    drag.current.active = false;
  }

  return (
    <div
      className="flight-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="img"
      aria-label="SPHEREx telescope above Earth. Scroll to orbit it, look over it, pass underneath, then look through the top. Drag sideways to look around."
    >
      <Canvas
        camera={{ position: [1.52, 0.31, 2.0], fov: 32, near: 0.01, far: 80 }}
        dpr={[1, 1.7]}
        gl={{ antialias: true, alpha: false }}
      >
        <Scene progress={progress} drag={drag} />
      </Canvas>
      <Loader />
    </div>
  );
}

useGLTF.preload("/models/spherex.glb");
