"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DeckBtn, DeckLed } from "@/components/deck/DeckPrimitives";
import GalleryRoom, {
  STATIONS,
  type GalleryRoomPiece,
} from "@/components/GalleryRoom";
import {
  formatGalleryDay,
  galleryDayKey,
  galleryLoadPayload,
  galleryPiecesForDay,
  galleryToolHref,
  shiftGalleryDay,
  type GalleryPieceSpec,
} from "@/lib/galleryDaily";
import {
  spherexBlinkGifUrl,
  spherexFetch,
  spherexPngUrl,
  type SpherexResult,
} from "@/lib/spherexApi";

type PieceState = {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  message: string;
  src: string | null;
  /** Epoch stills for in-hall blink animation (WebGL cannot play GIFs). */
  frames: string[];
  mediaLabel: string;
  targetName: string | null;
  nFrames: number | null;
  photoSummary: string | null;
  irCharacter: string | null;
  targetDescription: string | null;
  nEpochs: number | null;
};

const EMPTY_STATE: PieceState = {
  status: "idle",
  message: "Waiting for acquisition…",
  src: null,
  frames: [],
  mediaLabel: "",
  targetName: null,
  nFrames: null,
  photoSummary: null,
  irCharacter: null,
  targetDescription: null,
  nEpochs: null,
};

async function pollJob(job: string, signal: AbortSignal): Promise<SpherexResult> {
  for (let i = 0; i < 160; i += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const s = await spherexFetch<{
      status: string;
      error?: string;
      message?: string;
      result?: SpherexResult;
    }>(`/api/job/${job}`);
    if (s.status === "error") {
      throw new Error(s.error || s.message || "Archive request failed");
    }
    if (s.status === "done" && s.result) return s.result;
    // Snappier early polls — gallery jobs are short once cutouts start landing.
    await new Promise((r) => setTimeout(r, i < 20 ? 140 : i < 60 ? 280 : 500));
  }
  throw new Error("Timed out waiting for SPHEREx frames");
}

function pickMedia(piece: GalleryPieceSpec, job: string, result: SpherexResult) {
  if (piece.mode.kind === "rgb") {
    if (result.rgb) {
      return {
        src: spherexPngUrl(job, result.rgb),
        frames: [] as string[],
        mediaLabel: "RGB · multi-band stack",
      };
    }
    const det = result.detectors.at(-1);
    if (det) {
      return {
        src: spherexPngUrl(job, det.png),
        frames: [] as string[],
        mediaLabel: `Fallback · D${det.detector} stack`,
      };
    }
  }

  if (piece.mode.kind === "blink") {
    const frames = result.epochs.map((epoch) => spherexPngUrl(job, epoch.png));
    if (result.epochs.length >= 2) {
      return {
        src: spherexBlinkGifUrl(job, 480),
        frames,
        mediaLabel: `Blink · ${result.epochs.length} visits`,
      };
    }
    const epoch = result.epochs[0];
    if (epoch) {
      return {
        src: spherexPngUrl(job, epoch.png),
        frames,
        mediaLabel: "Single pass · blink unavailable",
      };
    }
  }

  if (piece.mode.kind === "band") {
    const detector = piece.mode.detector;
    const det = result.detectors.find((d) => d.detector === detector);
    if (det) {
      return {
        src: spherexPngUrl(job, det.png),
        frames: [] as string[],
        mediaLabel: `D${det.detector} · ${det.n} frames stacked`,
      };
    }
    const frame = result.frames.find((f) => f.detector === detector);
    if (frame) {
      return {
        src: spherexPngUrl(job, frame.png),
        frames: [] as string[],
        mediaLabel: `D${frame.detector} · ${frame.date}`,
      };
    }
  }

  const epoch = result.epochs[0];
  if (epoch) {
    return {
      src: spherexPngUrl(job, epoch.png),
      frames: [] as string[],
      mediaLabel: `Pass stack · ${epoch.start}`,
    };
  }
  return null;
}

/** Wall bays for plates, plinths for sculptures — keeps the horseshoe readable. */
function placeInHall(
  pieces: GalleryPieceSpec[],
  states: PieceState[],
): { roomItems: GalleryRoomPiece[]; indexMap: number[] } {
  const wallSlots = [0, 2, 4];
  const plinthSlots = [1, 3];
  const indexMap = new Array(pieces.length).fill(0);
  const roomItems: GalleryRoomPiece[] = new Array(STATIONS.length);

  let wi = 0;
  let pi = 0;
  pieces.forEach((piece, sourceIndex) => {
    const state = states[sourceIndex] ?? EMPTY_STATE;
    const item: GalleryRoomPiece = {
      piece,
      src: state.src,
      frames: state.frames,
      status: state.status,
      message: state.message,
    };
    const slot =
      piece.form === "sculpture"
        ? (plinthSlots[pi++] ?? 1)
        : (wallSlots[wi++] ?? 2);
    roomItems[slot] = item;
    indexMap[sourceIndex] = slot;
  });

  // Fill any holes if form counts ever drift
  for (let i = 0; i < STATIONS.length; i += 1) {
    if (!roomItems[i]) {
      const fallback = pieces[0];
      roomItems[i] = {
        piece: fallback,
        src: null,
        status: "idle",
        message: "",
      };
    }
  }

  return { roomItems, indexMap };
}

