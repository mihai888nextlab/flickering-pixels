"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import ToolSkyOverlay from "@/components/ToolSkyOverlay";
import { useBookmarks, type Bookmark } from "@/lib/useBookmarks";
import {
  bandMissingReason,
  detectorForWavelength,
  FALLBACK_DETECTORS,
  imageForVisitBand,
  spherexBlinkGifUrl,
  spherexDiffUrl,
  spherexFetch,
  spherexFitsZipUrl,
  spherexPngUrl,
  type ContamFlagName,
  type DetectorBand,
  type MotionPrediction,
  type MoverCandidate,
  type MoversResult,
  type SpectrumResult,
  type SpherexConfig,
  type SpherexFrame,
  type SpherexResult,
  type TrackMark,
  wavelengthForDetector,
} from "@/lib/spherexApi";

/** Motion tracking: user marks per survey pass + the fitted prediction, tied to one job. */
type TrackState = {
  job: string | null;
  marks: TrackMark[];
  pred: MotionPrediction | null;
  busy: boolean;
  error: string | null;
};
const EMPTY_TRACK: TrackState = { job: null, marks: [], pred: null, busy: false, error: null };

/** Automatic moving-object search, run once per finished load. */
type MoversState = { job: string | null; busy: boolean; data: MoversResult | null; error: string | null };
const EMPTY_MOVERS: MoversState = { job: null, busy: false, data: null, error: null };
const TRACK_MIN_MARKS = 3;
const TRACK_HORIZON_DAYS = 182.6;

function compassPoint(deg: number) {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Cutout pixel → px inside the field element (null before the image has laid out). */
function cutoutPointPx(field: HTMLElement | null, npix: number, x: number, y: number) {
  if (!field) return null;
  const paint = cutoutPaintBox(field, npix);
  if (!paint) return null;
  return {
    x: paint.left + ((x + 0.5) / npix) * paint.width,
    y: paint.top + ((y + 0.5) / npix) * paint.height,
    pxPerPix: paint.width / npix,
  };
}

const CONTAM_LABELS: Record<ContamFlagName, string> = {
  overflow: "Overflow",
  nonlinear: "Nonlinear",
  persist: "Persist",
  outlier: "Outlier",
  source: "Known source",
  ghost: "Ghost",
  ghost_ext: "Ghost (ext)",
  bloom: "Bloom",
  snowball: "Snowball",
  halo: "Halo",
};

/** Contamination bits that usually mean “treat carefully” (SOURCE is informational). */
const CONTAM_WARN: ContamFlagName[] = [
  "overflow",
  "nonlinear",
  "persist",
  "outlier",
  "ghost",
  "ghost_ext",
  "bloom",
  "snowball",
  "halo",
];

type UserMode = "amateur" | "expert";
type InfoTab = "object" | "data";

/** Fast citizen path: cold IR bands only, thinned frame set. */
const AMATEUR_DETECTORS = [5, 6];
const AMATEUR_MAX_FRAMES = 20;
const EXPERT_DEFAULT_MAX_FRAMES = 48;
/** Glow used when the RGB composite is selected as the “wavelength”. */
const RGB_VIEW_COLOR = "#a6c8d8";

/** Near-infrared continuum 0.75–5 μm. Theme cites 102 bands; slider uses a dense 120-step scale. */
const BAND_COUNT = 120;
const WAVE_MIN = 0.75;
const WAVE_MAX = 5;

const SPECTRUM_STOPS = [
  { t: 0, color: [197, 198, 211] },
  { t: 0.18, color: [147, 131, 173] },
  { t: 0.4, color: [105, 112, 148] },
  { t: 0.62, color: [42, 75, 99] },
  { t: 0.82, color: [29, 49, 68] },
  { t: 1, color: [121, 164, 164] },
];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mixColor(t: number) {
  const x = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < SPECTRUM_STOPS.length - 2 && SPECTRUM_STOPS[i + 1].t < x) i += 1;
  const a = SPECTRUM_STOPS[i];
  const b = SPECTRUM_STOPS[i + 1];
  const u = (x - a.t) / (b.t - a.t || 1);
  const r = Math.round(lerp(a.color[0], b.color[0], u));
  const g = Math.round(lerp(a.color[1], b.color[1], u));
  const bl = Math.round(lerp(a.color[2], b.color[2], u));
  return `rgb(${r}, ${g}, ${bl})`;
}

function fileSlug(name: string | null | undefined, fallback: string) {
  const raw = (name || fallback || "spherex")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return raw || "spherex";
}

function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function triggerHrefDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function triggerBlobDownload(href: string, filename: string) {
  const res = await fetch(href);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail;
    throw new Error(
      typeof detail === "string" && detail
        ? detail
        : `Download failed (${res.status}). Re-lock the target and try again.`,
    );
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  triggerHrefDownload(url, filename);
  URL.revokeObjectURL(url);
}

type DownloadKind = "all" | "fits" | "view" | "pass" | "rgb" | "diff" | "gif" | "spectrum";

type DownloadExport = {
  key: string;
  kind: Exclude<DownloadKind, "all">;
  title: string;
  detail: string;
  filename: string;
  href?: string;
  /** Fetch as blob first (surfaces API errors instead of a silent 404 navigation). */
  viaBlob?: boolean;
  text?: { body: string; mime: string };
};

async function downloadExportsQueued(items: DownloadExport[]) {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.text) downloadTextFile(item.filename, item.text.body, item.text.mime);
    else if (item.href && item.viaBlob) await triggerBlobDownload(item.href, item.filename);
    else if (item.href) triggerHrefDownload(item.href, item.filename);
    if (i < items.length - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 380));
    }
  }
}

function downloadFormatTag(filename: string) {
  const ext = filename.split(".").pop()?.trim();
  return ext ? ext.toUpperCase() : "FILE";
}

function DownloadIcon({ kind }: { kind: DownloadKind }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (kind) {
    case "all":
      return (
        <svg {...common}>
          <path d="M12 4v10" />
          <path d="M8 10l4 4 4-4" />
          <path d="M5 18h14" />
        </svg>
      );
    case "fits":
      return (
        <svg {...common}>
          <path d="M8 4h7l3 3v13H8z" />
          <path d="M15 4v3h3" />
          <path d="M10 12h6M10 16h6" />
        </svg>
      );
    case "view":
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <circle cx="10" cy="11" r="2" />
          <path d="M14 15l3-3 3 3" />
        </svg>
      );
    case "pass":
      return (
        <svg {...common}>
          <rect x="5" y="4" width="14" height="10" rx="1.5" />
          <rect x="7" y="8" width="14" height="10" rx="1.5" />
          <rect x="3" y="6" width="14" height="10" rx="1.5" />
        </svg>
      );
    case "rgb":
      return (
        <svg {...common}>
          <circle cx="9" cy="10" r="4.2" />
          <circle cx="15" cy="10" r="4.2" />
          <circle cx="12" cy="15" r="4.2" />
        </svg>
      );
    case "diff":
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="7" height="14" rx="1.5" />
          <rect x="13.5" y="5" width="7" height="14" rx="1.5" />
          <path d="M10.5 12h3M12 10.5v3" />
        </svg>
      );
    case "gif":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 9l5 3-5 3z" />
        </svg>
      );
    case "spectrum":
      return (
        <svg {...common}>
          <path d="M4 16c2-6 3-9 5-9s3 8 5 8 3-5 6-5" />
          <path d="M4 19h16" />
        </svg>
      );
  }
}

const BANDS = Array.from({ length: BAND_COUNT }, (_, index) => {
  const t = index / (BAND_COUNT - 1);
  const um = WAVE_MIN + t * (WAVE_MAX - WAVE_MIN);
  return {
    um: um.toFixed(2),
    color: mixColor(t),
    t,
    value: um,
  };
});

const PRESET_META: Record<string, { kind: string; summary: string; wise: string }> = {
  wise0855: {
    kind: "Brown dwarf",
    summary: "The coldest brown dwarf we know. It should walk between visits.",
    wise: "AllWISE position held from the first visit.",
  },
  barnard: {
    kind: "Nearby star",
    summary: "A high-proper-motion star. The shift between visits is large.",
    wise: "AllWISE position held from the first visit.",
  },
  eps_indi_b: {
    kind: "Brown dwarf",
    summary: "A companion brown dwarf. The walk is smaller, and still real.",
    wise: "AllWISE position held from the first visit.",
  },
  rw_aur: {
    kind: "Young star",
    summary: "A variable young star. It stays put. Brightness changes with wavelength, not place.",
    wise: "AllWISE position agrees. No walk.",
  },
  r_dra: {
    kind: "Variable star",
    summary: "A long-period variable. The blink should show a pulse of light, not a change of place.",
    wise: "AllWISE position agrees. No walk.",
  },
};

function bandIndexFromUm(um: number) {
  const t = (um - WAVE_MIN) / (WAVE_MAX - WAVE_MIN);
  return Math.round(Math.max(0, Math.min(1, t)) * (BAND_COUNT - 1));
}

const AMATEUR_BAND = bandIndexFromUm(4.1);

function formatCoord(value: number, kind: "ra" | "dec") {
  return kind === "ra" ? value.toFixed(5) : `${value >= 0 ? "+" : ""}${value.toFixed(5)}`;
}

function clampToolFov(value: number) {
  if (!Number.isFinite(value)) return 0.12;
  return Math.min(0.4, Math.max(0.05, value));
}

/** Keep /data-analysis shareable without Next navigation (replaceState only). */
function syncToolQuery(parts: {
  ra?: number | string | null;
  dec?: number | string | null;
  fov?: number | null;
  name?: string | null;
}) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("enter");
  url.searchParams.delete("tour");
  url.searchParams.delete("mode");
  url.searchParams.delete("preset");

  const raN = parts.ra == null || parts.ra === "" ? NaN : Number(parts.ra);
  const decN = parts.dec == null || parts.dec === "" ? NaN : Number(parts.dec);
  if (Number.isFinite(raN) && Number.isFinite(decN)) {
    url.searchParams.set("ra", raN.toFixed(5));
    url.searchParams.set("dec", decN.toFixed(5));
    url.searchParams.delete("name");
  } else {
    url.searchParams.delete("ra");
    url.searchParams.delete("dec");
    const name = parts.name?.trim();
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
  }
  if (parts.fov != null && Number.isFinite(parts.fov)) {
    url.searchParams.set("fov", clampToolFov(parts.fov).toFixed(2));
  } else {
    url.searchParams.delete("fov");
  }

  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

const SPEC_COLORS = ["#5ec8ff", "#7ee787", "#ffb454", "#ff7b72", "#d2a8ff", "#f2cc60"];

const SPEC_DET_BANDS: { id: number; lo: number; hi: number }[] = [
  { id: 1, lo: 0.75, hi: 1.11 },
  { id: 2, lo: 1.11, hi: 1.63 },
  { id: 3, lo: 1.63, hi: 2.42 },
  { id: 4, lo: 2.42, hi: 3.82 },
  { id: 5, lo: 3.82, hi: 4.42 },
  { id: 6, lo: 4.42, hi: 5.0 },
];

const SPEC_VIEW_W = 520;
const SPEC_VIEW_H = 320;

type SpectrumHit = {
  i: number;
  cx: number;
  cy: number;
  wavelength_um: number;
  flux: number;
  detector: number;
  date: string;
  color: string;
  passLabel: string;
};

