import { enrichEditionPoem } from "@/lib/galleryEdition";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!raw || typeof raw !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) {
    return Response.json({ error: "Invalid day" }, { status: 400 });
  }
  if (typeof d.pieceId !== "string") {
    return Response.json({ error: "Invalid pieceId" }, { status: 400 });
  }

  const photoIn =
    d.photo && typeof d.photo === "object"
      ? (d.photo as Record<string, unknown>)
      : {};

  try {
    const entry = await enrichEditionPoem(d.day, d.pieceId, {
      summary: typeof photoIn.summary === "string" ? photoIn.summary : null,
      irCharacter:
        typeof photoIn.irCharacter === "string" ? photoIn.irCharacter : null,
      mediaLabel: typeof d.mediaLabel === "string" ? d.mediaLabel : null,
      targetName: typeof d.targetName === "string" ? d.targetName : null,
      targetDescription:
        typeof d.targetDescription === "string" ? d.targetDescription : null,
      nFrames: typeof d.nFrames === "number" ? d.nFrames : null,
      nEpochs: typeof d.nEpochs === "number" ? d.nEpochs : null,
    });
    return Response.json({
      poem: entry.poem,
      source: entry.source,
      fromPhoto: entry.fromPhoto,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Enrich failed" },
      { status: 500 },
    );
  }
}
