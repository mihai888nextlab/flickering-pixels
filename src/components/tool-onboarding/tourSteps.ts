export type TourSpotlight =
  | "map"
  | "search"
  | "time"
  | "time-blink"
  | "time-compare"
  | "known"
  | "zoom"
  | "globe"
  | "analyze"
  | "finds";

export type TourStepId =
  | "welcome"
  | "barnard-blink"
  | "barnard-compare"
  | "search"
  | "globe"
  | "context-menu"
  | "open-lab";

export type TourRequire =
  | { type: "ack" }
  | { type: "timeMode"; value: "blink" | "compare" | "first" | "last" }
  | { type: "showKnown"; value: boolean }
  | { type: "target"; match: string }
  | { type: "zoomIn" }
  | { type: "viewMoved" }
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
  /**
   * Where to park the coach card. Defaults to the first spotlight; use `"bottom"` for
   * map-wide steps so the card stays out of the way.
   */
  dock?: "auto" | "bottom";
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
    body: "Drag the sky to pan. Scroll to zoom. A short tour of the real controls — you drive them.",
    task: "Tap Continue when you are ready.",
    spotlight: "map",
    dock: "bottom",
    require: { type: "ack" },
    allowSkip: false,
    nextLabel: "Continue",
  },
  {
    id: "barnard-blink",
    kicker: "01 · Blink",
    title: "Play the visits.",
    body: "Barnard's Star walks between SPHEREx revisits. Blink swaps the first and last visit — fixed sky holds; movers jump.",
    task: "Tap Blink in the time bar.",
    tip: "Watch the field after it lights up.",
    spotlight: ["time-blink", "time"],
    load: { kind: "preset", key: "barnard" },
    cue: { showKnown: false },
    require: { type: "timeMode", value: "blink" },
    allowSkip: false,
    nextLabel: "Next",
    assistLabel: "Do it for me",
  },
  {
    id: "barnard-compare",
    kicker: "02 · Compare",
    title: "Red beside cyan.",
    body: "Compare overlays both visits: white means still; red beside cyan means it moved. Known movers (amber rings, asteroid diamonds) explain catalogued jumps.",
    task: "Tap Red / cyan in the time bar.",
    tip: "Afterward, try Known movers in the left HUD to veto false discoveries.",
    spotlight: ["time-compare", "time", "known"],
    require: { type: "timeMode", value: "compare" },
    allowSkip: false,
    nextLabel: "Next",
    assistLabel: "Do it for me",
  },
  {
    id: "search",
    kicker: "03 · Search",
    title: "Jump anywhere.",
    body: "Type a name or RA Dec and press Go. Try M101 — a spiral galaxy that holds still across visits.",
    task: "Search for M101.",
    spotlight: "search",
    require: { type: "target", match: "m101" },
    allowSkip: true,
    nextLabel: "Next",
    assistLabel: "Search M101",
  },
  {
    id: "globe",
    kicker: "04 · Globe",
    title: "Turn the whole sky.",
    body: "The mini globe shows where you are looking. Drag it to spin the sky, or click a spot to fly there.",
    task: "Drag or click the globe to move the view.",
    tip: "Lower-left corner of the map.",
    spotlight: "globe",
    require: { type: "viewMoved" },
    allowSkip: true,
    nextLabel: "Next",
    assistLabel: "Nudge the sky",
  },
  {
    id: "context-menu",
    kicker: "05 · Right-click",
    title: "Four actions on any spot.",
    body: "Right-click the sky for Information (what's here), Analyze (open the lab on that point), Flag as mover (save a candidate), and Share (copy a link).",
    task: "Read the options, then continue.",
    tip: "You can try a right-click now — the tour stays open.",
    spotlight: "map",
    dock: "bottom",
    require: { type: "ack" },
    allowSkip: true,
    nextLabel: "Got it",
  },
  {
    id: "open-lab",
    kicker: "06 · Lab",
    title: "Bands and spectra.",
    body: "Data analysis is the instrument bay: retune detectors, flicker frames, click for a spectrum. Finish by opening it on M1 — the Crab Nebula.",
    task: "Open the lab to finish the tour.",
    spotlight: "analyze",
    require: { type: "clickAnalyze" },
    allowSkip: true,
    nextLabel: "Open lab with M1",
  },
];

export const TOUR_STORAGE_KEY = "fp-sky-tour-v1";
