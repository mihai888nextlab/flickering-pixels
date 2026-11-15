/** Deterministic daily hall: 2 sculptures + 3 sky plates / blinks. */

export type GalleryForm = "sculpture" | "plate";

export type GalleryMode =
  | { kind: "rgb"; label: string }
  | { kind: "band"; detector: number; label: string }
  | { kind: "blink"; label: string };

export type GalleryPieceSpec = {
  id: string;
  day: string;
  slot: number;
  form: GalleryForm;
  title: string;
  blurb: string;
  edition: string;
  ra: number;
  dec: number;
  fov: number;
  mode: GalleryMode;
  atlasName: string;
  seed: number;
};

/** Fields with a fighting chance of SPHEREx QR coverage + visual interest. */
const SKY_ATLAS: { name: string; ra: number; dec: number }[] = [
  { name: "WISE 0855-0714", ra: 133.79513, dec: -7.24515 },
  { name: "Barnard's Star", ra: 269.45208, dec: 4.69339 },
  { name: "Epsilon Indi B", ra: 331.04384, dec: -56.78269 },
  { name: "RW Aurigae", ra: 76.95642, dec: 30.40142 },
  { name: "R Draconis", ra: 248.16738, dec: 66.75497 },
  { name: "Messier 31", ra: 10.68471, dec: 41.26875 },
  { name: "Messier 33", ra: 23.46204, dec: 30.66022 },
  { name: "Messier 51", ra: 202.46963, dec: 47.19517 },
  { name: "Messier 81", ra: 148.88822, dec: 69.06529 },
  { name: "Messier 82", ra: 148.96817, dec: 69.6797 },
  { name: "Messier 87", ra: 187.70593, dec: 12.39112 },
  { name: "Messier 101", ra: 210.80227, dec: 54.34895 },
  { name: "Messier 104", ra: 189.99763, dec: -11.62305 },
  { name: "Messier 1", ra: 83.63308, dec: 22.0145 },
  { name: "Messier 42", ra: 83.82208, dec: -5.39111 },
  { name: "Messier 45", ra: 56.75, dec: 24.1167 },
  { name: "Messier 8", ra: 270.90417, dec: -24.38667 },
  { name: "Messier 16", ra: 274.7, dec: -13.8067 },
  { name: "Messier 17", ra: 275.1958, dec: -16.1717 },
  { name: "Messier 20", ra: 270.6042, dec: -23.0183 },
  { name: "Messier 27", ra: 299.9014, dec: 22.7211 },
  { name: "Messier 57", ra: 283.3962, dec: 33.0292 },
  { name: "Messier 13", ra: 250.4218, dec: 36.4599 },
  { name: "Messier 3", ra: 205.5484, dec: 28.3772 },
  { name: "Messier 5", ra: 229.6384, dec: 2.081 },
  { name: "Messier 15", ra: 322.493, dec: 12.167 },
  { name: "Messier 30", ra: 325.0921, dec: -23.1791 },
  { name: "Messier 2", ra: 323.3626, dec: -0.8233 },
  { name: "IC 1101", ra: 227.614, dec: 4.765 },
  { name: "NGC 253", ra: 11.888, dec: -25.288 },
  { name: "NGC 891", ra: 35.6392, dec: 42.3492 },
  { name: "NGC 1300", ra: 49.9208, dec: -19.4111 },
  { name: "NGC 4565", ra: 189.0865, dec: 25.9877 },
  { name: "NGC 6946", ra: 308.7179, dec: 60.1539 },
  { name: "Centaurus A", ra: 201.3651, dec: -43.0191 },
  { name: "Fornax Cluster", ra: 54.6162, dec: -35.4505 },
  { name: "Coma Cluster", ra: 194.9531, dec: 27.9807 },
  { name: "Perseus Cluster", ra: 49.9507, dec: 41.5117 },
  { name: "Virgo Cluster", ra: 187.7059, dec: 12.3911 },
  { name: "LMC Core", ra: 80.8942, dec: -69.7561 },
  { name: "SMC", ra: 13.1866, dec: -72.8286 },
  { name: "Rho Ophiuchi", ra: 246.7042, dec: -24.395 },
  { name: "Taurus Molecular", ra: 68.98, dec: 26.38 },
  { name: "Orion B", ra: 86.55, dec: -0.15 },
  { name: "Cygnus X", ra: 307.5, dec: 41.0 },
  { name: "Galactic Center", ra: 266.4168, dec: -29.0078 },
  { name: "North Galactic Pole", ra: 192.8595, dec: 27.1283 },
  { name: "South Galactic Pole", ra: 12.8595, dec: -27.1283 },
  { name: "HDF North", ra: 189.2, dec: 62.216 },
  { name: "COSMOS Field", ra: 150.1192, dec: 2.2058 },
  { name: "ECDFS", ra: 53.15, dec: -27.8 },
  { name: "EGS", ra: 214.825, dec: 52.825 },
  { name: "UDS", ra: 34.5, dec: -5.2 },
  { name: "Lockman Hole", ra: 162.0, dec: 57.0 },
  { name: "Elias 2-27", ra: 70.775, dec: -34.175 },
  { name: "TW Hydrae", ra: 165.466, dec: -34.704 },
  { name: "HL Tauri", ra: 67.9108, dec: 18.2286 },
  { name: "AB Aurigae", ra: 73.941, dec: 30.551 },
  { name: "Vega Field", ra: 279.2347, dec: 38.7837 },
  { name: "Fomalhaut", ra: 344.4127, dec: -29.6222 },
  { name: "Beta Pictoris", ra: 86.8213, dec: -51.0665 },
];

