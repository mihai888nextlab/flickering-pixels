"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  TOUR_STEPS,
  TOUR_STORAGE_KEY,
  type TourRequire,
  type TourSpotlight,
  type TourStep,
} from "./tourSteps";
import type { SkyMapTourApi, SkyMapTourState } from "@/components/SkyMap";

export type MapTourActions = {
  goPreset: (key: string) => Promise<void>;
  goName: (name: string) => Promise<void>;
  setTimeMode: (mode: "any" | "first" | "last" | "blink" | "compare") => void;
  setShowKnown: (on: boolean) => void;
  zoomIn: () => void;
  getState: () => SkyMapTourState | null;
  openAnalysis: (target?: string) => void;
  ready: boolean;
  loading: boolean;
};

type Hole = { top: number; left: number; width: number; height: number; radius: number };

type Props = {
  active: boolean;
  actions: MapTourActions;
  onExit: () => void;
  onFinished: () => void;
};

function asList(spot: TourSpotlight | TourSpotlight[]) {
  return Array.isArray(spot) ? spot : [spot];
}

function readHoles(spots: TourSpotlight[]): Hole[] {
  const holes: Hole[] = [];
  for (const spot of spots) {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${spot}"]`);
    nodes.forEach((node) => {
      const r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const pad = spot === "map" ? 6 : 5;
      holes.push({
        top: Math.max(6, r.top - pad),
        left: Math.max(6, r.left - pad),
        width: Math.min(window.innerWidth - 12, r.width + pad * 2),
        height: Math.min(window.innerHeight - 12, r.height + pad * 2),
        radius: spot === "map" ? 14 : 10,
      });
    });
  }
  return holes;
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function requirementMet(
  require: TourRequire,
  state: SkyMapTourState | null,
  flags: { ack: boolean; analyze: boolean; fovStart: number | null },
) {
  if (require.type === "ack") return flags.ack;
  if (require.type === "clickAnalyze") return flags.analyze;
  if (!state) return false;
  if (require.type === "timeMode") return state.timeMode === require.value;
  if (require.type === "showKnown") return state.showKnown === require.value;
  if (require.type === "target") {
    const name = state.targetName ? norm(state.targetName) : "";
    return require.match
      .split("|")
      .map((part) => norm(part))
      .some((part) => part && name.includes(part));
  }
  if (require.type === "zoomIn") {
    if (flags.fovStart == null) return false;
    return state.fov <= flags.fovStart * 0.82 || state.fov <= 0.42;
  }
  return false;
}

export default function ToolTour({ active, actions, onExit, onFinished }: Props) {
  const [index, setIndex] = useState(0);
  const [holes, setHoles] = useState<Hole[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [analyzeHit, setAnalyzeHit] = useState(false);
  const [taskDone, setTaskDone] = useState(false);
  const [pulseOk, setPulseOk] = useState(false);
  const fovStart = useRef<number | null>(null);
  const appliedLoad = useRef<string | null>(null);
  const appliedCue = useRef<string | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const step = TOUR_STEPS[index] ?? null;

  const spots = useMemo(() => (step ? asList(step.spotlight) : []), [step]);
  const ready = actions.ready;
  const loading = actions.loading;

  const refreshHoles = useCallback(() => {
    setHoles(readHoles(spots));
  }, [spots]);

  useLayoutEffect(() => {
    if (!active) return;
    refreshHoles();
    const onResize = () => refreshHoles();
    window.addEventListener("resize", onResize);
    const id = window.setInterval(refreshHoles, 500);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearInterval(id);
    };
  }, [active, refreshHoles, index, ready]);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      appliedLoad.current = null;
      appliedCue.current = null;
      setWaiting(false);
      setError(null);
      setAck(false);
      setAnalyzeHit(false);
      setTaskDone(false);
      fovStart.current = null;
      return;
    }
    setIndex(0);
    appliedLoad.current = null;
    appliedCue.current = null;
    setAck(false);
    setAnalyzeHit(false);
    setTaskDone(false);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onAnalyze = () => setAnalyzeHit(true);
    window.addEventListener("fp-tour-analyze", onAnalyze);
    return () => window.removeEventListener("fp-tour-analyze", onAnalyze);
  }, [active]);

  // Load target for the current step.
  useEffect(() => {
    if (!active || !step?.load) return;
    const key =
      step.load.kind === "preset" ? `preset:${step.load.key}` : `name:${step.load.name}`;
    if (appliedLoad.current === key) return;
    appliedLoad.current = key;
    appliedCue.current = null;
    setWaiting(true);
    setError(null);
    setAck(false);
    setAnalyzeHit(false);
    setTaskDone(false);
    fovStart.current = null;

    const api = actionsRef.current;
    let cancelled = false;
    (async () => {
      try {
        if (step.load!.kind === "preset") await api.goPreset(step.load!.key);
        else await api.goName(step.load!.name);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load this target.");
          setWaiting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, step]);

  // Apply soft cues (without stealing interactive tasks).
  useEffect(() => {
    if (!active || !step) return;
    if (step.load && (!ready || loading)) {
      setWaiting(true);
      return;
    }
    setWaiting(false);
    if (appliedCue.current === step.id) return;
    appliedCue.current = step.id;
    setAck(false);
    setAnalyzeHit(false);
    setTaskDone(false);
    setPulseOk(false);

    const api = actionsRef.current;
    const cue = step.cue;
    if (cue?.timeMode) api.setTimeMode(cue.timeMode);
    if (typeof cue?.showKnown === "boolean") api.setShowKnown(cue.showKnown);
    // Known-movers task: start off so the user turns it on.
    if (step.require.type === "showKnown" && step.require.value === true) {
      api.setShowKnown(false);
    }
    // Blink/compare tasks: start on All photos so the user must tap.
    if (step.require.type === "timeMode") {
      api.setTimeMode("any");
    }
    const state = api.getState();
    fovStart.current = state?.fov ?? null;
    window.setTimeout(refreshHoles, 80);
  }, [active, step, ready, loading, refreshHoles]);

  // Poll map state for interactive completion.
  useEffect(() => {
    if (!active || !step) return;
    const tick = () => {
      const state = actionsRef.current.getState();
      const met = requirementMet(step.require, state, {
        ack,
        analyze: analyzeHit,
        fovStart: fovStart.current,
      });
      setTaskDone(met);
      if (met) setPulseOk(true);
    };
    tick();
    const id = window.setInterval(tick, 280);
    return () => window.clearInterval(id);
  }, [active, step, ack, analyzeHit]);

  if (!active || !step) return null;

  const total = TOUR_STEPS.length;
  const isLast = step.id === "done";
  const canAdvance =
    !waiting &&
    !loading &&
    (taskDone || step.require.type === "ack");

  function markComplete() {
    try {
      window.localStorage.setItem(TOUR_STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  function goNext() {
    if (step.require.type === "ack") {
      setAck(true);
      setTaskDone(true);
      setPulseOk(true);
      if (isLast) {
        markComplete();
        onFinished();
        return;
      }
      setIndex((i) => Math.min(i + 1, total - 1));
      return;
    }

    if (step.id === "open-lab") {
      markComplete();
      actionsRef.current.openAnalysis("M1");
      return;
    }

    if (!taskDone) return;

    if (isLast) {
      markComplete();
      onFinished();
      return;
    }
    setIndex((i) => Math.min(i + 1, total - 1));
  }

  async function runAssist() {
    if (!step) return;
    const api = actionsRef.current;
    try {
      if (step.require.type === "timeMode") {
        api.setTimeMode(step.require.value);
      } else if (step.require.type === "showKnown") {
        api.setShowKnown(step.require.value);
      } else if (step.require.type === "zoomIn") {
        api.zoomIn();
        api.zoomIn();
      } else if (step.require.type === "target") {
        const name = step.require.match === "m101" ? "M101" : step.require.match === "m1" ? "M1" : step.require.match;
        await api.goName(name);
      } else if (step.require.type === "clickAnalyze" || step.id === "open-lab") {
        markComplete();
        api.openAnalysis("M1");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assist failed.");
    }
  }

  function skipTour() {
    markComplete();
    onExit();
  }

  const statusLabel = waiting || loading
    ? "Loading sky…"
    : taskDone
      ? "Nice — continue when ready"
      : step.task;

  return (
    <div className="tour-rail" role="dialog" aria-modal="false" aria-labelledby="tour-rail-title">
      <div className="tour-rail-dim" aria-hidden="true">
        {holes.map((hole, i) => (
          <div
            key={`${hole.left}-${hole.top}-${i}`}
            className={taskDone ? "tour-rail-hole is-done" : "tour-rail-hole"}
            style={{
              top: hole.top,
              left: hole.left,
              width: hole.width,
              height: hole.height,
              borderRadius: hole.radius,
            }}
          />
        ))}
      </div>

      <div className={pulseOk && taskDone ? "tour-rail-dock is-ok" : "tour-rail-dock"}>
        <div className="tour-rail-progress" aria-hidden="true">
          {TOUR_STEPS.map((s, i) => (
            <i key={s.id} className={i < index ? "is-done" : i === index ? "is-on" : undefined} />
          ))}
        </div>

        <div className="tour-rail-copy">
          <p className="tour-rail-kicker">
            <span>
              {index + 1}/{total}
            </span>
            {step.kicker}
          </p>
          <h2 id="tour-rail-title">{step.title}</h2>
          <p className="tour-rail-body">{step.body}</p>
          {step.tip ? <p className="tour-rail-tip">{step.tip}</p> : null}
          <p className={taskDone ? "tour-rail-task is-done" : "tour-rail-task"} role="status">
            <span className="tour-rail-task-label">{taskDone ? "Done" : "Your move"}</span>
            {statusLabel}
          </p>
          {error ? (
            <p className="tour-rail-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="tour-rail-actions">
          <button type="button" className="tour-rail-skip" onClick={skipTour}>
            Skip tour
          </button>
          <div className="tour-rail-nav">
            {step.assistLabel && !taskDone && step.require.type !== "ack" ? (
              <button type="button" className="tour-rail-assist" onClick={() => void runAssist()}>
                {step.assistLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="tour-rail-next"
              onClick={goNext}
              disabled={
                waiting ||
                loading ||
                (step.require.type !== "ack" && !taskDone && step.id !== "open-lab")
              }
            >
              {step.require.type === "ack" && !ack
                ? step.nextLabel ?? "Continue"
                : step.id === "open-lab"
                  ? step.nextLabel
                  : taskDone || step.require.type === "ack"
                    ? step.nextLabel ?? "Next"
                    : "Waiting…"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { TourStep };
export type { SkyMapTourApi };
