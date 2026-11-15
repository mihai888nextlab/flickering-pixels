"use client";

import { useEffect, useState, type ReactNode } from "react";
import { spherexFetch } from "@/lib/spherexApi";

export type SkyPoint = { ra: number; dec: number };

export type InspectTab = "object" | "stars" | "visits";

export type SourceMark = { ra: number; dec: number; catalog: "gaia" | "allwise" };

export type MenuAction = "object" | "center" | "flag" | "share";

/** Gaia / AllWISE cone radius for the Stars tab. */
export const SOURCE_RADIUS_DEG = 1 / 60;

const TABS: { id: InspectTab; label: string }[] = [
  { id: "object", label: "What's here" },
  { id: "stars", label: "Stars" },
  { id: "visits", label: "Visits" },
];

type PointInfo = {
  ra: number;
  dec: number;
  constellation: string;
  object: { name: string; kind?: string; obj_type?: string } | null;
  /** Wikipedia summary; null when there is no page. */
  description: string | null;
  error?: string;
};

type CatalogSource = { ra: number; dec: number; mag: number | null };

type Catalogs = { gaia: CatalogSource[]; allwise: CatalogSource[]; errors: string[] };

type Visits = {
  total: number;
  first: string | null;
  last: string | null;
  detectors: { detector: number }[];
  passes: { start: string; end: string; n: number }[];
};

type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; message: string };

/**
 * Shared by right-click prefetch and the panel, so opening a tab reuses the request the menu
 * already started. Failed requests drop out and are retried by the next caller.
 */
const requests = new Map<string, { promise: Promise<unknown>; data?: unknown }>();
const MAX_REQUESTS = 60;

function request(path: string) {
  const hit = requests.get(path);
  if (hit) return hit;
  const entry: { promise: Promise<unknown>; data?: unknown } = {
    promise: spherexFetch<unknown>(path).then(
      (data) => {
        entry.data = data;
        return data;
      },
      (err) => {
        requests.delete(path);
        throw err;
      },
    ),
  };
  entry.promise.catch(() => {});
  requests.set(path, entry);
  if (requests.size > MAX_REQUESTS) requests.delete(requests.keys().next().value!);
  return entry;
}

function pointPaths(point: SkyPoint) {
  const q = `ra=${point.ra.toFixed(6)}&dec=${point.dec.toFixed(6)}`;
  return {
    info: `/api/map/point?${q}`,
    stars: `/api/context/catalogs?${q}&radius_deg=${SOURCE_RADIUS_DEG.toFixed(5)}`,
    visits: `/api/map/visits?${q}`,
  };
}

/** Start every lookup for a point; a right-click usually means the user wants details next. */
export function prefetchPoint(point: SkyPoint) {
  for (const path of Object.values(pointPaths(point))) request(path);
}

/** GET `path` from the SPHEREx API; null path means "not requested yet". */
function useApi<T>(path: string | null): Load<T> | null {
  const [res, setRes] = useState<{ path: string; load: Load<T> } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancel = false;
    request(path).promise.then(
      (data) => {
        if (!cancel) setRes({ path, load: { state: "ok", data: data as T } });
      },
      (err) => {
        if (!cancel) {
          setRes({
            path,
            load: { state: "error", message: err instanceof Error ? err.message : "Request failed" },
          });
        }
      },
    );
    return () => {
      cancel = true;
    };
  }, [path]);
  if (!path) return null;
  if (res?.path === path) return res.load;
  const ready = requests.get(path)?.data;
  return ready === undefined ? { state: "loading" } : { state: "ok", data: ready as T };
}

export function coordsText(point: SkyPoint) {
  return `${point.ra.toFixed(5)} ${point.dec >= 0 ? "+" : ""}${point.dec.toFixed(5)}`;
}

/** Survey IDs like "2MASS J0729…" mean nothing to a newcomer. */
function isCatalogId(name: string) {
  return /^(wisea?|2mass|2masx|2cxo|cxo|rx|ztf|gaia|sdss|panstarrs|ulas|iras|galex)\b/i.test(name.trim());
}

function plainKind(kind: string | undefined) {
  if (!kind) return "Faint light source";
  const map: Record<string, string> = {
    "IR source": "Infrared glow",
    "Visual source": "Faint light source",
    "UV source": "Ultraviolet source",
    "Radio source": "Radio source",
    "X-ray source": "X-ray source",
    Other: "Faint light source",
    Unknown: "Faint light source",
  };
  return map[kind] ?? kind;
}

