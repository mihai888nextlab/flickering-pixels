"use client";

import {
  AdaptiveDpr,
  AdaptiveEvents,
  ContactShadows,
  Environment,
  OrbitControls,
  useTexture,
} from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import {
  ACESFilmicToneMapping,
  DoubleSide,
  MathUtils,
  SRGBColorSpace,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type SpotLight,
  type Texture,
} from "three";
import {
  loadHeightmap,
  SculptureExhibit,
  type Heightmap,
} from "@/components/GallerySculpture";
import type { GalleryPieceSpec } from "@/lib/galleryDaily";

export type GalleryRoomPiece = {
  piece: GalleryPieceSpec;
  src: string | null;
  /** Epoch PNG URLs — when 2+, the wall plate blinks through them. */
  frames?: string[];
  status: "idle" | "loading" | "ready" | "empty" | "error";
  message: string;
};

type Station = {
  position: [number, number, number];
  rotation: [number, number, number];
  lookAt: [number, number, number];
};

/** Plates on walls; sculptures inset from corners so 360° orbit stays clear. */
export const STATIONS: Station[] = [
  { position: [-6.8, 1.95, -0.4], rotation: [0, Math.PI / 2, 0], lookAt: [-6.8, 1.7, -0.4] },
  { position: [-2.85, 0, -2.7], rotation: [0, 0.55, 0], lookAt: [-2.85, 1.7, -2.7] },
  { position: [0, 2.05, -6.2], rotation: [0, 0, 0], lookAt: [0, 1.8, -6.2] },
  { position: [2.85, 0, -2.7], rotation: [0, -0.55, 0], lookAt: [2.85, 1.7, -2.7] },
  { position: [6.8, 1.95, -0.4], rotation: [0, -Math.PI / 2, 0], lookAt: [6.8, 1.7, -0.4] },
];

/**
 * Toolbench / deck skeuomorphism tokens (from --tool-face / --tool-metal / --tool-well).
 * Light face → mid chassis → recessed well, with cyan instrument glow.
 */
const PALETTE = {
  wall: "#3a424e",
  wallPanel: "#5a6270",
  wallDeep: "#232830",
  ceiling: "#2f353e",
  floor: "#12171e",
  floorEdge: "#1a1f26",
  metal: "#4a5360",
  metalBright: "#6a7382",
  metalHi: "#7a8494",
  base: "#0a0d12",
  well: "#05070a",
  frame: "#0a0d12",
  mat: "#05070a",
  accent: "#5ce1ff",
  accentWarm: "#e8c56a",
  accentOk: "#3dde9f",
};

function GlowStrip({
  position,
  size,
  color,
  intensity = 1.2,
}: {
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  intensity?: number;
}) {
  return (
    <mesh position={position}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={intensity}
        roughness={0.35}
        metalness={0.15}
      />
    </mesh>
  );
}

function CoveLight({
  position,
  size = [2.2, 0.03, 0.5] as [number, number, number],
  glow = PALETTE.accent,
}: {
  position: [number, number, number];
  size?: [number, number, number];
  glow?: string;
}) {
  return (
    <group position={position}>
      <mesh>
        <boxGeometry args={[size[0] + 0.2, 0.06, size[2] + 0.2]} />
        <meshStandardMaterial color={PALETTE.metal} roughness={0.38} metalness={0.82} />
      </mesh>
      <mesh position={[0, -0.02, 0]}>
        <boxGeometry args={size} />
        <meshStandardMaterial
          color="#d8f4ff"
          emissive={glow}
          emissiveIntensity={1.7}
          roughness={0.35}
          metalness={0}
        />
      </mesh>
    </group>
  );
}

function WallModule({
  position,
  rotation = [0, 0, 0],
  width = 1.7,
  accent = PALETTE.accent,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  width?: number;
  accent?: string;
}) {
  return (
    <group position={position} rotation={rotation}>
      {/* Beveled tool-face panel */}
      <mesh castShadow>
        <boxGeometry args={[width, 2.1, 0.1]} />
        <meshStandardMaterial color={PALETTE.wallPanel} roughness={0.42} metalness={0.55} />
      </mesh>
      <mesh position={[0, 0, 0.06]}>
        <boxGeometry args={[width - 0.12, 1.95, 0.04]} />
        <meshStandardMaterial color={PALETTE.wall} roughness={0.48} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.78, 0.09]}>
        <boxGeometry args={[width * 0.68, 0.06, 0.03]} />
        <meshStandardMaterial color={PALETTE.metalHi} roughness={0.32} metalness={0.78} />
      </mesh>
      <GlowStrip
        position={[0, -0.88, 0.09]}
        size={[width * 0.48, 0.028, 0.02]}
        color={accent}
        intensity={1.15}
      />
    </group>
  );
}

