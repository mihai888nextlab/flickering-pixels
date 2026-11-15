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

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

/** Angular distance in arcseconds (small-angle, fine for "is this the same spot?"). */
function sepArcsec(a: { ra: number; dec: number }, b: { ra: number; dec: number }) {
  let dRa = Math.abs(a.ra - b.ra);
  if (dRa > 180) dRa = 360 - dRa;
  const cos = Math.cos(((a.dec + b.dec) / 2) * (Math.PI / 180));
  return Math.hypot(dRa * cos, a.dec - b.dec) * 3600;
}

/** The signed-in user's saved sky positions (stored in Postgres via /api/bookmarks). */
export function useBookmarks() {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    call<{ bookmarks: Bookmark[] }>("/api/bookmarks")
      .then((r) => {
        if (!cancel) setItems(r.bookmarks);
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : "Couldn't load bookmarks");
      })
      .finally(() => {
        if (!cancel) setLoaded(true);
      });
    return () => {
      cancel = true;
    };
  }, []);

  const save = useCallback(async (input: NewBookmark) => {
    setError(null);
    try {
      const { bookmark } = await call<{ bookmark: Bookmark }>("/api/bookmarks", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setItems((list) => [bookmark, ...list]);
      return bookmark;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save bookmark");
      return null;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setError(null);
    let previous: Bookmark[] = [];
    setItems((list) => {
      previous = list;
      return list.filter((b) => b.id !== id);
    });
    try {
      await call<void>(`/api/bookmarks/${id}`, { method: "DELETE" });
    } catch (e) {
      setItems(previous); // put it back if the server refused
      setError(e instanceof Error ? e.message : "Couldn't delete bookmark");
    }
  }, []);

  /** An existing bookmark at (about) the same spot, within 2″. */
  const findNear = useCallback(
    (pos: { ra: number; dec: number }) => items.find((b) => sepArcsec(b, pos) < 2) ?? null,
    [items],
  );

  return { items, loaded, error, save, remove, findNear };
}
