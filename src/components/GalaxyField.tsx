"use client";

import dynamic from "next/dynamic";

const GalaxySky = dynamic(() => import("./GalaxySky"), {
  ssr: false,
});

/** Page-anchored nebula washes + drifting 3D pixel stars behind the post-hero deck. */
export default function GalaxyField() {
  return (
    <div className="galaxy-field" aria-hidden="true">
      <div className="galaxy-field-fallback" />
      {/* Anchored to the page — not to the rotating sky. */}
      <span className="galaxy-nebula is-challenge" />
      <span className="galaxy-nebula is-approach" />
      <span className="galaxy-nebula is-blink" />
      <span className="galaxy-nebula is-targets" />
      <span className="galaxy-nebula is-closing" />
      <GalaxySky />
    </div>
  );
}