function DataPillar({
  position,
  accent = PALETTE.accent,
}: {
  position: [number, number, number];
  accent?: string;
}) {
  return (
    <group position={position}>
      <mesh castShadow position={[0, 1.3, 0]}>
        <boxGeometry args={[0.42, 2.6, 0.42]} />
        <meshStandardMaterial color={PALETTE.metal} roughness={0.36} metalness={0.78} />
      </mesh>
      <mesh position={[0, 1.3, 0]}>
        <boxGeometry args={[0.46, 2.45, 0.34]} />
        <meshStandardMaterial color={PALETTE.wallDeep} roughness={0.45} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.08, 0]}>
        <boxGeometry args={[0.54, 0.16, 0.54]} />
        <meshStandardMaterial color={PALETTE.base} roughness={0.48} metalness={0.65} />
      </mesh>
      <GlowStrip position={[0.23, 1.35, 0]} size={[0.03, 1.7, 0.03]} color={accent} intensity={1.25} />
    </group>
  );
}

function CeilingTruss({ z }: { z: number }) {
  return (
    <group position={[0, 4.95, z]}>
      <mesh>
        <boxGeometry args={[13.6, 0.14, 0.22]} />
        <meshStandardMaterial color={PALETTE.metal} roughness={0.36} metalness={0.82} />
      </mesh>
      <mesh position={[0, -0.02, 0]}>
        <boxGeometry args={[13.2, 0.06, 0.12]} />
        <meshStandardMaterial color={PALETTE.wallDeep} roughness={0.45} metalness={0.55} />
      </mesh>
      <GlowStrip position={[0, -0.1, 0]} size={[12.2, 0.03, 0.04]} color={PALETTE.accent} intensity={0.95} />
    </group>
  );
}

/** Futuristic exhibition bay — lean skeuomorphic shell. */
function HallShell() {
  const roomZ = 4.2;
  const roomDepth = 22.5;
  const trussZs = useMemo(() => [-3.5, 1.2, 6.0], []);

  return (
    <group>
      {/* Floor deck */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, roomZ]} receiveShadow>
        <planeGeometry args={[14.5, roomDepth]} />
        <meshStandardMaterial color={PALETTE.floor} roughness={0.62} metalness={0.28} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, roomZ]} receiveShadow>
        <planeGeometry args={[3.6, roomDepth - 1.5]} />
        <meshStandardMaterial color={PALETTE.floorEdge} roughness={0.48} metalness={0.42} />
      </mesh>
      <GlowStrip position={[-1.9, 0.01, roomZ]} size={[0.06, 0.01, roomDepth - 2]} color={PALETTE.accent} intensity={1.25} />
      <GlowStrip position={[1.9, 0.01, roomZ]} size={[0.06, 0.01, roomDepth - 2]} color={PALETTE.accentWarm} intensity={1.05} />

      {/* Shell walls — tool-face chassis */}
      <mesh position={[0, 2.55, -6.35]} receiveShadow>
        <boxGeometry args={[14.5, 5.2, 0.22]} />
        <meshStandardMaterial color={PALETTE.wall} roughness={0.5} metalness={0.48} />
      </mesh>
      <mesh position={[-6.95, 2.55, roomZ]} receiveShadow>
        <boxGeometry args={[0.22, 5.2, roomDepth]} />
        <meshStandardMaterial color={PALETTE.wall} roughness={0.5} metalness={0.48} />
      </mesh>
      <mesh position={[6.95, 2.55, roomZ]} receiveShadow>
        <boxGeometry args={[0.22, 5.2, roomDepth]} />
        <meshStandardMaterial color={PALETTE.wall} roughness={0.5} metalness={0.48} />
      </mesh>

      {/* Back wall raised face plates */}
      {[-3.3, 3.3].map((x) => (
        <mesh key={`back-clad-${x}`} position={[x, 2.55, -6.2]} castShadow>
          <boxGeometry args={[2.4, 3.4, 0.1]} />
          <meshStandardMaterial color={PALETTE.wallPanel} roughness={0.4} metalness={0.58} />
        </mesh>
      ))}
      <GlowStrip position={[0, 4.4, -6.18]} size={[12, 0.05, 0.05]} color={PALETTE.accent} intensity={1.3} />

      {/* Ceiling */}
      <mesh position={[0, 5.12, roomZ]} receiveShadow>
        <boxGeometry args={[14.5, 0.16, roomDepth]} />
        <meshStandardMaterial color={PALETTE.ceiling} roughness={0.55} metalness={0.5} />
      </mesh>
      {trussZs.map((z) => (
        <CeilingTruss key={`truss-${z}`} z={z} />
      ))}
      <CoveLight position={[-2.6, 5.0, -0.6]} glow={PALETTE.accent} />
      <CoveLight position={[2.6, 5.0, -0.6]} glow={PALETTE.accentWarm} />
      <CoveLight position={[0, 5.0, 2.4]} size={[3.0, 0.03, 0.45]} glow={PALETTE.accent} />

      {/* Kick plates + cove rails */}
      <mesh position={[0, 0.14, -6.2]}>
        <boxGeometry args={[14.1, 0.28, 0.1]} />
        <meshStandardMaterial color={PALETTE.base} roughness={0.42} metalness={0.72} />
      </mesh>
      <mesh position={[-6.8, 0.14, roomZ]}>
        <boxGeometry args={[0.1, 0.28, roomDepth - 0.4]} />
        <meshStandardMaterial color={PALETTE.base} roughness={0.42} metalness={0.72} />
      </mesh>
      <mesh position={[6.8, 0.14, roomZ]}>
        <boxGeometry args={[0.1, 0.28, roomDepth - 0.4]} />
        <meshStandardMaterial color={PALETTE.base} roughness={0.42} metalness={0.72} />
      </mesh>
      <GlowStrip position={[-6.8, 4.55, roomZ]} size={[0.05, 0.04, roomDepth - 1]} color={PALETTE.accent} intensity={1.1} />
      <GlowStrip position={[6.8, 4.55, roomZ]} size={[0.05, 0.04, roomDepth - 1]} color={PALETTE.accentWarm} intensity={1.0} />

      {/* Side instrument panels */}
      <WallModule position={[-6.82, 2.15, 3.2]} rotation={[0, Math.PI / 2, 0]} accent={PALETTE.accent} />
      <WallModule position={[-6.82, 2.15, 6.4]} rotation={[0, Math.PI / 2, 0]} accent={PALETTE.accentOk} />
      <WallModule position={[6.82, 2.15, 3.2]} rotation={[0, -Math.PI / 2, 0]} accent={PALETTE.accentWarm} />
      <WallModule position={[6.82, 2.15, 6.4]} rotation={[0, -Math.PI / 2, 0]} accent={PALETTE.accent} />

      {/* Back-corner pillars only */}
      <DataPillar position={[-5.9, 0, -5.5]} accent={PALETTE.accent} />
      <DataPillar position={[5.9, 0, -5.5]} accent={PALETTE.accentWarm} />

      {/* Front bulkhead — closes the bay so orbit views never fall into void */}
      <mesh position={[0, 2.55, 14.8]} receiveShadow>
        <boxGeometry args={[14.5, 5.2, 0.28]} />
        <meshStandardMaterial color={PALETTE.wallDeep} roughness={0.52} metalness={0.42} />
      </mesh>
      <mesh position={[0, 2.55, 14.62]} castShadow>
        <boxGeometry args={[10.5, 3.6, 0.1]} />
        <meshStandardMaterial color={PALETTE.wall} roughness={0.48} metalness={0.5} />
      </mesh>
      <GlowStrip
        position={[0, 4.4, 14.6]}
        size={[11.5, 0.05, 0.05]}
        color={PALETTE.accent}
        intensity={0.85}
      />
      <mesh position={[0, 0.14, 14.65]}>
        <boxGeometry args={[14.1, 0.28, 0.1]} />
        <meshStandardMaterial color={PALETTE.base} roughness={0.42} metalness={0.72} />
      </mesh>
      <DataPillar position={[-5.9, 0, 13.8]} accent={PALETTE.accentOk} />
      <DataPillar position={[5.9, 0, 13.8]} accent={PALETTE.accent} />
    </group>
  );
}

