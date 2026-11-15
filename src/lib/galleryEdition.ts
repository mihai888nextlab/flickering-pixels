import { promises as fs } from "fs";
import path from "path";
import {
  galleryPiecesForDay,
  type GalleryPieceSpec,
} from "@/lib/galleryDaily";
import { generateGalleryPoem } from "@/lib/galleryLlm";
import type {
  GalleryPhotoContext,
  GalleryPoemRequest,
} from "@/lib/galleryPoem";

export type GalleryEditionPoem = {
  poem: string;
  source: "groq" | "gemini" | "local";
  /** True once written from the real cutout / photometry. */
  fromPhoto: boolean;
  photoSummary?: string;
};

/** Shared daily metadata — same poems for every visitor of this UTC day. */
export type GalleryEdition = {
  day: string;
  version: 2;
  createdAt: string;
  poems: Record<string, GalleryEditionPoem>;
  pieces: GalleryPieceSpec[];
};

const CACHE_DIR = path.join(process.cwd(), ".data", "gallery-editions");
const inflightEdition = new Map<string, Promise<GalleryEdition>>();
const inflightEnrich = new Map<string, Promise<GalleryEditionPoem>>();

function editionPath(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Invalid gallery day");
  }
  return path.join(CACHE_DIR, `${day}.json`);
}

async function readEditionFile(day: string): Promise<GalleryEdition | null> {
  try {
    const raw = await fs.readFile(editionPath(day), "utf8");
    const parsed = JSON.parse(raw) as GalleryEdition & { version?: number };
    if (
      parsed?.day === day &&
      parsed.version === 2 &&
      parsed.poems &&
      Array.isArray(parsed.pieces) &&
      parsed.pieces.length === 5
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeEditionFile(edition: GalleryEdition) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(
    editionPath(edition.day),
    JSON.stringify(edition, null, 2),
    "utf8",
  );
}

function toPoemRequest(
  piece: GalleryPieceSpec,
  photo?: GalleryPhotoContext | null,
): GalleryPoemRequest {
  return {
    id: piece.id,
    title: piece.title,
    atlasName: piece.atlasName,
    form: piece.form,
    mode: piece.mode,
    ra: piece.ra,
    dec: piece.dec,
    fov: piece.fov,
    seed: piece.seed,
    day: piece.day,
    edition: piece.edition,
    photo: photo ?? null,
  };
}

/**
 * Create the day's edition shell (piece briefs). Poems stay provisional until
 * each cutout loads and `enrichEditionPoem` locks a photo-aware verse.
 */
export async function ensureGalleryEdition(day: string): Promise<GalleryEdition> {
  const existing = await readEditionFile(day);
  if (existing) return existing;

  const pending = inflightEdition.get(day);
  if (pending) return pending;

  const job = (async () => {
    const again = await readEditionFile(day);
    if (again) return again;

    const pieces = galleryPiecesForDay(day);
    const poems: Record<string, GalleryEditionPoem> = {};
    for (const piece of pieces) {
      poems[piece.id] = {
        poem: piece.blurb,
        source: "local",
        fromPhoto: false,
      };
    }

    const edition: GalleryEdition = {
      day,
      version: 2,
      createdAt: new Date().toISOString(),
      poems,
      pieces,
    };

    try {
      await writeEditionFile(edition);
    } catch {
      // ignore read-only FS
    }
    return edition;
  })();

  inflightEdition.set(day, job);
  try {
    return await job;
  } finally {
    inflightEdition.delete(day);
  }
}

/**
 * Lock a poem for a piece using the real cutout photometry / look.
 * First successful enrich wins for the whole day (shared for everyone).
 */
export async function enrichEditionPoem(
  day: string,
  pieceId: string,
  photo: GalleryPhotoContext,
): Promise<GalleryEditionPoem> {
  const edition = await ensureGalleryEdition(day);
  const current = edition.poems[pieceId];
  if (current?.fromPhoto && current.poem) return current;

  const piece = edition.pieces.find((p) => p.id === pieceId);
  if (!piece) throw new Error("Unknown gallery piece for this day");

  const enrichKey = `${day}::${pieceId}`;
  const pending = inflightEnrich.get(enrichKey);
  if (pending) return pending;

  const job = (async () => {
    // Re-read in case another request finished while we waited for the lock.
    const latest = await ensureGalleryEdition(day);
    const again = latest.poems[pieceId];
    if (again?.fromPhoto && again.poem) return again;

    const generated = await generateGalleryPoem(toPoemRequest(piece, photo));
    const entry: GalleryEditionPoem = {
      poem: generated.poem,
      source: generated.source,
      fromPhoto: true,
      photoSummary: photo.summary ?? photo.irCharacter ?? photo.mediaLabel ?? undefined,
    };

    latest.poems[pieceId] = entry;
    const snap = latest.pieces.find((p) => p.id === pieceId);
    if (snap) snap.blurb = entry.poem;

    try {
      await writeEditionFile(latest);
    } catch {
      // keep memory
    }
    return entry;
  })();

  inflightEnrich.set(enrichKey, job);
  try {
    return await job;
  } finally {
    inflightEnrich.delete(enrichKey);
  }
}

export async function getEditionPoem(
  day: string,
  pieceId: string,
): Promise<GalleryEditionPoem | null> {
  const edition = await ensureGalleryEdition(day);
  return edition.poems[pieceId] ?? null;
}
