import {
  cleanPoemText,
  galleryPoemPrompt,
  poemLengthBrief,
  type GalleryPoemRequest,
} from "@/lib/galleryPoem";

function envKey(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  // Allow GROQ_API_KEY="…" forms in .env.local
  return raw.replace(/^["']|["']$/g, "").trim() || null;
}

/** Current Groq free-tier chat models (llama-3.1-8b-instant was retired). */
const GROQ_POEM_MODELS = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"] as const;

export async function poemFromGroq(
  facts: GalleryPoemRequest,
): Promise<string | null> {
  const key = envKey("GROQ_API_KEY");
  if (!key) return null;
  const length = poemLengthBrief(facts.seed);

  for (const model of GROQ_POEM_MODELS) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.95,
          max_tokens: length.maxTokens,
          seed: facts.seed >>> 0,
          messages: [
            {
              role: "system",
              content:
                "You are a poet for an infrared astronomy art gallery. Obey the requested LENGTH exactly. Reply with the poem only — no title, no preamble.",
            },
            { role: "user", content: galleryPoemPrompt(facts) },
          ],
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`[gallery-poem] Groq ${model} HTTP ${res.status}: ${errText.slice(0, 180)}`);
        continue;
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const cleaned = cleanPoemText(json.choices?.[0]?.message?.content ?? "", {
        minChars: length.minChars,
        maxChars: length.maxChars,
      });
      if (cleaned) return cleaned;
      console.warn(
        `[gallery-poem] Groq ${model} returned empty/unusable poem (${length.label})`,
      );
    } catch (err) {
      console.warn(`[gallery-poem] Groq ${model} failed`, err);
    }
  }
  return null;
}

export async function poemFromGemini(
  facts: GalleryPoemRequest,
): Promise<string | null> {
  const key = envKey("GEMINI_API_KEY");
  if (!key) return null;
  const length = poemLengthBrief(facts.seed);
  try {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent" +
      `?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: galleryPoemPrompt(facts) }] }],
        generationConfig: {
          temperature: 0.95,
          maxOutputTokens: length.maxTokens,
          seed: facts.seed >>> 0,
        },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();
    return cleanPoemText(text ?? "", {
      minChars: length.minChars,
      maxChars: length.maxChars,
    });
  } catch {
    return null;
  }
}

export async function generateGalleryPoem(
  facts: GalleryPoemRequest,
): Promise<{ poem: string; source: "groq" | "gemini" | "local" }> {
  const fromGroq = await poemFromGroq(facts);
  if (fromGroq) return { poem: fromGroq, source: "groq" };
  const fromGemini = await poemFromGemini(facts);
  if (fromGemini) return { poem: fromGemini, source: "gemini" };
  const { localGalleryPoem } = await import("@/lib/galleryPoem");
  return { poem: localGalleryPoem(facts), source: "local" };
}
