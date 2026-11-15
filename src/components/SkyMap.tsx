"use client";

import dynamic from "next/dynamic";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SPHEREX_API, spherexFetch, type SpherexConfig } from "@/lib/spherexApi";
import {
  SkyMapMenu,
  SkyMapPointPanel,
  prefetchPoint,
  type InspectTab,
  type MenuAction,
  type SkyPoint,
  type SourceMark,
} from "@/components/SkyMapInspect";
import {
  KnownOverlay,
  bodyKind,
  markText,
  mjdYear,
  separationArcsec,
  starAt,
  type KnownCell,
  type KnownMark,
} from "@/components/SkyMapKnown";
import { FindsPanel, useFinds, type Find } from "@/components/SkyMapFinds";

const SkyGlobe = dynamic(() => import("@/components/SkyGlobe"), { ssr: false });

/** Viewport angular height (degrees). Zoom is continuous between these. */
const FOV_MIN = 0.1;
const FOV_MAX = 2.4;
const FOV_START = 0.6;
/**
 * One photo per sky cell at every zoom level. IRSA cutout time is mostly fixed
 * overhead, so a few large cells load faster than many small ones.
 */
const TILE_DEG = 1.0;
const MAX_CELLS = 24;
/** HTTP/1.1 connections the browser opens per origin. */
const BROWSER_CONNECTIONS = 6;
/**
 * Parallel sharp-tile downloads, visible cells only, nearest first. The other 2 connections
 * stay free for previews, which would otherwise queue behind multi-second tile builds.
 */
const CONCURRENCY = 4;
/** Low-resolution HiPS previews: ~1 s each, shown under a cell until its sharp tile lands. */
const PREVIEW_CONCURRENCY = 2;
/**
 * Previews (only previews: a sharp tile costs megabytes) load for every cell whose center lies
 * within this radius of the view center, nearest first, so panning always lands on sky.
 */
const PREFETCH_RADIUS_DEG = 5 * TILE_DEG;
/** Wait this long after the view stops changing before requesting tiles. */
const SETTLE_MS = 180;
/** Wait this long after the view stops changing before rewriting the URL. */
const URL_SYNC_MS = 400;
/** Loaded tiles stay mounted this far outside the viewport so panning back never remounts them. */
const KEEP_DEG = 2 * TILE_DEG;
const KEEP_CELLS = 120;
/** Matches the `sky-map-tile-in` animation in globals.css. */
const FADE_MS = 300;
/** Right-click menu footprint (`.sky-map-menu`), used to keep it inside the stage. */
const MENU_W = 214;
const MENU_H = 190;
const TILE_VERSION = "9";
/** Blink speed: each visit stays on screen this long. */
const BLINK_MS = 650;
/** Known movers are looked up per cell; wider views would ask for too many cells at once. */
const KNOWN_MAX_FOV = 1.2;
const KNOWN_CONCURRENCY = 2;
/** Names next to known movers only when zoomed in this far; otherwise they would pile up. */
const KNOWN_LABEL_FOV = 0.6;
/** Middle of the DR1 survey, for star positions on the all-dates mosaic. */
const DR1_MID_YEAR = 2025.85;
/** A flagged spot this close to a known mover is probably that mover (about two pixels). */
const KNOWN_MATCH_ARCSEC = 15;
/** SPHEREx pixel size, the map tiles' pixel scale. */
const PIXEL_ARCSEC = 6.15;
/** The API answers empty coverage with a 1×1 PNG. */
const GAP_BYTES = 200;

const BARNARD = { ra: 269.452077, dec: 4.693391 };

type View = { ra: number; dec: number; fov: number };

type Cell = { ra: number; dec: number; size: number };

type Target = { name: string; ra: number; dec: number };

/** URL parameter that re-creates the marked object on reload. */
type MarkParam = { key: "preset" | "target"; value: string };

/**
 * Which photos fill the map: the best mix of every visit, only each patch's first or last
 * survey visit, the two swapping back and forth (blink), or both overlaid in red and cyan.
 * Blink and red/cyan are the two ways to spot what moved.
 */
type TimeMode = "any" | "first" | "last" | "blink" | "compare";
type Epoch = "any" | "first" | "last";
type Visit = "first" | "last";

const TIME_EPOCHS: Record<TimeMode, Epoch[]> = {
  any: ["any"],
  first: ["first"],
  last: ["last"],
  blink: ["first", "last"],
  compare: ["first", "last"],
};

const TIME_OPTIONS: { id: TimeMode; label: string }[] = [
  { id: "any", label: "All photos" },
  { id: "first", label: "First visit" },
  { id: "last", label: "Last visit" },
  { id: "blink", label: "Blink" },
  { id: "compare", label: "Red/cyan" },
];

function isTimeMode(value: string | null): value is TimeMode {
  return TIME_OPTIONS.some((option) => option.id === value);
}

/** The visits whose photos are on screen right now. */
function visitsShown(mode: TimeMode, phase: Visit): Visit[] {
  if (mode === "first" || mode === "last") return [mode];
  if (mode === "blink") return [phase];
  if (mode === "compare") return ["first", "last"];
  return [];
}

type TileEntry =
  | { state: "loading" }
  /**
   * `dates` is "start/end" of the photos in a pass tile, "first|last" for a red/cyan one.
   * `mjd` is the exposure time of the photo filling most of a pass tile.
   */
  | { state: "ok"; url: string; fresh: boolean; dates?: string; mjd?: number }
  | { state: "gap" }
  | { state: "retry"; tries: number; at: number };

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function wrapRa(ra: number) {
  return ((ra % 360) + 360) % 360;
}

