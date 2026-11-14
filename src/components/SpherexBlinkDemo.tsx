"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

const API = "/spherex-api";

type Preset = { name: string; ra: number; dec: number; fov: number };
type DetectorBand = { id: number; label: string; lo: number; hi: number };
type Config = {
  collections: string[];
  default_collections: string[];
  max_frames: number;
  max_frames_cap: number;
  detectors: DetectorBand[];
  presets: Record<string, Preset>;
};

const FALLBACK_DETECTORS: DetectorBand[] = [
  { id: 1, label: "D1", lo: 0.75, hi: 1.11 },
  { id: 2, label: "D2", lo: 1.11, hi: 1.63 },
  { id: 3, label: "D3", lo: 1.63, hi: 2.42 },
  { id: 4, label: "D4", lo: 2.42, hi: 3.82 },
  { id: 5, label: "D5", lo: 3.82, hi: 4.42 },
  { id: 6, label: "D6", lo: 4.42, hi: 5.0 },
];

function detectorForWavelength(um: number, bands: DetectorBand[]) {
  const hit = bands.find((b) => um >= b.lo && um <= b.hi);
  if (hit) return hit.id;
  return bands.reduce((best, b) => {
    const mid = (b.lo + b.hi) / 2;
    const bestMid = (bands.find((x) => x.id === best)!.lo + bands.find((x) => x.id === best)!.hi) / 2;
    return Math.abs(mid - um) < Math.abs(bestMid - um) ? b.id : best;
  }, bands[0]?.id ?? 1);
}

type Frame = {
  png: string;
  date: string;
  detector: number;
  band: string;
  collection: string;
  obs_id: string;
  flagged: number;
};

type Epoch = {
  png: string;
  start: string;
  end: string;
  n: number;
  target_px: [number, number];
};

type Detector = { png: string; detector: number; n: number; band: string };

type Result = {
  target: { name: string; ra: number; dec: number };
  fov: number;
  npix: number;
  n_found: number;
  n_used: number;
  frames: Frame[];
  epochs: Epoch[];
  detectors: Detector[];
  rgb: string | null;
};

type SpectrumPoint = { wavelength_um: number; flux: number; detector: number; date: string };
type Spectrum = { ra: number; dec: number; points: SpectrumPoint[]; rejected: number };

type Mode = "epochs" | "frames" | "diff";

type AladinApi = {
  init: Promise<void>;
  aladin: (
    sel: string,
    opts: Record<string, unknown>,
  ) => {
    gotoRaDec: (ra: number, dec: number) => void;
    setFoV: (fov: number) => void;
    removeLayers: () => void;
    addCatalog: (c: unknown) => void;
  };
  catalogFromVizieR: (
    catalog: string,
    target: string,
    radius: number,
    opts: Record<string, unknown>,
  ) => unknown;
};

declare global {
  interface Window {
    A?: AladinApi;
  }
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string | { msg?: string }[] }).detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((d) => d.msg).filter(Boolean).join("; ")
          : res.status === 500 || res.status === 502 || res.status === 504
            ? "The name service proxy timed out. Retrying…"
            : res.statusText || "Request failed";
    throw new ApiError(
      res.status,
      message || `Backend unreachable (${res.status}). Run: npm run spherex:api`,
    );
  }
  return res.json() as Promise<T>;
}

function pngUrl(job: string, name: string) {
  return `${API}/api/job/${job}/png/${name}`;
}