/** Fixed 0.7–5.1 µm axis. Only measured points + per-pass polylines (no fake fits). */
function drawSpectrumChart(
  s: SpectrumResult,
  idPrefix = "spec",
  theme: "preview" | "bay" = "bay",
): { html: string; note: string; hits: SpectrumHit[] } {
  const points = s.points;
  const W = SPEC_VIEW_W;
  const H = SPEC_VIEW_H;
  const preview = theme === "preview";
  const m = preview ? { l: 54, r: 16, t: 28, b: 42 } : { l: 48, r: 12, t: 22, b: 34 };
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;
  const rejectedNote = s.rejected
    ? ` ${s.rejected} frames skipped because a pixel here is flagged.`
    : "";
  if (!points.length) {
    return {
      html: "",
      hits: [],
      note: s.rejected
        ? `No usable measurement: all ${s.rejected} frames covering this spot have flagged pixels. Very bright stars overflow the detector, so their centres cannot be measured. Try a fainter source.`
        : "This spot is outside the images.",
    };
  }
  const ys = points.map((p) => p.flux);
  const x0 = 0.7;
  const x1 = 5.1;
  const yMinRaw = Math.min(...ys);
  const yMaxRaw = Math.max(...ys);
  const yPad = Math.max((yMaxRaw - yMinRaw) * 0.12, Math.abs(yMaxRaw) * 0.04, 0.05);
  const y0 = Math.min(0, yMinRaw - yPad * 0.25);
  const y1 = yMaxRaw + yPad || 1;
  const X = (v: number) => m.l + ((v - x0) / (x1 - x0)) * plotW;
  const Y = (v: number) => m.t + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
  const days = (d: string) => Date.parse(d) / 864e5;
  const passes: { start: string; end: string }[] = [];
  [...new Set(points.map((p) => p.date))]
    .sort()
    .forEach((d) => {
      const cur = passes.at(-1);
      if (cur && days(d) - days(cur.end) <= 60) cur.end = d;
      else passes.push({ start: d, end: d });
    });
  const passOf = (d: string) => passes.findIndex((q) => d >= q.start && d <= q.end);

  const yTicks = 4;
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => y0 + ((y1 - y0) * i) / yTicks);
  const gid = (name: string) => `${idPrefix}-${name}`;

  const passPaths = passes.map((q, i) => {
    const pts = points
      .filter((p) => p.date >= q.start && p.date <= q.end)
      .sort((a, b) => a.wavelength_um - b.wavelength_um || a.flux - b.flux);
    if (pts.length < 2) return "";
    const d = pts
      .map((p, j) => `${j ? "L" : "M"}${X(p.wavelength_um).toFixed(1)},${Y(p.flux).toFixed(1)}`)
      .join(" ");
    const color = SPEC_COLORS[i % SPEC_COLORS.length];
    return `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>`;
  });

  const hits: SpectrumHit[] = points.map((p, i) => {
    const pi = passOf(p.date);
    const pass = passes[pi];
    return {
      i,
      cx: X(p.wavelength_um),
      cy: Y(p.flux),
      wavelength_um: p.wavelength_um,
      flux: p.flux,
      detector: p.detector,
      date: p.date,
      color: SPEC_COLORS[pi % SPEC_COLORS.length],
      passLabel: pass ? pass.start.slice(0, 10) : p.date,
    };
  });

  const bandFills = [
    "rgba(70, 130, 180, 0.07)",
    "rgba(60, 110, 150, 0.08)",
    "rgba(90, 150, 70, 0.07)",
    "rgba(160, 140, 50, 0.08)",
    "rgba(170, 110, 55, 0.08)",
    "rgba(160, 80, 70, 0.07)",
  ];

  let g = preview
    ? `
    <defs>
      <linearGradient id="${gid("wave")}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#1a1628"/>
        <stop offset="35%" stop-color="#141a28"/>
        <stop offset="70%" stop-color="#101820"/>
        <stop offset="100%" stop-color="#0e1818"/>
      </linearGradient>
      <filter id="${gid("glow")}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="1.4" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <clipPath id="${gid("clip")}">
        <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="4"/>
      </clipPath>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="#0b1018" pointer-events="none"/>
    <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="4" fill="url(#${gid("wave")})" pointer-events="none"/>
    <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="4" fill="none" stroke="rgba(92,225,255,0.18)" pointer-events="none"/>
  `
    : `
    <defs>
      <linearGradient id="${gid("well")}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0a0e12"/>
        <stop offset="100%" stop-color="#05070a"/>
      </linearGradient>
      <linearGradient id="${gid("ir")}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="rgba(55, 95, 140, 0.18)"/>
        <stop offset="35%" stop-color="rgba(45, 86, 120, 0.12)"/>
        <stop offset="70%" stop-color="rgba(130, 110, 45, 0.12)"/>
        <stop offset="100%" stop-color="rgba(140, 70, 55, 0.16)"/>
      </linearGradient>
      <pattern id="${gid("scan")}" width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" fill="transparent"/>
        <rect y="3" width="4" height="1" fill="rgba(255,255,255,0.025)"/>
      </pattern>
      <pattern id="${gid("hatch")}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(180,200,220,0.04)" stroke-width="1"/>
      </pattern>
      <filter id="${gid("glow")}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="1.4" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <clipPath id="${gid("clip")}">
        <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="2"/>
      </clipPath>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="#0a0e12" pointer-events="none"/>
    <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="2" fill="url(#${gid("well")})" pointer-events="none"/>
    <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="2" fill="url(#${gid("ir")})" pointer-events="none"/>
    <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="2" fill="url(#${gid("scan")})" pointer-events="none"/>
    <rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" rx="2" fill="none" stroke="rgba(120,170,200,0.22)" stroke-width="1" pointer-events="none"/>
  `;

  SPEC_DET_BANDS.forEach((band, i) => {
    const xL = Math.max(X(band.lo), m.l);
    const xR = Math.min(X(band.hi), W - m.r);
    if (xR <= xL) return;
    const mid = (xL + xR) / 2;
    if (preview) {
      g += `<rect x="${xL}" y="${m.t}" width="${xR - xL}" height="${plotH}" fill="${i % 2 ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.12)"}" pointer-events="none"/>`;
      g += `<text class="spec-band" x="${mid}" y="${m.t + 12}" text-anchor="middle" pointer-events="none">D${band.id}</text>`;
      return;
    }
    g += `<rect x="${xL}" y="${m.t}" width="${xR - xL}" height="${plotH}" fill="${bandFills[i % bandFills.length]}" pointer-events="none"/>`;
    if (i > 0) {
      g += `<line x1="${xL}" y1="${m.t}" x2="${xL}" y2="${H - m.b}" stroke="rgba(200,220,235,0.08)" stroke-width="1" pointer-events="none"/>`;
    }
    g += `<rect x="${mid - 11}" y="${m.t + 4}" width="22" height="11" rx="2" fill="rgba(6,10,14,0.72)" stroke="rgba(160,190,210,0.18)" pointer-events="none"/>`;
    g += `<text class="spec-band" x="${mid}" y="${m.t + 12.5}" text-anchor="middle" pointer-events="none">D${band.id}</text>`;
  });

  g += `<g clip-path="url(#${gid("clip")})" pointer-events="none">`;
  if (preview) {
    for (const t of yTickVals) {
      g += `<line x1="${m.l}" y1="${Y(t)}" x2="${W - m.r}" y2="${Y(t)}" stroke="rgba(148,180,210,0.12)" stroke-dasharray="3 5"/>`;
    }
    for (let t = 1; t <= 5; t += 1) {
      g += `<line x1="${X(t)}" y1="${m.t}" x2="${X(t)}" y2="${H - m.b}" stroke="rgba(148,180,210,0.1)"/>`;
    }
  } else {
    for (const t of yTickVals) {
      g += `<line x1="${m.l}" y1="${Y(t)}" x2="${W - m.r}" y2="${Y(t)}" stroke="rgba(150,180,205,0.1)" stroke-width="1"/>`;
    }
    for (let t = 1; t <= 5; t += 1) {
      g += `<line x1="${X(t)}" y1="${m.t}" x2="${X(t)}" y2="${H - m.b}" stroke="rgba(150,180,205,0.08)" stroke-width="1"/>`;
    }
    g += `<rect x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" fill="url(#${gid("hatch")})"/>`;
  }
  if (y0 < 0 && y1 > 0) {
    g += `<line x1="${m.l}" y1="${Y(0)}" x2="${W - m.r}" y2="${Y(0)}" stroke="${preview ? "rgba(255,255,255,0.22)" : "rgba(210,225,235,0.28)"}" stroke-width="1"/>`;
  }
  g += passPaths.join("");
  g += `</g>`;

  // Points above the clip group so hit targets stay clickable in the bay.
  g += hits
    .map((h) => {
      const cx = h.cx.toFixed(1);
      const cy = h.cy.toFixed(1);
      const hitEvents = preview ? "none" : "all";
      const cursor = preview ? "inherit" : "pointer";
      return `<g class="spec-point" data-spec-i="${h.i}" style="cursor:${cursor}">
        <circle class="spec-hit" cx="${cx}" cy="${cy}" r="14" fill="transparent" pointer-events="${hitEvents}"/>
        <g filter="url(#${gid("glow")})" pointer-events="none">
          <circle cx="${cx}" cy="${cy}" r="5.2" fill="${h.color}" fill-opacity="0.32"/>
          <circle cx="${cx}" cy="${cy}" r="3.1" fill="${h.color}" stroke="rgba(8,12,20,0.9)" stroke-width="0.9"/>
        </g>
      </g>`;
    })
    .join("");

  g += `<g pointer-events="none">`;
  if (preview) {
    g += `<line x1="${m.l}" y1="${H - m.b}" x2="${W - m.r}" y2="${H - m.b}" stroke="rgba(180,210,230,0.35)"/>`;
    g += `<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${H - m.b}" stroke="rgba(180,210,230,0.35)"/>`;
    for (let t = 1; t <= 5; t += 1) {
      g += `<line x1="${X(t)}" y1="${H - m.b}" x2="${X(t)}" y2="${H - m.b + 5}" stroke="rgba(180,210,230,0.4)"/>`;
      g += `<text x="${X(t)}" y="${H - m.b + 18}" text-anchor="middle">${t}</text>`;
    }
    g += `<text x="${m.l + plotW / 2}" y="${H - 6}" text-anchor="middle" class="spec-axis">Wavelength (µm)</text>`;
    for (const t of yTickVals) {
      const label = Math.abs(t) >= 100 || Math.abs(t) < 0.01 ? t.toPrecision(2) : t.toFixed(t >= 10 ? 0 : 2);
      g += `<line x1="${m.l - 5}" y1="${Y(t)}" x2="${m.l}" y2="${Y(t)}" stroke="rgba(180,210,230,0.4)"/>`;
      g += `<text x="${m.l - 8}" y="${Y(t) + 3}" text-anchor="end">${label}</text>`;
    }
    g += `<text x="14" y="${m.t + plotH / 2}" transform="rotate(-90 14 ${m.t + plotH / 2})" text-anchor="middle" class="spec-axis">Flux (MJy/sr)</text>`;
    let lx = m.l + 8;
    passes.slice(0, 6).forEach((q, i) => {
      const color = SPEC_COLORS[i % SPEC_COLORS.length];
      const label = q.start.slice(0, 7);
      g += `<circle cx="${lx}" cy="12" r="3" fill="${color}"/>`;
      g += `<text x="${lx + 7}" y="15" class="spec-legend">${label}</text>`;
      lx += 8 + label.length * 6.2 + 10;
    });
  } else {
    g += `<line x1="${m.l}" y1="${H - m.b}" x2="${W - m.r}" y2="${H - m.b}" stroke="rgba(190,210,225,0.55)" stroke-width="1.35"/>`;
    g += `<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${H - m.b}" stroke="rgba(190,210,225,0.55)" stroke-width="1.35"/>`;
    for (let t = 1; t <= 5; t += 1) {
      g += `<line x1="${X(t)}" y1="${H - m.b}" x2="${X(t)}" y2="${H - m.b + 5}" stroke="rgba(190,210,225,0.5)" stroke-width="1.1"/>`;
      g += `<text class="spec-tick" x="${X(t)}" y="${H - m.b + 17}" text-anchor="middle">${t}</text>`;
    }
    g += `<text x="${m.l + plotW / 2}" y="${H - 7}" text-anchor="middle" class="spec-axis">Wavelength (µm)</text>`;
    for (const t of yTickVals) {
      const label = Math.abs(t) >= 100 || Math.abs(t) < 0.01 ? t.toPrecision(2) : t.toFixed(t >= 10 ? 0 : 2);
      g += `<line x1="${m.l - 5}" y1="${Y(t)}" x2="${m.l}" y2="${Y(t)}" stroke="rgba(190,210,225,0.5)" stroke-width="1.1"/>`;
      g += `<text class="spec-tick" x="${m.l - 8}" y="${Y(t) + 3.2}" text-anchor="end">${label}</text>`;
    }
    g += `<text x="11" y="${m.t + plotH / 2}" transform="rotate(-90 11 ${m.t + plotH / 2})" text-anchor="middle" class="spec-axis">Flux (MJy/sr)</text>`;
    let lx = m.l;
    passes.slice(0, 6).forEach((q, i) => {
      const color = SPEC_COLORS[i % SPEC_COLORS.length];
      const label = q.start.slice(0, 7);
      const w = 14 + label.length * 6.1;
      g += `<rect x="${lx}" y="3" width="${w}" height="13" rx="3" fill="rgba(8,12,16,0.55)" stroke="rgba(255,255,255,0.06)"/>`;
      g += `<circle cx="${lx + 7}" cy="9.5" r="2.6" fill="${color}"/>`;
      g += `<text x="${lx + 13}" y="13" class="spec-legend">${label}</text>`;
      lx += w + 5;
    });
  }
  g += `</g>`;

  const note =
    `RA ${s.ra.toFixed(5)}°, Dec ${s.dec.toFixed(5)}° · ${points.length} measurements · one polyline per survey pass.${rejectedNote}<br>Click a point for details. Lines connect that pass’s measured points. Different colors at the same λ mean variability.`;
  return { html: g, note, hits };
}

/** ViewBox radius for treating points as stacked / overlapping. */
const SPEC_HIT_RADIUS = 22;

function spectrumHitOrder(a: SpectrumHit, b: SpectrumHit) {
  return a.date.localeCompare(b.date) || a.detector - b.detector || a.i - b.i;
}

function spectrumHitsNear(hits: SpectrumHit[], x: number, y: number, radius = SPEC_HIT_RADIUS) {
  return hits
    .map((h) => ({ h, d: Math.hypot(h.cx - x, h.cy - y) }))
    .filter((row) => row.d <= radius)
    .sort((a, b) => a.d - b.d || spectrumHitOrder(a.h, b.h))
    .map((row) => row.h);
}

/** Stable list order for the stacked-points picker (never re-sort around the selection). */
function spectrumStackList(hits: SpectrumHit[]) {
  return [...hits].sort(spectrumHitOrder);
}

/** Painted content box for an SVG using preserveAspectRatio xMidYMid meet. */
function svgMeetBox(svg: SVGSVGElement, vw = SPEC_VIEW_W, vh = SPEC_VIEW_H) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const width = vw * scale;
  const height = vh * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
    scale,
  };
}

/** Map a pointer into SVG viewBox space (handles letterboxing / CSS max-height). */
function pointerToSvgViewBox(svg: SVGSVGElement, clientX: number, clientY: number) {
  const meet = svgMeetBox(svg);
  if (!meet || meet.scale <= 0) return null;
  return {
    x: (clientX - meet.left) / meet.scale,
    y: (clientY - meet.top) / meet.scale,
  };
}

/**
 * Map a click on a field that uses object-fit:contain into cutout pixel coords.
 * Returns null when the click lands in the letterbox.
 */