function LivingAmbience({ selectedIndex }: { selectedIndex: number | null }) {
  const focus = useRef<SpotLight>(null);
  const target = useRef<Group>(null);

  useEffect(() => {
    if (focus.current && target.current) {
      focus.current.target = target.current;
      focus.current.target.updateMatrixWorld();
    }
  });

  useFrame((_, dt) => {
    if (!focus.current || !target.current) return;
    const station = selectedIndex != null ? STATIONS[selectedIndex] : null;
    const goal = station
      ? {
          x: station.position[0] * 0.35,
          y: 4.35,
          z: station.position[2] * 0.25 + 1.8,
          tx: station.lookAt[0],
          ty: station.lookAt[1],
          tz: station.lookAt[2],
          intensity: 2.35,
        }
      : { x: 0, y: 4.6, z: 2.4, tx: 0, ty: 1.5, tz: -1.2, intensity: 1.05 };

    focus.current.position.x = MathUtils.damp(focus.current.position.x, goal.x, 3, dt);
    focus.current.position.y = MathUtils.damp(focus.current.position.y, goal.y, 3, dt);
    focus.current.position.z = MathUtils.damp(focus.current.position.z, goal.z, 3, dt);
    focus.current.intensity = MathUtils.damp(focus.current.intensity, goal.intensity, 3, dt);
    target.current.position.x = MathUtils.damp(target.current.position.x, goal.tx, 3, dt);
    target.current.position.y = MathUtils.damp(target.current.position.y, goal.ty, 3, dt);
    target.current.position.z = MathUtils.damp(target.current.position.z, goal.tz, 3, dt);
    focus.current.target.updateMatrixWorld();
  });

  return (
    <>
      <color attach="background" args={[PALETTE.wallDeep]} />
      <fog attach="fog" args={[PALETTE.wallDeep, 22, 48]} />
      <Environment preset="warehouse" environmentIntensity={0.3} />
      <ambientLight intensity={0.34} color="#8a96a4" />
      <hemisphereLight args={["#5ce1ff", "#12171e", 0.38]} />
      <directionalLight
        castShadow
        position={[4.5, 8.5, 3.2]}
        intensity={0.9}
        color="#c8d2dc"
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0002}
        shadow-camera-far={24}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
      />
      <directionalLight position={[-4.2, 3.4, -1.2]} intensity={0.55} color="#5ce1ff" />
      <directionalLight position={[4.2, 3.2, -1.2]} intensity={0.4} color="#e8c56a" />
      <directionalLight position={[0, 2.8, 4]} intensity={0.22} color="#3dde9f" />
      <spotLight
        ref={focus}
        position={[0, 4.5, 2.2]}
        angle={0.42}
        penumbra={0.82}
        intensity={1.2}
        color="#e8f7ff"
        castShadow={false}
        distance={16}
        decay={1.4}
      />
      <group ref={target} position={[0, 1.5, -1.2]} />
      <ContactShadows
        frames={1}
        position={[0, 0.012, -0.4]}
        opacity={0.62}
        scale={14}
        blur={2.0}
        far={5.5}
        color="#000000"
      />
    </>
  );
}

