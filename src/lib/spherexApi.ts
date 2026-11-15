/** Shared client for the local SPHEREx blink FastAPI (`npm run spherex:api`). */

export const SPHEREX_API = "/spherex-api";

export type SpherexPreset = { name: string; ra: number; dec: number; fov: number };

export type DetectorBand = { id: number; label: string; lo: number; hi: number };

export type SpherexConfig = {
  collections: string[];
  default_collections: string[];
  max_frames: number;
  max_frames_cap: number;
  detectors: DetectorBand[];
  presets: Record<string, SpherexPreset>;
};

export type ContamFlagName =
  | "overflow"
  | "nonlinear"
  | "persist"
  | "outlier"
  | "source"
  | "ghost"
  | "ghost_ext"
  | "bloom"
  | "snowball"
  | "halo";

export type SpherexFrame = {
  png: string;
  date: string;
  detector: number;
  band: string;
  collection: string;
  obs_id: string;
  flagged: number;
  /** Fraction of cutout pixels with each SPHEREx FLAGS contamination bit. */
  flags?: Partial<Record<ContamFlagName, number>>;
};

export type SpherexEpoch = {
  png: string;
  start: string;
  end: string;
  n: number;
  target_px: [number, number];
};

export type SpherexDetector = { png: string; detector: number; n: number; band: string };

export type SpherexPhoto = {
  center_mjy_sr: number | null;
  peak_snr: number | null;
  flagged_mean: number;
  ir_character: string | null;
  summary: string;
};

export type SpherexTarget = {
  name: string;
  ra: number;
  dec: number;
  kind?: string | null;
  obj_type?: string | null;
  redshift?: number | null;
  resolver?: string | null;
  separation_arcsec?: number | null;
  /** Short prose blurb for the Object tab (Wikipedia / catalog). */
  description?: string | null;
};

/** Per-band bookkeeping for one load: frames in the archive → downloaded → usable at this spot. */
export type SpherexBandCoverage = {
  detector: number;
  found: number;
  downloaded: number;
  used: number;
};

/** Why a requested band has nothing on the stage, or null when it loaded. */
export function bandMissingReason(c: SpherexBandCoverage | undefined): string | null {
  if (!c || c.used > 0) return null;
  if (c.found === 0) return "SPHEREx hasn't observed this spot in this band yet (no frames in the released data).";
  if (c.downloaded === 0)
    return `IRSA has ${c.found} frame${c.found === 1 ? "" : "s"} here, but every download timed out. Press Load to retry.`;
  return "Its frames only catch this spot at a detector edge, so none were usable.";
}

export type SpherexResult = {
  target: SpherexTarget;
  photo?: SpherexPhoto;
  fov: number;
  npix: number;
  n_found: number;
  n_used: number;
  frames: SpherexFrame[];
  epochs: SpherexEpoch[];
  detectors: SpherexDetector[];
  /** Older backends omit this. */
  band_coverage?: SpherexBandCoverage[];
  /** Releases IRSA didn't answer for during this load (their survey passes are missing). */
  missing_releases?: string[];
  rgb: string | null;
  contam_bits?: ContamFlagName[];
};

export type SpectrumPoint = {
  wavelength_um: number;
  flux: number;
  detector: number;
  date: string;
};

export type SpectrumResult = {
  ra: number;
  dec: number;
  points: SpectrumPoint[];
  rejected: number;
};

/** A user click on the moving object in one survey pass (display pixels, origin top-left). */
export type TrackMark = { epoch: number; x: number; y: number };

export type MotionPrediction = {
  marks: {
    epoch: number;
    date: string;
    x: number;
    y: number;
    ra: number;
    dec: number;
    snr: number;
    refined: boolean;
  }[];
  /** mas/yr */
  pm_ra_cosdec: number;
  pm_dec: number;
  pm_err: number;
  speed_arcsec_yr: number;
  /** Direction of motion, degrees east of north. */
  position_angle: number;
  rms_arcsec: number;
  prediction: {
    date: string;
    ra: number;
    dec: number;
    x: number;
    y: number;
    in_view: boolean;
    sigma_arcsec: number;
    sigma_px: number;
  };
  /** Where the catalog proper motion puts the target at the same date, when known. */
  catalog: { ra: number; dec: number; separation_arcsec: number } | null;
  notes: string[];
};