function cutoutPaintBox(field: HTMLElement, npix: number) {
  const img = field.querySelector<HTMLImageElement>("img.tool-cutout");
  const box = (img ?? field).getBoundingClientRect();
  const fieldBox = field.getBoundingClientRect();
  const nw = img?.naturalWidth || npix;
  const nh = img?.naturalHeight || npix;
  if (!box.width || !box.height || !nw || !nh) return null;
  const scale = Math.min(box.width / nw, box.height / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const ox = box.left + (box.width - dw) / 2;
  const oy = box.top + (box.height - dh) / 2;
  return {
    left: ox - fieldBox.left,
    top: oy - fieldBox.top,
    width: dw,
    height: dh,
  };
}

function pointerToCutoutPixel(
  field: HTMLElement,
  clientX: number,
  clientY: number,
  npix: number,
): { x: number; y: number } | null {
  const paint = cutoutPaintBox(field, npix);
  if (!paint || paint.width <= 0 || paint.height <= 0) return null;
  const fieldBox = field.getBoundingClientRect();
  const x = ((clientX - fieldBox.left - paint.left) / paint.width) * npix;
  const y = ((clientY - fieldBox.top - paint.top) / paint.height) * npix;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < -0.5 || y < -0.5 || x > npix - 0.5 || y > npix - 0.5) return null;
  return {
    x: Math.min(npix - 1e-3, Math.max(0, x)),
    y: Math.min(npix - 1e-3, Math.max(0, y)),
  };
}

function cutoutMarkerStyle(
  field: HTMLElement | null,
  npix: number,
  x: number,
  y: number,
): CSSProperties | undefined {
  if (!field) {
    return {
      left: `${(100 * (x + 0.5)) / npix}%`,
      top: `${(100 * (y + 0.5)) / npix}%`,
    };
  }
  const paint = cutoutPaintBox(field, npix);
  if (!paint) {
    return {
      left: `${(100 * (x + 0.5)) / npix}%`,
      top: `${(100 * (y + 0.5)) / npix}%`,
    };
  }
  return {
    left: paint.left + ((x + 0.5) / npix) * paint.width,
    top: paint.top + ((y + 0.5) / npix) * paint.height,
  };
}

