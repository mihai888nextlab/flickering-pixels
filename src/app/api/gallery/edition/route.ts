import { ensureGalleryEdition } from "@/lib/galleryEdition";

export async function GET(request: Request) {
  const day = new URL(request.url).searchParams.get("day")?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json(
      { error: "Query ?day=YYYY-MM-DD (UTC) is required" },
      { status: 400 },
    );
  }

  try {
    const edition = await ensureGalleryEdition(day);
    return Response.json({
      day: edition.day,
      createdAt: edition.createdAt,
      poems: Object.fromEntries(
        Object.entries(edition.poems).map(([id, entry]) => [id, entry.poem]),
      ),
      sources: Object.fromEntries(
        Object.entries(edition.poems).map(([id, entry]) => [id, entry.source]),
      ),
      fromPhoto: Object.fromEntries(
        Object.entries(edition.poems).map(([id, entry]) => [
          id,
          !!entry.fromPhoto,
        ]),
      ),
      pieces: edition.pieces,
    });
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Edition unavailable",
      },
      { status: 500 },
    );
  }
}