const PLATE_SIZE = 2.55;

function PictureFrame({
  width,
  height,
  selected,
  hovered,
}: {
  width: number;
  height: number;
  selected?: boolean;
  hovered?: boolean;
}) {
  const rail = 0.14;
  const outer = width + rail * 2;
  const outerH = height + rail * 2;
  const moulding = 0.055;
  const frameColor = selected ? PALETTE.wallDeep : PALETTE.metal;
  const highlight = selected ? PALETTE.metalBright : PALETTE.wallPanel;
  const bezel = useRef<Mesh>(null);
  const lip = useRef<Mesh>(null);
  const tick = useRef<Mesh>(null);
  const glow = useRef(selected ? 1 : 0);

  useFrame((_, dt) => {
    const target = selected ? 1 : hovered ? 0.55 : 0;
    glow.current = MathUtils.damp(glow.current, target, 8, dt);
    const g = glow.current;
    const bezelMat = bezel.current?.material as
      | { emissiveIntensity?: number }
      | undefined;
    const lipMat = lip.current?.material as
      | { emissiveIntensity?: number }
      | undefined;
    const tickMat = tick.current?.material as
      | { emissiveIntensity?: number; opacity?: number }
      | undefined;
    if (bezelMat) {
      bezelMat.emissiveIntensity = 0.22 * g;
    }
    if (lipMat) {
      lipMat.emissiveIntensity = selected ? 0 : 0.145 * g;
    }
    if (tick.current && tickMat) {
      // Geometry width is `width`; scale.x sets the lit underline length.
      tick.current.scale.x = selected ? 0.35 : 0.22 * (g / 0.55);
      tickMat.opacity = Math.min(1, g / 0.55);
      tickMat.emissiveIntensity = 0.9 * g;
      tick.current.visible = g > 0.01;
    }
  });

  return (
    <group>
      {/* Recessed well backing */}
      <mesh position={[0, 0, -0.01]} castShadow>
        <boxGeometry args={[outer + 0.02, outerH + 0.02, 0.03]} />
        <meshStandardMaterial color={PALETTE.well} roughness={0.7} metalness={0.25} />
      </mesh>

      {/* Outer metal bezel — tool-face moulding */}
      <mesh ref={bezel} position={[0, 0, 0.028]} castShadow>
        <boxGeometry args={[outer, outerH, 0.07]} />
        <meshStandardMaterial
          color={frameColor}
          emissive={PALETTE.accent}
          emissiveIntensity={0}
          roughness={0.36}
          metalness={0.72}
        />
      </mesh>

      {/* Inner bevel lip */}
      <mesh ref={lip} position={[0, 0, 0.055]}>
        <boxGeometry args={[outer - moulding, outerH - moulding, 0.035]} />
        <meshStandardMaterial
          color={highlight}
          emissive={PALETTE.accent}
          emissiveIntensity={0}
          roughness={0.4}
          metalness={0.55}
        />
      </mesh>

      {/* LCD-style mat around the print */}
      <mesh position={[0, 0, 0.07]}>
        <boxGeometry args={[width + 0.12, height + 0.12, 0.02]} />
        <meshStandardMaterial color={PALETTE.base} roughness={0.85} metalness={0.15} />
      </mesh>

      {/* Deep reveal behind the image */}
      <mesh position={[0, 0, 0.078]}>
        <boxGeometry args={[width + 0.02, height + 0.02, 0.012]} />
        <meshStandardMaterial color={PALETTE.mat} roughness={0.9} metalness={0.05} />
      </mesh>

      <mesh
        ref={tick}
        position={[0, -outerH / 2 - 0.05, 0.04]}
        visible={false}
      >
        <boxGeometry args={[width, 0.012, 0.012]} />
        <meshStandardMaterial
          color={PALETTE.accent}
          emissive={PALETTE.accent}
          emissiveIntensity={0}
          roughness={0.4}
          metalness={0.1}
          transparent
          opacity={0}
        />
      </mesh>
    </group>
  );
}