function DetailsModal({
  piece,
  state,
  onClose,
  onRetry,
  poemBusy,
}: {
  piece: GalleryPieceSpec;
  state: PieceState;
  onClose: () => void;
  onRetry: () => void;
  poemBusy?: boolean;
}) {
  const toolHref = galleryToolHref(piece);
  const isSculpture = piece.form === "sculpture";

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="gallery-details-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${piece.title} details`}
    >
      <button
        type="button"
        className="gallery-details-scrim"
        aria-label="Close details"
        onClick={onClose}
      />
      <div className="gallery-details-stage">
        <header className="gallery-details-bar">
          <div className="gallery-piece-plate">
            <DeckLed
              tone={
                state.status === "ready"
                  ? "green"
                  : state.status === "error" || state.status === "empty"
                    ? "amber"
                    : "cyan"
              }
              pulse={state.status === "loading"}
            />
            <div>
              <p className="gallery-kicker">{piece.edition}</p>
              <h3>{piece.title}</h3>
            </div>
          </div>
          <button
            type="button"
            className="gallery-details-close"
            aria-label="Close details"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <p
          className={
            poemBusy
              ? "gallery-details-blurb is-composing"
              : "gallery-details-blurb"
          }
          aria-busy={!!poemBusy}
        >
          {piece.blurb}
        </p>

        <div className="gallery-details-hero">
          {state.src ? (
            <div className="gallery-details-plate">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={state.src} alt="" draggable={false} />
            </div>
          ) : (
            <div className="gallery-details-plate is-empty" aria-hidden="true" />
          )}

          <dl className="gallery-meta gallery-meta-side">
            <div>
              <dt>Form</dt>
              <dd>{isSculpture ? "Sculpture" : "Plate"}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{piece.mode.label}</dd>
            </div>
            <div>
              <dt>RA</dt>
              <dd>{piece.ra.toFixed(5)}°</dd>
            </div>
            <div>
              <dt>Dec</dt>
              <dd>
                {piece.dec >= 0 ? "+" : ""}
                {piece.dec.toFixed(5)}°
              </dd>
            </div>
            <div>
              <dt>FOV</dt>
              <dd>{piece.fov.toFixed(2)}°</dd>
            </div>
            <div>
              <dt>Anchor</dt>
              <dd title={piece.atlasName}>{piece.atlasName}</dd>
            </div>
          </dl>
        </div>

        <footer className="gallery-details-foot">
          {state.status === "error" || state.status === "empty" ? (
            <button type="button" className="gallery-retry" onClick={onRetry}>
              Retry bay
            </button>
          ) : null}
          <DeckBtn href={toolHref}>Open in Lab</DeckBtn>
        </footer>
      </div>
    </div>
  );
}

