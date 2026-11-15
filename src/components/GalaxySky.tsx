"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, Color, NearestFilter, type Group } from "three";

const STAR_COLORS = ["#e1e9ef", "#c9c4d2", "#a39bb9", "#8e9eb3", "#a5cbd4", "#c9dfe3"].map(
  (hex) => new Color(hex),
);

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
    const texture = new CanvasTexture(canvas);
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.needsUpdate = true;
    return texture;
  }, []);
}

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

function DriftSky() {
  const field = useRef<Group>(null);
  const square = useSquareTexture();
  const cross = useCrossTexture();

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (!field.current) return;
    field.current.rotation.y = t * 0.018;
    field.current.rotation.x = Math.sin(t * 0.07) * 0.1;
    field.current.rotation.z = Math.sin(t * 0.045) * 0.04;
  });

  return (
    <group ref={field}>
      <PixelPoints count={380} near={4.2} far={13} size={0.034} map={square} />
      <PixelPoints count={40} near={5.2} far={10.5} size={0.34} map={cross} cutoff={0.08} />
      <PixelPoints count={12} near={5.8} far={9} size={0.72} map={cross} cutoff={0.08} />
    </group>
  );
}

export default function GalaxySky() {
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const deck = document.querySelector(".site-deck");
      const frame = frameRef.current;
      if (!(deck instanceof HTMLElement) || !frame) return;

      const rect = deck.getBoundingClientRect();
      const viewH = window.innerHeight;
      const top = Math.max(0, rect.top);
      const bottom = Math.max(0, viewH - rect.bottom);
      const visible = rect.bottom > 0 && rect.top < viewH;
      frame.style.clipPath = `inset(${top}px 0 ${bottom}px 0)`;
      frame.style.opacity = visible ? "1" : "0";
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className="galaxy-field-canvas" ref={frameRef}>
      <Canvas
        camera={{ position: [0, 0.15, 2.4], fov: 42, near: 0.1, far: 40 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true, premultipliedAlpha: false }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
        style={{ pointerEvents: "none" }}
      >
        <DriftSky />
      </Canvas>
    </div>
  );
}