function PlateTexture({ src, size }: { src: string; size: number }) {
  const texture = useTexture(src);
  useEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
  }, [texture]);
  return (
    <mesh position={[0, 0, 0.09]}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/** Cycle epoch stills — WebGL textures do not animate GIF files. */
function BlinkPlateTexture({
  frames,
  size,
}: {
  frames: string[];
  size: number;
}) {
  const maps = useTexture(frames) as Texture[];
  const mesh = useRef<Mesh>(null);
  const index = useRef(0);

  useEffect(() => {
    for (const texture of maps) {
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
    }
  }, [maps]);

  useFrame(({ clock }) => {
    if (!mesh.current || maps.length < 2) return;
    const next = Math.floor(clock.elapsedTime / 0.48) % maps.length;
    if (next === index.current) return;
    index.current = next;
    const mat = mesh.current.material as MeshBasicMaterial;
    mat.map = maps[next] ?? null;
    mat.needsUpdate = true;
  });

  return (
    <mesh ref={mesh} position={[0, 0, 0.09]}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial map={maps[0]} toneMapped={false} />
    </mesh>
  );
}

function VoidPlate({ loading, size }: { loading?: boolean; size: number }) {
  const mesh = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!mesh.current || !loading) return;
    const mat = mesh.current.material as { emissiveIntensity?: number };
    if (mat.emissiveIntensity != null) {
      mat.emissiveIntensity = 0.12 + Math.sin(clock.getElapsedTime() * 2) * 0.08;
    }
  });
  return (
    <mesh ref={mesh} position={[0, 0, 0.09]}>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial
        color="#101218"
        emissive={loading ? PALETTE.accent : "#1a1010"}
        emissiveIntensity={loading ? 0.16 : 0.03}
        metalness={0.1}
        roughness={0.92}
        side={DoubleSide}
      />
    </mesh>
  );
}

function WallExhibit({
  item,
  selected,
  onSelect,
}: {
  item: GalleryRoomPiece;
  selected: boolean;
  onSelect: () => void;
}) {
  const size = PLATE_SIZE;
  const [hovered, setHovered] = useState(false);
  const glare = useRef<Mesh>(null);
  const glareAmt = useRef(selected ? 1 : 0);

  useFrame((_, dt) => {
    const target = selected || hovered ? 1 : 0;
    glareAmt.current = MathUtils.damp(glareAmt.current, target, 8, dt);
    const mat = glare.current?.material as { opacity?: number } | undefined;
    if (mat) mat.opacity = 0.045 + 0.035 * glareAmt.current;
  });

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = "auto";
      }}
    >
      <PictureFrame
        width={size}
        height={size}
        selected={selected}
        hovered={hovered}
      />
      {item.status === "ready" &&
      item.frames &&
      item.frames.length >= 2 ? (
        <Suspense fallback={<VoidPlate loading size={size} />}>
          <BlinkPlateTexture frames={item.frames} size={size} />
        </Suspense>
      ) : item.src && item.status === "ready" ? (
        <Suspense fallback={<VoidPlate loading size={size} />}>
          <PlateTexture src={item.src} size={size} />
        </Suspense>
      ) : (
        <VoidPlate loading={item.status === "loading"} size={size} />
      )}
      <mesh ref={glare} position={[0, 0, 0.1]}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.045}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function PlinthExhibit({
  item,
  selected,
  onSelect,
}: {
  item: GalleryRoomPiece;
  selected: boolean;
  onSelect: () => void;
}) {
  const [map, setMap] = useState<Heightmap | null>(null);
  const [hovered, setHovered] = useState(false);
  const stub = useRef<Mesh>(null);
  const stand = useRef<Mesh>(null);
  const glow = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setMap(null);
    if (!item.src || item.status !== "ready") return;
    void loadHeightmap(item.src)
      .then((next) => {
        if (!cancelled) setMap(next);
      })
      .catch(() => {
        if (!cancelled) setMap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.src, item.status]);

  useFrame((_, dt) => {
    if (map) return;
    const loading = item.status === "loading";
    const target = loading ? 1 : hovered ? 0.55 : 0;
    glow.current = MathUtils.damp(glow.current, target, 8, dt);
    const g = glow.current;
    const stubMat = stub.current?.material as
      | { emissiveIntensity?: number }
      | undefined;
    const standMat = stand.current?.material as
      | { emissiveIntensity?: number }
      | undefined;
    if (stubMat) stubMat.emissiveIntensity = loading ? 0.16 : 0.1 * (g / 0.55);
    if (standMat) standMat.emissiveIntensity = loading ? 0 : 0.08 * (g / 0.55);
  });

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = "auto";
      }}
    >
      {map ? (
        <SculptureExhibit
          map={map}
          title={item.piece.title}
          scale={0.7}
          selected={selected}
          hovered={hovered}
        />
      ) : (
        <group>
          <mesh ref={stub} position={[0, 1.05, 0]} castShadow>
            <boxGeometry args={[0.95, 0.95, 0.14]} />
            <meshStandardMaterial
              color="#151820"
              emissive={PALETTE.accent}
              emissiveIntensity={0}
              metalness={0.2}
              roughness={0.7}
            />
          </mesh>
          <mesh ref={stand} position={[0, 0.48, 0]} castShadow>
            <boxGeometry args={[0.72, 0.96, 0.72]} />
            <meshStandardMaterial
              color={PALETTE.wall}
              emissive={PALETTE.accent}
              emissiveIntensity={0}
              roughness={0.42}
              metalness={0.6}
            />
          </mesh>
          <mesh position={[0, 0.04, 0]} receiveShadow>
            <boxGeometry args={[0.95, 0.08, 0.95]} />
            <meshStandardMaterial color={PALETTE.floorEdge} roughness={0.5} metalness={0.55} />
          </mesh>
        </group>
      )}
    </group>
  );
}