function SpectrumChartView({
  html,
  hits,
  pick,
  onPick,
  onBackgroundClick,
  modal = false,
  interactive = false,
}: {
  html: string;
  hits: SpectrumHit[];
  pick: number | null;
  onPick: (i: number | null) => void;
  onBackgroundClick?: () => void;
  modal?: boolean;
  /** Point picking / tips only in the expanded view. */
  interactive?: boolean;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [cluster, setCluster] = useState<SpectrumHit[]>([]);
  const [tipBox, setTipBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );
  const selected =
    interactive && pick != null ? hits.find((h) => h.i === pick) ?? null : null;
  const stackSource =
    interactive && cluster.length > 1
      ? cluster
      : interactive && selected
        ? spectrumHitsNear(hits, selected.cx, selected.cy)
        : [];
  const stack = stackSource.length > 1 ? spectrumStackList(stackSource) : stackSource;

  useEffect(() => {
    if (pick == null) setCluster([]);
  }, [pick]);

  useEffect(() => {
    setCluster([]);
  }, [hits]);

  useEffect(() => {
    if (!interactive) {
      setTipBox(null);
      return;
    }
    const syncTipBox = () => {
      const chart = chartRef.current;
      const svg = svgRef.current;
      if (!chart || !svg) {
        setTipBox(null);
        return;
      }
      const meet = svgMeetBox(svg);
      if (!meet) {
        setTipBox(null);
        return;
      }
      const box = chart.getBoundingClientRect();
      setTipBox({
        left: meet.left - box.left,
        top: meet.top - box.top,
        width: meet.width,
        height: meet.height,
      });
    };
    syncTipBox();
    const chart = chartRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncTipBox) : null;
    if (chart) ro?.observe(chart);
    window.addEventListener("resize", syncTipBox);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", syncTipBox);
    };
  }, [interactive, html, modal]);

  function clearPick() {
    setCluster([]);
    onPick(null);
  }

  function onSvgClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (!interactive) return;
    const svg = event.currentTarget;
    const local = pointerToSvgViewBox(svg, event.clientX, event.clientY);
    if (!local) return;
    if (
      local.x < -SPEC_HIT_RADIUS ||
      local.y < -SPEC_HIT_RADIUS ||
      local.x > SPEC_VIEW_W + SPEC_HIT_RADIUS ||
      local.y > SPEC_VIEW_H + SPEC_HIT_RADIUS
    ) {
      clearPick();
      onBackgroundClick?.();
      return;
    }
    const nearByDist = spectrumHitsNear(hits, local.x, local.y);
    const near = spectrumStackList(nearByDist);

    if (!near.length) {
      clearPick();
      onBackgroundClick?.();
      return;
    }

    event.stopPropagation();
    setCluster(near);

    if (near.length === 1) {
      onPick(pick === near[0].i ? null : near[0].i);
      if (pick === near[0].i) setCluster([]);
      return;
    }

    // Stacked points: cycle in stable list order; first click selects nearest to cursor.
    const nearest = nearByDist[0];
    const idx = pick == null ? -1 : near.findIndex((h) => h.i === pick);
    if (idx >= 0) {
      onPick(near[(idx + 1) % near.length].i);
    } else {
      onPick(nearest.i);
    }
  }

  const tipAnchor = selected ?? stack[0] ?? null;
  const tipStyle = tipAnchor
    ? ({
        left: tipBox
          ? tipBox.left + (tipAnchor.cx / SPEC_VIEW_W) * tipBox.width
          : `${(tipAnchor.cx / SPEC_VIEW_W) * 100}%`,
        top: tipBox
          ? tipBox.top + (tipAnchor.cy / SPEC_VIEW_H) * tipBox.height
          : `${(tipAnchor.cy / SPEC_VIEW_H) * 100}%`,
        transform: `translate(${tipAnchor.cx / SPEC_VIEW_W > 0.62 ? "-108%" : "12%"}, ${
          tipAnchor.cy / SPEC_VIEW_H > 0.55 ? "-110%" : "12%"
        })`,
        ["--tip-color" as string]: selected?.color ?? tipAnchor.color,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={chartRef}
      className={[
        modal ? "tool-spectrum-chart is-modal" : "tool-spectrum-chart",
        interactive ? "is-interactive" : "is-static",
      ].join(" ")}
    >
      <svg
        ref={svgRef}
        className={modal ? "tool-spectrum-svg is-modal" : "tool-spectrum-svg"}
        viewBox={`0 0 ${SPEC_VIEW_W} ${SPEC_VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={
          interactive
            ? "Flux versus wavelength. Click a point for details. Overlapping points can be cycled or chosen from the list."
            : "Spectrum preview. Click to expand for interactive point details."
        }
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={interactive ? onSvgClick : undefined}
      />
      {interactive && selected ? (
        <svg
          className="tool-spectrum-pick-ring"
          viewBox={`0 0 ${SPEC_VIEW_W} ${SPEC_VIEW_H}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <circle
            cx={selected.cx}
            cy={selected.cy}
            r="9.5"
            fill="none"
            stroke={selected.color}
            strokeWidth="1.8"
            strokeOpacity="0.95"
          />
          <circle
            cx={selected.cx}
            cy={selected.cy}
            r="3.6"
            fill={selected.color}
            stroke="rgba(8,12,20,0.9)"
            strokeWidth="0.9"
          />
        </svg>
      ) : null}
      {interactive && selected && tipStyle ? (
        <aside className="tool-spectrum-tip" style={tipStyle} role="status">
          <header>
            <i style={{ background: selected.color }} aria-hidden="true" />
            <strong>Pass {selected.passLabel}</strong>
            <button type="button" aria-label="Dismiss point info" onClick={clearPick}>
              ×
            </button>
          </header>
          {stack.length > 1 ? (
            <div className="tool-spectrum-stack" role="group" aria-label="Overlapping measurements">
              <p>
                {stack.length} stacked · pick one
              </p>
              <div className="tool-spectrum-stack-list">
                {stack.map((h) => (
                  <button
                    key={h.i}
                    type="button"
                    className={h.i === selected.i ? "is-on" : undefined}
                    style={{ ["--tip-color" as string]: h.color }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPick(h.i);
                    }}
                  >
                    <i aria-hidden="true" />
                    <span>
                      {h.passLabel}
                      <small>
                        D{h.detector} · {h.flux.toFixed(2)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <dl>
            <div>
              <dt>λ</dt>
              <dd>{selected.wavelength_um.toFixed(3)} µm</dd>
            </div>
            <div>
              <dt>Flux</dt>
              <dd>{selected.flux.toFixed(3)} MJy/sr</dd>
            </div>
            <div>
              <dt>Detector</dt>
              <dd>D{selected.detector}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{selected.date}</dd>
            </div>
          </dl>
        </aside>
      ) : null}
    </div>
  );
}

function ToolMetalDial({
  id,
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
  ticks,
}: {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  ticks?: { value: number; label: string }[];
}) {
  const wellRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const pct = max <= min ? 0 : ((value - min) / (max - min)) * 100;
  const style = { ["--wave-pct" as string]: String(pct) } as CSSProperties;

  function valueFromClientX(clientX: number) {
    const well = wellRef.current;
    if (!well) return value;
    const rect = well.getBoundingClientRect();
    const t = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
    const raw = min + Math.max(0, Math.min(1, t)) * (max - min);
    const stepped = Math.round(raw / step) * step;
    return Math.min(max, Math.max(min, Number(stepped.toFixed(4))));
  }

  function onKnobPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    onChange(valueFromClientX(event.clientX));
  }

  function onKnobPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onChange(valueFromClientX(event.clientX));
  }

  function onKnobPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }

  return (
    <div className="tool-metal-dial" style={style}>
      <div className="tool-metal-dial-head">
        <span className="tool-coord-tag">{label}</span>
        <output className="tool-metal-dial-unit" htmlFor={id}>
          {unit}
        </output>
      </div>
      <div className="tool-wave-well" ref={wellRef}>
        <div className="tool-wave-fill" aria-hidden="true" />
        <input
          id={id}
          className="tool-wave-slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(+event.target.value)}
        />
        <div
          className={dragging ? "tool-wave-knob is-dragging" : "tool-wave-knob"}
          role="presentation"
          onPointerDown={onKnobPointerDown}
          onPointerMove={onKnobPointerMove}
          onPointerUp={onKnobPointerUp}
          onPointerCancel={onKnobPointerUp}
        >
          <i />
        </div>
      </div>
      {ticks?.length ? (
        <div className="tool-wave-majors tool-metal-dial-ticks">
          {ticks.map((tick) => (
            <button
              key={tick.label}
              type="button"
              className="tool-wave-major"
              style={{ left: `${((tick.value - min) / (max - min || 1)) * 100}%` }}
              onClick={() => onChange(tick.value)}
            >
              {tick.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function ToolBench() {
  const [cfg, setCfg] = useState<SpherexConfig | null>(null);
  const mode: UserMode = "expert";
  const setMode = (_: UserMode) => {};
  const [ra, setRa] = useState("");
  const [dec, setDec] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [fov, setFov] = useState(0.12);
  const [expertDetectors, setExpertDetectors] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [expertMaxFrames, setExpertMaxFrames] = useState(EXPERT_DEFAULT_MAX_FRAMES);
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [result, setResult] = useState<SpherexResult | null>(null);
  const [status, setStatus] = useState("Connecting to SPHEREx archive…");
  const [statusErr, setStatusErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [visit, setVisit] = useState(0);
  const [band, setBand] = useState(AMATEUR_BAND);
  const [showRgb, setShowRgb] = useState(false);
  const [wavePanel, setWavePanel] = useState<"bands" | "utils">("bands");
  const [stageExtra, setStageExtra] = useState<"none" | "diff" | "stack">("none");
  const [everyFrame, setEveryFrame] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [showMark, setShowMark] = useState(true);
  const [infoTab, setInfoTab] = useState<InfoTab>("object");
  const [spectrumData, setSpectrumData] = useState<SpectrumResult | null>(null);
  const [spectrumNote, setSpectrumNote] = useState("Click the sky image to sample a spectrum.");
  const [spectrumOpen, setSpectrumOpen] = useState(false);
  const [spectrumPick, setSpectrumPick] = useState<number | null>(null);
  const [spectrumSamplePx, setSpectrumSamplePx] = useState<{ x: number; y: number } | null>(null);
  const [fieldLayoutEpoch, setFieldLayoutEpoch] = useState(0);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [skyOpen, setSkyOpen] = useState(false);
  const [tracking, setTracking] = useState(false);
  const bookmarks = useBookmarks();
  const [bookmarkNote, setBookmarkNote] = useState<string | null>(null);
  const [trackState, setTrackState] = useState<TrackState>(EMPTY_TRACK);
  const [moversState, setMoversState] = useState<MoversState>(EMPTY_MOVERS);
  const fieldRef = useRef<HTMLDivElement>(null);
  // Same node as fieldRef, as state so render-time overlay math doesn't read a ref.
  const [fieldNode, setFieldNode] = useState<HTMLDivElement | null>(null);
  const attachField = useCallback((el: HTMLDivElement | null) => {
    fieldRef.current = el;
    setFieldNode(el);
  }, []);
  const pollTimerRef = useRef<number | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const bootstrapped = useRef(false);
  const isAmateur = false; // data-analysis is lab-only

  const detectorBands: DetectorBand[] = cfg?.detectors?.length
    ? cfg.detectors
    : FALLBACK_DETECTORS;

  const activeDetectors = useMemo(() => detectorBands, [detectorBands]);

  const active = BANDS[band];
  const detectorId = detectorForWavelength(
    active.value,
    activeDetectors.length ? activeDetectors : detectorBands,
  );
  const detectorMeta = detectorBands.find((d) => d.id === detectorId);

  const waveStyle = useMemo(
    () =>
      ({
        ["--knob" as string]:
          stageExtra === "diff"
            ? "#f0a040"
            : stageExtra === "stack"
              ? "#3dde9f"
              : showRgb
                ? RGB_VIEW_COLOR
                : active.color,
        ["--wave-pct" as string]: showRgb || stageExtra !== "none" ? "100" : String((band / (BAND_COUNT - 1)) * 100),
      }) as CSSProperties,
    [active.color, band, showRgb, stageExtra],
  );

  const visits = result?.epochs ?? [];
  const everyFrames = useMemo(() => {
    if (!result || !everyFrame) return [] as SpherexFrame[];
    return result.frames
      .filter((f) => f.detector === detectorId)
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.png.localeCompare(b.png));
  }, [result, everyFrame, detectorId]);
  const usingEvery = everyFrame && stageExtra === "none" && !showRgb && everyFrames.length > 0;
  const timelineCount = usingEvery ? everyFrames.length : visits.length;
  const visitSafe = timelineCount ? Math.min(visit, timelineCount - 1) : 0;
  const everyShot = usingEvery ? everyFrames[visitSafe] ?? null : null;
  const frame = usingEvery
    ? visits.find(
        (epoch) => everyShot != null && everyShot.date >= epoch.start && everyShot.date <= epoch.end,
      ) ?? visits[0]
    : visits[visitSafe];
  // Marks belong to the job they were made on; a new target starts clean.
  const track = trackState.job === job ? trackState : EMPTY_TRACK;
  const movers = moversState.job === job ? moversState : EMPTY_MOVERS;
  /** The prediction on screen came from the automatic search (not from hand marks). */
  const autoPick: MoverCandidate | null =
    track.pred && !track.marks.length && "significance" in track.pred ? (track.pred as MoverCandidate) : null;
  const frameEpoch = frame ? visits.indexOf(frame) : -1;
  const trackReady = Boolean(result) && visits.length >= TRACK_MIN_MARKS && stageExtra === "none" && !showRgb;
  const trackOn = tracking && trackReady;
  const rgbAvailable = Boolean(result?.rgb);
  const detectorStack = result?.detectors.find((d) => d.detector === detectorId) ?? null;
  const hideTimelineWell = stageExtra === "diff" || stageExtra === "stack";
  const image = useMemo(() => {
    if (!result || !job) return null;
    if (stageExtra === "diff" && visits.length >= 2) {
      return {
        src: spherexDiffUrl(job),
        label: `Difference · all ${visits.length} passes`,
      };
    }
    if (stageExtra === "stack" && detectorStack) {
      return {
        src: spherexPngUrl(job, detectorStack.png),
        label: `${detectorStack.band} · D${detectorStack.detector} coadd · ${detectorStack.n} frames`,
      };
    }
    if (showRgb && result.rgb) {
      return {
        src: spherexPngUrl(job, result.rgb),
        label: `RGB composite · ${result.n_used} frames`,
      };
    }
    if (usingEvery && everyShot) {
      return {
        src: spherexPngUrl(job, everyShot.png),
        label: `Frame ${visitSafe + 1}/${everyFrames.length} · ${everyShot.date} · D${everyShot.detector}`,
      };
    }
    return imageForVisitBand(result, job, visitSafe, detectorId);
  }, [
    result,
    job,
    visitSafe,
    detectorId,
    showRgb,
    stageExtra,
    visits.length,
    detectorStack,
    usingEvery,
    everyShot,
    everyFrames.length,
  ]);

  const meta = presetKey ? PRESET_META[presetKey] : null;
  const objectName = result?.target.name ?? (presetKey && cfg?.presets[presetKey]?.name) ?? null;

  const downloadExports = useMemo((): DownloadExport[] => {
    if (!job || !result) return [];
    const slug = fileSlug(objectName, job);
    const items: DownloadExport[] = [
      {
        key: "fits",
        kind: "fits",
        title: "FITS cutouts",
        detail: "All IRSA frames for this field",
        href: spherexFitsZipUrl(job),
        filename: `spherex_${slug}_fits.zip`,
      },
    ];
    if (image?.src) {
      items.push({
        key: "view",
        kind: "view",
        title: "Current view",
        detail: showRgb ? "RGB on stage" : `Pass ${visit + 1} · selected band`,
        href: image.src,
        filename: showRgb ? `spherex_${slug}_rgb_view.png` : `spherex_${slug}_view.png`,
      });
    }
    if (frame) {
      items.push({
        key: "pass",
        kind: "pass",
        title: "Survey pass",
        detail: `${frame.start}${frame.end !== frame.start ? ` → ${frame.end}` : ""}`,
        href: spherexPngUrl(job, frame.png),
        filename: `spherex_${slug}_pass${visit + 1}.png`,
      });
    }
    if (result.rgb) {
      items.push({
        key: "rgb",
        kind: "rgb",
        title: "RGB composite",
        detail: "Detector-band color stack",
        href: spherexPngUrl(job, result.rgb),
        filename: `spherex_${slug}_rgb.png`,
      });
    }
    if (visits.length >= 2) {
      items.push({
        key: "diff",
        kind: "diff",
        title: "Difference",
        detail: `Peak-to-peak · ${visits.length} passes`,
        href: spherexDiffUrl(job),
        filename: `spherex_${slug}_diff.png`,
      });
      items.push({
        key: "gif",
        kind: "gif",
        title: "Blink GIF",
        detail: `Loop of ${visits.length} passes`,
        href: spherexBlinkGifUrl(job),
        filename: `spherex_${slug}_blink.gif`,
        viaBlob: true,
      });
    }
    if (spectrumData?.points.length) {
      const rows = [
        "wavelength_um,flux_mjy_sr,detector,date",
        ...spectrumData.points.map(
          (p) => `${p.wavelength_um},${p.flux},${p.detector},${JSON.stringify(p.date)}`,
        ),
      ];
      items.push({
        key: "spectrum",
        kind: "spectrum",
        title: "Spectrum",
        detail: `${spectrumData.points.length} points · last click`,
        filename: `spherex_${slug}_spectrum.csv`,
        text: { body: `${rows.join("\n")}\n`, mime: "text/csv;charset=utf-8" },
      });
    }
    return items;
  }, [job, result, objectName, image, frame, visit, visits.length, spectrumData, showRgb]);
  const objectKind =
    result?.target.kind ?? meta?.kind ?? (result ? "Field" : null);
  const photoLine = result?.photo?.summary ?? null;
  const catalogBits = useMemo(() => {
    if (!result?.target) return [] as string[];
    const t = result.target;
    const bits: string[] = [];
    if (t.redshift != null && Number.isFinite(t.redshift)) {
      bits.push(`z = ${t.redshift.toPrecision(4)}`);
    }
    if (t.separation_arcsec != null && t.separation_arcsec > 0.05) {
      bits.push(`${t.separation_arcsec.toFixed(1)}″ from NED match`);
    }
    if (t.resolver === "ned" || t.resolver === "ned-cone") bits.push("NED");
    else if (t.resolver === "simbad") bits.push("SIMBAD");
    else if (t.resolver === "gaia") bits.push("Gaia");
    else if (t.resolver === "local" || t.resolver === "preset") bits.push("local catalog");
    return bits;
  }, [result?.target]);
  const activeFrame = useMemo((): SpherexFrame | null => {
    if (!result) return null;
    if (everyShot) return everyShot;
    if (!frame) return null;
    const inEpoch = result.frames.filter(
      (f) => f.detector === detectorId && f.date >= frame.start && f.date <= frame.end,
    );
    if (inEpoch.length) return inEpoch[Math.floor(inEpoch.length / 2)];
    const anyDet = result.frames.filter((f) => f.date >= frame.start && f.date <= frame.end);
    return anyDet[0] ?? result.frames[0] ?? null;
  }, [result, frame, detectorId, everyShot]);
  const contamEntries = useMemo(() => {
    const flags = activeFrame?.flags;
    if (!flags) return [] as { key: ContamFlagName; label: string; pct: number; warn: boolean }[];
    const keys = (result?.contam_bits ?? (Object.keys(CONTAM_LABELS) as ContamFlagName[])).filter(
      (k) => (flags[k] ?? 0) > 0,
    );
    return keys
      .map((key) => ({
        key,
        label: CONTAM_LABELS[key],
        pct: (flags[key] ?? 0) * 100,
        warn: CONTAM_WARN.includes(key),
      }))
      .sort((a, b) => b.pct - a.pct);
  }, [activeFrame, result?.contam_bits]);
  const ledWarn = statusErr || (!loading && !result && Boolean(status));
  const ledLive = Boolean(result) || loading;

  // On demand (the Find movers button): the backend looks up the field's fast stars
  // (Gaia DR3, plus the target's own catalog motion) and known asteroids (SkyBoT, with JPL
  // Horizons for 6 months ahead), and checks each star against the SPHEREx passes. The best
  // one (the loaded target first) goes straight onto the stage with its 6-month position.
  const findMovers = useCallback(async (key: string) => {
    setMoversState({ job: key, busy: true, data: null, error: null });
    try {
      const data = await spherexFetch<MoversResult>(
        `/api/job/${key}/movers?horizon_days=${TRACK_HORIZON_DAYS}`,
      );
      if (activeJobRef.current !== key) return;
      setMoversState({ job: key, busy: false, data, error: null });
      const best = data.candidates[0];
      if (best) {
        // Don't overwrite marks the user already started by hand.
        setTrackState((s) =>
          s.job === key && (s.marks.length || s.pred)
            ? s
            : { job: key, marks: [], pred: best, busy: false, error: null },
        );
      }
    } catch (err) {
      if (activeJobRef.current !== key) return;
      const error = err instanceof Error ? err.message : "Motion search failed";
      setMoversState({ job: key, busy: false, data: null, error });
    }
  }, []);

  const poll = useCallback(async (key: string) => {
    if (activeJobRef.current !== key) return;
    try {
      const s = await spherexFetch<{
        status: string;
        done?: number;
        total?: number;
        attempt?: number;
        message?: string;
        error?: string;
        result?: SpherexResult;
      }>(`/api/job/${key}`);
      if (activeJobRef.current !== key) return;
      if (s.status === "error") {
        setStatus(s.error || "Archive request failed");
        setStatusErr(true);
        setLoading(false);
        setProgress(null);
        return;
      }
      if (s.status === "done" && s.result) {
        setResult(s.result);
        setJob(key);
        setLoading(false);
        setProgress(null);
        setStatusErr(false);
        setVisit(0);
        setPlaying(false);
        setSpectrumData(null);
        setSpectrumNote("Click the sky image to sample a spectrum.");
        setSpectrumOpen(false);
        setSpectrumPick(null);
        setSpectrumSamplePx(null);
        setDownloadOpen(false);
        setSkyOpen(false);
        const span = s.result.epochs.length
          ? `${s.result.epochs[0].start} → ${s.result.epochs.at(-1)!.end}`
          : "no passes yet";
        // Say which requested bands came back empty, and why (archive gap vs. download timeouts).
        const empty = (s.result.band_coverage ?? []).filter((c) => c.used === 0);
        const timedOut = empty.filter((c) => c.found > 0 && c.downloaded === 0);
        const notObserved = empty.filter((c) => c.found === 0);
        const clipped = empty.filter((c) => c.found > 0 && c.downloaded > 0);
        const ids = (list: typeof empty) => list.map((c) => `D${c.detector}`).join(", ");
        const missing = [
          notObserved.length ? `${ids(notObserved)} not observed here yet` : "",
          timedOut.length ? `${ids(timedOut)} timed out (Load again to retry)` : "",
          clipped.length ? `${ids(clipped)} only at a detector edge` : "",
        ].filter(Boolean);
        const lostReleases = s.result.missing_releases ?? [];
        if (lostReleases.length) {
          missing.push(`IRSA skipped ${lostReleases.join(", ")}, so some passes are missing (Load again)`);
        }
        setStatus(
          `${s.result.n_used} frames · ${s.result.epochs.length} survey passes · ${span}` +
            (missing.length ? ` · ${missing.join(" · ")}` : ""),
        );
        return;
      }
      setLoading(true);
      setStatusErr(false);
      if (s.status === "searching") {
        setProgress(null);
        setStatus(s.message || "Searching the SPHEREx archive…");
      } else if (s.status === "downloading") {
        const pct = s.total ? Math.round((100 * (s.done || 0)) / s.total) : 0;
        setProgress(pct);
        setStatus(s.message || `Downloading cutouts… ${s.done ?? 0}/${s.total ?? 0}`);
      } else if (s.status === "processing") {
        setProgress(null);
        setStatus(s.message || "Aligning and stacking images…");
      } else {
        setStatus(s.message || s.status);
      }
      pollTimerRef.current = window.setTimeout(() => poll(key), 1000);
    } catch (err) {
      if (activeJobRef.current !== key) return;
      setStatus(err instanceof Error ? err.message : "Lost connection — retrying…");
      setStatusErr(false);
      setLoading(true);
      pollTimerRef.current = window.setTimeout(() => poll(key), 2000);
    }
  }, []);

  const loadOptionsForMode = useCallback(
    (_nextMode: UserMode, _opts?: { allBands?: boolean }) => {
      const dets =
        expertDetectors.length === detectorBands.length
          ? []
          : [...expertDetectors].sort((a, b) => a - b);
      return {
        detectors: dets,
        max_frames: expertMaxFrames,
      };
    },
    [detectorBands.length, expertDetectors, expertMaxFrames],
  );

  const startLoad = useCallback(
    async (body: Record<string, unknown>, nextMode: UserMode = mode) => {
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      const preset =
        typeof body.preset === "string" && body.preset ? body.preset : null;
      const presetMeta = preset && cfg?.presets?.[preset] ? cfg.presets[preset] : null;
      const bodyRa = typeof body.ra === "number" ? body.ra : Number(body.ra);
      const bodyDec = typeof body.dec === "number" ? body.dec : Number(body.dec);
      const bodyFov =
        typeof body.fov === "number" ? body.fov : Number(body.fov);
      syncToolQuery({
        ra: Number.isFinite(bodyRa) ? bodyRa : (presetMeta?.ra ?? null),
        dec: Number.isFinite(bodyDec) ? bodyDec : (presetMeta?.dec ?? null),
        fov: Number.isFinite(bodyFov) ? bodyFov : (presetMeta?.fov ?? null),
        name: typeof body.name === "string" ? body.name : null,
      });
      setResult(null);
      setJob(null);
      setPlaying(false);
      setVisit(0);
      setSpectrumData(null);
      setSpectrumNote("Click the sky image to sample a spectrum.");
      setSpectrumOpen(false);
      setSpectrumPick(null);
      setSpectrumSamplePx(null);
      setDownloadOpen(false);
      setSkyOpen(false);
      setShowRgb(false);
      setLoading(true);
      setProgress(null);
      setStatusErr(false);
      setStatus(
        nextMode === "amateur"
          ? "Loading a quick blink (D5–D6 + RGB)…"
          : "Searching the SPHEREx archive…",
      );
      try {
        const opts = loadOptionsForMode(nextMode);
        const payload = {
          ...body,
          // No `collections`: the backend applies its current defaults, so an open tab never
          // keeps requesting a stale release list from before a backend config change.
          ...opts,
          // Always start fresh — reusing a hung download leaves the bar stuck at 23/24.
          force: true,
        };
        const { job: key } = await spherexFetch<{ job: string }>("/api/load", {
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
      }
    },
    [cfg?.presets, loadOptionsForMode, mode, poll],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await spherexFetch<SpherexConfig>("/api/config");
        if (cancelled) return;
        setCfg(config);
        setStatus("Enter a name or RA/Dec, then Lock to load SPHEREx cutouts.");
        setStatusErr(false);
      } catch (err) {
        if (cancelled) return;
        setStatus(
          err instanceof Error
            ? err.message
            : "Cannot reach the SPHEREx API. Run: npm run spherex:api",
        );
        setStatusErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const bump = () => setFieldLayoutEpoch((n) => n + 1);
    bump();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(bump) : null;
    ro?.observe(field);
    const img = field.querySelector<HTMLImageElement>("img.tool-cutout");
    img?.addEventListener("load", bump);
    window.addEventListener("resize", bump);
    return () => {
      ro?.disconnect();
      img?.removeEventListener("load", bump);
      window.removeEventListener("resize", bump);
    };
  }, [result?.npix, image?.src]);

  const bootstrapDefaultTarget = useCallback(
    (nextMode: UserMode) => {
      if (!cfg) return;
      const params = new URLSearchParams(window.location.search);
      const qPreset = params.get("preset");
      const qName = params.get("name")?.trim() || null;
      const qRa = params.get("ra");
      const qDec = params.get("dec");
      const qFov = params.get("fov");
      const raN = qRa != null ? Number(qRa) : NaN;
      const decN = qDec != null ? Number(qDec) : NaN;
      const fovN = qFov != null ? clampToolFov(Number(qFov)) : null;

      setBand(bandIndexFromUm(2.5));
      setInfoTab("object");

      if (qPreset && cfg.presets[qPreset]) {
        const p = cfg.presets[qPreset];
        setPresetKey(qPreset);
        setNameQuery("");
        setRa(formatCoord(p.ra, "ra"));
        setDec(formatCoord(p.dec, "dec"));
        setFov(fovN ?? p.fov);
        void startLoad({ preset: qPreset, fov: fovN ?? p.fov }, nextMode);
        return;
      }

      if (qName) {
        const loadFov = fovN ?? 0.18;
        setPresetKey(null);
        setNameQuery(qName);
        setFov(loadFov);
        void (async () => {
          setLoading(true);
          setStatusErr(false);
          setStatus(`Resolving “${qName}” via NED / SIMBAD / Gaia…`);
          try {
            const t = await spherexFetch<{ ra_2026: number; dec_2026: number }>(
              `/api/resolve?name=${encodeURIComponent(qName)}`,
            );
            setRa(formatCoord(t.ra_2026, "ra"));
            setDec(formatCoord(t.dec_2026, "dec"));
            await startLoad({ name: qName, fov: loadFov }, nextMode);
          } catch (err) {
            setStatus(err instanceof Error ? err.message : "Name resolve failed");
            setStatusErr(true);
            setLoading(false);
          }
        })();
        return;
      }

      if (Number.isFinite(raN) && Number.isFinite(decN)) {
        const loadFov = fovN ?? 0.12;
        setPresetKey(null);
        setNameQuery("");
        setRa(formatCoord(raN, "ra"));
        setDec(formatCoord(decN, "dec"));
        setFov(loadFov);
        void startLoad({ ra: raN, dec: decN, fov: loadFov }, nextMode);
        return;
      }

      // No target in the URL — leave the lab idle until the user locks a field.
      setPresetKey(null);
      syncToolQuery({ ra: null, dec: null, fov: fovN, name: null });
      setStatus("Enter a name or RA/Dec, then Lock to load SPHEREx cutouts.");
      setStatusErr(false);
    },
    [cfg, startLoad],
  );

  useEffect(() => {
    if (!cfg || bootstrapped.current) return;
    bootstrapped.current = true;

    const params = new URLSearchParams(window.location.search);
    const nextMode: UserMode = "expert";
    setMode(nextMode);
    bootstrapDefaultTarget(nextMode);
    // Intentionally once after config arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  useEffect(() => {
    return () => {
      activeJobRef.current = null;
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!spectrumOpen && !downloadOpen && !skyOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (spectrumOpen) {
        setSpectrumOpen(false);
        setSpectrumPick(null);
      }
      if (downloadOpen) setDownloadOpen(false);
      if (skyOpen) setSkyOpen(false);
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [spectrumOpen, downloadOpen, skyOpen]);

  useEffect(() => {
    if (!playing || timelineCount < 2) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setPlaying(false);
      return;
    }
    const id = window.setInterval(() => {
      setVisit((current) => (current + 1) % timelineCount);
    }, 560);
    return () => window.clearInterval(id);
  }, [playing, timelineCount]);

  useEffect(() => {
    if (visit > 0 && timelineCount > 0 && visit >= timelineCount) {
      setVisit(timelineCount - 1);
    }
  }, [visit, timelineCount]);

  function openBookmark(b: Bookmark) {
    setPresetKey(null);
    setNameQuery("");
    setRa(formatCoord(b.ra, "ra"));
    setDec(formatCoord(b.dec, "dec"));
    const bFov = clampToolFov(b.fov);
    setFov(bFov);
    void startLoad({ ra: b.ra, dec: b.dec, fov: bFov });
  }

  async function saveBookmark(input: { label: string; ra: number; dec: number; fov: number; kind: "target" | "prediction" }) {
    const existing = bookmarks.findNear(input);
    if (existing) {
      setBookmarkNote(`Already saved as “${existing.label}”.`);
      return;
    }
    const saved = await bookmarks.save(input);
    if (saved) setBookmarkNote(`Saved “${saved.label}”.`);
  }

  async function onLock(event: FormEvent) {
    event.preventDefault();
    const query = nameQuery.trim();
    if (query) {
      setLoading(true);
      setStatusErr(false);
      setStatus(`Resolving “${query}” via NED / SIMBAD / Gaia…`);
      try {
        const t = await spherexFetch<{
          ra_2026: number;
          dec_2026: number;
          name?: string;
        }>(`/api/resolve?name=${encodeURIComponent(query)}`);
        setPresetKey(null);
        setRa(formatCoord(t.ra_2026, "ra"));
        setDec(formatCoord(t.dec_2026, "dec"));
        // Keep the typed name so the job identity / Object blurb stay M101 — not a
        // random nearby WISEA hit from an RA/Dec cone search.
        await startLoad({ name: query, fov });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Name resolve failed");
        setStatusErr(true);
        setLoading(false);
      }
      return;
    }

    const raN = Number(ra);
    const decN = Number(dec);
    if (!Number.isFinite(raN) || !Number.isFinite(decN)) {
      setStatus("Enter RA/Dec in degrees, or an object name.");
      setStatusErr(true);
      return;
    }
    setPresetKey(null);
    void startLoad({ ra: raN, dec: decN, fov });
  }

  function copyShareLink() {
    const raN = Number(ra);
    const decN = Number(dec);
    const presetMeta = presetKey && cfg?.presets?.[presetKey] ? cfg.presets[presetKey] : null;
    syncToolQuery({
      ra: Number.isFinite(raN) ? raN : (presetMeta?.ra ?? null),
      dec: Number.isFinite(decN) ? decN : (presetMeta?.dec ?? null),
      fov,
      name: nameQuery.trim() || null,
    });
    const url = window.location.href;
    void navigator.clipboard.writeText(url).then(
      () => setStatus("Share link copied to clipboard."),
      () => setStatus(url),
    );
    setStatusErr(false);
  }

  function selectDetector(id: number) {
    setShowRgb(false);
    setStageExtra("none");
    setVisit(0);
    const pool = activeDetectors.some((d) => d.id === id) ? activeDetectors : detectorBands;
    setBand(bandIndexFromUm(wavelengthForDetector(id, pool)));
  }

  function selectRgb() {
    if (!rgbAvailable) return;
    setStageExtra("none");
    setEveryFrame(false);
    setShowRgb(true);
  }

  function selectDiff() {
    if (visits.length < 2) return;
    setShowRgb(false);
    setEveryFrame(false);
    setPlaying(false);
    setStageExtra((current) => (current === "diff" ? "none" : "diff"));
  }

  function selectStack() {
    if (!detectorStack) return;
    setShowRgb(false);
    setEveryFrame(false);
    setPlaying(false);
    setStageExtra((current) => (current === "stack" ? "none" : "stack"));
  }

  function toggleEveryFrame() {
    setShowRgb(false);
    setStageExtra("none");
    setVisit(0);
    setEveryFrame((value) => !value);
  }

  function toggleWavePanel() {
    if (wavePanel === "bands") {
      setWavePanel("utils");
      return;
    }
    setStageExtra("none");
    setEveryFrame(false);
    setShowRgb(false);
    setPlaying(false);
    setVisit(0);
    setWavePanel("bands");
  }

  function cycleWavelength(direction: 1 | -1) {
    const ids = activeDetectors.map((d) => d.id);
    const opts: Array<number | "rgb"> = rgbAvailable ? [...ids, "rgb"] : ids;
    if (!opts.length) return;
    const current: number | "rgb" = showRgb ? "rgb" : detectorId;
    const idx = Math.max(0, opts.indexOf(current));
    const next = opts[(idx + direction + opts.length) % opts.length];
    if (next === "rgb") selectRgb();
    else selectDetector(next);
  }

  function stepVisit(direction: number) {
    if (!timelineCount) return;
    setVisit((current) => (current + direction + timelineCount) % timelineCount);
  }

  function toggleFlicker() {
    if (timelineCount < 2) return;
    setPlaying((value) => !value);
  }

  function onStageKeyDown(event: { key: string; preventDefault: () => void }) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepVisit(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepVisit(1);
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      toggleFlicker();
    }
  }

  function addTrackMark(x: number, y: number) {
    if (!job || frameEpoch < 0) return;
    const marks = [...track.marks.filter((m) => m.epoch !== frameEpoch), { epoch: frameEpoch, x, y }];
    setTrackState({ job, marks, pred: null, busy: false, error: null });
    setPlaying(false);
    // Hop to the next pass that still needs a mark (pass view only; every-frame mode steps by shot).
    if (!usingEvery && marks.length < visits.length) {
      for (let step = 1; step < visits.length; step++) {
        const next = (frameEpoch + step) % visits.length;
        if (!marks.some((m) => m.epoch === next)) {
          setVisit(next);
          break;
        }
      }
    }
  }

  function toggleTracking() {
    setTracking((on) => !on);
    setPlaying(false);
    if (!tracking && (stageExtra !== "none" || showRgb)) {
      setStageExtra("none");
      setShowRgb(false);
    }
  }

  function resetTrack() {
    setTrackState({ ...EMPTY_TRACK, job });
  }

  async function predictMotion() {
    if (!job || track.marks.length < TRACK_MIN_MARKS) return;
    const forJob = job;
    const marks = track.marks;
    setTrackState({ job: forJob, marks, pred: null, busy: true, error: null });
    try {
      const pred = await spherexFetch<MotionPrediction>(`/api/job/${forJob}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marks, horizon_days: TRACK_HORIZON_DAYS }),
      });
      setTrackState((s) => (s.job === forJob && s.marks === marks ? { ...s, pred, busy: false } : s));
    } catch (err) {
      const error = err instanceof Error ? err.message : "Prediction failed";
      setTrackState((s) => (s.job === forJob && s.marks === marks ? { ...s, busy: false, error } : s));
    }
  }

  async function onFieldClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!job || !result || !fieldRef.current) return;
    if (trackOn) {
      const hit = pointerToCutoutPixel(fieldRef.current, event.clientX, event.clientY, result.npix);
      if (hit) addTrackMark(hit.x, hit.y);
      return;
    }
    if (isAmateur) return;
    const mapped = pointerToCutoutPixel(fieldRef.current, event.clientX, event.clientY, result.npix);
    if (!mapped) return;
    const { x, y } = mapped;
    setInfoTab("data");
    setSpectrumNote("Measuring this spot in every frame…");
    setSpectrumPick(null);
    setSpectrumSamplePx({ x, y });
    try {
      const data = await spherexFetch<SpectrumResult>(
        `/api/job/${job}/spectrum?x=${x.toFixed(2)}&y=${y.toFixed(2)}`,
      );
      const chart = drawSpectrumChart(data, "spec");
      setSpectrumData(data);
      setSpectrumNote(chart.note);
    } catch (err) {
      setSpectrumData(null);
      setSpectrumNote(err instanceof Error ? err.message : "Spectrum failed");
    }
  }

  const spectrumPreview = useMemo(
    () => (spectrumData ? drawSpectrumChart(spectrumData, "spec-p", "preview") : null),
    [spectrumData],
  );
  const spectrumModal = useMemo(
    () => (spectrumData ? drawSpectrumChart(spectrumData, "spec-m", "bay") : null),
    [spectrumData],
  );

  return (
    <div className="tool-wrap">
      <div className="tool-layout">
        <form className="tool-dash tool-address" onSubmit={onLock}>
          <div className="tool-dash-scroll" data-lenis-prevent>
          <header className="tool-dash-head">
            <div className="tool-dash-plate">
              <i
                className={
                  ledWarn ? "tool-dash-led is-warn" : ledLive ? "tool-dash-led is-live" : "tool-dash-led"
                }
                aria-hidden="true"
              />
              <div>
                <p className="tool-side-label">Target</p>
                <h1>Data analysis</h1>
              </div>
            </div>
            <Link
              href={
                result
                  ? `/tool?ra=${result.target.ra.toFixed(5)}&dec=${result.target.dec.toFixed(5)}`
                  : Number.isFinite(Number(ra)) && Number.isFinite(Number(dec))
                    ? `/tool?ra=${Number(ra).toFixed(5)}&dec=${Number(dec).toFixed(5)}`
                    : "/tool"
              }
              className="tool-map-test-link"
            >
              Sky map
            </Link>
          </header>

          <div className="tool-coord-bay" role="group" aria-label="Coordinates">
              <label className="tool-coord">
                <span className="tool-coord-tag">RA</span>
                <span className="tool-coord-unit">deg</span>
                <input
                  value={ra}
                  onChange={(event) => setRa(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="133.786"
                />
              </label>
              <label className="tool-coord">
                <span className="tool-coord-tag">Dec</span>
                <span className="tool-coord-unit">deg</span>
                <input
                  value={dec}
                  onChange={(event) => setDec(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="-7.244"
                />
              </label>
              <label className="tool-coord is-wide">
                <span className="tool-coord-tag">Name</span>
                <span className="tool-coord-unit">NED·SIM</span>
                <input
                  value={nameQuery}
                  onChange={(event) => setNameQuery(event.target.value)}
                  autoComplete="off"
                  placeholder="M31, Deneb, Vega…"
                />
              </label>
              <ToolMetalDial
                id="tool-fov-dial"
                label="FOV"
                unit={`${fov.toFixed(2)}°`}
                min={0.05}
                max={0.4}
                step={0.01}
                value={fov}
                onChange={setFov}
                ticks={[
                  { value: 0.05, label: "0.05" },
                  { value: 0.12, label: "0.12" },
                  { value: 0.25, label: "0.25" },
                  { value: 0.4, label: "0.40" },
                ]}
              />
              <ToolMetalDial
                id="tool-frames-dial"
                label="Frames"
                unit={expertMaxFrames <= 0 ? "all" : String(expertMaxFrames)}
                min={0}
                max={cfg?.max_frames_cap ?? 120}
                step={4}
                value={expertMaxFrames}
                onChange={setExpertMaxFrames}
                ticks={[
                  { value: 0, label: "all" },
                  { value: 24, label: "24" },
                  { value: 48, label: "48" },
                  { value: cfg?.max_frames_cap ?? 120, label: "max" },
                ]}
              />
              <div className="tool-coord is-wide tool-det-pick" role="group" aria-label="Detectors to fetch">
                <span className="tool-coord-tag">Bands</span>
                <div className="tool-band-bank is-compact">
                  {detectorBands.map((d) => {
                    const on = expertDetectors.includes(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className={on ? "tool-band-key is-on" : "tool-band-key"}
                        onClick={() => {
                          setExpertDetectors((current) => {
                            if (on && current.length === 1) return current;
                            return on
                              ? current.filter((id) => id !== d.id)
                              : [...current, d.id].sort((a, b) => a - b);
                          });
                        }}
                      >
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
          

          <button className="tool-lock" type="submit" disabled={loading && !result}>
            <span className="tool-lock-ring" aria-hidden="true" />
            <span className="tool-lock-face">
              <strong>{loading ? "Sync" : "Lock"}</strong>
              <small>{loading ? "IRSA" : "Acquire"}</small>
            </span>
          </button>

          <div className="tool-channel-bank tool-bookmarks" id="bookmarks">
            <div className="tool-channel-cap">
              <p className="tool-side-label">Bookmarks</p>
              <span>{bookmarks.loaded ? `${bookmarks.items.length} saved` : "Loading"}</span>
            </div>
            {bookmarks.items.length ? (
              <div className="tool-channels" role="list">
                {bookmarks.items.map((b) => {
                  const here = result ? bookmarks.findNear(result.target)?.id === b.id : false;
                  return (
                    <div key={b.id} role="listitem" className="tool-bookmark-row">
                      <button
                        type="button"
                        className={here ? "tool-channel is-on" : "tool-channel"}
                        onClick={() => openBookmark(b)}
                        disabled={loading && here}
                        title={`${b.ra.toFixed(5)}°, ${b.dec >= 0 ? "+" : ""}${b.dec.toFixed(5)}° · FOV ${b.fov.toFixed(2)}°`}
                      >
                        <i aria-hidden="true" />
                        <span className="tool-channel-idx">{b.kind === "prediction" ? "PRD" : "★"}</span>
                        <span className="tool-channel-name">{b.label}</span>
                      </button>
                      <button
                        type="button"
                        className="tool-bookmark-del"
                        aria-label={`Delete bookmark ${b.label}`}
                        onClick={() => void bookmarks.remove(b.id)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : bookmarks.loaded ? (
              <p className="tool-bookmark-empty">
                Lock a target, then press <strong>Bookmark</strong> to keep it here.
              </p>
            ) : null}
            {bookmarks.error || bookmarkNote ? (
              <p className={bookmarks.error ? "tool-bookmark-note is-error" : "tool-bookmark-note"} role="status">
                {bookmarks.error ?? bookmarkNote}
              </p>
            ) : null}
          </div>

          <div className="tool-side-actions">
            <button
              type="button"
              className="tool-side-btn"
              disabled={!result}
              onClick={() =>
                result &&
                void saveBookmark({
                  label: objectName ?? result.target.name,
                  ra: result.target.ra,
                  dec: result.target.dec,
                  fov: result.fov || fov,
                  kind: "target",
                })
              }
            >
              {result && bookmarks.findNear(result.target) ? "★ Bookmarked" : "☆ Bookmark"}
            </button>
            <button
              type="button"
              className="tool-side-btn"
              onClick={copyShareLink}
              disabled={!result && !(Number.isFinite(Number(ra)) && Number.isFinite(Number(dec)))}
            >
              Copy share link
            </button>
            <button
              type="button"
              className="tool-side-btn"
              onClick={() => setSkyOpen(true)}
              disabled={!result}
            >
              Sky context
            </button>
            {!isAmateur && job && result ? (
              <button type="button" className="tool-side-btn" onClick={() => setDownloadOpen(true)}>
                Download
              </button>
            ) : null}
          </div>

          </div>
        </form>

        <div className="tool-stage">
          <div className="tool-wave" style={waveStyle} data-tour="wave">
            <div className="tool-wave-panel">
              {wavePanel === "bands" ? (
                <div className="tool-band-bank" role="group" aria-label="Infrared wavelength bands" data-tour="bands">
                  {activeDetectors.map((d) => {
                    const loaded = result?.detectors.some((x) => x.detector === d.id);
                    const on = stageExtra === "none" && !showRgb && detectorId === d.id;
                    const why =
                      result && !loaded
                        ? (bandMissingReason(result.band_coverage?.find((c) => c.detector === d.id)) ??
                          "No usable frames in this band for this load.")
                        : undefined;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className={on ? "tool-band-key is-on" : "tool-band-key"}
                        disabled={Boolean(result) && !loaded}
                        title={why ? `${d.label}: ${why}` : undefined}
                        aria-pressed={on}
                        aria-label={`${d.label} ${d.lo.toFixed(2)} to ${d.hi.toFixed(2)} micrometers${why ? `. Unavailable: ${why}` : ""}`}
                        onClick={() => selectDetector(d.id)}
                      >
                        <i aria-hidden="true" />
                        <span className="tool-band-key-id">{d.label}</span>
                        <span className="tool-band-key-um">
                          {d.lo.toFixed(1)}–{d.hi.toFixed(1)}
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={
                      showRgb && stageExtra === "none"
                        ? "tool-band-key tool-band-key-rgb is-on"
                        : "tool-band-key tool-band-key-rgb"
                    }
                    disabled={!rgbAvailable}
                    aria-pressed={showRgb && stageExtra === "none"}
                    aria-label="RGB composite wavelength view"
                    onClick={selectRgb}
                  >
                    <i aria-hidden="true" />
                    <span className="tool-band-key-id">RGB</span>
                    <span className="tool-band-key-um">color</span>
                  </button>
                </div>
              ) : (
                <div className="tool-band-bank tool-util-bank" role="group" aria-label="Stage utilities" data-tour="utils">
                  <button
                    type="button"
                    className={stageExtra === "diff" ? "tool-band-key is-on" : "tool-band-key"}
                    disabled={visits.length < 2}
                    aria-pressed={stageExtra === "diff"}
                    aria-label="Single difference photo: peak-to-peak change across every survey pass"
                    onClick={selectDiff}
                  >
                    <i aria-hidden="true" />
                    <span className="tool-band-key-id">DIFF</span>
                    <span className="tool-band-key-um">all</span>
                  </button>
                  <button
                    type="button"
                    className={stageExtra === "stack" ? "tool-band-key is-on" : "tool-band-key"}
                    disabled={!detectorStack}
                    aria-pressed={stageExtra === "stack"}
                    aria-label="Coadd every frame for this detector to raise signal to noise"
                    onClick={selectStack}
                  >
                    <i aria-hidden="true" />
                    <span className="tool-band-key-id">STACK</span>
                    <span className="tool-band-key-um">S/N</span>
                  </button>
                  <button
                    type="button"
                    className={usingEvery ? "tool-band-key is-on" : "tool-band-key"}
                    disabled={!result?.frames.some((f) => f.detector === detectorId)}
                    aria-pressed={usingEvery}
                    aria-label="Step through every individual frame for this detector instead of survey-pass stacks"
                    onClick={toggleEveryFrame}
                  >
                    <i aria-hidden="true" />
                    <span className="tool-band-key-id">EVERY</span>
                    <span className="tool-band-key-um">frame</span>
                  </button>
                </div>
              )}
              <button
                type="button"
                className={wavePanel === "utils" ? "tool-wave-more is-on" : "tool-wave-more"}
                aria-label={wavePanel === "bands" ? "Show stage utilities" : "Show wavelength bands"}
                aria-pressed={wavePanel === "utils"}
                onClick={toggleWavePanel}
              >
                <span aria-hidden="true">{wavePanel === "bands" ? "+" : "×"}</span>
              </button>
            </div>
          </div>

          <div className="tool-sky">
            <section
              className="tool-viewport"
              tabIndex={0}
              aria-label={
                isAmateur
                  ? "Sky preview. Left and right change the visit. Space starts or stops flicker. Scroll to change field of view."
                  : "Sky preview. Left and right change the visit. Up and down change the wavelength. Space starts or stops flicker. Scroll to change field of view. Click to sample spectrum."
              }
              onKeyDown={(event) => {
                onStageKeyDown(event);
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  cycleWavelength(event.key === "ArrowUp" ? 1 : -1);
                }
              }}
            >
              <div className="tool-frame-bar">
                <span>
                  {stageExtra === "diff" && visits.length >= 2
                    ? `Diff · all ${visits.length} passes`
                    : stageExtra === "stack"
                      ? `Detector stack · ${detectorMeta?.label ?? `D${detectorId}`}`
                      : usingEvery && everyShot
                        ? `Frame ${visitSafe + 1}/${everyFrames.length} · ${everyShot.date}`
                        : showRgb
                          ? "RGB composite · all passes"
                          : frame
                            ? `Pass ${visitSafe + 1}/${visits.length} · ${frame.start}${frame.end !== frame.start ? ` → ${frame.end}` : ""}`
                            : loading
                              ? "Acquiring…"
                              : "No visit"}
                </span>
                <span>
                  {stageExtra === "diff"
                    ? "single frame"
                    : stageExtra === "stack"
                      ? `S/N · ${detectorStack?.n ?? "—"} frames`
                      : usingEvery
                        ? `every · ${detectorMeta?.label ?? `D${detectorId}`}`
                        : showRgb
                          ? "RGB · color"
                          : `${active.um} μm · ${detectorMeta?.label ?? `D${detectorId}`}`}
                </span>
              </div>
              <div
                className={`tool-field is-live${isAmateur ? " is-amateur" : ""}${trackOn ? " is-tracking" : ""}`}
                data-tour="field"
                data-lenis-prevent
                ref={attachField}
                style={{ ["--field" as string]: showRgb ? RGB_VIEW_COLOR : active.color }}
                onClick={onFieldClick}
              >
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="tool-cutout"
                    src={image.src}
                    alt={image.label}
                    draggable={false}
                  />
                ) : !loading && !statusErr ? (
                  <p className="tool-empty">Lock a position to load SPHEREx frames.</p>
                ) : null}
                {status && (loading || statusErr) ? (
                  <div className={statusErr ? "tool-warn tool-status-pill" : "tool-status-lcd tool-status-pill"}>
                    <p>{status}</p>
                    {loading && progress !== null ? (
                      <div
                        className="tool-load-bar"
                        role="progressbar"
                        aria-valuenow={progress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <i style={{ width: `${Math.max(progress, 4)}%` }} />
                      </div>
                    ) : loading ? (
                      <div className="tool-load-bar is-indeterminate" role="progressbar" aria-label="Loading">
                        <i />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {showMark && result && stageExtra !== "stack"
                  ? (() => {
                      const markEpoch =
                        usingEvery && everyShot
                          ? visits.find((e) => everyShot.date >= e.start && everyShot.date <= e.end) ??
                            visits[0]
                          : frame;
                      if (!markEpoch) return null;
                      return (
                        <span
                          className="tool-wise"
                          style={cutoutMarkerStyle(
                            fieldRef.current,
                            result.npix,
                            markEpoch.target_px[0],
                            markEpoch.target_px[1],
                          )}
                          title="Expected position from proper motion"
                          data-layout={fieldLayoutEpoch}
                        />
                      );
                    })()
                  : null}
                {spectrumSamplePx && result && !isAmateur ? (
                  <span
                    className="tool-spectrum-sample"
                    style={cutoutMarkerStyle(
                      fieldRef.current,
                      result.npix,
                      spectrumSamplePx.x,
                      spectrumSamplePx.y,
                    )}
                    title="Spectrum sample position"
                    data-layout={fieldLayoutEpoch}
                  />
                ) : null}
                {result && image && (track.marks.length > 0 || track.pred) && stageExtra === "none" && !showRgb
                  ? (() => {
                      const npix = result.npix;
                      // After a fit, draw the centroid-refined positions; before, the raw clicks.
                      const shown = track.pred
                        ? track.pred.marks
                        : [...track.marks].sort((a, b) => a.epoch - b.epoch);
                      const pred = track.pred?.prediction ?? null;
                      const clampPix = (v: number) => Math.min(npix - 1, Math.max(0, v));
                      const predPix = pred ? { x: clampPix(pred.x), y: clampPix(pred.y) } : null;
                      const path = [
                        ...shown.map((m) => cutoutPointPx(fieldNode, npix, m.x, m.y)),
                        ...(predPix ? [cutoutPointPx(fieldNode, npix, predPix.x, predPix.y)] : []),
                      ].filter((p): p is NonNullable<typeof p> => p !== null);
                      const predPx = predPix ? path[path.length - 1] : null;
                      return (
                        <>
                          {path.length >= 2 ? (
                            <svg className="tool-track-path" aria-hidden="true" data-layout={fieldLayoutEpoch}>
                              <polyline
                                className={pred ? "is-fit" : undefined}
                                points={path.map((p) => `${p.x},${p.y}`).join(" ")}
                              />
                              {pred && predPx ? (
                                <circle
                                  cx={predPx.x}
                                  cy={predPx.y}
                                  r={Math.max(9, pred.sigma_px * predPx.pxPerPix)}
                                />
                              ) : null}
                            </svg>
                          ) : null}
                          {shown.map((m) => (
                            <span
                              key={m.epoch}
                              className={m.epoch === frameEpoch ? "tool-track-mark is-current" : "tool-track-mark"}
                              style={cutoutMarkerStyle(fieldNode, npix, m.x, m.y)}
                              title={`Pass ${m.epoch + 1}`}
                              data-layout={fieldLayoutEpoch}
                            >
                              <b>{m.epoch + 1}</b>
                            </span>
                          ))}
                          {pred && predPix ? (
                            <span
                              className={pred.in_view ? "tool-track-predict" : "tool-track-predict is-off"}
                              style={cutoutMarkerStyle(fieldNode, npix, predPix.x, predPix.y)}
                              title={`Predicted position on ${pred.date}`}
                              data-layout={fieldLayoutEpoch}
                            >
                              <b>{pred.in_view ? pred.date : `off frame · ${pred.date}`}</b>
                            </span>
                          ) : null}
                        </>
                      );
                    })()
                  : null}
              </div>
            </section>
          </div>

          <div
            className={hideTimelineWell ? "tool-timeline is-slim" : "tool-timeline"}
            data-tour="timeline"
            tabIndex={0}
            aria-label={
              hideTimelineWell
                ? "Visit controls. Left and right change the visit. Space starts or stops flicker."
                : "Visit timeline. Left and right change the visit. Space starts or stops flicker."
            }
            onKeyDown={(event) => {
              if (
                (event.key === " " || event.key === "Spacebar") &&
                event.target instanceof HTMLButtonElement
              ) {
                return;
              }
              onStageKeyDown(event);
            }}
          >
            <button
              type="button"
              className={playing ? "tool-blink is-on" : "tool-blink"}
              data-tour="flicker"
              onClick={toggleFlicker}
              disabled={timelineCount < 2 || stageExtra === "stack" || stageExtra === "diff"}
            >
              <i aria-hidden="true" />
              <span>{playing ? "Stop" : "Flicker"}</span>
            </button>
            {!hideTimelineWell ? (
              <div className="tool-timeline-well">
                <div
                  className="tool-dots"
                  role="listbox"
                  aria-label={usingEvery ? "Individual frames" : "Survey passes"}
                >
                  {usingEvery
                    ? everyFrames.map((item, index) => (
                        <button
                          key={`${item.png}-${index}`}
                          type="button"
                          role="option"
                          aria-selected={index === visitSafe}
                          className={index === visitSafe ? "tool-dot is-on" : "tool-dot"}
                          title={`${item.date} · D${item.detector} · ${item.band}`}
                          onClick={() => setVisit(index)}
                        >
                          <span className="sr-only">
                            Frame {index + 1}: {item.date}, detector {item.detector}
                          </span>
                        </button>
                      ))
                    : visits.map((item, index) => (
                        <button
                          key={`${item.start}-${index}`}
                          type="button"
                          role="option"
                          aria-selected={index === visitSafe}
                          className={index === visitSafe ? "tool-dot is-on" : "tool-dot"}
                          title={`${item.start} → ${item.end} · ${item.n} frames`}
                          onClick={() => setVisit(index)}
                        >
                          <span className="sr-only">
                            Survey pass {index + 1}: {item.start} to {item.end}
                          </span>
                        </button>
                      ))}
                </div>
              </div>
            ) : (
              <output className="tool-timeline-slim-readout" aria-live="polite">
                {stageExtra === "diff" && visits.length >= 2
                  ? `all ${visits.length}`
                  : stageExtra === "stack"
                    ? detectorMeta?.label ?? `D${detectorId}`
                    : "—"}
              </output>
            )}
            <div className="tool-arrows">
              <button
                type="button"
                aria-label={usingEvery ? "Earlier frame" : "Earlier visit"}
                onClick={() => stepVisit(-1)}
                disabled={!timelineCount || stageExtra === "stack" || stageExtra === "diff"}
              >
                ←
              </button>
              <button
                type="button"
                aria-label={usingEvery ? "Later frame" : "Later visit"}
                onClick={() => stepVisit(1)}
                disabled={!timelineCount || stageExtra === "stack" || stageExtra === "diff"}
              >
                →
              </button>
            </div>
          </div>
        </div>

        <section className="tool-dash tool-info" style={waveStyle} data-tour="object">
          <div className="tool-dash-scroll" data-lenis-prevent>
          <header className="tool-dash-head">
            <div className="tool-dash-plate">
              <i className={result ? "tool-dash-led is-live" : "tool-dash-led"} aria-hidden="true" />
              <div>
                <p className="tool-side-label">Details</p>
                <h2>
                  {!isAmateur && infoTab === "data" ? "Data" : "Object"}
                </h2>
              </div>
            </div>
            <output className="tool-wave-readout">
              <span>{detectorMeta?.label ?? `D${detectorId}`}</span>
              <small>
                {detectorMeta
                  ? `${detectorMeta.lo.toFixed(2)}–${detectorMeta.hi.toFixed(2)} µm`
                  : `${active.um} μm`}
              </small>
            </output>
          </header>

          {!isAmateur ? (
            <div className="tool-info-tabs" role="tablist" aria-label="Detail panels">
              <button
                type="button"
                role="tab"
                aria-selected={infoTab === "object"}
                className={infoTab === "object" ? "is-on" : undefined}
                onClick={() => setInfoTab("object")}
              >
                Object
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={infoTab === "data"}
                className={infoTab === "data" ? "is-on" : undefined}
                onClick={() => setInfoTab("data")}
              >
                Data
              </button>
            </div>
          ) : null}

          {isAmateur || infoTab === "object" ? (
            <div className="tool-object-pane">
              <div className="tool-object-stack">
                <div className="tool-meter-rack">
                  <div className="tool-meter-row" role="group" aria-label="Target">
                    <div className="tool-meter">
                      <span className="tool-meter-label">Object</span>
                      <output className="tool-meter-value">{objectName ?? "——"}</output>
                    </div>
                    <div className="tool-meter">
                      <span className="tool-meter-label">Kind</span>
                      <output className="tool-meter-value">{objectKind ?? "——"}</output>
                    </div>
                  </div>
                  <div className="tool-meter-row" role="group" aria-label="Visit">
                    <div className="tool-meter">
                      <span className="tool-meter-label">Visit</span>
                      <output className="tool-meter-value">
                        {usingEvery
                          ? everyFrames.length
                            ? `${visitSafe + 1}/${everyFrames.length}`
                            : "——"
                          : frame && visits.length
                            ? `${visitSafe + 1}/${visits.length}`
                            : "——"}
                      </output>
                    </div>
                    <div className="tool-meter">
                      <span className="tool-meter-label">Date</span>
                      <output className="tool-meter-value">{frame?.start ?? "——"}</output>
                    </div>
                  </div>
                  <div className="tool-meter-row" role="group" aria-label="Signal">
                    <div className="tool-meter">
                      <span className="tool-meter-label">Band</span>
                      <output className="tool-meter-value">
                        {detectorMeta ? `${detectorMeta.label}` : `D${detectorId}`}
                      </output>
                    </div>
                    <div className="tool-meter">
                      <span className="tool-meter-label">Window</span>
                      <output className="tool-meter-value">
                        {detectorMeta
                          ? `${detectorMeta.lo.toFixed(2)}–${detectorMeta.hi.toFixed(2)}`
                          : "——"}
                      </output>
                    </div>
                  </div>
                  <div className="tool-meter is-wide">
                    <span className="tool-meter-label">Image</span>
                    <output className="tool-meter-value">{image?.label ?? meta?.wise ?? "——"}</output>
                  </div>
                  {photoLine ? (
                    <div className="tool-meter is-wide">
                      <span className="tool-meter-label">Photo</span>
                      <output className="tool-meter-value">{photoLine}</output>
                    </div>
                  ) : null}
                </div>

                <div className="tool-brief-lcd">
                  {!meta?.summary && result?.target.description ? (
                    <p className="tool-brief-kicker">Description</p>
                  ) : null}
                  <p>
                    {meta?.summary ??
                      result?.target.description ??
                      (result
                        ? [
                            catalogBits.length ? catalogBits.join(" · ") : null,
                            isAmateur
                              ? `Watch ${result.target.name} across survey passes.`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") ||
                          `Live SPHEREx cutouts for ${result.target.name}.`
                        : "Enter a name or RA/Dec, then Lock to load the field.")}
                  </p>
                </div>
              </div>

              <div className="tool-track-pane" aria-label="Predict motion">
                <div className="tool-spectrum-head">
                  <div className="tool-dash-plate is-compact">
                    <i className={track.pred ? "tool-dash-led is-live" : "tool-dash-led"} aria-hidden="true" />
                    <p className="tool-side-label">Moving objects · +6 months</p>
                  </div>
                  <div className="tool-track-actions">
                    {track.marks.length || track.pred ? (
                      <button type="button" className="tool-spectrum-expand" onClick={resetTrack}>
                        Clear
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="tool-spectrum-expand"
                      disabled={!result || !job || movers.busy}
                      aria-busy={movers.busy}
                      title="Look up moving stars and asteroids in this field and predict where they'll be in 6 months"
                      onClick={() => {
                        if (!job) return;
                        setTracking(false);
                        void findMovers(job);
                      }}
                    >
                      {movers.busy ? "Searching…" : movers.error ? "Retry" : "Find movers"}
                    </button>
                    <button
                      type="button"
                      className={trackOn ? "tool-spectrum-expand is-on" : "tool-spectrum-expand"}
                      aria-pressed={trackOn}
                      disabled={!result || visits.length < TRACK_MIN_MARKS}
                      title="Mark an object yourself in 3 or more survey passes"
                      onClick={toggleTracking}
                    >
                      {trackOn ? "Done" : "By hand"}
                    </button>
                  </div>
                </div>

                {movers.data?.candidates.length ? (
                  <div className="tool-track-actions tool-track-movers" role="group" aria-label="Moving objects found">
                    {movers.data.candidates.map((c, i) => (
                      <button
                        key={c.id}
                        type="button"
                        className={autoPick?.id === c.id ? "tool-spectrum-expand is-on" : "tool-spectrum-expand"}
                        aria-pressed={autoPick?.id === c.id}
                        title={`${c.name} · ${c.source}${
                          c.kind === "star" ? ` · seen by SPHEREx in ${c.seen_passes}/${c.marks.length} passes` : ""
                        }`}
                        onClick={() => {
                          setTracking(false);
                          setTrackState({ job, marks: [], pred: c, busy: false, error: null });
                        }}
                      >
                        {c.is_target ? "Target" : c.kind === "asteroid" ? `☄ ${c.name}` : `★ ${i + 1}`} ·{" "}
                        {c.speed_label} {compassPoint(c.position_angle)}
                      </button>
                    ))}
                  </div>
                ) : null}

                {track.pred ? (
                  (() => {
                    const p = track.pred;
                    const fmt = (v: number) => v.toFixed(5);
                    const speed = autoPick ? autoPick.speed_label : `${p.speed_arcsec_yr.toFixed(2)}″/yr`;
                    return (
                      <div className="tool-track-card">
                        {autoPick ? (
                          <p className="tool-track-source">
                            {autoPick.name} · {autoPick.source}
                            {autoPick.kind === "star"
                              ? autoPick.confirmed
                                ? ` · SPHEREx ${autoPick.seen_passes}/${autoPick.marks.length} passes`
                                : " · not visible to SPHEREx here"
                              : ""}
                          </p>
                        ) : null}

                        <section className="tool-track-section" aria-label="Predicted position">
                          <p className="tool-track-section-label">Where in 6 months</p>
                          <p className="tool-track-hero">
                            <strong>{p.prediction.date}</strong>
                            <span>± {p.prediction.sigma_arcsec.toFixed(1)}″</span>
                          </p>
                          <p className="tool-track-coords">
                            {fmt(p.prediction.ra)}°, {p.prediction.dec >= 0 ? "+" : ""}
                            {fmt(p.prediction.dec)}°
                          </p>
                        </section>

                        <section className="tool-track-section" aria-label="Fitted motion">
                          <p className="tool-track-section-label">Motion</p>
                          <div className="tool-track-facts">
                            <div>
                              <span>Speed</span>
                              <strong>{speed}</strong>
                            </div>
                            <div>
                              <span>Heading</span>
                              <strong>
                                {compassPoint(p.position_angle)} · {p.position_angle.toFixed(0)}°
                              </strong>
                            </div>
                          </div>
                          {!isAmateur && autoPick?.kind !== "asteroid" ? (
                            <p className="tool-track-meta">
                              μ α* {p.pm_ra_cosdec.toFixed(0)} · δ {p.pm_dec.toFixed(0)} ± {p.pm_err.toFixed(0)}{" "}
                              mas/yr · rms {p.rms_arcsec.toFixed(1)}″
                            </p>
                          ) : null}
                          {p.catalog ? (
                            <p className="tool-track-meta">
                              {p.catalog.separation_arcsec.toFixed(1)}″ from catalog proper-motion position
                            </p>
                          ) : null}
                        </section>

                        {p.notes.length ? (
                          <div className="tool-track-notes">
                            {p.notes.map((note) => (
                              <p key={note}>{note}</p>
                            ))}
                          </div>
                        ) : null}

                        <div className="tool-track-actions tool-track-actions-bar">
                          <Link
                            className="tool-spectrum-expand"
                            href={`/tool?ra=${p.prediction.ra.toFixed(5)}&dec=${p.prediction.dec.toFixed(5)}&fov=0.2`}
                          >
                            Open in sky map
                          </Link>
                          <button
                            type="button"
                            className="tool-spectrum-expand"
                            onClick={() =>
                              void saveBookmark({
                                label: `${objectName ?? result?.target.name ?? "Object"} · ${p.prediction.date}`,
                                ra: p.prediction.ra,
                                dec: p.prediction.dec,
                                fov: result?.fov ?? fov,
                                kind: "prediction",
                              })
                            }
                          >
                            Bookmark
                          </button>
                          <button
                            type="button"
                            className="tool-spectrum-expand"
                            onClick={() =>
                              void navigator.clipboard?.writeText(
                                `${fmt(p.prediction.ra)} ${fmt(p.prediction.dec)}`,
                              )
                            }
                          >
                            Copy RA/Dec
                          </button>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <>
                    <div className="tool-spectrum-empty">
                      {!result
                        ? "Load a target, then press Find movers."
                        : track.error
                          ? track.error
                          : trackOn
                            ? `Click the moving object in each pass — ${track.marks.length}/${TRACK_MIN_MARKS} marked${
                                track.marks.some((m) => m.epoch === frameEpoch) ? " (this pass ✓)" : ""
                              }.`
                            : track.marks.length
                              ? `${track.marks.length} pass${track.marks.length === 1 ? "" : "es"} marked.`
                              : movers.busy
                                ? "Measuring the motion of every star in the field…"
                                : movers.error
                                  ? `Automatic search failed: ${movers.error}`
                                  : movers.data
                                    ? movers.data.candidates.length
                                      ? "Pick a moving object above to see its predicted path."
                                      : [
                                          ...movers.data.notes,
                                          visits.length >= TRACK_MIN_MARKS
                                            ? "Spotted something yourself? Use By hand."
                                            : "",
                                        ]
                                          .filter(Boolean)
                                          .join(" ")
                                    : "Press Find movers to look up moving stars and asteroids in this field, or mark one By hand."}
                    </div>
                    {track.marks.length >= TRACK_MIN_MARKS ? (
                      <button
                        type="button"
                        className="tool-spectrum-expand tool-track-go"
                        disabled={track.busy}
                        onClick={() => void predictMotion()}
                      >
                        {track.busy ? "Fitting…" : "Predict position in 6 months"}
                      </button>
                    ) : null}
                  </>
                )}
              </div>

              <label className={showMark ? "tool-toggle is-on tool-object-foot" : "tool-toggle tool-object-foot"}>
                <span className="tool-toggle-copy">
                  <strong>Motion mark</strong>
                  <small>Overlay expected position</small>
                </span>
                <span className="tool-toggle-switch" aria-hidden="true">
                  <i />
                </span>
                <input
                  type="checkbox"
                  checked={showMark}
                  onChange={(event) => setShowMark(event.target.checked)}
                />
              </label>
            </div>
          ) : (
            <>
              <div className="tool-contam-pane">
                <p className="tool-side-label">Contamination</p>
                <div className="tool-meter-row" role="group" aria-label="Flagged pixels">
                  <div className="tool-meter">
                    <span className="tool-meter-label">Bad flags</span>
                    <output className="tool-meter-value">
                      {activeFrame
                        ? `${(100 * activeFrame.flagged).toFixed(1)}%`
                        : "——"}
                    </output>
                  </div>
                  <div className="tool-meter">
                    <span className="tool-meter-label">Field mean</span>
                    <output className="tool-meter-value">
                      {result?.photo
                        ? `${(100 * result.photo.flagged_mean).toFixed(1)}%`
                        : "——"}
                    </output>
                  </div>
                </div>
                {contamEntries.length ? (
                  <div className="tool-contam-grid">
                    {contamEntries
                      .filter((entry) => !entry.warn)
                      .map((entry) => (
                        <div key={entry.key} className="tool-contam-chip is-info is-wide">
                          <span>{entry.label}</span>
                          <output>
                            {entry.pct < 0.1 ? "<0.1%" : `${entry.pct.toFixed(1)}%`}
                          </output>
                        </div>
                      ))}
                    <ul className="tool-contam-list">
                      {contamEntries
                        .filter((entry) => entry.warn)
                        .map((entry) => (
                          <li key={entry.key} className="is-warn">
                            <span>{entry.label}</span>
                            <output>
                              {entry.pct < 0.1 ? "<0.1%" : `${entry.pct.toFixed(1)}%`}
                            </output>
                          </li>
                        ))}
                    </ul>
                  </div>
                ) : (
                  <div className="tool-contam-empty">
                    {activeFrame
                      ? "No contamination bits set in this cutout."
                      : "Load a field to inspect FLAGS."}
                  </div>
                )}
              </div>

              <div className="tool-spectrum-pane" data-tour="spectrum">
                <div className="tool-spectrum-head">
                  <div className="tool-dash-plate is-compact">
                    <i
                      className={spectrumData ? "tool-dash-led is-live" : "tool-dash-led"}
                      aria-hidden="true"
                    />
                    <p className="tool-side-label">Spectrum</p>
                  </div>
                  {spectrumPreview?.html ? (
                    <button
                      type="button"
                      className="tool-spectrum-expand"
                      onClick={() => setSpectrumOpen(true)}
                    >
                      Expand
                    </button>
                  ) : null}
                </div>
                {spectrumPreview?.html ? (
                  <button
                    type="button"
                    className="tool-spectrum-preview-hit"
                    onClick={() => setSpectrumOpen(true)}
                    aria-label="Expand spectrum"
                  >
                    <SpectrumChartView
                      html={spectrumPreview.html}
                      hits={spectrumPreview.hits}
                      pick={null}
                      onPick={() => undefined}
                      interactive={false}
                    />
                  </button>
                ) : (
                  <div className="tool-spectrum-empty">
                    Click the sky image to latch a sample point.
                  </div>
                )}
              </div>
            </>
          )}
          </div>
        </section>
      </div>

      {skyOpen && result ? (
        <ToolSkyOverlay
          open={skyOpen}
          onClose={() => setSkyOpen(false)}
          ra={result.target.ra}
          dec={result.target.dec}
          fov={result.fov || fov}
          label={objectName}
        />
      ) : null}

      {downloadOpen && job && result ? (
        <div
          className="tool-spectrum-modal tool-download-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Download options"
        >
          <button
            type="button"
            className="tool-spectrum-modal-scrim"
            aria-label="Close downloads"
            onClick={() => setDownloadOpen(false)}
          />
          <div className="tool-download-stage">
            <header className="tool-download-head">
              <div className="tool-dash-plate">
                <i className="tool-dash-led is-live" aria-hidden="true" />
                <div>
                  <p className="tool-side-label">Exports</p>
                  <h2>Download bay</h2>
                </div>
              </div>
              <div className="tool-download-head-actions">
                <button
                  type="button"
                  className="tool-download-all"
                  disabled={!downloadExports.length}
                  onClick={() => {
                    void downloadExportsQueued(downloadExports).catch((err) => {
                      setStatus(err instanceof Error ? err.message : "Download failed");
                      setStatusErr(true);
                    });
                  }}
                >
                  <i className="tool-download-all-cap" aria-hidden="true" />
                  <span>Pull all</span>
                  <small>{downloadExports.length || "—"}</small>
                </button>
                <button
                  type="button"
                  className="tool-download-close"
                  aria-label="Close downloads"
                  onClick={() => setDownloadOpen(false)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </header>

            <p className="tool-download-rail">
              Select a cartridge to save · {objectName ?? "current field"}
            </p>

            <ul className="tool-download-bays">
              {downloadExports.map((item) => {
                const tag = downloadFormatTag(item.filename);
                const body = (
                  <>
                    <i className="tool-download-bay-led" aria-hidden="true">
                      <DownloadIcon kind={item.kind} />
                    </i>
                    <span className="tool-download-bay-copy">
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <span className="tool-download-bay-meta">
                      <span className="tool-download-bay-tag">{tag}</span>
                      <span className="tool-download-bay-go" aria-hidden="true">
                        ↓
                      </span>
                    </span>
                  </>
                );
                if (item.text) {
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        className="tool-download-bay"
                        onClick={() =>
                          downloadTextFile(item.filename, item.text!.body, item.text!.mime)
                        }
                      >
                        {body}
                      </button>
                    </li>
                  );
                }
                if (item.viaBlob && item.href) {
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        className="tool-download-bay"
                        onClick={() => {
                          void triggerBlobDownload(item.href!, item.filename).catch((err) => {
                            setStatus(err instanceof Error ? err.message : "Download failed");
                            setStatusErr(true);
                          });
                        }}
                      >
                        {body}
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={item.key}>
                    <a className="tool-download-bay" href={item.href} download={item.filename}>
                      {body}
                    </a>
                  </li>
                );
              })}
              {!spectrumData?.points.length ? (
                <li className="tool-download-hint">
                  Click a pixel on the sky image to unlock a spectrum CSV cartridge.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}

      {spectrumOpen && spectrumModal?.html ? (
        <div
          className="tool-spectrum-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Spectrum fullscreen"
        >
          <button
            type="button"
            className="tool-spectrum-modal-scrim"
            aria-label="Close spectrum"
            onClick={() => {
              setSpectrumOpen(false);
              setSpectrumPick(null);
            }}
          />
          <div className="tool-spectrum-modal-stage">
            <header className="tool-spectrum-modal-bar">
              <div className="tool-dash-plate">
                <i className="tool-dash-led is-live" aria-hidden="true" />
                <div>
                  <p className="tool-side-label">Spectrum bay</p>
                  <h2>Flux vs wavelength</h2>
                </div>
              </div>
              <button
                type="button"
                className="tool-spectrum-modal-close"
                aria-label="Close spectrum"
                onClick={() => {
                  setSpectrumOpen(false);
                  setSpectrumPick(null);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <p className="tool-spectrum-rail">
              Click a point for details · stacked points cycle or pick from the list
            </p>
            <div className="tool-spectrum-modal-frame">
              <SpectrumChartView
                html={spectrumModal.html}
                hits={spectrumModal.hits}
                pick={spectrumPick}
                onPick={setSpectrumPick}
                modal
                interactive
              />
            </div>
            <div
              className="tool-spectrum-meta tool-spectrum-modal-meta"
              dangerouslySetInnerHTML={{ __html: spectrumNote }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