/** A catalogued moving object in the field (Gaia star, the target, or a known asteroid). */
export type MoverCandidate = MotionPrediction & {
  id: number;
  name: string;
  /** Where the motion comes from, e.g. "Gaia DR3" or "SkyBoT + JPL Horizons". */
  source: string;
  kind: "star" | "asteroid";
  /** Human-readable speed ("10.39″/yr", "43″/hour"). */
  speed_label: string;
  /** SPHEREx shows a source at the catalog position in 2+ passes. */
  confirmed: boolean;
  seen_passes: number;
  /** Catalog motion across the loaded passes, in SPHEREx pixels. */
  shift_px: number;
  significance: number;
  snr: number;
  /** The loaded target. */
  is_target: boolean;
};

export type MoversResult = {
  candidates: MoverCandidate[];
  passes: number;
  notes: string[];
};

export class SpherexApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function spherexFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${SPHEREX_API}${path}`, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string | { msg?: string }[] }).detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((d) => d.msg).filter(Boolean).join("; ")
          : res.statusText || "Request failed";
    throw new SpherexApiError(
      res.status,
      message || `Backend unreachable (${res.status}). Run: npm run spherex:api`,
    );
  }
  return res.json() as Promise<T>;
}

export function spherexPngUrl(job: string, name: string) {
  return `${SPHEREX_API}/api/job/${job}/png/${name}`;
}

export function spherexFitsZipUrl(job: string) {
  return `${SPHEREX_API}/api/job/${job}/fits.zip`;
}

/** Survey-pass difference. Default: single photo — change across every pass. */
export function spherexDiffUrl(job: string, a?: number, b?: number) {
  if (a != null && b != null) {
    return `${SPHEREX_API}/api/job/${job}/diff?a=${a}&b=${b}&mode=pair`;
  }
  return `${SPHEREX_API}/api/job/${job}/diff?mode=span`;
}

export function spherexBlinkGifUrl(job: string, durationMs = 500) {
  return `${SPHEREX_API}/api/job/${job}/blink.gif?duration_ms=${durationMs}`;
}

export const FALLBACK_DETECTORS: DetectorBand[] = [
  { id: 1, label: "D1", lo: 0.75, hi: 1.11 },
  { id: 2, label: "D2", lo: 1.11, hi: 1.63 },
  { id: 3, label: "D3", lo: 1.63, hi: 2.42 },
  { id: 4, label: "D4", lo: 2.42, hi: 3.82 },
  { id: 5, label: "D5", lo: 3.82, hi: 4.42 },
  { id: 6, label: "D6", lo: 4.42, hi: 5.0 },
];

export function detectorForWavelength(um: number, bands: DetectorBand[]) {
  if (!bands.length) return 1;
  const hit = bands.find((b) => um >= b.lo && um <= b.hi);
  if (hit) return hit.id;
  return bands.reduce((best, b) => {
    const mid = (b.lo + b.hi) / 2;
    const bestBand = bands.find((x) => x.id === best)!;
    const bestMid = (bestBand.lo + bestBand.hi) / 2;
    return Math.abs(mid - um) < Math.abs(bestMid - um) ? b.id : best;
  }, bands[0].id);
}

export function wavelengthForDetector(id: number, bands: DetectorBand[]) {
  const band = bands.find((b) => b.id === id);
  if (!band) return 2;
  return (band.lo + band.hi) / 2;
}

/** Image for a survey-pass visit, optionally tinted to one SPHEREx detector band. */
export function imageForVisitBand(
  result: SpherexResult,
  job: string,
  visit: number,
  detectorId: number,
): { src: string; label: string } | null {
  const epoch = result.epochs[visit];
  if (!epoch) return null;

  // Wavelength: prefer a frame from this survey pass at the selected detector.
  const inEpoch = result.frames.filter(
    (f) =>
      f.detector === detectorId &&
      f.date >= epoch.start &&
      f.date <= epoch.end,
  );
  if (inEpoch.length) {
    const mid = inEpoch[Math.floor(inEpoch.length / 2)];
    return {
      src: spherexPngUrl(job, mid.png),
      label: `Pass ${visit + 1} · ${epoch.start} · D${mid.detector}`,
    };
  }

  // Fallback: full pass stack (all detectors) — the main timestamp image.
  return {
    src: spherexPngUrl(job, epoch.png),
    label: `Pass ${visit + 1} · ${epoch.start} → ${epoch.end} · ${epoch.n} frames`,
  };
}
