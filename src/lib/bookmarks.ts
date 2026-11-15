import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookmark } from "@/db/schema";

/** What the browser sends/receives. Ids are UUIDs; coordinates are degrees. */
export type BookmarkDTO = {
  id: string;
  label: string;
  ra: number;
  dec: number;
  fov: number;
  kind: string;
  note: string | null;
  createdAt: string;
};

export const MAX_BOOKMARKS_PER_USER = 200;

function toDTO(row: typeof bookmark.$inferSelect): BookmarkDTO {
  return {
    id: row.id,
    label: row.label,
    ra: row.ra,
    dec: row.dec,
    fov: row.fov,
    kind: row.kind,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Validate an untrusted create payload. Returns the clean values or an error message. */
export function parseBookmarkInput(
  body: unknown,
): { ok: true; value: Omit<BookmarkDTO, "id" | "createdAt"> } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON object" };
  const b = body as Record<string, unknown>;
  const ra = Number(b.ra);
  const dec = Number(b.dec);
  const fov = b.fov == null ? 0.12 : Number(b.fov);
  if (!Number.isFinite(ra) || ra < 0 || ra >= 360) return { ok: false, error: "ra must be in [0, 360)" };
  if (!Number.isFinite(dec) || dec < -90 || dec > 90) return { ok: false, error: "dec must be in [-90, 90]" };
  if (!Number.isFinite(fov) || fov <= 0 || fov > 10) return { ok: false, error: "fov must be in (0, 10]" };
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 120) : "";
  const kind = typeof b.kind === "string" && /^[a-z]{1,20}$/.test(b.kind) ? b.kind : "target";
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 1000) : null;
  return {
    ok: true,
    value: {
      label: label || `${ra.toFixed(4)}, ${dec >= 0 ? "+" : ""}${dec.toFixed(4)}`,
      ra,
      dec,
      fov,
      kind,
      note,
    },
  };
}

export async function listBookmarks(userId: string): Promise<BookmarkDTO[]> {
  const rows = await db
    .select()
    .from(bookmark)
    .where(eq(bookmark.userId, userId))
    .orderBy(desc(bookmark.createdAt))
    .limit(MAX_BOOKMARKS_PER_USER);
  return rows.map(toDTO);
}

export async function countBookmarks(userId: string): Promise<number> {
  return db.$count(bookmark, eq(bookmark.userId, userId));
}

export async function createBookmark(
  userId: string,
  value: Omit<BookmarkDTO, "id" | "createdAt">,
): Promise<BookmarkDTO> {
  const [row] = await db
    .insert(bookmark)
    .values({ userId, ...value })
    .returning();
  return toDTO(row);
}

/** Deletes only if the bookmark belongs to this user. Returns whether a row was removed. */
export async function deleteBookmark(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(bookmark)
    .where(and(eq(bookmark.id, id), eq(bookmark.userId, userId)))
    .returning({ id: bookmark.id });
  return rows.length > 0;
}
