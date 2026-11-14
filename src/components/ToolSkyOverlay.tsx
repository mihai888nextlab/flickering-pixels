"use client";

import { useEffect, useRef, useState } from "react";
import { spherexFetch } from "@/lib/spherexApi";

type AladinInstance = {
  gotoRaDec: (ra: number, dec: number) => void;
  setFoV: (fov: number) => void;
  removeLayers: () => void;
  addCatalog: (c: unknown) => void;
  setImageSurvey?: (survey: string) => void;
};

type AladinCatalog = {
  addSources: (sources: unknown[]) => void;
};

type AladinApi = {
  init: Promise<void>;
  aladin: (sel: string | HTMLElement, opts: Record<string, unknown>) => AladinInstance;
  catalog: (opts: Record<string, unknown>) => AladinCatalog;
  source: (ra: number, dec: number, data?: Record<string, unknown>) => unknown;
};

type SkySource = {
  ra: number;
  dec: number;
  name: string;
  mag?: number | null;
  w1?: number | null;
  w2?: number | null;
  catalog: string;
};

type SkyCatalogs = {
  gaia: SkySource[];
  allwise: SkySource[];
  errors: string[];
};

declare global {
  interface Window {
    A?: AladinApi;
  }
}

const HOST_ID = "tool-sky-aladin";

/** IRSA-mirrored 2MASS colour HiPS, served same-origin via next.config rewrite. */
function hipsSurveyUrl() {
  if (typeof window === "undefined") return "/hips/CDS/2MASS/Color";
  return `${window.location.origin}/hips/CDS/2MASS/Color`;
}

function ensureAladinScript() {
  if (typeof window === "undefined") return;
  if (window.A || document.querySelector("script[data-aladin-lite]")) return;
  const script = document.createElement("script");
  script.type = "module";
  script.dataset.aladinLite = "1";
  script.textContent = `
    import("https://cdn.jsdelivr.net/npm/aladin-lite@3.6.5/dist/aladin.js")
      .then(({ default: A }) => {
        window.A = A;
        window.dispatchEvent(new Event("aladin-ready"));
      })
      .catch(() => {
        window.dispatchEvent(new CustomEvent("aladin-error", {
          detail: "Aladin Lite could not be downloaded."
        }));
      });
  `;
  document.head.appendChild(script);
}

function waitForAladin(): Promise<AladinApi> {
  return new Promise((resolve, reject) => {
    if (window.A) {
      resolve(window.A);
      return;
    }
    const onReady = () => {
      cleanup();
      if (window.A) resolve(window.A);
      else reject(new Error("Aladin Lite loaded without API."));
    };
    const onErr = (event: Event) => {
      cleanup();
      const detail = (event as CustomEvent<string>).detail;
      reject(new Error(detail || "Aladin Lite could not start."));
    };
    const cleanup = () => {
      window.removeEventListener("aladin-ready", onReady);
      window.removeEventListener("aladin-error", onErr);
    };
    window.addEventListener("aladin-ready", onReady, { once: true });
    window.addEventListener("aladin-error", onErr, { once: true });
    ensureAladinScript();
  });
}

function toAladinSources(A: AladinApi, rows: SkySource[]) {
  return rows.map((row) => {
    const data: Record<string, unknown> = {
      name: row.name,
      catalog: row.catalog,
    };
    if (row.mag != null) data.mag = row.mag;
    if (row.w1 != null) data.W1 = row.w1;
    if (row.w2 != null) data.W2 = row.w2;
    return A.source(row.ra, row.dec, data);
  });
}

