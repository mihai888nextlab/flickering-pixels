"use client";

import { useCallback, useSyncExternalStore } from "react";

/** A spot the user flagged as a possible moving object. Kept in this browser only. */
export type Find = {
  id: string;
  ra: number;
  dec: number;
  fov: number;
  /** Visit dates ("start/end") of the photos that showed it, when known. */
  first?: string;
  last?: string;
  savedAt: string;
  note: string;
  /** Small red/cyan crop around the spot (PNG data URL). */
  thumb?: string;
  /** Catalogued mover within a few arcseconds, "" if none, absent if not checked. */
  known?: string;
};

const STORAGE_KEY = "flickering-pixels.finds";
const EMPTY: Find[] = [];

/** Parsed list for the stored string, so every reader gets the same array until it changes. */
let cachedRaw: string | null = null;
let cached: Find[] = EMPTY;
/** Set when storage refuses writes (full or blocked); the list then lives in memory only. */
let memoryOnly = false;
const listeners = new Set<() => void>();

function snapshot(): Find[] {
  if (memoryOnly) return cached;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return cached;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      const list = raw ? JSON.parse(raw) : [];
      cached = Array.isArray(list) ? list : EMPTY;
    } catch {
      cached = EMPTY;
    }
  }
  return cached;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function write(list: Find[]) {
  const raw = JSON.stringify(list);
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    memoryOnly = true;
  }
  cachedRaw = raw;
  cached = list;
  listeners.forEach((listener) => listener());
}

export function useFinds() {
  const finds = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const update = useCallback((change: (list: Find[]) => Find[]) => write(change(snapshot())), []);
  return {
    finds,
    add: useCallback(
      (find: Omit<Find, "id" | "savedAt">) =>
        update((list) => [
          {
            ...find,
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            savedAt: new Date().toISOString(),
          },
          ...list,
        ]),
      [update],
    ),
    remove: useCallback((id: string) => update((list) => list.filter((f) => f.id !== id)), [update]),
    setNote: useCallback(
      (id: string, note: string) => update((list) => list.map((f) => (f.id === id ? { ...f, note } : f))),
      [update],
    ),
  };
}

/** Map link that opens a find in red/cyan, zoomed in on it. */
export function findLink(find: Find) {
  const params = new URLSearchParams({
    ra: find.ra.toFixed(5),
    dec: find.dec.toFixed(5),
    fov: Math.min(find.fov, 0.3).toFixed(2),
    time: "compare",
  });
  return `${window.location.origin}/tool?${params.toString()}`;
}

function knownText(find: Find) {
  if (find.known === undefined) return "Not checked against known movers";
  return find.known ? `Probably ${find.known}` : "No known star or asteroid here";
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(finds: Find[]) {
  const head = ["ra_deg", "dec_deg", "first_visit", "last_visit", "saved_at", "known_match", "note", "link"];
  const rows = finds.map((f) =>
    [
      f.ra.toFixed(6),
      f.dec.toFixed(6),
      f.first ?? "",
      f.last ?? "",
      f.savedAt,
      f.known ?? "",
      f.note,
      findLink(f),
    ].map(csvCell),
  );
  return [head, ...rows].map((r) => r.join(",")).join("\n");
}

export function FindsPanel({
  finds,
  onGo,
  onRemove,
  onNote,
  onClose,
  onNotice,
}: {
  finds: Find[];
  onGo: (find: Find) => void;
  onRemove: (id: string) => void;
  onNote: (id: string, note: string) => void;
  onClose: () => void;
  onNotice: (text: string) => void;
}) {
  const download = () => {
    const blob = new Blob([toCsv(finds)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "spherex-possible-movers.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  const copyLinks = () => {
    const text = finds.map((f) => `${f.ra.toFixed(5)} ${f.dec.toFixed(5)}  ${findLink(f)}`).join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => onNotice(`Copied ${finds.length} link${finds.length === 1 ? "" : "s"}`))
      .catch(() => onNotice("Could not copy; use Download CSV instead"));
  };

  return (
    <aside
      className="sky-map-finds"
      aria-label="My possible movers"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <header>
        <h2>My possible movers</h2>
        <button type="button" className="sky-map-info-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {finds.length === 0 ? (
        <p className="sky-map-finds-empty">
          Nothing flagged yet. In Red/cyan or Blink, right-click a red dot beside a cyan one and choose “Flag as
          mover”.
        </p>
      ) : (
        <ul data-lenis-prevent>
          {finds.map((f) => (
            <li key={f.id}>
              {f.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.thumb} alt="" width={64} height={64} />
              ) : (
                <span className="sky-map-finds-nothumb" />
              )}
              <div>
                <button type="button" className="sky-map-finds-go" onClick={() => onGo(f)}>
                  RA {f.ra.toFixed(4)}° · Dec {f.dec.toFixed(4)}°
                </button>
                <p className={f.known ? "is-known" : undefined}>{knownText(f)}</p>
                <input
                  type="text"
                  value={f.note}
                  placeholder="Add a note"
                  aria-label="Note"
                  onChange={(event) => onNote(f.id, event.target.value)}
                />
              </div>
              <button type="button" className="sky-map-finds-remove" aria-label="Remove" onClick={() => onRemove(f.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {finds.length ? (
        <footer>
          <button type="button" onClick={copyLinks}>
            Copy links
          </button>
          <button type="button" onClick={download}>
            Download CSV
          </button>
        </footer>
      ) : null}
    </aside>
  );
}
