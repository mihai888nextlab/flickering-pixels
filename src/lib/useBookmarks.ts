"use client";

import { useCallback, useEffect, useState } from "react";

export type Bookmark = {
  id: string;
  label: string;
  ra: number;
  dec: number;
  fov: number;
  kind: string;
  note: string | null;
  createdAt: string;
};

export type NewBookmark = {
  label?: string;
  ra: number;
  dec: number;
  fov: number;
  kind?: "target" | "prediction" | "map";
  note?: string;
};

/** Bookmarks live in this browser only (no accounts). */
const STORAGE_KEY = "flickering-pixels:bookmarks";
const MAX_BOOKMARKS = 200;

function readStored(): Bookmark[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as Bookmark[]).filter((b) => b && typeof b.id === "string") : [];
  } catch {
    return [];
  }
}

function writeStored(list: Bookmark[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false; // private window, storage full or blocked
  }
}

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Same limits the old server API enforced. */
function checkInput(input: NewBookmark): string | null {
  const { ra, dec, fov } = input;
  if (!Number.isFinite(ra) || ra < 0 || ra >= 360) return "RA must be between 0 and 360°";
  if (!Number.isFinite(dec) || dec < -90 || dec > 90) return "Dec must be between -90 and 90°";
  if (!Number.isFinite(fov) || fov <= 0 || fov > 10) return "FOV must be between 0 and 10°";
  return null;
}

/** Angular distance in arcseconds (small-angle, fine for "is this the same spot?"). */
function sepArcsec(a: { ra: number; dec: number }, b: { ra: number; dec: number }) {
  let dRa = Math.abs(a.ra - b.ra);
  if (dRa > 180) dRa = 360 - dRa;
  const cos = Math.cos(((a.dec + b.dec) / 2) * (Math.PI / 180));
  return Math.hypot(dRa * cos, a.dec - b.dec) * 3600;
}

/** Saved sky positions, kept in this browser's localStorage. */
export function useBookmarks() {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // localStorage only exists in the browser: read it after mount, and follow other tabs.
    const sync = () => {
      setItems(readStored());
      setLoaded(true);
    };
    const id = window.setTimeout(sync, 0);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const save = useCallback(async (input: NewBookmark) => {
    setError(null);
    const problem = checkInput(input);
    if (problem) {
      setError(problem);
      return null;
    }
    const current = readStored();
    if (current.length >= MAX_BOOKMARKS) {
      setError(`You can keep up to ${MAX_BOOKMARKS} bookmarks. Delete some first.`);
      return null;
    }
    const bookmark: Bookmark = {
      id: newId(),
      label: (input.label || `${input.ra.toFixed(4)}, ${input.dec.toFixed(4)}`).slice(0, 120),
      ra: input.ra,
      dec: input.dec,
      fov: input.fov,
      kind: input.kind ?? "target",
      note: input.note?.slice(0, 1000) ?? null,
      createdAt: new Date().toISOString(),
    };
    const next = [bookmark, ...current];
    if (!writeStored(next)) {
      setError("This browser won't let the page save bookmarks (private window or storage blocked).");
      return null;
    }
    setItems(next);
    return bookmark;
  }, []);

  const remove = useCallback(async (id: string) => {
    setError(null);
    const next = readStored().filter((b) => b.id !== id);
    if (!writeStored(next)) {
      setError("Couldn't delete the bookmark: browser storage is blocked.");
      return;
    }
    setItems(next);
  }, []);

  /** An existing bookmark at (about) the same spot, within 2″. */
  const findNear = useCallback(
    (pos: { ra: number; dec: number }) => items.find((b) => sepArcsec(b, pos) < 2) ?? null,
    [items],
  );

  return { items, loaded, error, save, remove, findNear };
}