const POETIC_ADJ = [
  "Lonely",
  "Devoted",
  "Unquiet",
  "Tender",
  "Fated",
  "Sleepless",
  "Gilded",
  "Ruinous",
  "Hushed",
  "Fevered",
  "Sacred",
  "Wayward",
  "Eternal",
  "Ashen",
  "Radiant",
  "Stolen",
  "Forbidden",
  "Luminous",
  "Wild",
  "Melancholy",
  "Ardent",
  "Spectral",
  "Bittersweet",
  "Celestial",
  "Wounded",
  "Opulent",
  "Silent",
  "Reckless",
  "Vesper",
  "Emberlit",
];

const POETIC_NOUN = [
  "Serenade",
  "Requiem",
  "Confession",
  "Waltz",
  "Elegy",
  "Vow",
  "Nocturne",
  "Rapture",
  "Lament",
  "Sonnet",
  "Pilgrimage",
  "Mirage",
  "Baptism",
  "Eclipse",
  "Inheritance",
  "Orchard",
  "Cathedral",
  "Fever",
  "Harbor",
  "Duel",
  "Promise",
  "Asylum",
  "Garden",
  "Reliquary",
  "Ballad",
  "Threshold",
  "Romance",
  "Threnody",
  "Covenant",
  "Afterglow",
];

const POETIC_OF = [
  "Infrared Roses",
  "Forgotten Moons",
  "Dust-Lit Lovers",
  "Winter Light",
  "Broken Orbits",
  "Copper Midnights",
  "Unnamed Stars",
  "Velvet Ruin",
  "Quiet Suns",
  "Glass Empires",
  "Slow Fire",
  "Pale Desire",
  "Hidden Choirs",
  "Astral Wine",
  "Sleeping Nebulae",
  "Ivory Silence",
  "Scarlet Wavelengths",
  "Distant Weddings",
  "Frozen Hymns",
  "Orphan Galaxies",
  "Silver Grief",
  "Honeyed Dark",
  "Phantom Solstice",
  "Lantern Constellations",
  "Midnight Orchids",
  "Burnished Skies",
  "Unsent Letters",
  "Last Warmth",
  "Sacred Static",
  "Endless Dusk",
];

const POETIC_LINES = [
  "Where the Light Learns Longing",
  "A Kiss Across Five Microns",
  "The Sky Remembers Your Name",
  "Love Letter to a Dying Star",
  "Tonight the Dust Begins to Sing",
  "For the One Who Left the Galaxy",
  "Softly, the Universe Aches",
  "In the Chapel of Cold Fire",
  "We Were Wavelengths Once",
  "An Opera Written in Embers",
  "When Capricorn Kept Our Secret",
  "The Last Warm Room in Space",
  "Do Not Wake the Infrared",
  "A Portrait of Almost Forever",
  "Between One Visit and the Next",
  "How Quietly a Sun Can Break",
  "The Romance of Empty Coordinates",
  "Still Burning for No One",
  "Map of a Heart That Drifted",
  "Hush — the Nebula Is Listening",
  "Ode to a Pixel That Trembled",
  "All Our Summers in One Band",
  "She Wore the Spectrum Like Silk",
  "A Duet with the Unseen Heat",
  "Prayer for the Unresolved Light",
  "The Night Invents Another Lover",
  "Come Closer, Faraway Fire",
  "What the Dark Kept Beautiful",
  "Sonata for Three Survey Passes",
  "I Found You in the Noise Floor",
];

