"use client";

import { Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  InstancedMesh,
  MathUtils,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Group,
  type Mesh,
} from "three";

export type Heightmap = {
  size: number;
  heights: Float32Array;
  colors: Float32Array;
  peaks: { x: number; y: number; z: number; h: number; r: number; g: number; b: number }[];
};

export function hashTitle(title: string) {
  let h = 2166136261;
  for (let i = 0; i < title.length; i += 1) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export async function loadHeightmap(src: string, size = 64): Promise<Heightmap> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read plate for sculpture"));
    image.src = src;
  });

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const luma = new Float32Array(size * size);
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    luma[i] = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
  }

  const sorted = Float32Array.from(luma).sort();
  const lo = sorted[Math.floor(sorted.length * 0.08)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * 0.97)] ?? 1;
  const span = Math.max(1e-4, hi - lo);

  const heights = new Float32Array(size * size);
  const colors = new Float32Array(size * size * 3);
  const cool = new Color("#102438");
  const mid = new Color("#3d9ec4");
  const hot = new Color("#d8ecff");
  const tmp = new Color();
  const peakCandidates: Heightmap["peaks"] = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const t = Math.min(1, Math.max(0, (luma[i] - lo) / span));
      const shaped = Math.pow(t, 0.9);
      heights[i] = shaped;

      if (shaped < 0.5) tmp.copy(cool).lerp(mid, shaped / 0.5);
      else tmp.copy(mid).lerp(hot, (shaped - 0.5) / 0.5);

      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;

      if (shaped > 0.78 && x > 3 && y > 3 && x < size - 4 && y < size - 4) {
        peakCandidates.push({
          x: (x / (size - 1) - 0.5) * 2.35,
          y: (0.5 - y / (size - 1)) * 2.35,
          z: shaped,
          h: shaped,
          r: tmp.r,
          g: tmp.g,
          b: tmp.b,
        });
      }
    }
  }

  peakCandidates.sort((a, b) => b.h - a.h);
  const peaks = peakCandidates.filter((_, i) => i % 5 === 0).slice(0, 16);

  return { size, heights, colors, peaks };
}

function buildSculptGeometry(map: Heightmap, twist: number) {
  const geo = new PlaneGeometry(2.1, 2.1, map.size - 1, map.size - 1);
  const pos = geo.attributes.position;
  const colorAttr = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i += 1) {
    const h = map.heights[i] ?? 0;
    let x = pos.getX(i);
    let y = pos.getY(i);
    const r = Math.hypot(x, y);
    const ang = Math.atan2(y, x) + twist * r * 0.45;
    const flare = 1 + h * 0.06;
    x = Math.cos(ang) * r * flare;
    y = Math.sin(ang) * r * flare;
    // Keep relief shallow so it sits on the plinth without cutting through.
    pos.setXYZ(i, x, y, h * 0.42);
    colorAttr[i * 3] = map.colors[i * 3] ?? 0.2;
    colorAttr[i * 3 + 1] = map.colors[i * 3 + 1] ?? 0.3;
    colorAttr[i * 3 + 2] = map.colors[i * 3 + 2] ?? 0.4;
  }

  geo.setAttribute("color", new BufferAttribute(colorAttr, 3));
  geo.computeVertexNormals();
  return geo;
}

function CrystalForest({ peaks }: { peaks: Heightmap["peaks"] }) {
  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const quat = useMemo(() => new Quaternion(), []);
  const up = useMemo(() => new Vector3(0, 1, 0), []);
  const dir = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    peaks.forEach((p, i) => {
      const height = 0.05 + p.h * 0.16;
      const radius = 0.01 + p.h * 0.01;
      dummy.position.set(p.x * 0.85, p.y * 0.85, p.z * 0.42 + height * 0.35);
      dir.set(p.x * 0.06, p.y * 0.06, 1).normalize();
      quat.setFromUnitVectors(up, dir);
      dummy.quaternion.copy(quat);
      dummy.scale.set(radius, height, radius);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, new Color(p.r, p.g, p.b));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [peaks, dummy, quat, up, dir]);

  if (!peaks.length) return null;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, peaks.length]}>
      <coneGeometry args={[1, 1, 5]} />
      <meshStandardMaterial
        vertexColors
        metalness={0.7}
        roughness={0.28}
        emissive="#5ce1ff"
        emissiveIntensity={0.18}
      />
    </instancedMesh>
  );
}

function GhostVeil({ map, twist }: { map: Heightmap; twist: number }) {
  const geometry = useMemo(() => buildSculptGeometry(map, twist), [map, twist]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry} scale={[1.01, 1.01, 1.02]} position={[0, 0, 0.02]}>
      <meshBasicMaterial
        color="#8adfff"
        wireframe
        transparent
        opacity={0.03}
        blending={AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  );
}