/** Square-on viewing distance for wall plates (framed, not nose-to-glass). */
const WALL_VIEW_DIST = 4.6;
const CAM_MOVE_DUR = 1.25;
/** Idle overlook — far enough back that side plates read fully in-frame. */
const IDLE_CAM = { x: 0, y: 2.55, z: 11.05 };
const IDLE_LOOK = { x: 0, y: 1.5, z: -1.4 };
/** Lock idle vertical orbit to this polar angle (horizontal look only). */
const IDLE_POLAR = Math.acos(
  MathUtils.clamp(
    (IDLE_CAM.y - IDLE_LOOK.y) /
      Math.hypot(
        IDLE_CAM.x - IDLE_LOOK.x,
        IDLE_CAM.y - IDLE_LOOK.y,
        IDLE_CAM.z - IDLE_LOOK.z,
      ),
    -1,
    1,
  ),
);

/** Inner clear volume — keep the lens inside these when orbiting sculptures. */
const HALL_CLEAR = {
  xMin: -6.55,
  xMax: 6.55,
  yMin: 0.7,
  yMax: 4.3,
  zMin: -5.95,
  zMax: 12.5,
};

/** Orbit radius that fits a sculpture without hitting walls / floor / ceiling. */
function sculptureOrbitLimits(lookAt: [number, number, number]) {
  const [x, y, z] = lookAt;
  const margin = 0.85;
  const xzClear = Math.min(
    x - HALL_CLEAR.xMin,
    HALL_CLEAR.xMax - x,
    z - HALL_CLEAR.zMin,
    HALL_CLEAR.zMax - z,
  );
  // Keep a readable viewing distance — never nose-to-glass.
  const maxDistance = MathUtils.clamp(xzClear - margin, 2.6, 3.8);
  const minDistance = Math.max(2.1, maxDistance * 0.7);

  const cosCeil = MathUtils.clamp((HALL_CLEAR.yMax - y) / maxDistance, -1, 1);
  const cosFloor = MathUtils.clamp((HALL_CLEAR.yMin - y) / maxDistance, -1, 1);
  const minPolarAngle = Math.max(0.75, Math.acos(cosCeil));
  const maxPolarAngle = Math.min(1.75, Math.acos(cosFloor));

  return { minDistance, maxDistance, minPolarAngle, maxPolarAngle };
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  t: number,
) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Quadratic bezier through a center-aisle arc so piece-to-piece moves feel intentional. */
function arcPose(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  t: number,
) {
  const mid = {
    x: (from.x + to.x) * 0.5 * 0.42,
    y: Math.max(from.y, to.y) + 0.45,
    z: (from.z + to.z) * 0.5 + 1.1,
  };
  const ab = lerp3(from, mid, t);
  const bc = lerp3(mid, to, t);
  return lerp3(ab, bc, t);
}