/** One-line meaning of an object type, for when Wikipedia has no page. */
const KIND_MEANING: Record<string, string> = {
  Galaxy: "a huge family of billions of stars, far beyond our own Milky Way",
  "Galaxy pair": "two galaxies close enough to pull on each other",
  "Galaxy group": "a small crowd of galaxies held together by gravity",
  "Galaxy cluster": "hundreds of galaxies held together by gravity",
  Quasar: "the blazing center of a distant galaxy, powered by a giant black hole",
  Star: "a star in our Milky Way",
  "Double star": "two stars that look close together in the sky",
  "Variable star": "a star whose brightness changes over time",
  "Star cluster": "a group of stars born together from the same cloud",
  "Stellar association": "a loose group of young stars born together",
  "Planetary nebula": "the glowing shell a dying Sun-like star throws off",
  Nebula: "a cloud of gas and dust in space",
  "H II region": "a glowing cloud where new stars are being born",
  "Supernova remnant": "the expanding wreckage of an exploded star",
  "Infrared glow": "something that shines mostly in infrared light, often warm dust",
};

function eyeHint(mag: number) {
  if (mag < 6) return "you could see it with your own eyes on a dark night";
  if (mag < 9) return "a pair of binoculars would show it";
  if (mag < 13) return "you would need a small telescope";
  return "only big telescopes can see it";
}

function monthYear(iso: string) {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function listText(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-meter">
      <span className="tool-meter-label">{label}</span>
      <output className="tool-meter-value" title={value}>
        {value}
      </output>
    </div>
  );
}

function Pending({ load, what }: { load: Load<unknown> | null; what: string }) {
  if (!load || load.state === "loading") return <p className="sky-map-info-note">Looking up {what}…</p>;
  if (load.state === "error") return <p className="sky-map-info-note is-error">{load.message}</p>;
  return null;
}

function Story({ children }: { children: ReactNode }) {
  return (
    <div className="tool-brief-lcd">
      <p>{children}</p>
    </div>
  );
}

/** 16px line icons drawn with currentColor, so they follow the menu's hover color. */
const MENU_ICONS: Record<MenuAction | "flicker", ReactNode> = {
  object: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.2v4M8 4.8v.01" />
    </>
  ),
  center: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
    </>
  ),
  flicker: <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" />,
  flag: <path d="M3.5 15V1.8M3.5 2.3h9l-2.2 3.2 2.2 3.2h-9" />,
  share: (
    <>
      <path d="M6.8 9.2a3 3 0 004.2 0l2.4-2.4a3 3 0 00-4.2-4.2l-.9.9" />
      <path d="M9.2 6.8a3 3 0 00-4.2 0L2.6 9.2a3 3 0 004.2 4.2l.9-.9" />
    </>
  ),
};

function MenuIcon({ name }: { name: keyof typeof MENU_ICONS }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {MENU_ICONS[name]}
    </svg>
  );
}

/** Right-click menu at stage coordinates (x, y). Stars and visits live in the panel's tabs. */
export function SkyMapMenu({
  x,
  y,
  point,
  onAction,
}: {
  x: number;
  y: number;
  point: SkyPoint;
  onAction: (action: MenuAction) => void;
}) {
  const item = (action: MenuAction, label: string) => (
    <button type="button" role="menuitem" onClick={() => onAction(action)}>
      <MenuIcon name={action} />
      {label}
    </button>
  );
  return (
    <div
      className="sky-map-menu"
      role="menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {item("object", "What's here?")}
      {item("center", "Center here")}
      <a role="menuitem" href={`/data-analysis?ra=${point.ra.toFixed(5)}&dec=${point.dec.toFixed(5)}&fov=0.12&mode=expert`}>
        <MenuIcon name="flicker" />
        Watch it flicker
      </a>
      {item("flag", "Flag as possible mover")}
      {item("share", "Share this spot")}
    </div>
  );
}