function wrapDelta(deg: number) {
  let d = deg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function cosDeg(dec: number) {
  return Math.max(0.2, Math.cos((dec * Math.PI) / 180));
}

/**
 * Same grid as `snap_map_cell` in spherex-blink-demo/app.py.
 * RA step shrinks by cos(dec) so neighboring cutouts stay square.
 */
function snapCell(ra: number, dec: number, size: number): Cell & { raStep: number } {
  const decS = clamp(Math.round(Math.round(dec / size) * size * 1e6) / 1e6, -89, 89);
  const raStep = size / Math.max(0.2, Math.abs(Math.cos((decS * Math.PI) / 180)));
  const raS = wrapRa(Math.round(Math.round(ra / raStep) * raStep * 1e6) / 1e6);
  return { ra: raS, dec: decS, size, raStep };
}

/** "RA Dec" or "RA, Dec" in decimal degrees; anything else is treated as an object name. */
function parseCoords(text: string): { ra: number; dec: number } | null {
  const m = text.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*[,\s]\s*([+-]?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const ra = Number(m[1]);
  const dec = Number(m[2]);
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) return null;
  return { ra, dec };
}

/** Absolute link to the map at a view, in the parameters the page reads on load. */
function mapLink(v: View, time: TimeMode = "any") {
  const params = new URLSearchParams({ ra: v.ra.toFixed(5), dec: v.dec.toFixed(5), fov: v.fov.toFixed(2) });
  if (time !== "any") params.set("time", time);
  return `${window.location.origin}/tool?${params.toString()}`;
}

/** Name -> position today (the API applies proper motion up to 2026). */
async function resolveName(text: string): Promise<Target> {
  const t = await spherexFetch<{ ra_2026: number; dec_2026: number; name?: string }>(
    `/api/resolve?name=${encodeURIComponent(text)}`,
  );
  return { name: t.name || text, ra: t.ra_2026, dec: t.dec_2026 };
}

function tileKey(cell: Cell) {
  return `${cell.ra.toFixed(6)}|${cell.dec.toFixed(6)}`;
}

/** Previews, pass tiles and red/cyan composites share the loader's maps under prefixed keys. */
function previewKey(cell: Cell) {
  return `p|${tileKey(cell)}`;
}

function isPreviewKey(key: string) {
  return key.startsWith("p|");
}

function sharpKey(cell: Cell, epoch: Epoch) {
  return epoch === "any" ? tileKey(cell) : `${epoch}|${tileKey(cell)}`;
}

function compareKey(cell: Cell) {
  return `c|${tileKey(cell)}`;
}

/** What a cell shows in this time mode; blink alternates between its two keys. */
function displayKeys(cell: Cell, mode: TimeMode): string[] {
  if (mode === "compare") return [compareKey(cell)];
  return TIME_EPOCHS[mode].map((epoch) => sharpKey(cell, epoch));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-08-15/2025-10-01" -> "15 Aug – 1 Oct 2025". */
function formatDates(span: string) {
  const day = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return { y, text: `${d} ${MONTHS[m - 1]}` };
  };
  const [start, end] = span.split("/");
  const a = day(start);
  const b = day(end ?? start);
  if (start === end || !end) return `${a.text} ${a.y}`;
  return a.y === b.y ? `${a.text} – ${b.text} ${b.y}` : `${a.text} ${a.y} – ${b.text} ${b.y}`;
}

/**
 * The known mover within KNOWN_MATCH_ARCSEC of `point` at either visit: a fast star where it
 * was at either exposure, or a body at any exposure looked up.
 */
function knownNear(data: KnownCell, point: SkyPoint, visits: (TileEntry | undefined)[]): KnownMark | null {
  const years = visits.flatMap((entry) => (entry?.state === "ok" && entry.mjd ? [mjdYear(entry.mjd)] : []));
  for (const star of data.stars) {
    const hit = (years.length ? years : [DR1_MID_YEAR]).some(
      (year) => separationArcsec(starAt(star, year), point) <= KNOWN_MATCH_ARCSEC,
    );
    if (hit) {
      const pm = Math.hypot(star.pmra, star.pmdec) / 1000;
      return { kind: "star", key: star.name, name: star.name, pm, g: star.g, at: star };
    }
  }
  for (const list of data.bodies) {
    for (const body of list.items) {
      if (separationArcsec(body, point) <= KNOWN_MATCH_ARCSEC) {
        return {
          kind: "body",
          key: body.name,
          name: body.name,
          label: bodyKind(body.kind),
          v: body.v,
          at: body,
          epoch: "first",
        };
      }
    }
  }
  return null;
}

/** Grey level at quantile `q` of a 256-bin histogram holding `total` pixels. */
function histQuantile(hist: Uint32Array, total: number, q: number) {
  let seen = 0;
  for (let v = 0; v < 256; v += 1) {
    seen += hist[v];
    if (seen >= total * q) return v;
  }
  return 255;
}

/**
 * First pass in red, last pass in cyan: still stars add up to white, a mover leaves a red
 * dot where it was and a cyan dot where it went. Each tile has its own brightness stretch,
 * so the last pass is rescaled to the first's background and star levels before mixing.
 * Pixels only one pass covers stay transparent.
 */
async function composeCompare(firstUrl: string, lastUrl: string): Promise<string | null> {
  const [a, b] = await Promise.all(
    [firstUrl, lastUrl].map(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img;
    }),
  );
  const w = a.naturalWidth;
  const h = a.naturalHeight;
  if (b.naturalWidth !== w || b.naturalHeight !== h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(a, 0, 0);
  const pa = ctx.getImageData(0, 0, w, h).data;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(b, 0, 0);
  const pb = ctx.getImageData(0, 0, w, h).data;

  const histA = new Uint32Array(256);
  const histB = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < pa.length; i += 4) {
    if (pa[i + 3] && pb[i + 3]) {
      histA[pa[i]] += 1;
      histB[pb[i]] += 1;
      total += 1;
    }
  }
  if (!total) return null;
  const medA = histQuantile(histA, total, 0.5);
  const medB = histQuantile(histB, total, 0.5);
  const gain = (histQuantile(histA, total, 0.995) - medA) / Math.max(1, histQuantile(histB, total, 0.995) - medB);

  const out = ctx.createImageData(w, h);
  const po = out.data;
  for (let i = 0; i < pa.length; i += 4) {
    if (!pa[i + 3] || !pb[i + 3]) continue;
    const later = clamp(Math.round(medA + (pb[i] - medB) * gain), 0, 255);
    po[i] = pa[i];
    po[i + 1] = later;
    po[i + 2] = later;
    po[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}

/**
 * A `size`-pixel square of a tile image around `point`, enlarged 3× with hard pixel edges,
 * as a PNG data URL. Tiles are north-up, east-left, PIXEL_ARCSEC per pixel, centered on the cell.
 */
async function cropThumb(src: string, cell: Cell, point: SkyPoint, size = 24): Promise<string | undefined> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const perDeg = 3600 / PIXEL_ARCSEC;
  const cx = (img.naturalWidth - 1) / 2 - wrapDelta(point.ra - cell.ra) * cosDeg(cell.dec) * perDeg;
  const cy = (img.naturalHeight - 1) / 2 - (point.dec - cell.dec) * perDeg;
  const canvas = document.createElement("canvas");
  canvas.width = size * 3;
  canvas.height = size * 3;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * Exposure times to look up Solar System bodies at for a cell, or null while a needed pass
 * tile is still loading. Blink asks for both visits at once so its swaps never refetch.
 */
function knownMjds(cell: Cell, mode: TimeMode, tileMap: ReadonlyMap<string, TileEntry>): number[] | null {
  if (mode === "any") return [];
  const out: number[] = [];
  for (const visit of mode === "first" || mode === "last" ? [mode] : (["first", "last"] as const)) {
    const entry = tileMap.get(sharpKey(cell, visit));
    if (entry?.state === "gap") continue;
    if (entry?.state !== "ok" || entry.mjd == null) return null;
    out.push(entry.mjd);
  }
  return out;
}

function knownKey(cell: Cell, mjds: number[]) {
  return `${tileKey(cell)}|${mjds.map((m) => m.toFixed(5)).join(",")}`;
}

function knownPath(cell: Cell, mjds: number[]) {
  const params = new URLSearchParams({
    ra: cell.ra.toFixed(6),
    dec: cell.dec.toFixed(6),
    size: cell.size.toFixed(6),
    mjd: mjds.map((m) => m.toFixed(5)).join(","),
  });
  return `/api/map/known?${params.toString()}`;
}

type LoadKind = "tile" | "preview";

function previewUrl(cell: Cell) {
  const params = new URLSearchParams({
    ra: cell.ra.toFixed(6),
    dec: cell.dec.toFixed(6),
    size: cell.size.toFixed(6),
    detector: "2",
  });
  return `${SPHEREX_API}/api/map/preview?${params.toString()}`;
}

function tileUrl(cell: Cell, epoch: Epoch) {
  const params = new URLSearchParams({
    ra: cell.ra.toFixed(6),
    dec: cell.dec.toFixed(6),
    size: cell.size.toFixed(6),
    detector: "2",
    // DR1 covers the whole sky; the quick releases (QR2/QR3) leave large holes.
    collection: "spherex_dr1",
    v: TILE_VERSION,
  });
  if (epoch !== "any") params.set("epoch", epoch);
  return `${SPHEREX_API}/api/map/tile?${params.toString()}`;
}

/**
 * Cells overlapping the viewport grown by `margin` degrees on each side,
 * nearest to the center first so it loads first.
 */
function cellsFor(view: View, aspect: number, margin = 0, limit = MAX_CELLS): Cell[] {
  const size = TILE_DEG;
  const halfH = view.fov / 2 + margin + size / 2;
  const halfW = (view.fov * aspect) / 2 + margin + size / 2;
  const centerRow = snapCell(view.ra, view.dec, size);
  const rows = Math.ceil(halfH / size);
  const seen = new Set<string>();
  const cells: (Cell & { dist: number })[] = [];
  for (let j = -rows; j <= rows; j += 1) {
    const rowDec = centerRow.dec + j * size;
    if (Math.abs(rowDec - view.dec) > halfH) continue;
    const anchor = snapCell(view.ra, rowDec, size);
    const cos = cosDeg(anchor.dec);
    const cols = Math.ceil(halfW / size) + 1;
    for (let i = -cols; i <= cols; i += 1) {
      const cell = snapCell(anchor.ra + i * anchor.raStep, anchor.dec, size);
      const dx = wrapDelta(cell.ra - view.ra) * cos;
      const dy = cell.dec - view.dec;
      if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) continue;
      const key = tileKey(cell);
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push({ ra: cell.ra, dec: cell.dec, size, dist: Math.hypot(dx, dy) });
    }
  }
  return cells
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map(({ ra, dec, size: s }) => ({ ra, dec, size: s }));
}

/** Cells whose centers lie within `radius` degrees of the view center, nearest first. */
function cellsAround(view: View, radius: number): Cell[] {
  return cellsFor({ ...view, fov: 0 }, 1, radius, Infinity).filter(
    (cell) =>
      Math.hypot(wrapDelta(cell.ra - view.ra) * cosDeg(cell.dec), cell.dec - view.dec) <= radius + 1e-6,
  );
}

export type SkyMapTourState = {
  timeMode: TimeMode;
  showKnown: boolean;
  targetName: string | null;
  fov: number;
  ready: boolean;
  loading: boolean;
};

export type SkyMapTourApi = {
  goPreset: (key: string) => Promise<void>;
  goName: (name: string) => Promise<void>;
  setTimeMode: (mode: TimeMode) => void;
  setShowKnown: (on: boolean) => void;
  zoomIn: () => void;
  getState: () => SkyMapTourState;
  ready: boolean;
  loading: boolean;
};

export default function SkyMap({
  onTourApi,
  onRequestTour,
}: {
  onTourApi?: (api: SkyMapTourApi) => void;
  onRequestTour?: () => void;
} = {}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; view: View } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [stage, setStage] = useState({ w: 1, h: 1 });

  const tiles = useRef(new Map<string, TileEntry>());
  const inflight = useRef(new Map<string, AbortController>());
  const wanted = useRef<{ visible: Cell[]; prefetch: Cell[]; mode: TimeMode }>({
    visible: [],
    prefetch: [],
    mode: "any",
  });
  const retryTimer = useRef<number | null>(null);
  const pumpRef = useRef<() => void>(() => {});
  /** Render copy of `tiles`; the ref is the loader's working state. */
  const [tileView, setTileView] = useState<ReadonlyMap<string, TileEntry>>(() => new Map());
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [markParam, setMarkParam] = useState<MarkParam | null>(null);
  const [menu, setMenu] = useState<(SkyPoint & { x: number; y: number }) | null>(null);
  const [inspect, setInspect] = useState<(SkyPoint & { tab: InspectTab }) | null>(null);
  const [sourceMarks, setSourceMarks] = useState<SourceMark[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [timeMode, setTimeMode] = useState<TimeMode>("any");
  const [blinkPhase, setBlinkPhase] = useState<Visit>("first");
  const [showKnown, setShowKnown] = useState(true);
  /** Known movers per `tileKey|mjds`; the ref is the loader's working state. */
  const known = useRef(new Map<string, KnownCell | "loading" | "error">());
  const [knownView, setKnownView] = useState<ReadonlyMap<string, KnownCell | "loading" | "error">>(
    () => new Map(),
  );
  const { finds, add: addFind, remove: removeFind, setNote: setFindNote } = useFinds();
  const [findsOpen, setFindsOpen] = useState(false);

  useEffect(() => {
    if (timeMode !== "blink") return;
    const id = window.setInterval(() => setBlinkPhase((p) => (p === "first" ? "last" : "first")), BLINK_MS);
    return () => window.clearInterval(id);
  }, [timeMode]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  function goTo(hit: Target, mark: MarkParam | null) {
    setTarget(hit);
    setMarkParam(mark);
    setView((v) => ({ ra: wrapRa(hit.ra), dec: clamp(hit.dec, -85, 85), fov: v?.fov ?? FOV_START }));
  }

  function onMenuAction(action: MenuAction) {
    if (!menu) return;
    const point = { ra: menu.ra, dec: menu.dec };
    setMenu(null);
    if (action === "center") {
      setView((v) => (v ? { ...v, ra: point.ra, dec: clamp(point.dec, -85, 85) } : v));
    } else if (action === "share") {
      const link = mapLink({ ...point, fov: view?.fov ?? FOV_START }, timeMode);
      navigator.clipboard
        .writeText(link)
        .then(() => setNotice("Link copied: paste it anywhere to share this spot"))
        .catch(() => setNotice(link));
    } else if (action === "flag") {
      void flagSpot(point);
    } else {
      setSourceMarks([]);
      setFindsOpen(false);
      setInspect({ ...point, tab: action });
    }
  }

  const onGlobeNavigate = useCallback((ra: number, dec: number) => {
    setMenu(null);
    setView((v) => (v ? { ...v, ra: wrapRa(ra), dec: clamp(dec, -85, 85) } : v));
  }, []);

  const onInspectTab = useCallback((tab: InspectTab) => {
    setInspect((cur) => (cur ? { ...cur, tab } : cur));
  }, []);

  async function goName(text: string) {
    const q = text.trim();
    if (!q) throw new Error("Enter a name to search.");
    setQuery(q);
    setSearchError(null);
    const coords = parseCoords(q);
    if (coords) {
      goTo({ name: `${coords.ra.toFixed(3)}°, ${coords.dec.toFixed(3)}°`, ...coords }, null);
      return;
    }
    setSearching(true);
    try {
      const hit = await resolveName(q);
      goTo(hit, { key: "target", value: q });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Name resolve failed";
      setSearchError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setSearching(false);
    }
  }

  async function goPreset(key: string) {
    const cfg = await spherexFetch<SpherexConfig>("/api/config");
    const preset = cfg.presets[key];
    if (!preset) throw new Error(`Unknown preset “${key}”.`);
    setQuery(preset.name);
    setSearchError(null);
    const hit = await resolveName(preset.name).catch(() => ({
      name: preset.name,
      ra: preset.ra,
      dec: preset.dec,
    }));
    goTo(hit, { key: "preset", value: key });
  }

  async function onSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || searching) return;
    try {
      await goName(query);
    } catch {
      /* error already shown */
    }
  }

  /**
   * Start from the URL: `ra`/`dec`/`fov` set the view; `preset` (challenge targets) or
   * `target` (any name) mark an object, and center on it when the URL has no position.
   */
  useEffect(() => {
    let cancel = false;
    const q = new URLSearchParams(window.location.search);
    const num = (key: string) => {
      const s = q.get(key)?.trim();
      return s ? Number(s) : NaN;
    };
    const fovQ = num("fov");
    const fov = Number.isFinite(fovQ) ? clamp(fovQ, FOV_MIN, FOV_MAX) : FOV_START;
    const at = { ra: num("ra"), dec: num("dec") };
    const hasPosition = Number.isFinite(at.ra) && Number.isFinite(at.dec);
    const time = q.get("time");
    const open = (p: SkyPoint) => {
      if (cancel) return;
      if (isTimeMode(time)) setTimeMode(time);
      setView({ ra: wrapRa(p.ra), dec: clamp(p.dec, -85, 85), fov });
    };
    if (hasPosition) open(at);

    const presetKey = q.get("preset")?.trim() || null;
    const name = q.get("target")?.trim() || null;
    (async () => {
      const cfg = await spherexFetch<SpherexConfig>("/api/config").catch(() => null);
      const preset = presetKey ? cfg?.presets[presetKey] : undefined;
      const wanted = name ?? preset?.name;
      let mark: Target | null = null;
      if (wanted) {
        // The resolver moves high proper-motion stars to where they are now; the preset
        // table holds catalog positions, minutes of arc off for Barnard's Star.
        mark = await resolveName(wanted).catch(() =>
          preset ? { name: preset.name, ra: preset.ra, dec: preset.dec } : null,
        );
        if (cancel) return;
        if (mark) {
          setTarget(mark);
          setMarkParam(name ? { key: "target", value: name } : { key: "preset", value: presetKey! });
          if (name) setQuery(name);
        } else {
          setSearchError(`Could not find “${wanted}”`);
        }
      }
      if (!hasPosition) open(mark ?? cfg?.presets.barnard ?? BARNARD);
    })();
    return () => {
      cancel = true;
    };
  }, []);

  /** Mirror the view (and the marked object) into the URL so it can be shared or reloaded. */
  useEffect(() => {
    if (!view) return;
    const id = window.setTimeout(() => {
      const url = new URL(mapLink(view, timeMode), window.location.href);
      if (markParam) url.searchParams.set(markParam.key, markParam.value);
      const next = `${url.pathname}${url.search}${window.location.hash}`;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next !== current) window.history.replaceState(null, "", next);
    }, URL_SYNC_MS);
    return () => window.clearTimeout(id);
  }, [view, markParam, timeMode]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Zoom by `factor` keeping the sky under (mx, my) — offsets from the stage center — fixed. */
  const zoomAt = useCallback((factor: number, mx: number, my: number) => {
    setView((v) => {
      if (!v) return v;
      const el = stageRef.current;
      const h = el?.clientHeight || 1;
      const fov = clamp(v.fov * factor, FOV_MIN, FOV_MAX);
      const k = fov / v.fov;
      const pxPerDeg = h / v.fov;
      return {
        ra: wrapRa(v.ra - (mx / pxPerDeg / cosDeg(v.dec)) * (1 - k)),
        dec: clamp(v.dec - (my / pxPerDeg) * (1 - k), -85, 85),
        fov,
      };
    });
  }, []);

  const mapReady = Boolean(view) && !searching;
  useEffect(() => {
    onTourApi?.({
      goPreset,
      goName,
      setTimeMode,
      setShowKnown,
      zoomIn: () => zoomAt(1 / 1.5, 0, 0),
      getState: () => ({
        timeMode,
        showKnown,
        targetName: target?.name ?? null,
        fov: view?.fov ?? FOV_START,
        ready: mapReady,
        loading: searching,
      }),
      ready: mapReady,
      loading: searching,
    });
  }, [onTourApi, mapReady, searching, timeMode, showKnown, target, view?.fov]);


  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // The details panel and the menu scroll on their own instead of zooming the map.
      if (event.target instanceof Element && event.target.closest(".sky-map-info, .sky-map-menu, .sky-map-globe")) {
        return;
      }
      event.preventDefault();
      setMenu(null);
      const rect = el.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(
        Math.exp(clamp(delta, -120, 120) * 0.002),
        event.clientX - rect.left - rect.width / 2,
        event.clientY - rect.top - rect.height / 2,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /** Store a ready image under `key`; it fades in, then drops the fade class. */
  const publish = useCallback((key: string, url: string, dates?: string, mjd?: number) => {
    tiles.current.set(key, { state: "ok", url, fresh: true, dates, mjd });
    window.setTimeout(() => {
      const entry = tiles.current.get(key);
      if (entry?.state !== "ok" || !entry.fresh) return;
      tiles.current.set(key, { ...entry, fresh: false });
      setTileView(new Map(tiles.current));
    }, FADE_MS);
  }, []);

  /** Begin one tile or preview download; on finish, publish the tile map and pump again. */
  const start = useCallback((cell: Cell, kind: LoadKind, epoch: Epoch = "any") => {
    const key = kind === "preview" ? previewKey(cell) : sharpKey(cell, epoch);
    const prev = tiles.current.get(key);
    const tries = prev?.state === "retry" ? prev.tries : 0;
    const ctl = new AbortController();
    inflight.current.set(key, ctl);
    tiles.current.set(key, { state: "loading" });
    const url = kind === "preview" ? previewUrl(cell) : tileUrl(cell, epoch);
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (blob.size < GAP_BYTES) {
          tiles.current.set(key, { state: "gap" });
          return;
        }
        const url = URL.createObjectURL(blob);
        // Decode before mounting so the tile never paints as an empty box.
        const probe = new Image();
        probe.src = url;
        await probe.decode().catch(() => {});
        const mjd = Number(res.headers.get("X-Map-Mjd"));
        publish(key, url, res.headers.get("X-Map-Dates") ?? undefined, mjd > 0 ? mjd : undefined);
      })
      .catch(() => {
        if (ctl.signal.aborted) return;
        tiles.current.set(key, {
          state: "retry",
          tries: tries + 1,
          at: Date.now() + Math.min(30_000, 2500 * 2 ** tries),
        });
      })
      .finally(() => {
        if (ctl.signal.aborted) return;
        inflight.current.delete(key);
        setTileView(new Map(tiles.current));
        pumpRef.current();
      });
  }, [publish]);

  /** Mix a cell's first and last pass tiles into one red/cyan image, once both are in. */
  const compose = useCallback(
    (cell: Cell) => {
      const key = compareKey(cell);
      if (tiles.current.has(key)) return;
      const first = tiles.current.get(sharpKey(cell, "first"));
      const last = tiles.current.get(sharpKey(cell, "last"));
      if (first?.state === "gap" || last?.state === "gap") {
        if (first && last && first.state !== "loading" && last.state !== "loading") {
          tiles.current.set(key, { state: "gap" });
        }
        return;
      }
      if (first?.state !== "ok" || last?.state !== "ok") return;
      tiles.current.set(key, { state: "loading" });
      composeCompare(first.url, last.url)
        .catch(() => null)
        .then((url) => {
          if (tiles.current.get(key)?.state !== "loading") {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          if (url) publish(key, url, `${first.dates ?? ""}|${last.dates ?? ""}`);
          else tiles.current.set(key, { state: "gap" });
          setTileView(new Map(tiles.current));
        });
    },
    [publish],
  );

  const pump = useCallback(() => {
    const now = Date.now();
    const { visible, prefetch, mode } = wanted.current;
    const epochs = TIME_EPOCHS[mode];
    // A sharp tile that scrolls off screen is dropped here; the API still finishes and caches it.
    const wantKeys = new Set([
      ...visible.flatMap((cell) => epochs.map((epoch) => sharpKey(cell, epoch))),
      ...[...visible, ...prefetch].map(previewKey),
    ]);

    const drop = (key: string) => {
      inflight.current.get(key)?.abort();
      inflight.current.delete(key);
      tiles.current.delete(key);
    };
    for (const key of [...inflight.current.keys()]) {
      if (!wantKeys.has(key)) drop(key);
    }

    let nextRetry = Infinity;
    const needsLoad = (key: string) => {
      const entry = tiles.current.get(key);
      if (!entry) return true;
      if (entry.state !== "retry") return false;
      if (entry.at > now) {
        nextRetry = Math.min(nextRetry, entry.at);
        return false;
      }
      return true;
    };
    const sharpInflight = () => [...inflight.current.keys()].filter((key) => !isPreviewKey(key));

    const loadPreviews = (cells: Cell[], limit: number) => {
      for (const cell of cells) {
        if (inflight.current.size - sharpInflight().length >= limit) break;
        if (inflight.current.size >= BROWSER_CONNECTIONS) break;
        if (!needsLoad(previewKey(cell))) continue;
        start(cell, "preview");
      }
    };

    // Visible previews first: they are small and fast, and fill the view while the sharp
    // tiles take seconds. The prefetch circle then takes whatever connections are left.
    loadPreviews(visible, PREVIEW_CONCURRENCY);
    // Cell by cell, so in compare mode the center cell gets both of its passes first.
    sharp: for (const cell of visible) {
      for (const epoch of epochs) {
        if (sharpInflight().length >= CONCURRENCY) break sharp;
        if (needsLoad(sharpKey(cell, epoch))) start(cell, "tile", epoch);
      }
    }
    loadPreviews([...visible, ...prefetch], BROWSER_CONNECTIONS);
    if (mode === "compare") visible.forEach(compose);

    if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
    retryTimer.current = Number.isFinite(nextRetry)
      ? window.setTimeout(() => pumpRef.current(), Math.max(50, nextRetry - Date.now()))
      : null;
  }, [start, compose]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  useEffect(() => {
    const tileMap = tiles.current;
    const loads = inflight.current;
    return () => {
      if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
      for (const ctl of loads.values()) ctl.abort();
      for (const entry of tileMap.values()) {
        if (entry.state === "ok") URL.revokeObjectURL(entry.url);
      }
    };
  }, []);

  const aspect = stage.w / Math.max(1, stage.h);
  const cells = useMemo(() => (view ? cellsFor(view, aspect) : []), [view, aspect]);
  const around = useMemo(() => (view ? cellsAround(view, PREFETCH_RADIUS_DEG) : []), [view]);
  const ring = useMemo(() => {
    const shown = new Set(cells.map(tileKey));
    return around.filter((cell) => !shown.has(tileKey(cell)));
  }, [cells, around]);
  /**
   * Everything that may be drawn, in a fixed key order: React then never moves a tile node,
   * and a moved node would restart its fade-in and blink.
   */
  const drawn = useMemo(() => {
    if (!view) return [];
    const visible = new Set(cells.map(tileKey));
    const byKey = new Map<string, Cell>();
    for (const cell of [...cellsFor(view, aspect, KEEP_DEG, KEEP_CELLS), ...around]) {
      byKey.set(tileKey(cell), cell);
    }
    return [...byKey]
      .map(([key, cell]) => ({ cell, key, visible: visible.has(key) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }, [view, aspect, cells, around]);

  useEffect(() => {
    wanted.current = { visible: cells, prefetch: ring, mode: timeMode };
    // Only fetch where the view comes to rest, not every cell a drag or zoom sweeps past.
    const id = window.setTimeout(pump, SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [cells, ring, timeMode, pump]);

  const fov = view?.fov ?? FOV_START;
  const pxPerDeg = stage.h / fov;
  const tilePx = TILE_DEG * pxPerDeg;
  const cos = view ? cosDeg(view.dec) : 1;
  const pending = cells.filter((cell) =>
    displayKeys(cell, timeMode).some((key) => {
      const s = tileView.get(key)?.state;
      return s !== "ok" && s !== "gap";
    }),
  ).length;
  /** Visit dates ("start/end") of the cell nearest the view center, for the time controls. */
  const visitDates = (visit: Visit) => {
    const entry = cells[0] ? tileView.get(sharpKey(cells[0], visit)) : undefined;
    return entry?.state === "ok" && entry.dates ? formatDates(entry.dates) : null;
  };
  const timeNote =
    timeMode === "compare"
      ? `Red: ${visitDates("first") ?? "first visit"} · Cyan: ${visitDates("last") ?? "last visit"}`
      : timeMode === "first" || timeMode === "last"
        ? visitDates(timeMode) && `Photos from ${visitDates(timeMode)}`
        : null;

  const knownOn = showKnown && fov <= KNOWN_MAX_FOV;
  /** Visible cells whose known movers are loaded for the current mode. */
  const knownCells = useMemo(() => {
    if (!knownOn) return [];
    const out: { cell: Cell; data: KnownCell }[] = [];
    for (const cell of cells) {
      const mjds = knownMjds(cell, timeMode, tileView);
      const data = mjds && knownView.get(knownKey(cell, mjds));
      if (data && typeof data === "object") out.push({ cell, data });
    }
    return out;
  }, [knownOn, cells, timeMode, tileView, knownView]);
  const knownLoading =
    knownOn && cells.some((cell) => {
      const mjds = knownMjds(cell, timeMode, tileView);
      return !mjds || knownView.get(knownKey(cell, mjds)) === "loading";
    });
  const knownErrors = [...new Set(knownCells.flatMap((k) => k.data.errors))];

  useEffect(() => {
    if (!knownOn) return;
    let busy = [...known.current.values()].filter((v) => v === "loading").length;
    for (const cell of cells) {
      if (busy >= KNOWN_CONCURRENCY) break;
      const mjds = knownMjds(cell, timeMode, tileView);
      if (!mjds) continue;
      const key = knownKey(cell, mjds);
      if (known.current.has(key)) continue;
      known.current.set(key, "loading");
      busy += 1;
      spherexFetch<KnownCell>(knownPath(cell, mjds))
        .then((data) => known.current.set(key, data))
        .catch(() => known.current.set(key, "error"))
        .finally(() => setKnownView(new Map(known.current)));
    }
  }, [knownOn, cells, timeMode, tileView, knownView]);

  /**
   * Known movers where the photos on screen show them. Stars move with the visit being shown
   * (and draw their path in red/cyan); a body is only drawn inside the cell whose exposure
   * time it was computed for, since neighbouring cells can be days apart.
   */
  const knownMarks = useMemo(() => {
    const shown = visitsShown(timeMode, blinkPhase);
    const marks: KnownMark[] = [];
    const seen = new Set<string>();
    for (const { cell, data } of knownCells) {
      const mjdOf = (visit: Visit) => {
        const entry = tileView.get(sharpKey(cell, visit));
        return entry?.state === "ok" ? entry.mjd : undefined;
      };
      const yearOf = (visit: Visit) => {
        const mjd = mjdOf(visit);
        return mjd ? mjdYear(mjd) : DR1_MID_YEAR;
      };
      for (const star of data.stars) {
        if (seen.has(star.name)) continue;
        seen.add(star.name);
        const nowVisit = shown.length ? shown[shown.length - 1] : null;
        marks.push({
          kind: "star",
          key: star.name,
          name: star.name,
          pm: Math.hypot(star.pmra, star.pmdec) / 1000,
          g: star.g,
          at: starAt(star, nowVisit ? yearOf(nowVisit) : DR1_MID_YEAR),
          from: shown.length === 2 ? starAt(star, yearOf("first")) : undefined,
        });
      }
      for (const visit of shown) {
        const mjd = mjdOf(visit);
        const list = data.bodies.find((b) => mjd != null && Math.abs(b.mjd - mjd) < 1e-4);
        for (const body of list?.items ?? []) {
          const inside =
            Math.abs(body.dec - cell.dec) <= cell.size / 2 &&
            Math.abs(wrapDelta(body.ra - cell.ra)) * cosDeg(cell.dec) <= cell.size / 2;
          if (!inside) continue;
          marks.push({
            kind: "body",
            key: `${visit}|${body.name}`,
            name: body.name,
            label: bodyKind(body.kind),
            v: body.v,
            at: { ra: body.ra, dec: body.dec },
            epoch: visit,
          });
        }
      }
    }
    return marks;
  }, [knownCells, timeMode, blinkPhase, tileView]);

  const project = useCallback(
    (p: { ra: number; dec: number }): [number, number] => [
      stage.w / 2 - wrapDelta(p.ra - (view?.ra ?? 0)) * cos * pxPerDeg,
      stage.h / 2 - (p.dec - (view?.dec ?? 0)) * pxPerDeg,
    ],
    [stage, view, cos, pxPerDeg],
  );
  const knownInView = knownMarks.filter((mark) => {
    const [x, y] = project(mark.at);
    return x > -40 && y > -40 && x < stage.w + 40 && y < stage.h + 40;
  });

  /**
   * Save a spot as a possible mover: its visit dates, a red/cyan crop, and whether a known
   * star or asteroid sits on it (only answerable when known movers are loaded for that cell).
   */
  async function flagSpot(point: SkyPoint) {
    const snapped = snapCell(point.ra, point.dec, TILE_DEG);
    const cell: Cell = { ra: snapped.ra, dec: snapped.dec, size: TILE_DEG };
    const first = tiles.current.get(sharpKey(cell, "first"));
    const last = tiles.current.get(sharpKey(cell, "last"));
    let thumb: string | undefined;
    try {
      if (first?.state === "ok" && last?.state === "ok") {
        const mixed = await composeCompare(first.url, last.url);
        if (mixed) {
          thumb = await cropThumb(mixed, cell, point);
          URL.revokeObjectURL(mixed);
        }
      } else {
        const shown = displayKeys(cell, timeMode)
          .map((key) => tiles.current.get(key))
          .find((entry) => entry?.state === "ok");
        if (shown?.state === "ok") thumb = await cropThumb(shown.url, cell, point);
      }
    } catch {
      /* A find without a picture is still worth keeping. */
    }
    const checked = knownCells.find((k) => tileKey(k.cell) === tileKey(cell));
    const near = checked ? knownNear(checked.data, point, [first, last]) : null;
    addFind({
      ra: point.ra,
      dec: point.dec,
      fov,
      first: first?.state === "ok" ? first.dates : undefined,
      last: last?.state === "ok" ? last.dates : undefined,
      note: "",
      thumb,
      known: near ? markText(near) : checked ? "" : undefined,
    });
    setNotice(near ? `Saved. It looks like ${near.name}, which is already known` : "Saved to My finds");
  }

  function goToFind(find: Find) {
    setMenu(null);
    setTimeMode((mode) => (mode === "blink" ? mode : "compare"));
    setView((v) => ({ ra: find.ra, dec: clamp(find.dec, -85, 85), fov: Math.min(v?.fov ?? find.fov, 0.3) }));
  }

  return (
    <div
      ref={stageRef}
      className="sky-map" data-tour="map"
      role="application"
      aria-label="Sky map"
      tabIndex={0}
      onPointerDown={(event) => {
        setMenu(null);
        if (!view || event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* Pointer capture is optional; drag still tracks the pointer. */
        }
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        const ppd = stage.h / start.view.fov;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        setView({
          ra: wrapRa(start.view.ra + dx / ppd / cosDeg(start.view.dec)),
          dec: clamp(start.view.dec + dy / ppd, -85, 85),
          fov: start.view.fov,
        });
      }}
      onPointerUp={(event) => {
        if (drag.current?.id === event.pointerId) drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onContextMenu={(event) => {
        if (!view) return;
        if (event.target instanceof Element && event.target.closest(".sky-map-hud, .sky-map-info")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const point = {
          ra: wrapRa(view.ra - (x - stage.w / 2) / (cos * pxPerDeg)),
          dec: clamp(view.dec - (y - stage.h / 2) / pxPerDeg, -90, 90),
        };
        prefetchPoint(point);
        setMenu({
          x: Math.max(8, Math.min(x, stage.w - MENU_W - 8)),
          y: Math.max(8, Math.min(y, stage.h - MENU_H - 8)),
          ...point,
        });
      }}
    >
      {view
        ? drawn.map(({ cell, key, visible }) => {
            // Blink keeps both visits mounted and only flips which one is visible, so a
            // swap never waits for an image to decode.
            const keys = displayKeys(cell, timeMode);
            const shownKey = timeMode === "blink" ? sharpKey(cell, blinkPhase) : keys[0];
            const entry = tileView.get(shownKey);
            const preview = tileView.get(previewKey(cell));
            const sharp = entry?.state === "ok" ? entry : null;
            // The sharp tile hides the preview once it has faded in. Pass tiles can leave
            // parts of a cell uncovered, so there the preview stays underneath, dimmed: it
            // mixes every date and must not pass for one visit.
            const timed = timeMode !== "any";
            const under = preview?.state === "ok" && (timed || !sharp || sharp.fresh) ? preview : null;
            const previewClass = `sky-map-tile is-preview${timed ? " is-dim" : ""}${under?.fresh ? " is-fresh" : ""}`;
            if (!sharp && !under && (entry?.state === "gap" || !visible)) return null;
            // Sky images have RA increasing to the left (east-left, north-up).
            const x = -wrapDelta(cell.ra - view.ra) * cos * pxPerDeg;
            const y = -(cell.dec - view.dec) * pxPerDeg;
            // A cell spans 1/cos(its dec) in RA, drawn with the view's cos: rows then abut exactly.
            const width = (tilePx * cos) / cosDeg(cell.dec);
            const style = {
              left: stage.w / 2 + x - width / 2,
              top: stage.h / 2 + y - tilePx / 2,
              width,
              height: tilePx,
            };
            return (
              <Fragment key={key}>
                {under ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key="p"
                    className={previewClass}
                    src={under.url}
                    alt=""
                    draggable={false}
                    style={style}
                  />
                ) : null}
                {keys.map((k) => {
                  const layer = tileView.get(k);
                  if (layer?.state !== "ok") return null;
                  const hidden = k !== shownKey;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={k}
                      className={`sky-map-tile${layer.fresh ? " is-fresh" : ""}${hidden ? " is-hidden" : ""}`}
                      src={layer.url}
                      alt=""
                      draggable={false}
                      style={style}
                    />
                  );
                })}
                {sharp || under || entry?.state === "gap" ? null : (
                  <div key="t" className="sky-map-cell is-pending" style={style} aria-hidden="true" />
                )}
              </Fragment>
            );
          })
        : null}
      {view && target ? (
        <div
          className="sky-map-target"
          style={{
            left: stage.w / 2 - wrapDelta(target.ra - view.ra) * cos * pxPerDeg,
            top: stage.h / 2 - (target.dec - view.dec) * pxPerDeg,
          }}
          aria-hidden="true"
        >
          <span>{target.name}</span>
        </div>
      ) : null}
      {view && knownInView.length ? (
        <KnownOverlay marks={knownInView} project={project} labels={fov <= KNOWN_LABEL_FOV} />
      ) : null}
      {view
        ? finds.map((find) => {
            const [x, y] = project(find);
            if (x < -20 || y < -20 || x > stage.w + 20 || y > stage.h + 20) return null;
            return (
              <i
                key={find.id}
                className="sky-map-find"
                style={{ left: x, top: y }}
                title={find.note || "Your flagged spot"}
                aria-hidden="true"
              />
            );
          })
        : null}
      {view && inspect?.tab === "stars"
        ? sourceMarks.map((mark, i) => (
            <i
              key={`${mark.catalog}-${i}`}
              className={`sky-map-source is-${mark.catalog}`}
              style={{
                left: stage.w / 2 - wrapDelta(mark.ra - view.ra) * cos * pxPerDeg,
                top: stage.h / 2 - (mark.dec - view.dec) * pxPerDeg,
              }}
              aria-hidden="true"
            />
          ))
        : null}
      {view && inspect ? (
        <i
          className="sky-map-pin"
          style={{
            left: stage.w / 2 - wrapDelta(inspect.ra - view.ra) * cos * pxPerDeg,
            top: stage.h / 2 - (inspect.dec - view.dec) * pxPerDeg,
          }}
          aria-hidden="true"
        />
      ) : null}
      {view ? (
        <SkyGlobe ra={view.ra} dec={view.dec} fov={view.fov} target={target} onNavigate={onGlobeNavigate} />
      ) : null}
      {menu ? <SkyMapMenu x={menu.x} y={menu.y} point={menu} onAction={onMenuAction} /> : null}
      {inspect ? (
        <SkyMapPointPanel
          key={`${inspect.ra}|${inspect.dec}`}
          point={inspect}
          tab={inspect.tab}
          onTab={onInspectTab}
          onClose={() => setInspect(null)}
          onSources={setSourceMarks}
        />
      ) : null}
      {findsOpen ? (
        <FindsPanel
          finds={finds}
          onGo={goToFind}
          onRemove={removeFind}
          onNote={setFindNote}
          onClose={() => setFindsOpen(false)}
          onNotice={setNotice}
        />
      ) : null}
      <div className="sky-map-hud">
        <p className="sky-map-kicker">Sky map · SPHEREx</p>
        <form
          className="sky-map-search" data-tour="search"
          onSubmit={onSearch}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="M42, Vega, or 83.82 -5.39"
            aria-label="Object name or RA Dec in degrees"
            spellCheck={false}
          />
          <button type="submit" disabled={searching || !query.trim()}>
            {searching ? "…" : "Go"}
          </button>
        </form>
        {searchError ? <p className="sky-map-search-error">{searchError}</p> : null}
        <p>
          {view
            ? `RA ${view.ra.toFixed(3)}° · Dec ${view.dec.toFixed(3)}° · FOV ${fov.toFixed(2)}°`
            : "Pointing at Barnard's Star…"}
        </p>
        <p>
          {notice ??
            (pending > 0
              ? `Loading ${pending} photo${pending === 1 ? "" : "s"}…`
              : "Drag to move · scroll to zoom · right-click for details")}
        </p>
        <div className="sky-map-zoom" data-tour="zoom" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1 / 1.5, 0, 0)}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1.5, 0, 0)}>
            −
          </button>
          <div className="sky-map-tools">
            <button
              type="button"
              data-tour="known"
              aria-pressed={showKnown}
              className={showKnown ? "is-on" : undefined}
              title="Ring fast Gaia stars and known asteroids, so you can tell them from new finds"
              onClick={() => setShowKnown((on) => !on)}
            >
              Known movers
            </button>
            <button
              type="button"
              data-tour="finds"
              aria-expanded={findsOpen}
              className={findsOpen ? "is-on" : undefined}
              onClick={() => {
                setInspect(null);
                setFindsOpen((open) => !open);
              }}
            >
              My finds{finds.length ? ` (${finds.length})` : ""}
            </button>
          </div>
        </div>
        <div
          className="sky-map-time" data-tour="time"
          role="group"
          aria-label="Which photos to show"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {TIME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              data-tour={option.id === "blink" || option.id === "compare" ? `time-${option.id}` : undefined}
              aria-pressed={timeMode === option.id}
              className={timeMode === option.id ? "is-on" : undefined}
              onClick={() => setTimeMode(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {timeMode === "compare" ? (
          <p className="sky-map-time-help">
            White: still. <b className="is-red">Red</b> beside <b className="is-cyan">cyan</b>: it moved.
          </p>
        ) : null}
        {timeMode === "blink" ? (
          <p className="sky-map-time-help">
            Jumping dots moved. Now:{" "}
            <b className={blinkPhase === "first" ? "is-red" : "is-cyan"}>
              {blinkPhase === "first" ? "first" : "last"} visit
            </b>
            {visitDates(blinkPhase) ? `, ${visitDates(blinkPhase)}` : ""}
          </p>
        ) : null}
        {timeNote ? <p className="sky-map-time-note">{timeNote}</p> : null}
        {showKnown ? (
          <p className="sky-map-known-legend">
            {fov > KNOWN_MAX_FOV ? (
              "Zoom in to see known movers"
            ) : (
              <>
                <span className="is-star" aria-hidden="true" /> fast star
                <span className="is-body" aria-hidden="true" /> asteroid
                {knownLoading ? " · checking catalogs…" : ""}
                {knownErrors.length ? ` · ${knownErrors[0]}` : ""}
              </>
            )}
          </p>
        ) : null}
        <div className="sky-map-hud-links">
          <a
            data-tour="analyze"
            href={
              view
                ? `/data-analysis?ra=${view.ra.toFixed(5)}&dec=${view.dec.toFixed(5)}&mode=expert`
                : "/data-analysis?mode=expert"
            }
            onClick={() => {
              window.dispatchEvent(new CustomEvent("fp-tour-analyze"));
            }}
          >
            Data analysis
          </a>
          {onRequestTour ? (
            <button type="button" className="sky-map-tour-btn" onClick={onRequestTour}>
              Guided tour
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
