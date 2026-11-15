import {
  composeGalleryPoem,
  type GalleryPoemFacts,
} from "@/lib/galleryDaily";

export type GalleryPhotoContext = {
  summary?: string | null;
  irCharacter?: string | null;
  mediaLabel?: string | null;
  targetName?: string | null;
  targetDescription?: string | null;
  nFrames?: number | null;
  nEpochs?: number | null;
};

export type GalleryPoemRequest = GalleryPoemFacts & {
  id: string;
  seed: number;
  day: string;
  edition: string;
  photo?: GalleryPhotoContext | null;
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function localGalleryPoem(facts: GalleryPoemRequest): string {
  return composeGalleryPoem(mulberry32(facts.seed ^ 0xa11ce), {
    title: facts.title,
    atlasName: facts.atlasName,
    form: facts.form,
    mode: facts.mode,
    ra: facts.ra,
    dec: facts.dec,
    fov: facts.fov,
  });
}

/** Seed-locked length brief so the day's five poems swing wild. */
export function poemLengthBrief(seed: number): {
  label: string;
  instruction: string;
  maxTokens: number;
  minChars: number;
  maxChars: number;
} {
  const roll = mulberry32(seed ^ 0x1eaf)();
  if (roll < 0.12) {
    return {
      label: "one-word",
      instruction:
        "LENGTH (mandatory): exactly ONE word. A single charged noun or verb. Nothing else — no punctuation beyond an optional period.",
      maxTokens: 16,
      minChars: 2,
      maxChars: 40,
    };
  }
  if (roll < 0.28) {
    return {
      label: "one-line",
      instruction:
        "LENGTH (mandatory): exactly ONE line — a single sentence or fragment. No line breaks. Hard cap: 600 characters.",
      maxTokens: 60,
      minChars: 8,
      maxChars: 600,
    };
  }
  if (roll < 0.48) {
    return {
      label: "tiny",
      instruction:
        "LENGTH (mandatory): 2–3 very short lines. Sparse. Leave air. Hard cap: 600 characters.",
      maxTokens: 90,
      minChars: 12,
      maxChars: 600,
    };
  }
  if (roll < 0.72) {
    return {
      label: "medium",
      instruction:
        "LENGTH (mandatory): about 4–6 lines of free verse. Compact but complete. Hard cap: 600 characters.",
      maxTokens: 180,
      minChars: 40,
      maxChars: 600,
    };
  }
  return {
    label: "long",
    instruction:
      "LENGTH (mandatory): a relatively LONG poem — roughly 8–13 lines (or one dense stanza). NEVER more than 13 lines, and NEVER more than 600 characters total including spaces and line breaks.",
    maxTokens: 220,
    minChars: 160,
    maxChars: 600,
  };
}

export function galleryPoemPrompt(facts: GalleryPoemRequest): string {
  const dec =
    (facts.dec >= 0 ? "+" : "") + facts.dec.toFixed(5) + "°";
  const photo = facts.photo;
  const length = poemLengthBrief(facts.seed);
  const photoLines = [
    photo?.summary ? `Photometry / look: ${photo.summary}` : null,
    photo?.irCharacter ? `Infrared character: ${photo.irCharacter}` : null,
    photo?.mediaLabel ? `Print: ${photo.mediaLabel}` : null,
    photo?.nEpochs != null && photo.nEpochs > 0
      ? `Visit passes in the reel: ${photo.nEpochs}`
      : null,
    photo?.nFrames != null ? `Frames used: ${photo.nFrames}` : null,
    photo?.targetName ? `Resolved neighbor: ${photo.targetName}` : null,
    photo?.targetDescription
      ? `About the field: ${photo.targetDescription.slice(0, 280)}`
      : null,
  ].filter(Boolean);

  return [
    "Write one original free-verse poem for an infrared sky gallery exhibit.",
    length.instruction,
    `Length mode for this exhibit: ${length.label}. Obey it strictly.`,
    "Absolute maximums: 600 characters (spaces and newlines count) AND 13 lines.",
    "The poem MUST feel born from THIS cutout’s appearance and infrared character — not generic space verse.",
    "Use the photo notes as sensory fuel (glow, dust, warmth, quiet, flicker). Do not dump them as a list.",
    "Make it handwritten and surprising — not a template, not labeled stanzas.",
    "Tone: intimate, lyrical, slightly melancholic.",
    "Do not start with craft labels like “Carved…”, “Hung…”, “Lifted…”.",
    "No title heading, no markdown, no quotes wrapping the whole poem, no preamble.",
    "Output the poem text only.",
    "",
    `Exhibit title: ${facts.title}`,
    `Near sky field: ${facts.atlasName}`,
    `Form: ${facts.form} · ${facts.mode.label}`,
    `Pointing: RA ${facts.ra.toFixed(5)}°, Dec ${dec}, FOV ${facts.fov.toFixed(2)}°`,
    `Edition: ${facts.edition} · day ${facts.day} UTC`,
    "",
    "What the plate actually shows:",
    ...(photoLines.length
      ? photoLines.map((l) => `- ${l}`)
      : ["- (no photometry yet — lean on title, field, and mode)"]),
  ].join("\n");
}

export function cleanPoemText(
  raw: string,
  bounds?: { minChars: number; maxChars: number },
): string | null {
  let text = raw.trim();
  if (!text) return null;
  text = text
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
  if (/as an ai|i cannot|i'm unable|language model/i.test(text)) return null;
  const minChars = bounds?.minChars ?? 1;
  const maxChars = Math.min(bounds?.maxChars ?? 600, 600);
  const maxLines = 13;
  if (text.length < minChars) return null;

  // Soft trim overlong output so it can still ship.
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const atLine = cut.lastIndexOf("\n");
    const atSpace = cut.lastIndexOf(" ");
    const pivot = Math.max(atLine, atSpace);
    text = (pivot > maxChars * 0.6 ? cut.slice(0, pivot) : cut).trim();
    if (text.length < minChars) return null;
  }

  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n").trim();
    if (text.length < minChars) return null;
  }
  return text;
}