function CameraDirector({
  focus,
  facingYaw,
  idle,
  freeOrbit,
  wallInspect,
  userOrbiting,
  sculptOrbit,
}: {
  focus: [number, number, number] | null;
  /** Piece facing yaw (rad) — wall plates and sculptures. */
  facingYaw: number | null;
  idle: boolean;
  freeOrbit: boolean;
  wallInspect: boolean;
  userOrbiting: boolean;
  sculptOrbit: ReturnType<typeof sculptureOrbitLimits> | null;
}) {
  const { camera, controls } = useThree();
  const goalPos = useRef({ ...IDLE_CAM });
  const look = useRef({ ...IDLE_LOOK });
  const fromPos = useRef({ ...IDLE_CAM });
  const fromLook = useRef({ ...IDLE_LOOK });
  const moveT = useRef(1);
  const lastGood = useRef({ ...IDLE_CAM });
  const needsOrbitSync = useRef(false);
  const sculptDist = sculptOrbit?.maxDistance ?? 3.0;

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;

    let nextGoal: { x: number; y: number; z: number };
    let nextLook: { x: number; y: number; z: number };

    if (!focus) {
      nextGoal = { ...IDLE_CAM };
      nextLook = { ...IDLE_LOOK };
    } else {
      const [fx, fy, fz] = focus;
      nextLook = { x: fx, y: fy, z: fz };
      if (freeOrbit) {
        // Face-on: stand on the sculpture's forward axis at eye height.
        const yaw = facingYaw ?? 0;
        nextGoal = {
          x: fx + Math.sin(yaw) * sculptDist,
          y: fy,
          z: fz + Math.cos(yaw) * sculptDist,
        };
      } else if (facingYaw != null) {
        nextGoal = {
          x: fx + Math.sin(facingYaw) * WALL_VIEW_DIST,
          y: fy,
          z: fz + Math.cos(facingYaw) * WALL_VIEW_DIST,
        };
      } else {
        nextGoal = {
          x: MathUtils.clamp(fx * 0.32, -2.8, 2.8),
          y: Math.max(1.85, fy + 0.35),
          z: MathUtils.clamp(5.7 + Math.abs(fx) * 0.08, 5.0, 7.0),
        };
        nextLook = { x: fx * 0.88, y: fy, z: fz };
      }
    }

    // Skip restarting the arc when the settled pose is already the goal
    // (unstable object deps used to re-trigger a mid→origin hop).
    const sameGoal =
      moveT.current >= 1 &&
      Math.hypot(
        nextGoal.x - goalPos.current.x,
        nextGoal.y - goalPos.current.y,
        nextGoal.z - goalPos.current.z,
      ) < 0.02 &&
      Math.hypot(
        nextLook.x - look.current.x,
        nextLook.y - look.current.y,
        nextLook.z - look.current.z,
      ) < 0.02;
    if (sameGoal) return;

    fromPos.current = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    };
    fromLook.current = orbit?.target
      ? { x: orbit.target.x, y: orbit.target.y, z: orbit.target.z }
      : { ...look.current };
    goalPos.current = nextGoal;
    look.current = nextLook;
    moveT.current = 0;
    needsOrbitSync.current = false;
  }, [focus, freeOrbit, facingYaw, sculptDist, camera, controls]);

  useFrame(({ clock }, dt) => {
    const orbit = controls as (OrbitControlsImpl & {
      sphericalDelta?: { set: (x: number, y: number, z: number) => void };
    }) | null;
    const moving = moveT.current < 1;
    const gp = goalPos.current;
    const lk = look.current;

    // Travel owns the pose; once settled, OrbitControls can orbit freely
    // (wall azimuth/polar limits still keep plates framed).
    if (orbit) {
      orbit.enabled = !moving;
    }

    if (moving) {
      moveT.current = Math.min(1, moveT.current + dt / CAM_MOVE_DUR);
      const t = easeInOutCubic(moveT.current);
      const pos = arcPose(fromPos.current, gp, t);
      const lookNow = lerp3(fromLook.current, lk, t);
      camera.position.set(pos.x, pos.y, pos.z);
      camera.lookAt(lookNow.x, lookNow.y, lookNow.z);
      if (orbit?.target) orbit.target.set(lookNow.x, lookNow.y, lookNow.z);

      if (moveT.current >= 1) {
        camera.position.set(gp.x, gp.y, gp.z);
        camera.lookAt(lk.x, lk.y, lk.z);
        if (orbit?.target) orbit.target.set(lk.x, lk.y, lk.z);
        needsOrbitSync.current = true;
        lastGood.current = { x: gp.x, y: gp.y, z: gp.z };
      }
    } else if (needsOrbitSync.current && orbit) {
      orbit.sphericalDelta?.set(0, 0, 0);
      // Place end pose first so update() rebuilds spherical from it (no clamp hop).
      camera.position.set(gp.x, gp.y, gp.z);
      if (orbit.target) orbit.target.set(lk.x, lk.y, lk.z);
      orbit.update?.();
      camera.position.set(gp.x, gp.y, gp.z);
      camera.lookAt(lk.x, lk.y, lk.z);
      if (orbit.target) orbit.target.set(lk.x, lk.y, lk.z);
      needsOrbitSync.current = false;
      lastGood.current = { x: gp.x, y: gp.y, z: gp.z };
    } else if (wallInspect || freeOrbit) {
      // Keep the orbit pivot on the piece; leave camera where the user put it.
      if (orbit?.target) {
        orbit.target.set(lk.x, lk.y, lk.z);
      }
    } else if (focus || idle) {
      const sway = idle && !focus && !userOrbiting
        ? Math.sin(clock.getElapsedTime() * 0.16) * 0.28
        : 0;
      if (!userOrbiting) {
        camera.position.x = MathUtils.damp(camera.position.x, gp.x + sway, 2.0, dt);
        camera.position.y = MathUtils.damp(camera.position.y, gp.y, 2.0, dt);
        camera.position.z = MathUtils.damp(camera.position.z, gp.z, 2.0, dt);
        if (orbit?.target) {
          orbit.target.x = MathUtils.damp(orbit.target.x, lk.x, 2.4, dt);
          orbit.target.y = MathUtils.damp(orbit.target.y, lk.y, 2.4, dt);
          orbit.target.z = MathUtils.damp(orbit.target.z, lk.z, 2.4, dt);
        }
        camera.lookAt(
          orbit?.target?.x ?? lk.x,
          orbit?.target?.y ?? lk.y,
          orbit?.target?.z ?? lk.z,
        );
      }
    }

    const p = camera.position;
    const oob =
      p.y > HALL_CLEAR.yMax ||
      p.y < HALL_CLEAR.yMin ||
      p.x > HALL_CLEAR.xMax ||
      p.x < HALL_CLEAR.xMin ||
      p.z > HALL_CLEAR.zMax ||
      p.z < HALL_CLEAR.zMin;

    if (oob && !moving) {
      p.set(lastGood.current.x, lastGood.current.y, lastGood.current.z);
    } else if (!oob) {
      lastGood.current = { x: p.x, y: p.y, z: p.z };
    }
  });

  return null;
}

