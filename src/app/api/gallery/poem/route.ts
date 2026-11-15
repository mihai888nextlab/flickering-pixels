import { getEditionPoem } from "@/lib/galleryEdition";

/** @deprecated Prefer GET /api/gallery/edition?day= — kept for single-piece reads. */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!raw || typeof raw !== "object") {
    return Response.json({ error: "Invalid poem request" }, { status: 400 });
  }
  const d = raw as { id?: unknown; day?: unknown };
  if (typeof d.id !== "string" || typeof d.day !== "string") {
    return Response.json({ error: "Invalid poem request" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) {
    return Response.json({ error: "Invalid day" }, { status: 400 });
  }

  try {
    const entry = await getEditionPoem(d.day, d.id);
    if (!entry) {
      return Response.json({ error: "Poem not found" }, { status: 404 });
    }
    return Response.json({ poem: entry.poem, source: entry.source });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Poem unavailable" },
      { status: 500 },
    );
  }
}