function pickPoeticTitle(rand: () => number): string {
  const style = Math.floor(rand() * 5);
  const adj = POETIC_ADJ[Math.floor(rand() * POETIC_ADJ.length)];
  const noun = POETIC_NOUN[Math.floor(rand() * POETIC_NOUN.length)];
  const of = POETIC_OF[Math.floor(rand() * POETIC_OF.length)];
  if (style === 0) return POETIC_LINES[Math.floor(rand() * POETIC_LINES.length)];
  if (style === 1) return `${adj} ${noun}`;
  if (style === 2) return `${noun} of ${of}`;
  if (style === 3) return `The ${adj} ${noun}`;
  return `${adj} ${noun} of ${of}`;
}

function pickOne<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function skyBearing(ra: number, dec: number) {
  const hemisphere =
    dec > 28 ? "high northern dark" : dec > 8 ? "northern hush" : dec > -8 ? "equatorial quiet" : dec > -28 ? "southern hush" : "deep southern dark";
  // RA → rough seasonal sky mood (UTC poetic, not astronomy lesson).
  const season =
    ra < 45
      ? "winter’s first lanterns"
      : ra < 90
        ? "late-winter embers"
        : ra < 135
          ? "spring’s thin fire"
          : ra < 180
            ? "early-summer veils"
            : ra < 225
              ? "high-summer dust"
              : ra < 270
                ? "late-summer ash"
                : ra < 315
                  ? "autumn’s copper edge"
                  : "year-end starlight";
  return { hemisphere, season };
}

export type GalleryPoemFacts = {
  title: string;
  atlasName: string;
  form: GalleryForm;
  mode: GalleryMode;
  ra: number;
  dec: number;
  fov: number;
};

/**
 * Local fallback poem from sky facts + title —
 * seeded combinatorial verse used when no LLM key is configured.
 */
export function composeGalleryPoem(
  rand: () => number,
  piece: GalleryPoemFacts,
): string {
  const { hemisphere, season } = skyBearing(piece.ra, piece.dec);
  const field = piece.atlasName;
  const title = piece.title;
  const fovTone =
    piece.fov < 0.1
      ? "a whisper-wide window"
      : piece.fov < 0.14
        ? "a narrow chapel of sky"
        : "a wider porch of night";
  const craft =
    piece.form === "sculpture"
      ? pickOne(rand, [
          "Carved from infrared hush,",
          "Lifted into bas-relief,",
          "Pressed into cool metal memory,",
        ])
      : pickOne(rand, [
          "Hung as a blinking vigil,",
          "Pinned to the wall like a warm letter,",
          "Strung as a survey hymn,",
        ]);

  const lineA = pickOne(rand, [
    `${craft}\nnear ${field},\nin the ${hemisphere}.`,
    `${craft}\n${field} under ${season}.`,
    `Toward ${field},\nthrough ${fovTone},\nthe ${hemisphere} leans in.`,
  ]);

  const bandHint = piece.mode.kind === "band"
    ? (piece.mode.label.split("·")[1]?.trim() ?? "this band")
    : null;
  const modeLine =
    piece.mode.kind === "blink"
      ? pickOne(rand, [
          "Blink by blink, the visits argue softly.",
          "Each pass a different confession of heat.",
          "The reel remembers what a single night forgets.",
        ])
      : piece.mode.kind === "rgb"
        ? pickOne(rand, [
            "Three bands braid into one held breath.",
            "Color is only patience stacked on patience.",
          ])
        : pickOne(rand, [
            `${piece.mode.label} keeps the warmth the eye cannot.`,
            `In ${bandHint}, longing has a wavelength.`,
          ]);

  const lineB = pickOne(rand, [
    modeLine,
    `RA ${piece.ra.toFixed(2)}°, Dec ${piece.dec >= 0 ? "+" : ""}${piece.dec.toFixed(2)}°—\ncoordinates spoken like a vow.`,
    `${fovTone[0]!.toUpperCase()}${fovTone.slice(1)} on ${season}.`,
  ]);

  const lineC = pickOne(rand, [
    `They called it “${title}.”\nThe sky did not correct them.`,
    `“${title}”\nis only the name we borrowed\nfor what the dust already knew.`,
    `If you must title the ache,\nlet it be “${title}.”`,
    `Tomorrow the seed returns the same poem.\nTonight it still feels new:\n“${title}.”`,
  ]);

  return `${lineA}\n\n${lineB}\n\n${lineC}`;
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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

/** UTC calendar day key — the gallery edition flips with the date, not local midnight alone. */
export function galleryDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function shiftGalleryDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return galleryDayKey(dt);
}

export function formatGalleryDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function wrapRa(ra: number) {
  const x = ra % 360;
  return x < 0 ? x + 360 : x;
}

function clampDec(dec: number) {
  return Math.max(-85, Math.min(85, dec));
}

/**
 * Five art briefs for a UTC day: 2 sculptures + 3 blink plates.
 * Layout order is seeded-shuffled; same day → same mix everywhere.
 */