/** Plain-language details for one sky point, styled like the tool page's Object tab. */
export function SkyMapPointPanel({
  point,
  tab,
  onTab,
  onClose,
  onSources,
}: {
  point: SkyPoint;
  tab: InspectTab;
  onTab: (tab: InspectTab) => void;
  onClose: () => void;
  onSources: (marks: SourceMark[]) => void;
}) {
  const [seen, setSeen] = useState<ReadonlySet<InspectTab>>(() => new Set([tab]));
  if (!seen.has(tab)) setSeen(new Set([...seen, tab]));

  const paths = pointPaths(point);
  const info = useApi<PointInfo>(seen.has("object") ? paths.info : null);
  const catalogs = useApi<Catalogs>(seen.has("stars") ? paths.stars : null);
  const visits = useApi<Visits>(seen.has("visits") ? paths.visits : null);

  const catalogData = catalogs?.state === "ok" ? catalogs.data : null;
  useEffect(() => {
    if (!catalogData) return;
    onSources([
      ...catalogData.gaia.map((s) => ({ ra: s.ra, dec: s.dec, catalog: "gaia" as const })),
      ...catalogData.allwise.map((s) => ({ ra: s.ra, dec: s.dec, catalog: "allwise" as const })),
    ]);
  }, [catalogData, onSources]);

  const pointData = info?.state === "ok" ? info.data : null;
  const object = pointData?.object && !isCatalogId(pointData.object.name) ? pointData.object : null;
  const title = tab === "object" && pointData ? (object?.name ?? "Open sky") : "This spot";
  const loaded = (tab === "object" ? info : tab === "stars" ? catalogs : visits)?.state === "ok";

  const brightest = catalogData?.gaia
    .map((s) => s.mag)
    .filter((m): m is number => m != null)
    .sort((a, b) => a - b)[0];

  const visitData = visits?.state === "ok" ? visits.data : null;

  return (
    <section
      className="sky-map-info"
      aria-label="About this spot"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="sky-map-info-scroll" data-lenis-prevent>
        <header className="tool-dash-head">
          <div className="tool-dash-plate">
            <i className={loaded ? "tool-dash-led is-live" : "tool-dash-led"} aria-hidden="true" />
            <div>
              <p className="tool-side-label">Sky spot</p>
              <h2>{title}</h2>
            </div>
          </div>
          <button type="button" className="sky-map-info-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="tool-info-tabs" role="tablist" aria-label="About this spot">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "is-on" : undefined}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "object" ? (
          pointData ? (
            <div className="tool-object-stack">
              <div className="tool-meter-row">
                <Meter label="Type" value={object ? plainKind(object.kind) : "Open sky"} />
                <Meter label="Constellation" value={pointData.constellation} />
              </div>
              <Story>
                {object
                  ? (pointData.description ??
                    `${object.name} is ${
                      KIND_MEANING[plainKind(object.kind)] ?? `a ${plainKind(object.kind).toLowerCase()}`
                    }, in the constellation ${pointData.constellation}.`)
                  : `Nothing famous sits exactly here — just stars and faint galaxies in ${pointData.constellation}. Try the Stars tab to see what's around.`}
              </Story>
              {pointData.error ? <p className="sky-map-info-note is-error">{pointData.error}</p> : null}
            </div>
          ) : (
            <Pending load={info} what="this spot" />
          )
        ) : null}

        {tab === "stars" ? (
          catalogData ? (
            <div className="tool-object-stack">
              <div className="tool-meter-row">
                <Meter label="Stars" value={String(catalogData.gaia.length)} />
                <Meter label="Infrared glows" value={String(catalogData.allwise.length)} />
              </div>
              <Story>
                {catalogData.gaia.length
                  ? `In a tiny circle around this spot, about 1/30 the width of the full Moon, the Gaia space telescope counted ${catalogData.gaia.length} star${catalogData.gaia.length === 1 ? "" : "s"}.`
                  : "Gaia found no stars in the tiny circle around this spot."}{" "}
                {brightest != null
                  ? `The brightest one has magnitude ${brightest.toFixed(1)} (smaller numbers are brighter): ${eyeHint(brightest)}.`
                  : null}{" "}
                {catalogData.allwise.length
                  ? `WISE, an infrared telescope, also saw ${catalogData.allwise.length} warm glow${catalogData.allwise.length === 1 ? "" : "s"} here.`
                  : null}
              </Story>
              <p className="sky-map-info-note">
                <span className="sky-map-key is-gaia" /> stars &nbsp; <span className="sky-map-key is-allwise" />{" "}
                infrared glows are circled on the map.
              </p>
              {catalogData.errors.length ? (
                <p className="sky-map-info-note is-error">Some star data could not be loaded right now.</p>
              ) : null}
            </div>
          ) : (
            <Pending load={catalogs} what="stars" />
          )
        ) : null}

        {tab === "visits" ? (
          visitData ? (
            <div className="tool-object-stack">
              <div className="tool-meter-row">
                <Meter label="Photos" value={String(visitData.total)} />
                <Meter label="Sky sweeps" value={String(visitData.passes.length)} />
              </div>
              <Story>
                {visitData.total === 0
                  ? "SPHEREx has not photographed this spot yet."
                  : `SPHEREx photographed this spot ${visitData.total} times while sweeping the whole sky, in ${listText(
                      visitData.passes.map((p) => monthYear(p.start)),
                    )}. Each photo catches a different infrared color, light our eyes can't see, which is how SPHEREx builds a rainbow for every point in the sky.`}
              </Story>
              {visitData.passes.length > 1 ? (
                <p className="sky-map-info-note">
                  Comparing sweeps shows what moved or changed. Pick “Watch it flicker in the tool” from the
                  right-click menu to try it.
                </p>
              ) : null}
            </div>
          ) : (
            <Pending load={visits} what="SPHEREx photos" />
          )
        ) : null}
      </div>
    </section>
  );
}