function StationNode({
  index,
  item,
  selected,
  onSelect,
}: {
  index: number;
  item: GalleryRoomPiece;
  selected: boolean;
  onSelect: () => void;
}) {
  const station = STATIONS[index] ?? STATIONS[0];
  const showSculpture = item.piece.form === "sculpture";

  return (
    <group position={station.position} rotation={station.rotation}>
      {showSculpture ? (
        <PlinthExhibit item={item} selected={selected} onSelect={onSelect} />
      ) : (
        <WallExhibit item={item} selected={selected} onSelect={onSelect} />
      )}
      <mesh
        visible={false}
        position={[0, showSculpture ? 1.0 : 0, 0.2]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        <boxGeometry args={showSculpture ? [1.8, 2.4, 1.4] : [3.1, 3.2, 0.7]} />
      </mesh>
    </group>
  );
}

/** Pointer travel past this (px) counts as a camera drag, not a click-to-exit. */
const DRAG_THRESHOLD_PX = 8;

function Scene({
  items,
  selectedIndex,
  onSelect,
  userOrbiting,
  gesture,
}: {
  items: GalleryRoomPiece[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  userOrbiting: boolean;
  gesture: MutableRefObject<{ x: number; y: number; dragged: boolean }>;
}) {
  const selected = selectedIndex != null ? items[selectedIndex] : null;
  const freeOrbit = selected?.piece.form === "sculpture";
  const isWallPiece = selected != null && selected.piece.form !== "sculpture";
  const station = selectedIndex != null ? STATIONS[selectedIndex] : null;
  const focus = station?.lookAt ?? null;
  const facingYaw = station ? station.rotation[1] : null;
  const wallAz = facingYaw ?? 0;
  const sculptOrbit = useMemo(
    () => (freeOrbit && focus ? sculptureOrbitLimits(focus) : null),
    // focus tuples are stable STATIONS entries; key on coords + mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [freeOrbit, focus?.[0], focus?.[1], focus?.[2]],
  );

  return (
    <>
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />
      <LivingAmbience selectedIndex={selectedIndex} />
      <HallShell />
      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom
        enableRotate
        minDistance={
          isWallPiece
            ? WALL_VIEW_DIST - 0.45
            : sculptOrbit
              ? sculptOrbit.minDistance
              : 5.5
        }
        maxDistance={
          isWallPiece
            ? WALL_VIEW_DIST + 0.65
            : sculptOrbit
              ? sculptOrbit.maxDistance
              : 12.2
        }
        minPolarAngle={
          isWallPiece
            ? Math.PI / 2 - 0.2
            : sculptOrbit
              ? sculptOrbit.minPolarAngle
              : IDLE_POLAR
        }
        maxPolarAngle={
          isWallPiece
            ? Math.PI / 2 + 0.16
            : sculptOrbit
              ? sculptOrbit.maxPolarAngle
              : IDLE_POLAR
        }
        minAzimuthAngle={
          isWallPiece ? wallAz - 0.28 : freeOrbit ? -Infinity : -0.45
        }
        maxAzimuthAngle={
          isWallPiece ? wallAz + 0.28 : freeOrbit ? Infinity : 0.45
        }
        target={[0, 1.5, -1.4]}
        enableDamping
        dampingFactor={isWallPiece ? 0.1 : 0.07}
        enabled
      />
      <CameraDirector
        focus={focus}
        facingYaw={facingYaw}
        idle={selectedIndex == null && !userOrbiting}
        freeOrbit={!!freeOrbit}
        wallInspect={isWallPiece}
        userOrbiting={userOrbiting}
        sculptOrbit={sculptOrbit}
      />
      {items.map((item, index) => (
        <StationNode
          key={`${item.piece.id}-${index}`}
          index={index}
          item={item}
          selected={selectedIndex === index}
          onSelect={() => {
            // Dragging to orbit must not toggle/clear the focused piece.
            if (gesture.current.dragged) return;
            onSelect(selectedIndex === index ? null : index);
          }}
        />
      ))}
    </>
  );
}

export default function GalleryRoom({
  items,
  selectedIndex,
  onSelect,
  overlay,
}: {
  items: GalleryRoomPiece[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  overlay?: ReactNode;
}) {
  const [userOrbiting, setUserOrbiting] = useState(false);
  const orbitTimer = useRef<number | null>(null);
  const gesture = useRef({ x: 0, y: 0, dragged: false });

  return (
    <div
      className="gallery-room"
      onPointerDown={(e) => {
        gesture.current = { x: e.clientX, y: e.clientY, dragged: false };
        setUserOrbiting(true);
        if (orbitTimer.current) window.clearTimeout(orbitTimer.current);
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (
          !g.dragged &&
          Math.hypot(e.clientX - g.x, e.clientY - g.y) >= DRAG_THRESHOLD_PX
        ) {
          g.dragged = true;
        }
      }}
      onPointerUp={() => {
        if (orbitTimer.current) window.clearTimeout(orbitTimer.current);
        orbitTimer.current = window.setTimeout(() => setUserOrbiting(false), 1600);
      }}
    >
      <div className="gallery-room-vignette" aria-hidden="true" />
      <Canvas
        className="gallery-room-canvas"
        dpr={[1, 1.25]}
        camera={{
          position: [IDLE_CAM.x, IDLE_CAM.y, IDLE_CAM.z],
          fov: 46,
          near: 0.1,
          far: 60,
        }}
        gl={{
          antialias: false,
          alpha: false,
          powerPreference: "high-performance",
          stencil: false,
          depth: true,
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.22,
        }}
        shadows
        onPointerMissed={() => {
          // Only a still click clears focus — orbit drags keep the piece selected.
          if (!gesture.current.dragged) onSelect(null);
        }}
      >
        <Suspense fallback={null}>
          <Scene
            items={items}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            userOrbiting={userOrbiting}
            gesture={gesture}
          />
        </Suspense>
      </Canvas>
      {overlay}
    </div>
  );
}