/** Bas-relief on a plinth — meant to live inside a shared Canvas. */
export function SculptureExhibit({
  map,
  title,
  scale = 1,
  selected = false,
  hovered = false,
}: {
  map: Heightmap;
  title: string;
  scale?: number;
  selected?: boolean;
  hovered?: boolean;
}) {
  const group = useRef<Group>(null);
  const body = useRef<Mesh>(null);
  const column = useRef<Mesh>(null);
  const band = useRef<Mesh>(null);
  const base = useRef<Mesh>(null);
  const glow = useRef(selected ? 1 : 0);
  const twist = 0.12 + hashTitle(title) * 0.18;
  const geometry = useMemo(() => buildSculptGeometry(map, twist), [map, twist]);
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.42,
        roughness: 0.36,
        side: DoubleSide,
        emissive: new Color("#0c2836"),
        emissiveIntensity: 0.22,
      }),
    [],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame(({ clock }, dt) => {
    const t = clock.getElapsedTime();
    const target = selected ? 1 : hovered ? 0.55 : 0;
    glow.current = MathUtils.damp(glow.current, target, 8, dt);
    const g = glow.current;

    if (body.current) {
      const mat = body.current.material as MeshStandardMaterial;
      const baseAmt = 0.18 + 0.1 * g;
      const pulse = 0.025 + 0.025 * g;
      mat.emissiveIntensity = baseAmt + Math.sin(t * 0.9) * pulse;
    }
    if (group.current && selected) {
      group.current.rotation.y = Math.sin(t * 0.2) * 0.05;
    }

    const colMat = column.current?.material as MeshStandardMaterial | undefined;
    const bandMat = band.current?.material as MeshStandardMaterial | undefined;
    const baseMat = base.current?.material as MeshStandardMaterial | undefined;
    if (colMat) {
      colMat.emissiveIntensity = selected ? 0 : 0.11 * g;
    }
    if (bandMat) {
      bandMat.emissiveIntensity = 0.4 + 0.5 * g;
    }
    if (baseMat) {
      baseMat.emissiveIntensity = 0.14 * g;
      baseMat.color.set(g > 0.08 ? "#2f353e" : "#1a1f26");
    }
  });

  // Pedestal cap top is 1.08. Plane half-extent 1.05 + tilt puts the
  // lowest verts ~1.03 below the sculpt origin — keep a clear air gap.
  const plinthTop = 1.08;
  const sculptClearance = 1.03 + 0.16;
  const sculptY = plinthTop + sculptClearance;

  return (
    <group ref={group} scale={scale}>
      <group rotation={[-0.18, 0.08, 0]} position={[0, sculptY, 0.04]}>
        <mesh ref={body} geometry={geometry} material={material} castShadow />
        {selected ? <GhostVeil map={map} twist={twist} /> : null}
        <CrystalForest peaks={map.peaks} />
        {selected ? (
          <Sparkles
            count={10}
            scale={[1.5, 1.5, 0.8]}
            size={1.2}
            speed={0.1}
            opacity={0.24}
            color="#b8f3ff"
          />
        ) : null}
      </group>

      {/* Tool-metal pedestal with cyan instrument band */}
      <mesh ref={column} position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[0.7, 1.0, 0.7]} />
        <meshStandardMaterial
          color="#3a424e"
          emissive="#5ce1ff"
          emissiveIntensity={0}
          roughness={0.42}
          metalness={0.62}
        />
      </mesh>
      <mesh ref={band} position={[0, 0.5, 0]}>
        <boxGeometry args={[0.72, 0.08, 0.72]} />
        <meshStandardMaterial
          color="#5ce1ff"
          emissive="#5ce1ff"
          emissiveIntensity={0.4}
          roughness={0.35}
          metalness={0.2}
        />
      </mesh>
      <mesh position={[0, 1.04, 0]} castShadow>
        <boxGeometry args={[0.82, 0.08, 0.82]} />
        <meshStandardMaterial color="#5a6270" roughness={0.38} metalness={0.7} />
      </mesh>
      {/* Thin mount plate — sculpture rests above this, not through the stand */}
      <mesh position={[0, plinthTop + 0.02, 0]} castShadow>
        <boxGeometry args={[0.9, 0.04, 0.28]} />
        <meshStandardMaterial color="#2f353e" roughness={0.4} metalness={0.65} />
      </mesh>
      <mesh ref={base} position={[0, 0.04, 0]} receiveShadow>
        <boxGeometry args={[0.98, 0.08, 0.98]} />
        <meshStandardMaterial
          color="#1a1f26"
          roughness={0.5}
          metalness={0.55}
          emissive="#5ce1ff"
          emissiveIntensity={0}
        />
      </mesh>
      {selected ? (
        <mesh position={[0, 0.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.52, 0.56, 48]} />
          <meshStandardMaterial
            color="#5ce1ff"
            emissive="#5ce1ff"
            emissiveIntensity={0.7}
            roughness={0.45}
            metalness={0.1}
            transparent
            opacity={0.85}
            side={DoubleSide}
          />
        </mesh>
      ) : null}
    </group>
  );
}
