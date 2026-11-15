export type TourSpotlight =
  | "map"
  | "search"
  | "time"
  | "time-blink"
  | "time-compare"
  | "known"
  | "zoom"
  | "analyze"
  | "finds";

export type TourStepId =
  | "welcome"
  | "barnard-see"
  | "barnard-blink"
  | "barnard-compare"
  | "barnard-known"
  | "zoom-in"
  | "m101-search"
  | "m1-nebula"
  | "open-lab"
  | "done";

export type TourRequire =
  | { type: "ack" }
  | { type: "timeMode"; value: "blink" | "compare" | "first" | "last" }
  | { type: "showKnown"; value: boolean }
  | { type: "target"; match: string }
  | { type: "zoomIn" }
  | { type: "clickAnalyze" };

export type TourStep = {
  id: TourStepId;
  kicker: string;
  title: string;
  body: string;
  /** What the user must do — shown as the live prompt. */
  task: string;
  tip?: string;
  spotlight: TourSpotlight | TourSpotlight[];
  load?: { kind: "preset"; key: string } | { kind: "name"; name: string };
  cue?: {
    timeMode?: "any" | "first" | "last" | "blink" | "compare";
    showKnown?: boolean;
  };
  require: TourRequire;
  /** First steps stay locked until the task is done; later ones allow Skip. */
  allowSkip: boolean;
  nextLabel?: string;
  /** Optional one-tap helper that performs the required action for the user. */
  assistLabel?: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    kicker: "Briefing",
    title: "You are on the SPHEREx sky map.",
    body: "Drag to pan. Scroll to zoom. We will walk a few real controls — you drive them.",
    task: "Tap Continue when you are ready.",
    spotlight: "map",
    require: { type: "ack" },
    allowSkip: false,
    nextLabel: "Continue",
  },
  {
    id: "barnard-see",
    kicker: "01 · Proper motion",
    title: "Stars move.",
    body: "Barnard's Star is one of the fastest wanderers. SPHEREx revisits months apart, so that walk can show up as a jump between visits.",
    task: "Look at the field, then continue.",
    tip: "The search box can jump to any name or RA Dec later.",
    spotlight: ["map", "search"],
    load: { kind: "preset", key: "barnard" },
    cue: { timeMode: "any", showKnown: false },
    require: { type: "ack" },
    allowSkip: false,
    nextLabel: "Got it",
  },
  {
    id: "barnard-blink",
    kicker: "02 · Blink",
    title: "Play the visits.",
    body: "Blink swaps the first and last survey visit. Fixed sky holds; movers jump.",
    task: "Tap Blink in the time bar.",
    tip: "Watch the field after it lights up.",
    spotlight: ["time-blink", "time", "map"],
    cue: { showKnown: false },
    require: { type: "timeMode", value: "blink" },
    allowSkip: false,
    nextLabel: "Next",
    assistLabel: "Do it for me",
  },
  {
    id: "barnard-compare",
    kicker: "03 · Compare",
    title: "Red beside cyan.",
    body: "Compare overlays both visits: white means still; red beside cyan means it moved.",
    task: "Tap Red / cyan in the time bar.",
    spotlight: ["time-compare", "time", "map"],
    require: { type: "timeMode", value: "compare" },
    allowSkip: false,
    nextLabel: "Next",
    assistLabel: "Do it for me",
  },
  {
    id: "barnard-known",
    kicker: "04 · Catalogues",
    title: "Known movers.",
    body: "Amber rings are fast Gaia stars; diamonds are asteroids at the visit times. A blink is only a discovery if neither explains it.",
    task: "Turn Known movers on (tap the control).",
    tip: "Zoom in if the legend says the view is too wide.",
    spotlight: ["known", "map"],
    cue: { timeMode: "compare" },
    require: { type: "showKnown", value: true },
    allowSkip: false,
    nextLabel: "Next",
    assistLabel: "Do it for me",
  },
  {
    id: "zoom-in",
    kicker: "05 · Zoom",
    title: "Get closer.",
    body: "Tighter FOV makes known-mover marks and tile detail readable.",
    task: "Zoom in with + or the scroll wheel.",
    spotlight: ["zoom", "map"],
    require: { type: "zoomIn" },
    allowSkip: true,
    nextLabel: "Next",
    assistLabel: "Zoom for me",
  },
  {
    id: "m101-search",
    kicker: "06 · Galaxy",
    title: "Not everything walks.",
    body: "M101 is a spiral galaxy — so far the whole island holds still across visits. Search takes you there.",
    task: "Search for M101 (type it and press Go).",
    tip: "Or use Assist to jump once you have seen the search box.",
    spotlight: ["search", "map"],
    require: { type: "target", match: "m101" },
    allowSkip: true,
    nextLabel: "Next",
    assistLabel: "Search M101",
  },
  {
    id: "m1-nebula",
    kicker: "07 · Nebula",
    title: "M1 — the Crab.",
    body: "A supernova remnant. It does not stroll like Barnard's Star; its story is chemistry across infrared bands.",
    task: "Search for M1.",
    spotlight: ["search", "map"],
    require: { type: "target", match: "m1|crab" },
    allowSkip: true,
    nextLabel: "Next",
    assistLabel: "Search M1",
  },
  {
    id: "open-lab",
    kicker: "08 · Lab",
    title: "Bands and spectra.",
    body: "Data analysis is the instrument bay: retune detectors, flicker frames, click for a spectrum.",
    task: "Open Data analysis (or Continue to jump with M1).",
    spotlight: ["analyze"],
    require: { type: "clickAnalyze" },
    allowSkip: true,
    nextLabel: "Open lab with M1",
    assistLabel: "Open lab with M1",
  },
  {
    id: "done",
    kicker: "Ready",
    title: "Your sky.",
    body: "Pan, blink, flag finds, and open the lab whenever a spot deserves wavelengths.",
    task: "Finish the briefing.",
    tip: "Restart anytime from Guided tour in the HUD.",
    spotlight: "map",
    require: { type: "ack" },
    allowSkip: true,
    nextLabel: "Start exploring",
  },
];

export const TOUR_STORAGE_KEY = "fp-sky-tour-v1";