export default function ToolSkyOverlay({
  open,
  onClose,
  ra,
  dec,
  fov,
  label,
}: {
  open: boolean;
  onClose: () => void;
  ra: number;
  dec: number;
  fov: number;
  label?: string | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const [msg, setMsg] = useState("Loading sky context…");
  const [showGaia, setShowGaia] = useState(true);
  const [showWise, setShowWise] = useState(true);
  const [catalogs, setCatalogs] = useState<SkyCatalogs | null>(null);
  const [viewEpoch, setViewEpoch] = useState(0);
  const [viewerReady, setViewerReady] = useState(false);

  // Fresh mount key whenever the modal opens on a field.
  useEffect(() => {
    if (!open) {
      aladinRef.current = null;
      setCatalogs(null);
      setViewerReady(false);
      setMsg("Loading sky context…");
      return;
    }
    setViewerReady(false);
    setViewEpoch((n) => n + 1);
  }, [open, ra, dec, fov]);

  // Load catalogues from our API (IRSA SCS), not CDS VizieR.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const radius = Math.min(0.35, Math.max(0.06, fov * 1.15));
    setMsg("Loading Gaia / AllWISE from IRSA…");
    (async () => {
      try {
        const data = await spherexFetch<SkyCatalogs>(
          `/api/context/catalogs?ra=${encodeURIComponent(String(ra))}&dec=${encodeURIComponent(String(dec))}&radius_deg=${radius.toFixed(4)}&gaia=true&wise=true`,
        );
        if (cancelled) return;
        setCatalogs(data);
        if (data.errors?.length && !data.gaia.length && !data.allwise.length) {
          setMsg(data.errors.join(" · "));
        }
      } catch (err) {
        if (!cancelled) {
          setCatalogs({ gaia: [], allwise: [], errors: [err instanceof Error ? err.message : "Catalog fetch failed"] });
          setMsg(err instanceof Error ? err.message : "Catalog fetch failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ra, dec, fov]);

  // Create Aladin once per viewEpoch, using the IRSA HiPS proxy for the base map.
  useEffect(() => {
    if (!open || viewEpoch === 0) return;
    let cancelled = false;

    (async () => {
      try {
        setMsg((current) => current || "Starting Aladin Lite…");
        const A = await waitForAladin();
        await A.init;
        if (cancelled || !hostRef.current) return;

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        if (cancelled || !hostRef.current) return;

        const viewFov = Math.max(fov * 1.2, 0.08);
        const survey = hipsSurveyUrl();
        const view = A.aladin(hostRef.current, {
          survey,
          fov: viewFov,
          target: `${ra} ${dec}`,
          showReticle: true,
          showCooGrid: false,
          showContextMenu: false,
        });
        // Explicitly set survey again in case the constructor ID path still hits CDS.
        view.setImageSurvey?.(survey);
        view.gotoRaDec(ra, dec);
        view.setFoV(viewFov);
        aladinRef.current = view;
        if (!cancelled) {
          setViewerReady(true);
          setMsg("");
        }
      } catch (err) {
        if (!cancelled) {
          aladinRef.current = null;
          setViewerReady(false);
          setMsg(err instanceof Error ? err.message : "Aladin Lite could not start.");
        }
      }
    })();

    return () => {
      cancelled = true;
      aladinRef.current = null;
      setViewerReady(false);
      hostRef.current?.replaceChildren();
    };
  }, [open, viewEpoch, ra, dec, fov]);

  // Paint catalogue markers whenever toggles / data / viewer change.
  useEffect(() => {
    if (!open || !catalogs || !viewerReady) return;
    const view = aladinRef.current;
    const A = window.A;
    if (!view || !A) return;

    view.removeLayers();
    // Keep IRSA survey after overlay clear.
    view.setImageSurvey?.(hipsSurveyUrl());

    if (showGaia && catalogs.gaia.length) {
      const cat = A.catalog({
        name: "Gaia DR3",
        color: "#ffb454",
        sourceSize: 10,
        displayLabel: false,
        onClick: "showPopup",
      });
      cat.addSources(toAladinSources(A, catalogs.gaia));
      view.addCatalog(cat);
    }
    if (showWise && catalogs.allwise.length) {
      const cat = A.catalog({
        name: "AllWISE",
        color: "#39d0ff",
        sourceSize: 12,
        shape: "circle",
        displayLabel: false,
        onClick: "showPopup",
      });
      cat.addSources(toAladinSources(A, catalogs.allwise));
      view.addCatalog(cat);
    }
  }, [open, catalogs, showGaia, showWise, viewEpoch, viewerReady]);

  if (!open) return null;

  const gaiaCount = catalogs?.gaia.length ?? 0;
  const wiseCount = catalogs?.allwise.length ?? 0;

  return (
    <div
      className="tool-spectrum-modal tool-sky-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Sky context overlays"
    >
      <button
        type="button"
        className="tool-spectrum-modal-scrim"
        aria-label="Close sky context"
        onClick={onClose}
      />
      <div className="tool-spectrum-modal-stage tool-sky-stage">
        <header className="tool-spectrum-modal-bar">
          <div>
            <p className="tool-side-label">Context</p>
            <h2>Sky overlays</h2>
          </div>
          <button
            type="button"
            className="tool-spectrum-modal-close"
            aria-label="Close sky context"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="tool-sky-meta">
          <p>
            {label ? <strong>{label}</strong> : null}
            {label ? " · " : null}
            RA {ra.toFixed(5)}°, Dec {dec.toFixed(5)}° · FOV {fov.toFixed(2)}°
          </p>
          <div className="tool-sky-toggles" role="group" aria-label="Catalog overlays">
            <button
              type="button"
              className={showGaia ? "is-on" : undefined}
              aria-pressed={showGaia}
              onClick={() => setShowGaia((v) => !v)}
            >
              <i className="is-gaia" aria-hidden="true" />
              Gaia DR3{gaiaCount ? ` (${gaiaCount})` : ""}
            </button>
            <button
              type="button"
              className={showWise ? "is-on" : undefined}
              aria-pressed={showWise}
              onClick={() => setShowWise((v) => !v)}
            >
              <i className="is-wise" aria-hidden="true" />
              AllWISE{wiseCount ? ` (${wiseCount})` : ""}
            </button>
          </div>
        </div>

        <div className="tool-sky-aladin-shell">
          {msg ? <span className="tool-sky-aladin-msg">{msg}</span> : null}
          <div key={viewEpoch} id={HOST_ID} ref={hostRef} className="tool-sky-aladin" />
        </div>

        <p className="tool-sky-caption">
          Base map: 2MASS colour via IRSA HiPS (proxied). Markers: Gaia DR3 + AllWISE from IRSA cone
          search — not CDS VizieR, so this works when European mirrors are blocked.
          {catalogs?.errors?.length ? ` · ${catalogs.errors.join(" · ")}` : ""}
        </p>
      </div>
    </div>
  );
}