export default function SpherexBlinkDemo() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewerRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<ReturnType<AladinApi["aladin"]> | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const bootstrapped = useRef(false);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [ra, setRa] = useState("");
  const [dec, setDec] = useState("");
  const [fov, setFov] = useState(0.1);
  const [name, setName] = useState("");
  const [collections, setCollections] = useState<string[]>([]);
  const [job, setJob] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  /** Infrared panel: RGB composite or a single detector stack. */
  const [irView, setIrView] = useState<"rgb" | number>("rgb");
  const [waveUm, setWaveUm] = useState(2.0);
  const [status, setStatus] = useState("Loading config…");
  const [statusErr, setStatusErr] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("epochs");
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(600);
  const [diffA, setDiffA] = useState(0);
  const [diffB, setDiffB] = useState(0);
  const [blinkSrc, setBlinkSrc] = useState("");
  const [frameMeta, setFrameMeta] = useState("");
  const [pm, setPm] = useState<{ left: string; top: string } | null>(null);
  const [specHtml, setSpecHtml] = useState("");
  const [specMeta, setSpecMeta] = useState("Click a pixel in the Blink panel.");
  const [aladinMsg, setAladinMsg] = useState("Loading Aladin Lite…");

  const detectorBands = cfg?.detectors?.length ? cfg.detectors : FALLBACK_DETECTORS;

  const list = useMemo(() => {
    if (!result) return [] as (Frame | Epoch)[];
    if (mode === "frames") {
      if (irView === "rgb") return result.frames;
      return result.frames.filter((f) => f.detector === irView);
    }
    return result.epochs;
  }, [result, mode, irView]);

  const irBigSrc = useMemo(() => {
    if (!result || !job) return undefined;
    if (irView === "rgb") return result.rgb ? pngUrl(job, result.rgb) : undefined;
    const det = result.detectors.find((d) => d.detector === irView);
    return det ? pngUrl(job, det.png) : result.rgb ? pngUrl(job, result.rgb) : undefined;
  }, [result, job, irView]);

  const irCaption = useMemo(() => {
    if (irView === "rgb") {
      return "Blue = D1+D2 (0.75–1.6 µm), green = D3+D4 (1.6–3.8 µm), red = D5+D6 (3.8–5 µm). Cold brown dwarfs look red.";
    }
    const band = detectorBands.find((b) => b.id === irView);
    const loaded = result?.detectors.find((d) => d.detector === irView);
    if (!band) return "";
    return `Detector ${band.label} · ${band.lo.toFixed(2)}–${band.hi.toFixed(2)} µm${loaded ? ` · ${loaded.n} frames stacked` : " · not in this load"}`;
  }, [irView, detectorBands, result]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api<Config>("/api/config");
        if (cancelled) return;
        setCfg(config);
        setCollections(config.default_collections);
        setStatus("Pick a challenge target or enter coordinates.");
        setStatusErr(false);
      } catch (err) {
        if (cancelled) return;
        setStatus(
          err instanceof Error
            ? err.message
            : "Cannot reach the SPHEREx API. In another terminal run: npm run spherex:api",
        );
        setStatusErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const existing = document.querySelector("script[data-aladin-lite]");
    if (existing) return;
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
          window.dispatchEvent(new CustomEvent("aladin-error", { detail: "Aladin Lite could not be downloaded." }));
        });
    `;
    document.head.appendChild(script);
    const onErr = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setAladinMsg(detail || "Aladin Lite could not start.");
    };
    window.addEventListener("aladin-error", onErr);
    return () => window.removeEventListener("aladin-error", onErr);
  }, []);

  const showAladin = useCallback((targetRa: number, targetDec: number, targetFov: number) => {
    const start = () => {
      const A = window.A;
      if (!A) {
        window.addEventListener("aladin-ready", () => showAladin(targetRa, targetDec, targetFov), {
          once: true,
        });
        return;
      }
      A.init
        .then(() => {
          setAladinMsg("");
          if (!aladinRef.current) {
            aladinRef.current = A.aladin("#sx-aladin", {
              survey: "P/2MASS/color",
              fov: targetFov * 1.2,
              target: `${targetRa} ${targetDec}`,
              showReticle: true,
              showCooGrid: false,
            });
          } else {
            aladinRef.current.gotoRaDec(targetRa, targetDec);
            aladinRef.current.setFoV(targetFov * 1.2);
            aladinRef.current.removeLayers();
          }
          const r = Math.max(targetFov, 0.05);
          aladinRef.current.addCatalog(
            A.catalogFromVizieR("I/355/gaiadr3", `${targetRa} ${targetDec}`, r, {
              onClick: "showTable",
              color: "#ffb454",
              sourceSize: 10,
            }),
          );
          aladinRef.current.addCatalog(
            A.catalogFromVizieR("II/328/allwise", `${targetRa} ${targetDec}`, r, {
              onClick: "showTable",
              color: "#39d0ff",
              sourceSize: 14,
              shape: "circle",
            }),
          );
        })
        .catch((err: Error) => setAladinMsg(`Aladin Lite could not start: ${err.message}`));
    };
    start();
  }, []);

  const showFrame = useCallback(
    (
      nextIdx: number,
      nextMode: Mode,
      nextResult: Result,
      nextJob: string,
      detFilter: "rgb" | number = "rgb",
    ) => {
      const items =
        nextMode === "frames"
          ? detFilter === "rgb"
            ? nextResult.frames
            : nextResult.frames.filter((frame) => frame.detector === detFilter)
          : nextResult.epochs;
      if (!items.length) {
        setFrameMeta(
          nextMode === "frames" && detFilter !== "rgb"
            ? `No frames for D${detFilter} in this load.`
            : "No frames.",
        );
        setPm(null);
        return;
      }
      const i = nextIdx % items.length;
      const f = items[i];
      setBlinkSrc(pngUrl(nextJob, f.png));
      if (nextMode === "epochs") {
        const epoch = f as Epoch;
        setFrameMeta(
          `Pass <b>${i + 1}/${items.length}</b> · <b>${epoch.start}</b> → ${epoch.end} · ${epoch.n} frames stacked`,
        );
        const n = nextResult.npix;
        setPm({
          left: `${(100 * (epoch.target_px[0] + 0.5)) / n}%`,
          top: `${(100 * (epoch.target_px[1] + 0.5)) / n}%`,
        });
      } else {
        const frame = f as Frame;
        setPm(null);
        setFrameMeta(
          `Frame <b>${i + 1}/${items.length}</b> · <b>${frame.date}</b> · detector D${frame.detector} (${frame.band}) · ${frame.collection.replace("spherex_", "").toUpperCase()} · ${frame.obs_id} · flags ${(100 * frame.flagged).toFixed(1)}%`,
        );
      }
    },
    [],
  );

  const showDiff = useCallback(
    (nextJob: string, nextResult: Result, a: number, b: number) => {
      setPm(null);
      setBlinkSrc(`${API}/api/job/${nextJob}/diff?a=${a}&b=${b}`);
      const E = nextResult.epochs;
      setFrameMeta(
        E.length < 2
          ? "Need at least 2 survey passes for a difference."
          : `<b>${E[b].start}</b> minus <b>${E[a].start}</b>. Things that moved show up as a black/white pair.`,
      );
    },
    [],
  );

  const applyMode = useCallback(
    (nextMode: Mode, nextResult: Result, nextJob: string, detFilter: "rgb" | number = "rgb") => {
      setMode(nextMode);
      if (nextMode === "diff") {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        showDiff(nextJob, nextResult, diffA, Math.max(diffB, nextResult.epochs.length - 1));
        return;
      }
      setIdx(0);
      showFrame(0, nextMode, nextResult, nextJob, detFilter);
    },
    [diffA, diffB, showDiff, showFrame],
  );

  const poll = useCallback(
    async (key: string) => {
      if (activeJobRef.current !== key) return;
      try {
        const s = await api<{
          status: string;
          done?: number;
          total?: number;
          attempt?: number;
          message?: string;
          error?: string;
          result?: Result;
        }>(`/api/job/${key}`);
        if (activeJobRef.current !== key) return;
        if (s.status === "error") {
          setStatus(s.error || "Job failed");
          setStatusErr(true);
          setLoading(false);
          setProgress(null);
          setProgressIndeterminate(false);
          return;
        }
        if (s.status === "done" && s.result) {
          const r = s.result;
          setResult(r);
          setLoading(false);
          setProgress(null);
          setProgressIndeterminate(false);
          const span = r.epochs.length ? `${r.epochs[0].start} → ${r.epochs.at(-1)!.end}` : "";
          setStatus(
            `<b>${r.target.name}</b> · RA ${r.target.ra.toFixed(5)}°, Dec ${r.target.dec.toFixed(5)}° · ${r.n_found} SPHEREx images found, ${r.n_used} used · ${r.epochs.length} survey passes · ${span}`,
          );
          setStatusErr(false);
          setDiffA(0);
          setDiffB(Math.max(0, r.epochs.length - 1));
          setIrView(r.rgb ? "rgb" : r.detectors[0]?.detector ?? "rgb");
          setSpecHtml("");
          setSpecMeta("Click a pixel in the Blink panel.");
          [...r.epochs, ...r.frames].forEach((f) => {
            const img = new Image();
            img.src = pngUrl(key, f.png);
          });
          const nextMode = r.epochs.length > 1 ? "epochs" : "frames";
          applyMode(nextMode, r, key, r.rgb ? "rgb" : r.detectors[0]?.detector ?? "rgb");
          showAladin(r.target.ra, r.target.dec, r.fov);
          return;
        }

        setLoading(true);
        setStatusErr(false);
        if (s.status === "searching") {
          setProgressIndeterminate(true);
          setProgress(null);
          setStatus(
            s.message ||
              `Searching the SPHEREx archive…${s.attempt ? ` (attempt ${s.attempt})` : ""} — keeping at it, IRSA can be slow`,
          );
        } else if (s.status === "downloading") {
          const pct = s.total ? Math.round((100 * (s.done || 0)) / s.total) : 0;
          setProgressIndeterminate(false);
          setProgress(pct);
          setStatus(
            s.message ||
              `Downloading cutouts from IRSA: ${s.done ?? 0}/${s.total ?? 0}`,
          );
        } else if (s.status === "processing") {
          setProgressIndeterminate(true);
          setProgress(null);
          setStatus(s.message || "Aligning and stacking images…");
        } else {
          setProgressIndeterminate(true);
          setStatus(s.message || s.status);
        }
        pollTimerRef.current = window.setTimeout(() => poll(key), 1000);
      } catch {
        if (activeJobRef.current !== key) return;
        // Network blip while polling — keep trying instead of aborting the job.
        setStatus("Lost connection to the demo API — retrying…");
        setStatusErr(false);
        setLoading(true);
        setProgressIndeterminate(true);
        pollTimerRef.current = window.setTimeout(() => poll(key), 2000);
      }
    },
    [applyMode, showAladin],
  );

  const load = useCallback(
    async (body: Record<string, unknown>, opts?: { force?: boolean }) => {
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      // Reuse an in-flight job for the same target so a long IRSA wait is not cancelled.
      const payload = {
        ...body,
        collections,
        force: Boolean(opts?.force),
      };
      const q = body.preset
        ? `?preset=${body.preset}`
        : `?ra=${body.ra}&dec=${body.dec}&fov=${body.fov}`;
      router.replace(`/tool-demo${q}`);
      setResult(null);
      setStatus("Searching the SPHEREx archive…");
      setStatusErr(false);
      setLoading(true);
      setProgressIndeterminate(true);
      setProgress(null);
      try {
        const { job: key } = await api<{ job: string }>("/api/load", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        activeJobRef.current = key;
        setJob(key);
        poll(key);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Load failed");
        setStatusErr(true);
        setLoading(false);
        setProgress(null);
        setProgressIndeterminate(false);
      }
    },
    [collections, poll, router],
  );

  useEffect(() => {
    if (!cfg || bootstrapped.current) return;
    bootstrapped.current = true;
    const preset = searchParams.get("preset");
    const qRa = searchParams.get("ra");
    const qDec = searchParams.get("dec");
    const qFov = searchParams.get("fov");
    if (preset && cfg.presets[preset]) {
      const p = cfg.presets[preset];
      setRa(p.ra.toFixed(5));
      setDec(p.dec.toFixed(5));
      setFov(p.fov);
      void load({ preset, fov: p.fov });
    } else if (qRa && qDec) {
      setRa(qRa);
      setDec(qDec);
      const nextFov = qFov ? +qFov : 0.1;
      if (qFov) setFov(nextFov);
      void load({ ra: +qRa, dec: +qDec, fov: nextFov });
    }
    // Intentionally once after config arrives — not on every load identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  useEffect(() => {
    return () => {
      activeJobRef.current = null;
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!job || !result || mode === "diff" || !playing || list.length === 0) {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      return;
    }
    const delay = 1500 + 100 - speed;
    timerRef.current = window.setTimeout(() => {
      setIdx((current) => {
        const next = (current + 1) % list.length;
        showFrame(next, mode, result, job, irView);
        return next;
      });
    }, delay);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [job, result, mode, playing, speed, idx, list.length, showFrame, irView]);

  useEffect(() => {
    if (!job || !result) return;
    if (mode === "diff") showDiff(job, result, diffA, diffB);
    else showFrame(idx, mode, result, job, irView);
  }, [diffA, diffB, job, mode, result, idx, showDiff, showFrame, irView]);

  useEffect(() => {
    if (!job || !result || mode !== "frames") return;
    setIdx(0);
    showFrame(0, mode, result, job, irView);
    // Only when wavelength / detector filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [irView]);

  async function onResolve(event: FormEvent) {
    event.preventDefault();
    setStatusErr(false);
    setLoading(true);
    setProgressIndeterminate(true);
    setProgress(null);
    const query = name.trim();
    if (!query) {
      setStatus("Enter an object name to resolve.");
      setStatusErr(true);
      setLoading(false);
      setProgressIndeterminate(false);
      return;
    }

    // NED is usually fast; a few retries cover transient blips without proxy timeouts.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      setStatus(`Resolving “${query}” via NASA/IPAC NED…${attempt > 1 ? ` attempt ${attempt}/4` : ""}`);
      try {
        const t = await api<{ ra_2026: number; dec_2026: number; name?: string; resolver?: string }>(
          `/api/resolve?name=${encodeURIComponent(query)}`,
        );
        setRa(t.ra_2026.toFixed(5));
        setDec(t.dec_2026.toFixed(5));
        setStatus(`Resolved ${t.name ?? query} → loading SPHEREx frames…`);
        await load({ ra: t.ra_2026, dec: t.dec_2026, fov });
        return;
      } catch (err) {
        const statusCode = err instanceof ApiError ? err.status : 0;
        // Unknown name — stop. Timeouts / 5xx — keep trying.
        if (statusCode === 404) {
          setStatus(err instanceof Error ? err.message : "Unknown name");
          setStatusErr(true);
          setLoading(false);
          setProgressIndeterminate(false);
          return;
        }
        if (attempt === 4) {
          setStatus(
            err instanceof Error
              ? err.message
              : "Name lookup failed. Use RA/Dec or a challenge preset.",
          );
          setStatusErr(true);
          setLoading(false);
          setProgressIndeterminate(false);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
    }
  }

  function onSubmitCoords(event: FormEvent) {
    event.preventDefault();
    void load({ ra: +ra, dec: +dec, fov });
  }

  function pickPreset(key: string) {
    if (!cfg) return;
    const p = cfg.presets[key];
    setRa(p.ra.toFixed(5));
    setDec(p.dec.toFixed(5));
    setFov(p.fov);
    void load({ preset: key, fov: p.fov });
  }

  function changeMode(next: Mode) {
    if (!job || !result) return;
    applyMode(next, result, job, irView);
  }

  async function onViewerClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!job || !result || !viewerRef.current) return;
    const box = viewerRef.current.getBoundingClientRect();
    const n = result.npix;
    const x = ((event.clientX - box.left) / box.width) * n - 0.5;
    const y = ((event.clientY - box.top) / box.height) * n - 0.5;
    setSpecMeta("Measuring this spot in every frame…");
    try {
      const s = await api<Spectrum>(`/api/job/${job}/spectrum?x=${x}&y=${y}`);
      drawSpectrum(s);
    } catch (err) {
      setSpecMeta(err instanceof Error ? err.message : "Spectrum failed");
    }
  }

  function drawSpectrum(s: Spectrum) {
    const P = s.points;
    const W = 520;
    const H = 300;
    const m = { l: 52, r: 12, t: 12, b: 36 };
    const rejectedNote = s.rejected
      ? ` ${s.rejected} frames skipped because a pixel here is flagged.`
      : "";
    if (!P.length) {
      setSpecHtml("");
      setSpecMeta(
        s.rejected
          ? `No usable measurement: all ${s.rejected} frames covering this spot have flagged pixels. Very bright stars overflow the detector, so their centres cannot be measured. Try a fainter source.`
          : "This spot is outside the images.",
      );
      return;
    }
    const ys = P.map((p) => p.flux);
    const x0 = 0.7;
    const x1 = 5.1;
    const y0 = Math.min(0, ...ys);
    const y1 = Math.max(...ys) * 1.1 || 1;
    const X = (v: number) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = (v: number) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const colors = ["#6cb6ff", "#7ee787", "#ffb454", "#ff7b72", "#d2a8ff", "#f2cc60"];
    const days = (d: string) => Date.parse(d) / 864e5;
    const passes: { start: string; end: string }[] = [];
    [...new Set(P.map((p) => p.date))]
      .sort()
      .forEach((d) => {
        const cur = passes.at(-1);
        if (cur && days(d) - days(cur.end) <= 60) cur.end = d;
        else passes.push({ start: d, end: d });
      });
    const passOf = (d: string) => passes.findIndex((q) => d >= q.start && d <= q.end);
    let g = `<line x1="${m.l}" y1="${H - m.b}" x2="${W - m.r}" y2="${H - m.b}" stroke="#232b3d"/>`;
    for (let t = 1; t <= 5; t += 1) {
      g += `<text x="${X(t)}" y="${H - m.b + 16}" text-anchor="middle">${t} µm</text>`;
    }
    g += `<text x="${m.l - 6}" y="${Y(y1 / 1.1)}" text-anchor="end">${(y1 / 1.1).toPrecision(2)}</text><text x="${m.l - 6}" y="${Y(0)}" text-anchor="end">0</text>`;
    g += `<text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle">MJy/sr (3×3 px)</text>`;
    g += P.map(
      (p) =>
        `<circle cx="${X(p.wavelength_um)}" cy="${Y(p.flux)}" r="3.2" fill="${colors[passOf(p.date) % colors.length]}"><title>${p.wavelength_um} µm · ${p.flux.toFixed(2)} · ${p.date} · D${p.detector}</title></circle>`,
    ).join("");
    setSpecHtml(g);
    setSpecMeta(
      `RA ${s.ra.toFixed(5)}°, Dec ${s.dec.toFixed(5)}° · ${P.length} measurements.${rejectedNote}<br>${passes
        .map((q, i) => `<span style="color:${colors[i % colors.length]}">●</span> ${q.start.slice(0, 7)}`)
        .join(" &nbsp; ")}<br>A brightness change at the same wavelength between passes means variability.`,
    );
  }

  return (
    <div className="spherex-demo">
      <nav className="sx-nav">
        <Link href="/">Home</Link>
        <Link href="/tool">The tool</Link>
      </nav>

      <header>
        <h1>
          SPHEREx Blink <span className="sx-tag">prototype</span>
        </h1>
        <p className="sx-sub">
          Type a sky position. See how it changes between SPHEREx passes. Live data from NASA/IPAC
          IRSA.
        </p>
      </header>

      <section className="sx-controls">
        <form onSubmit={onSubmitCoords}>
          <label>
            RA (deg){" "}
            <input
              type="number"
              step="any"
              required
              value={ra}
              onChange={(event) => setRa(event.target.value)}
            />
          </label>
          <label>
            Dec (deg){" "}
            <input
              type="number"
              step="any"
              required
              value={dec}
              onChange={(event) => setDec(event.target.value)}
            />
          </label>
          <label>
            Field of view{" "}
            <input
              type="range"
              min={0.05}
              max={0.4}
              step={0.01}
              value={fov}
              onChange={(event) => setFov(+event.target.value)}
            />
            <output>{fov.toFixed(2)}°</output>
          </label>
          <span>
            {cfg?.collections.map((c) => (
              <label key={c}>
                <input
                  type="checkbox"
                  checked={collections.includes(c)}
                  onChange={(event) => {
                    setCollections((current) =>
                      event.target.checked
                        ? [...current, c]
                        : current.filter((item) => item !== c),
                    );
                  }}
                />
                {c.replace("spherex_", "").toUpperCase()}
              </label>
            ))}
          </span>
          <button type="submit">Load</button>
        </form>

        <div className="sx-row">
          <span className="sx-muted">Challenge targets:</span>
          {cfg &&
            Object.entries(cfg.presets).map(([key, preset]) => (
              <button key={key} type="button" onClick={() => pickPreset(key)}>
                {preset.name}
              </button>
            ))}
          <form className="sx-inline" onSubmit={onResolve}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="…or object name (NED)"
            />
            <button type="submit">Resolve</button>
          </form>
        </div>

        <div className={`sx-status${statusErr ? " is-err" : ""}`}>
          <span dangerouslySetInnerHTML={{ __html: status }} />
          {loading || progress !== null || progressIndeterminate ? (
            <div
              className={`sx-bar${progressIndeterminate ? " is-indeterminate" : ""}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressIndeterminate ? undefined : progress ?? 0}
              aria-label="Load progress"
            >
              <div
                style={
                  progressIndeterminate
                    ? undefined
                    : { width: `${Math.max(progress ?? 0, 4)}%` }
                }
              />
            </div>
          ) : null}
          {loading && progress !== null && !progressIndeterminate ? (
            <div className="sx-bar-label">{progress}%</div>
          ) : null}
        </div>
      </section>

      {result && job ? (
        <main className="sx-panels">
          <section className="sx-panel">
            <h2>1 · Blink</h2>
            <div className="sx-tabs">
              {(
                [
                  ["epochs", "6-month passes (stacked)"],
                  ["frames", "Every frame"],
                  ["diff", "Difference"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={mode === id ? "is-on" : undefined}
                  onClick={() => changeMode(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="sx-viewer" ref={viewerRef} onClick={onViewerClick}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={blinkSrc} alt="SPHEREx cutout" />
              <div className="sx-cross" />
              <div
                className={pm ? "sx-pm is-on" : "sx-pm"}
                style={pm ? { left: pm.left, top: pm.top } : undefined}
                title="Expected position from proper motion"
              />
            </div>
            {mode !== "diff" ? (
              <div className="sx-row">
                <button type="button" onClick={() => setPlaying((value) => !value)}>
                  {playing ? "⏸ Pause" : "▶ Play"}
                </button>
                <label>
                  Speed{" "}
                  <input
                    type="range"
                    min={100}
                    max={1500}
                    step={50}
                    value={speed}
                    onChange={(event) => setSpeed(+event.target.value)}
                  />
                </label>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, list.length - 1)}
                  value={idx % Math.max(list.length, 1)}
                  onChange={(event) => {
                    const next = +event.target.value;
                    setIdx(next);
                    if (job && result) showFrame(next, mode, result, job, irView);
                  }}
                />
              </div>
            ) : (
              <div className="sx-row">
                <label>
                  A{" "}
                  <select value={diffA} onChange={(event) => setDiffA(+event.target.value)}>
                    {result.epochs.map((epoch, i) => (
                      <option key={epoch.start} value={i}>
                        {i + 1}: {epoch.start}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  B{" "}
                  <select value={diffB} onChange={(event) => setDiffB(+event.target.value)}>
                    {result.epochs.map((epoch, i) => (
                      <option key={`b-${epoch.start}`} value={i}>
                        {i + 1}: {epoch.start}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="sx-muted">B − A: white = only in B, black = only in A</span>
              </div>
            )}
            <div className="sx-meta" dangerouslySetInnerHTML={{ __html: frameMeta }} />
            <p className="sx-hint">Click the image to plot the spectrum at that spot →</p>
          </section>

          <section className="sx-panel">
            <h2>2 · Infrared colour</h2>
            <div className="sx-row sx-ir-pick">
              <button
                type="button"
                className={irView === "rgb" ? "is-on" : undefined}
                onClick={() => setIrView("rgb")}
                disabled={!result.rgb}
              >
                RGB
              </button>
              {detectorBands.map((band) => {
                const loaded = result.detectors.some((d) => d.detector === band.id);
                return (
                  <button
                    key={band.id}
                    type="button"
                    className={irView === band.id ? "is-on" : undefined}
                    disabled={!loaded}
                    title={
                      loaded
                        ? `${band.lo.toFixed(2)}–${band.hi.toFixed(2)} µm`
                        : "Not fetched in this load — enable the band above and Load again"
                    }
                    onClick={() => {
                      setIrView(band.id);
                      setWaveUm((band.lo + band.hi) / 2);
                    }}
                  >
                    {band.label}
                  </button>
                );
              })}
            </div>
            <label className="sx-wave-label">
              Wavelength{" "}
              <input
                type="range"
                min={0.75}
                max={5}
                step={0.01}
                value={waveUm}
                onChange={(event) => {
                  const um = +event.target.value;
                  setWaveUm(um);
                  const id = detectorForWavelength(um, detectorBands);
                  if (result.detectors.some((d) => d.detector === id)) {
                    setIrView(id);
                  }
                }}
              />
              <output>{waveUm.toFixed(2)} µm</output>
            </label>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="sx-big"
              src={irBigSrc}
              alt={irView === "rgb" ? "RGB composite" : `Detector D${irView}`}
            />
            <p className="sx-muted">{irCaption}</p>
            <div className="sx-dets">
              {result.detectors.map((d) => (
                <figure key={d.detector}>
                  <button
                    type="button"
                    className={
                      irView === d.detector ? "sx-det-hit is-on" : "sx-det-hit"
                    }
                    onClick={() => {
                      setIrView(d.detector);
                      const band = detectorBands.find((b) => b.id === d.detector);
                      if (band) setWaveUm((band.lo + band.hi) / 2);
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pngUrl(job, d.png)} alt={`D${d.detector}`} />
                  </button>
                  <figcaption>
                    D{d.detector} · {d.band}
                    <br />
                    {d.n} frames
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>

          <section className="sx-panel">
            <h2>3 · Spectrum</h2>
            <svg className="sx-spec" viewBox="0 0 520 300" dangerouslySetInnerHTML={{ __html: specHtml }} />
            <div className="sx-meta" dangerouslySetInnerHTML={{ __html: specMeta }} />
          </section>

          <section className="sx-panel">
            <h2>4 · Context (Aladin + Gaia + AllWISE)</h2>
            <div id="sx-aladin" className="sx-aladin">
              {aladinMsg ? aladinMsg : null}
            </div>
            <p className="sx-muted">
              Base image: 2MASS colour. Orange = Gaia DR3, cyan = AllWISE. Served by CDS.
            </p>
          </section>
        </main>
      ) : null}

      <footer className="sx-muted">
        Data: SPHEREx Quick Release images via the IRSA SIA + cutout services. Embed with{" "}
        <code>?ra=…&amp;dec=…&amp;fov=…</code> or <code>?preset=barnard</code>. Backend:{" "}
        <code>npm run spherex:api</code>
      </footer>
    </div>
  );
}
