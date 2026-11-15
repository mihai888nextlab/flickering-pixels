"use client";

/**
 * Known moving objects drawn over the sky map: fast Gaia stars and asteroids / comets.
 * A red/cyan pair that none of these explain is worth flagging.
 */

export type KnownStar = { name: string; ra: number; dec: number; pmra: number; pmdec: number; g: number };
export type KnownBody = { name: string; kind: string; ra: number; dec: number; v: number | null };
export type KnownCell = {
  ra: number;
  dec: number;
  /** Gaia DR3 positions at epoch 2016.0, proper motions in mas/yr (pmra includes cos dec). */
  stars: KnownStar[];
  /** Asteroids and comets at each exposure time asked for. */
  bodies: { mjd: number; items: KnownBody[]; complete: boolean }[];
  errors: string[];
};

type Sky = { ra: number; dec: number };

export type KnownMark =
  | {
      kind: "star";
      key: string;
      name: string;
      /** Total proper motion, arcsec per year. */
      pm: number;
      g: number;
      at: Sky;
      /** Where it was at the first visit, when both visits are on screen. */
      from?: Sky;
    }
  | { kind: "body"; key: string; name: string; label: string; v: number | null; at: Sky; epoch: "first" | "last" };

const GAIA_EPOCH = 2016.0;

export function mjdYear(mjd: number) {
  return 2000 + (mjd - 51544.5) / 365.25;
}

export function starAt(star: KnownStar, year: number): Sky {
  const dt = year - GAIA_EPOCH;
  const cos = Math.max(1e-6, Math.cos((star.dec * Math.PI) / 180));
  return { ra: star.ra + (star.pmra * dt) / 3.6e6 / cos, dec: star.dec + (star.pmdec * dt) / 3.6e6 };
}

/** Angular distance in arcseconds (flat-sky; only used within a few arcminutes). */
export function separationArcsec(a: Sky, b: Sky) {
  let dra = a.ra - b.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const cos = Math.cos((((a.dec + b.dec) / 2) * Math.PI) / 180);
  return Math.hypot(dra * cos, a.dec - b.dec) * 3600;
}

/** Map classes from SkyBoT ("MB>Inner", "NEA>Apollo", "Comet", …) in words. */
export function bodyKind(kind: string) {
  const k = kind.toLowerCase();
  if (k.startsWith("comet")) return "comet";
  if (k.startsWith("nea")) return "near-Earth asteroid";
  if (k.startsWith("trojan")) return "Jupiter trojan";
  if (k.startsWith("kbo") || k.startsWith("centaur")) return "distant icy body";
  return "asteroid";
}

/** What a known mark is, in one line, for tooltips and saved finds. */
export function markText(mark: KnownMark) {
  if (mark.kind === "star") return `${mark.name}, star moving ${mark.pm.toFixed(mark.pm < 1 ? 2 : 1)}″/yr`;
  return `${mark.name}, ${mark.label}${mark.v != null ? ` (mag ${mark.v})` : ""}`;
}

/**
 * Rings for fast stars (with a line from their first-visit position when both visits show)
 * and diamonds for Solar System bodies, red at the first visit and cyan at the last.
 */
export function KnownOverlay({
  marks,
  project,
  labels,
}: {
  marks: KnownMark[];
  project: (p: Sky) => [number, number];
  labels: boolean;
}) {
  return (
    <svg className="sky-map-known" aria-hidden="true">
      {marks.map((mark) => {
        const [x, y] = project(mark.at);
        if (mark.kind === "star") {
          const from = mark.from ? project(mark.from) : null;
          const moved = from && Math.hypot(from[0] - x, from[1] - y) > 2;
          return (
            <g key={mark.key} className="is-star">
              <title>{markText(mark)}</title>
              {moved ? <line x1={from[0]} y1={from[1]} x2={x} y2={y} /> : null}
              <circle cx={x} cy={y} r={11} />
              {labels && mark.pm >= 1 ? (
                <text x={x + 14} y={y + 4}>
                  Known star · {mark.pm.toFixed(1)}″/yr
                </text>
              ) : null}
            </g>
          );
        }
        return (
          <g key={mark.key} className={`is-body is-${mark.epoch}`}>
            <title>{markText(mark)}</title>
            <rect x={x - 6} y={y - 6} width={12} height={12} transform={`rotate(45 ${x} ${y})`} />
            {labels ? (
              <text x={x + 12} y={y + 4}>
                {mark.name}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
