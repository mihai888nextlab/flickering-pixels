"use client";

import { useEffect, useState, type CSSProperties } from "react";

export type UserMode = "amateur" | "expert";

type Phase = "mode" | "tutorial";

type Props = {
  open: boolean;
  onExpert: () => void;
  onAmateurSkip: () => void;
  onAmateurTour: () => void;
};

export default function ModeGate({ open, onExpert, onAmateurSkip, onAmateurTour }: Props) {
  const [phase, setPhase] = useState<Phase>("mode");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open) {
      setVisible(false);
      setPhase("mode");
      return;
    }
    const id = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && phase === "tutorial") setPhase("mode");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase]);

  if (!open) return null;

  return (
    <div
      className={visible ? "tool-gate is-in" : "tool-gate"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tool-gate-title"
    >
      <div className="tool-gate-sky" aria-hidden="true">
        <i className="tool-gate-aurora" />
        <i className="tool-gate-grain" />
        {Array.from({ length: 28 }, (_, i) => (
          <span
            key={i}
            className="tool-gate-star"
            style={
              {
                ["--x" as string]: `${(i * 37) % 100}%`,
                ["--y" as string]: `${(i * 53) % 100}%`,
                ["--d" as string]: `${0.8 + (i % 5) * 0.35}s`,
                ["--s" as string]: `${1 + (i % 3)}`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div className="tool-gate-panel">
        <p className="tool-gate-kicker">
          <i className="tool-dash-led is-live" aria-hidden="true" />
          Enter the instrument
        </p>

        {phase === "mode" ? (
          <>
            <h2 id="tool-gate-title">How do you want to look?</h2>
            <p className="tool-gate-lead">
              Amateur starts on the sky map with an optional tour. Expert jumps straight into free
              exploration — then open Data analysis when you want spectra and bands.
            </p>
            <div className="tool-gate-cards" role="group" aria-label="Choose a mode">
              <button type="button" className="tool-gate-card is-amateur" onClick={() => setPhase("tutorial")}>
                <span className="tool-gate-card-idx">01</span>
                <strong>Amateur</strong>
                <span>Sky map first, with a short guided tour if you want it.</span>
                <em>Recommended first flight</em>
              </button>
              <button type="button" className="tool-gate-card is-expert" onClick={onExpert}>
                <span className="tool-gate-card-idx">02</span>
                <strong>Expert</strong>
                <span>Full map controls — open Data analysis for the lab.</span>
                <em>Skip the tour</em>
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="tool-gate-title">Want a short tour?</h2>
            <p className="tool-gate-lead">
              A short sky-map tour: blink, red/cyan, search, the globe, right-click actions —
              then Data analysis for bands and spectra.
            </p>
            <div className="tool-gate-actions">
              <button type="button" className="tool-gate-primary" onClick={onAmateurTour}>
                Yes — guide me
              </button>
              <button type="button" className="tool-gate-ghost" onClick={onAmateurSkip}>
                No — I will explore
              </button>
              <button type="button" className="tool-gate-back" onClick={() => setPhase("mode")}>
                ← Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