export default function GalleryHall() {
  const [today, setToday] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [editionPoems, setEditionPoems] = useState<Record<string, string>>({});
  const [editionFromPhoto, setEditionFromPhoto] = useState<
    Record<string, boolean>
  >({});
  const [poemEnriching, setPoemEnriching] = useState<Record<string, boolean>>(
    {},
  );
  const [editionBusy, setEditionBusy] = useState(false);
  const seedPieces = useMemo(
    () => (day ? galleryPiecesForDay(day) : []),
    [day],
  );
  const pieces = useMemo(
    () =>
      seedPieces.map((piece) => ({
        ...piece,
        blurb: editionPoems[piece.id] ?? piece.blurb,
      })),
    [seedPieces, editionPoems],
  );
  const [states, setStates] = useState<PieceState[]>([]);
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  const { roomItems, indexMap } = useMemo(
    () => placeInHall(pieces, states),
    [pieces, states],
  );

  const stationToSource = useMemo(() => {
    const map = new Map<number, number>();
    indexMap.forEach((station, source) => map.set(station, source));
    return map;
  }, [indexMap]);

  const selectedStation =
    selectedSource != null ? (indexMap[selectedSource] ?? null) : null;

  const setPieceState = useCallback((index: number, next: PieceState) => {
    setStates((prev) => {
      const copy = [...prev];
      copy[index] = next;
      return copy;
    });
  }, []);

  const loadPiece = useCallback(
    async (piece: GalleryPieceSpec, index: number, signal: AbortSignal) => {
      setPieceState(index, {
        ...EMPTY_STATE,
        status: "loading",
        message: "Acquiring cutout from IRSA…",
      });
      try {
        const { job } = await spherexFetch<{ job: string }>("/api/load", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(galleryLoadPayload(piece)),
          signal,
        });
        setPieceState(index, {
          ...EMPTY_STATE,
          status: "loading",
          message: "Developing plate…",
        });
        const result = await pollJob(job, signal);
        if (!result.frames.length && !result.epochs.length && !result.rgb) {
          setPieceState(index, {
            ...EMPTY_STATE,
            status: "empty",
            message: "No SPHEREx frames at this pointing yet.",
            mediaLabel: "Out of current QR coverage",
            targetName: result.target.name,
            nFrames: 0,
          });
          return;
        }
        const media = pickMedia(piece, job, result);
        if (!media) {
          setPieceState(index, {
            ...EMPTY_STATE,
            status: "empty",
            message: "Coverage found, but no printable plate for this mode.",
            mediaLabel: "Unavailable",
            targetName: result.target.name,
            nFrames: result.n_used,
          });
          return;
        }
        setPieceState(index, {
          status: "ready",
          message: "",
          src: media.src,
          frames: media.frames,
          mediaLabel: media.mediaLabel,
          targetName: result.target.name,
          nFrames: result.n_used,
          photoSummary: result.photo?.summary ?? null,
          irCharacter: result.photo?.ir_character ?? null,
          targetDescription: result.target.description ?? null,
          nEpochs: result.epochs.length,
        });

        // Lock a shared poem from this cutout’s look (first visitor wins for the day).
        setPoemEnriching((prev) => ({ ...prev, [piece.id]: true }));
        void fetch("/api/gallery/edition/enrich", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            day: piece.day,
            pieceId: piece.id,
            mediaLabel: media.mediaLabel,
            targetName: result.target.name,
            targetDescription: result.target.description ?? null,
            nFrames: result.n_used,
            nEpochs: result.epochs.length,
            photo: {
              summary: result.photo?.summary ?? null,
              irCharacter: result.photo?.ir_character ?? null,
            },
          }),
          signal,
        })
          .then(async (res) => {
            if (!res.ok) return null;
            return (await res.json()) as {
              poem?: string;
              fromPhoto?: boolean;
            };
          })
          .then((data) => {
            if (!data?.poem?.trim()) return;
            setEditionPoems((prev) => ({ ...prev, [piece.id]: data.poem! }));
            setEditionFromPhoto((prev) => ({
              ...prev,
              [piece.id]: !!data.fromPhoto,
            }));
          })
          .catch(() => {
            // Keep provisional blurb if enrich fails.
          })
          .finally(() => {
            setPoemEnriching((prev) => ({ ...prev, [piece.id]: false }));
          });
      } catch (err) {
        if (signal.aborted) return;
        setPieceState(index, {
          ...EMPTY_STATE,
          status: "error",
          message: err instanceof Error ? err.message : "Acquisition failed",
          mediaLabel: "Fault",
        });
      }
    },
    [setPieceState],
  );

  const loadDay = useCallback(
    (dayPieces: GalleryPieceSpec[]) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      runIdRef.current += 1;
      setSelectedSource(null);
      setDetailsOpen(false);
      setStates(
        dayPieces.map(() => ({
          ...EMPTY_STATE,
          status: "loading",
          message: "Seeking SPHEREx coverage…",
        })),
      );
      // Cap IRSA concurrency — five full jobs at once thrash the archive;
      // two at a time finishes the first walls sooner.
      const concurrency = 2;
      let next = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (next < dayPieces.length) {
          if (ac.signal.aborted) return;
          const index = next;
          next += 1;
          const piece = dayPieces[index];
          if (!piece) return;
          await loadPiece(piece, index, ac.signal);
        }
      });
      void Promise.all(workers);
    },
    [loadPiece],
  );

  useEffect(() => {
    const key = galleryDayKey();
    setToday(key);
    setDay(key);
  }, []);

  // Shared daily edition shell — photo-aware poems arrive as each cutout loads.
  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    setEditionBusy(true);
    setEditionPoems({});
    setEditionFromPhoto({});
    void fetch(`/api/gallery/edition?day=${encodeURIComponent(day)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("edition unavailable");
        return (await res.json()) as {
          poems?: Record<string, string>;
          fromPhoto?: Record<string, boolean>;
        };
      })
      .then((data) => {
        if (cancelled || !data.poems) return;
        setEditionPoems(data.poems);
        setEditionFromPhoto(data.fromPhoto ?? {});
      })
      .catch(() => {
        // Keep seeded local blurbs if the edition endpoint fails.
      })
      .finally(() => {
        if (!cancelled) setEditionBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [day]);

  useEffect(() => {
    if (!seedPieces.length) return;
    loadDay(seedPieces);
    return () => abortRef.current?.abort();
  }, [seedPieces, loadDay]);

  useEffect(() => {
    // Walk stations left→right in the hall (0..4), not the piece-list order.
    const stationCount = STATIONS.length;
    function sourceAtStation(station: number) {
      return stationToSource.get(
        ((station % stationCount) + stationCount) % stationCount,
      );
    }

    function onKey(event: KeyboardEvent) {
      if (selectedSource == null || !pieces.length) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSource((cur) => {
          if (cur == null) return sourceAtStation(0) ?? 0;
          const station = indexMap[cur] ?? 0;
          return sourceAtStation(station + 1) ?? cur;
        });
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSource((cur) => {
          if (cur == null) return sourceAtStation(stationCount - 1) ?? 0;
          const station = indexMap[cur] ?? 0;
          return sourceAtStation(station - 1) ?? cur;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSource, pieces.length, indexMap, stationToSource]);

  const selectedPiece =
    selectedSource != null ? pieces[selectedSource] : null;
  const selectedState =
    selectedSource != null ? (states[selectedSource] ?? EMPTY_STATE) : null;

  if (!day || !today) {
    return (
      <div className="gallery-hall is-booting" aria-busy="true">
        <p className="gallery-hint">Opening the hall…</p>
      </div>
    );
  }

  return (
    <div className="gallery-hall">
      <div className="gallery-chrome">
        <div className="gallery-day-rail" role="group" aria-label="Exhibition day">
          <button
            type="button"
            className="gallery-day-nav"
            onClick={() => setDay((d) => (d ? shiftGalleryDay(d, -1) : d))}
            aria-label="Older edition"
          >
            ←
          </button>
          <div className="gallery-day-lcd">
            <span>Edition date</span>
            <strong>{formatGalleryDay(day)}</strong>
            <small>{day === today ? "Today · UTC" : `${day} · UTC`}</small>
          </div>
          <button
            type="button"
            className="gallery-day-nav"
            disabled={day >= today}
            onClick={() =>
              setDay((d) => (d && d < today ? shiftGalleryDay(d, 1) : d))
            }
            aria-label="Newer edition"
          >
            →
          </button>
        </div>
        <p className="gallery-hint">
          Drag to look · ← → step works · sculptures unlock 360°
        </p>
      </div>

      <GalleryRoom
        items={roomItems}
        selectedIndex={selectedStation}
        onSelect={(station) => {
          if (station == null) {
            setSelectedSource(null);
            setDetailsOpen(false);
            return;
          }
          const source = stationToSource.get(station);
          if (source == null) return;
          setSelectedSource(source);
        }}
        overlay={
          selectedPiece && selectedState ? (
            <aside className="gallery-inspect" aria-live="polite">
              <div className="gallery-inspect-plate">
                <DeckLed
                  tone={
                    selectedState.status === "ready"
                      ? "green"
                      : selectedState.status === "error" ||
                          selectedState.status === "empty"
                        ? "amber"
                        : "cyan"
                  }
                  pulse={selectedState.status === "loading"}
                />
                <div>
                  <p className="gallery-kicker">{selectedPiece.edition}</p>
                  <h2>{selectedPiece.title}</h2>
                </div>
              </div>
              <div className="gallery-inspect-actions">
                <button
                  type="button"
                  className="gallery-details-link"
                  onClick={() => setDetailsOpen(true)}
                >
                  Details
                </button>
                {selectedState.status === "error" ||
                selectedState.status === "empty" ? (
                  <button
                    type="button"
                    className="gallery-retry"
                    onClick={() => {
                      void loadPiece(
                        selectedPiece,
                        selectedSource!,
                        new AbortController().signal,
                      );
                    }}
                  >
                    Retry
                  </button>
                ) : null}
                <DeckBtn href={galleryToolHref(selectedPiece)}>Open in Lab</DeckBtn>
              </div>
            </aside>
          ) : null
        }
      />

      {detailsOpen && selectedPiece && selectedState ? (
        <DetailsModal
          piece={selectedPiece}
          state={selectedState}
          poemBusy={
            (editionBusy && !editionPoems[selectedPiece.id]) ||
            !!poemEnriching[selectedPiece.id]
          }
          onClose={() => setDetailsOpen(false)}
          onRetry={() => {
            void loadPiece(
              selectedPiece,
              selectedSource!,
              new AbortController().signal,
            );
          }}
        />
      ) : null}
    </div>
  );
}