export function galleryPiecesForDay(day: string): GalleryPieceSpec[] {
  const root = hashString(`gallery::v5::${day}`);
  const used = new Set<number>();
  const pieces: GalleryPieceSpec[] = [];
  const forms: GalleryForm[] = ["sculpture", "sculpture", "plate", "plate", "plate"];
  const shuffleRand = mulberry32(root ^ 0xc0ffee);
  for (let i = forms.length - 1; i > 0; i -= 1) {
    const j = Math.floor(shuffleRand() * (i + 1));
    const tmp = forms[i];
    forms[i] = forms[j]!;
    forms[j] = tmp!;
  }

  let sculptureNo = 0;
  let plateNo = 0;

  for (let slot = 0; slot < forms.length; slot += 1) {
    const form = forms[slot]!;
    const slotRand = mulberry32((root ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0);
    let atlasIndex = Math.floor(slotRand() * SKY_ATLAS.length);
    let guard = 0;
    while (used.has(atlasIndex) && guard < SKY_ATLAS.length) {
      atlasIndex = (atlasIndex + 1 + Math.floor(slotRand() * 7)) % SKY_ATLAS.length;
      guard += 1;
    }
    used.add(atlasIndex);
    const atlas = SKY_ATLAS[atlasIndex]!;

    const jitterRa = (slotRand() - 0.5) * 0.1;
    const jitterDec = (slotRand() - 0.5) * 0.08;
    // Keep FOV modest — smaller cutouts download faster from IRSA.
    const fov = Number((0.08 + slotRand() * 0.05).toFixed(2));
    // Wall plates blink; sculptures use a single-band still (RGB = 3× cutouts).
    const mode: GalleryMode =
      form === "sculpture"
        ? (() => {
            const detector = 1 + Math.floor(slotRand() * 6);
            const spans = [
              "0.75–1.11 µm",
              "1.11–1.63 µm",
              "1.63–2.42 µm",
              "2.42–3.82 µm",
              "3.82–4.42 µm",
              "4.42–5.00 µm",
            ];
            return {
              kind: "band" as const,
              detector,
              label: `Detector D${detector} · ${spans[detector - 1]}`,
            };
          })()
        : { kind: "blink", label: "Visit blink reel" };
    const title = pickPoeticTitle(slotRand);
    const editionNo = 1 + Math.floor(slotRand() * 96);
    const ra = Number(wrapRa(atlas.ra + jitterRa).toFixed(5));
    const dec = Number(clampDec(atlas.dec + jitterDec).toFixed(5));
    const seed = (root ^ Math.imul(atlasIndex + 1, slot + 3)) >>> 0;
    const blurb = composeGalleryPoem(slotRand, {
      title,
      atlasName: atlas.name,
      form,
      mode,
      ra,
      dec,
      fov,
    });

    let bay: string;
    if (form === "sculpture") {
      sculptureNo += 1;
      bay = `Sculpture ${sculptureNo === 1 ? "I" : "II"}`;
    } else {
      plateNo += 1;
      bay = `Plate ${plateNo}`;
    }

    pieces.push({
      id: `${day}-${slot}`,
      day,
      slot,
      form,
      title,
      blurb,
      edition: `Edition ${String(editionNo).padStart(2, "0")} · ${bay}`,
      ra,
      dec,
      fov,
      mode,
      atlasName: atlas.name,
      seed,
    });
  }

  return pieces;
}

export function galleryToolHref(piece: GalleryPieceSpec) {
  const q = new URLSearchParams({
    mode: "expert",
    ra: piece.ra.toFixed(5),
    dec: piece.dec.toFixed(5),
    fov: piece.fov.toFixed(2),
  });
  return `/tool?${q.toString()}`;
}

/** Detectors / frame budget tuned for gallery acquisition speed. */
export function galleryLoadPayload(piece: GalleryPieceSpec) {
  if (piece.mode.kind === "rgb") {
    return {
      ra: piece.ra,
      dec: piece.dec,
      fov: piece.fov,
      // Gallery RGB fallback — still prefer few frames.
      detectors: [5],
      max_frames: 3,
      force: false,
    };
  }
  if (piece.mode.kind === "blink") {
    return {
      ra: piece.ra,
      dec: piece.dec,
      fov: piece.fov,
      detectors: [5],
      // Two+ visits is enough to blink; fewer cutouts = much faster IRSA.
      max_frames: 4,
      force: false,
    };
  }
  return {
    ra: piece.ra,
    dec: piece.dec,
    fov: piece.fov,
    detectors: [piece.mode.detector],
    max_frames: 3,
    force: false,
  };
}
