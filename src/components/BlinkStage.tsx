"use client";

import { DeckBtn, DeckLed } from "@/components/deck/DeckPrimitives";
import { FALLBACK_DETECTORS } from "@/lib/spherexApi";
import { useEffect, useMemo, useState } from "react";
import manifest from "@/data/blink-m31-manifest.json";

const BASE = "/media/blink-m31";

const DET_COLORS: Record<number, string> = {
  1: "#7ee7ff",
  2: "#5ce1ff",
  3: "#3aa7c4",
  4: "#c9a227",
  5: "#e8c56a",
  6: "#f0a060",
};

export default function BlinkStage() {
  const epochs = manifest.epochs;
  const [playing, setPlaying] = useState(true);
  const [visit, setVisit] = useState(0);
  const [detectorId, setDetectorId] = useState(5);

  useEffect(() => {
    if (!playing || epochs.length < 2) return;
    const id = window.setInterval(() => {
      setVisit((current) => (current + 1) % epochs.length);
    }, 650);
    return () => window.clearInterval(id);
  }, [playing, epochs.length]);

  const frame = epochs[visit];
  const image = useMemo(() => {
    const key = `v${visit}_d${detectorId}` as keyof typeof manifest.band_views;
    const file = manifest.band_views[key] ?? frame.png;
    const band = FALLBACK_DETECTORS.find((d) => d.id === detectorId);
    return {
      src: `${BASE}/${file}`,
      label: `${band?.label ?? `D${detectorId}`} · ${band ? `${band.lo.toFixed(2)}–${band.hi.toFixed(2)} µm` : ""}`,
    };
  }, [detectorId, visit, frame.png]);

  const fieldColor = DET_COLORS[detectorId] ?? "#5ce1ff";

  const stopAt = (index: number) => {
    setPlaying(false);
    setVisit(index);
  };

  return (
    <section className="section deck-section" id="blink">
      <div className="container">
        <div className="deck-blink-split">
          <header className="deck-head deck-blink-copy">
            <div className="deck-head-meta">
              <DeckLed tone="cyan" pulse />
              <p className="kicker">Live blink</p>
            </div>
            <h2>This is the view inside the tool.</h2>
            <p className="section-lead">
              Real SPHEREx cutouts of {manifest.target.name} (RA {manifest.target.ra}°, Dec{" "}
              {manifest.target.dec}°). Flicker the visits and retune the wavelength.
            </p>
            <p className="deck-actions">
              <DeckBtn href="/tool?enter=1">Open the sky map</DeckBtn>
            </p>
          </header>

          <div className="deck-blink-stage" aria-label="SPHEREx blink preview">
            <div className="tool-wave deck-blink-wave">
              <div className="tool-wave-panel">
                <div
                  className="tool-band-bank is-compact"
                  role="group"
                  aria-label="Infrared wavelength bands"
                >
                  {FALLBACK_DETECTORS.map((d) => {
                    const on = detectorId === d.id;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className={on ? "tool-band-key is-on" : "tool-band-key"}
                        aria-pressed={on}
                        aria-label={`${d.label} ${d.lo.toFixed(2)} to ${d.hi.toFixed(2)} micrometers`}
                        onClick={() => setDetectorId(d.id)}
                      >
                        <i aria-hidden="true" />
                        <span className="tool-band-key-id">{d.label}</span>
                        <span className="tool-band-key-um">
                          {d.lo.toFixed(1)}–{d.hi.toFixed(1)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <section className="tool-viewport deck-blink-viewport">
              <div className="tool-frame-bar">
                <span>
                  Pass {visit + 1}/{epochs.length} · {frame.start}
                  {frame.end !== frame.start ? ` → ${frame.end}` : ""}
                </span>
                <span>{image.label}</span>
              </div>
              <div
                className="tool-field is-live is-amateur"
                style={{ ["--field" as string]: fieldColor }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="tool-cutout"
                  src={image.src}
                  alt={`SPHEREx ${manifest.target.name} · ${image.label}`}
                  draggable={false}
                />
              </div>
            </section>

            <div className="tool-timeline" aria-label="Visit timeline">
              <button
                type="button"
                className={playing ? "tool-blink is-on" : "tool-blink"}
                onClick={() => setPlaying((on) => !on)}
              >
                <i aria-hidden="true" />
                <span>{playing ? "Stop" : "Flicker"}</span>
              </button>
              <div className="tool-timeline-well">
                <div className="tool-dots" role="listbox" aria-label="Survey passes">
                  {epochs.map((item, index) => (
                    <button
                      key={`${item.start}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === visit}
                      className={index === visit ? "tool-dot is-on" : "tool-dot"}
                      title={`${item.start} → ${item.end}`}
                      onClick={() => stopAt(index)}
                    >
                      <span className="sr-only">
                        Survey pass {index + 1}: {item.start} to {item.end}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="tool-arrows">
                <button
                  type="button"
                  aria-label="Earlier visit"
                  onClick={() => stopAt((visit - 1 + epochs.length) % epochs.length)}
                >
                  ←
                </button>
                <button
                  type="button"
                  aria-label="Later visit"
                  onClick={() => stopAt((visit + 1) % epochs.length)}
                >
                  →
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
