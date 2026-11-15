"use client";

import TelescopeSlot from "@/components/TelescopeSlot";
import { DeckBtn } from "@/components/deck/DeckPrimitives";
import { useLenis } from "lenis/react";
import { useEffect, useRef } from "react";

const chapters = [
  {
    align: "",
    kicker: "NASA Space Apps 2026",
    title: "See the sky flicker.",
    body: "Scroll past SPHEREx. It is already mapping the whole sky in infrared.",
    heading: "h1" as const,
  },
  {
    align: "right",
    kicker: "Near infrared",
    title: "One hundred and two colors.",
    body: "Every visit is a spectrum — 0.75 to 5 µm — not a single photo.",
    heading: "h2" as const,
  },
  {
    align: "",
    kicker: "What shifts",
    title: "Find what moves.",
    body: "Movers show up only when two visits are blinked side by side.",
    heading: "h2" as const,
  },
  {
    align: "center",
    kicker: "The team",
    title: "Flickering Pixels.",
    body: "A public blink of SPHEREx, for anyone who wants to look.",
    heading: "h2" as const,
    actions: true,
  },
];

const ranges: [number, number][] = [
  [0, 0.16],
  [0.2, 0.34],
  [0.39, 0.52],
  [0.56, 0.78],
];

/** Matches TelescopeStage STORY — constant-speed flight until here, then timed finale. */
const FINALE_AT = 0.8;
/** Same duration as the section opacity handoff in CSS. */
const FINALE_MS = 1600;
/** Max story progress per second — keeps the 3D move steady regardless of scroll speed. */
const MAX_PROGRESS_PER_SEC = 0.28;
/**
 * Wide top-down hold with Earth behind SPHEREx (before the black plunge).
 * Re-entering here keeps scroll-up mirrored with scroll-down.
 */
const REENTER_PROGRESS = FINALE_AT + 0.18 * 0.5;

function chapterOpacity(progress: number, index: number) {
  const [start, end] = ranges[index];
  const fade = 0.045;
  if (progress < start || progress > end) return 0;
  const enter = index === 0 ? 1 : Math.min(1, (progress - start) / fade);
  const exit = Math.min(1, (end - progress) / fade);
  return Math.min(enter, exit);
}

function easeInOut(t: number) {
  return t * t * (3 - 2 * t);
}

export default function Hero() {
  const trackRef = useRef<HTMLElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const nodes = useRef<(HTMLElement | null)[]>([]);
  const railRef = useRef<HTMLElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const revealedRef = useRef(false);
  const lenis = useLenis();
  const lenisRef = useRef(lenis);
  lenisRef.current = lenis;

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = document.getElementById("challenge");
    document.documentElement.classList.add("flight-handoff");
    let frame = 0;
    let finaleStartedAt: number | null = null;
    let visual = 0;
    let lastTime = performance.now();

    const readScrollTarget = () => {
      const rect = track.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      if (total <= 0) return 0;
      const scrolled = Math.min(Math.max(-rect.top, 0), total);
      return scrolled / total;
    };

    /** Document Y of an element — offsetTop breaks inside positioned wrappers (e.g. .site-deck). */
    const documentTop = (el: HTMLElement) => {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      return el.getBoundingClientRect().top + y;
    };

    const progressScrollY = (value: number) => {
      const total = Math.max(0, track.offsetHeight - window.innerHeight);
      return documentTop(track) + Math.min(1, Math.max(0, value)) * total;
    };

    const snapTo = (top: number) => {
      const lenisNow = lenisRef.current;
      if (lenisNow) lenisNow.scrollTo(top, { immediate: true });
      else window.scrollTo(0, top);
    };

    const snapToNext = () => {
      if (!next) return;
      snapTo(documentTop(next));
    };

    const revealNext = () => {
      stickyRef.current?.classList.add("is-done");
      if (revealedRef.current) return;
      revealedRef.current = true;
      lenisRef.current?.start();
      snapToNext();
      requestAnimationFrame(() => {
        next?.classList.add("is-revealed");
      });
    };

    const JUMP_SECTIONS = new Set(["challenge", "approach", "blink", "targets"]);

    const skipToSection = (id: string) => {
      const target = document.getElementById(id);
      if (!target) return;
      finaleStartedAt = null;
      visual = 1;
      revealedRef.current = true;
      lenisRef.current?.start();
      const sticky = stickyRef.current;
      if (sticky) {
        sticky.style.transition = "none";
        sticky.classList.add("is-done");
      }
      if (next) {
        next.style.transition = "none";
        next.classList.add("is-revealed");
      }
      snapTo(documentTop(target));
      paint(1);
      requestAnimationFrame(() => {
        if (sticky) sticky.style.transition = "";
        if (next) next.style.transition = "";
      });
      const hash = `#${id}`;
      if (window.location.hash !== hash) history.replaceState(null, "", hash);
    };

    /**
     * Leave the following section and resume the hero on the cinematic top-down
     * frame (same beat as scroll-down before the plunge), then scrub in reverse.
     */
    const reenterFinaleEnd = () => {
      const sticky = stickyRef.current;
      revealedRef.current = false;
      finaleStartedAt = null;
      visual = REENTER_PROGRESS;
      lenisRef.current?.start();
      if (sticky) sticky.classList.remove("is-done");
      if (next) next.classList.remove("is-revealed");
      snapTo(progressScrollY(REENTER_PROGRESS));
      paint(REENTER_PROGRESS);
      if (JUMP_SECTIONS.has(window.location.hash.slice(1))) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };

    const onJumpClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a");
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href) return;
      const hash = href.startsWith("/#") ? href.slice(2) : href.startsWith("#") ? href.slice(1) : "";
      if (!JUMP_SECTIONS.has(hash)) return;
      event.preventDefault();
      event.stopPropagation();
      skipToSection(hash);
    };

    const paint = (value: number) => {
      progress.current = value;
      nodes.current.forEach((node, index) => {
        if (!node) return;
        const opacity = reduce ? (index === 0 ? 1 : 0) : chapterOpacity(value, index);
        node.style.opacity = String(opacity);
        node.style.pointerEvents = opacity > 0.55 ? "auto" : "none";
      });
      if (railRef.current) railRef.current.style.height = `${Math.round(value * 100)}%`;
      if (hintRef.current) hintRef.current.style.opacity = reduce ? "0" : String(value < 0.05 ? 1 : 0);

      if (reduce) {
        stickyRef.current?.classList.add("is-done");
        next?.classList.add("is-revealed");
      }

      track.style.setProperty("--nx", `${16 + value * 38}%`);
      track.style.setProperty("--ny", `${22 + Math.sin(value * Math.PI) * 26}%`);
      track.style.setProperty("--nx2", `${84 - value * 42}%`);
      track.style.setProperty("--ny2", `${24 + Math.sin(value * Math.PI) * 20}%`);
      track.style.setProperty("--nx3", `${40 + Math.cos(value * Math.PI * 2) * 22}%`);
      track.style.setProperty("--ny3", `${78 - value * 28}%`);
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      if (reduce) {
        paint(0.12);
        return;
      }

      const scrollTarget = readScrollTarget();

      if (revealedRef.current) {
        const challengeTop = next?.getBoundingClientRect().top ?? 0;
        // Scrolling back: resume on the wide top-down beat, then reverse like scroll-down.
        if (challengeTop > 32) reenterFinaleEnd();
        else visual = 1;
      } else if (finaleStartedAt != null) {
        const t = Math.min(1, (now - finaleStartedAt) / FINALE_MS);
        visual = FINALE_AT + easeInOut(t) * (1 - FINALE_AT);
        if (t >= 1) {
          visual = 1;
          revealNext();
        }
      } else if (visual < FINALE_AT && scrollTarget >= FINALE_AT) {
        finaleStartedAt = now;
        visual = FINALE_AT;
        lenisRef.current?.stop();
      } else if (visual >= FINALE_AT) {
        // Already in the finale (e.g. re-entered): scrub it both ways at constant speed.
        const target = Math.min(1, Math.max(0, scrollTarget));
        const gap = target - visual;
        if (Math.abs(gap) <= 0.0001) visual = target;
        else visual += Math.sign(gap) * Math.min(Math.abs(gap), MAX_PROGRESS_PER_SEC * dt);
        if (visual >= 0.995 && scrollTarget >= 0.98) revealNext();
      } else {
        // Story chase — forward stops at the finale gate so the timed dive can play.
        const target = scrollTarget >= visual ? Math.min(scrollTarget, FINALE_AT) : scrollTarget;
        const gap = target - visual;
        if (Math.abs(gap) <= 0.0001) visual = target;
        else visual += Math.sign(gap) * Math.min(Math.abs(gap), MAX_PROGRESS_PER_SEC * dt);
      }

      paint(visual);
      frame = requestAnimationFrame(tick);
    };

    lastTime = performance.now();
    frame = requestAnimationFrame(tick);
    document.addEventListener("click", onJumpClick, true);
    const initialHash = window.location.hash.slice(1);
    if (JUMP_SECTIONS.has(initialHash)) skipToSection(initialHash);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("click", onJumpClick, true);
      document.documentElement.classList.remove("flight-handoff");
      stickyRef.current?.classList.remove("is-done");
      next?.classList.remove("is-revealed");
      if (stickyRef.current) stickyRef.current.style.transition = "";
      if (next) next.style.transition = "";
      lenisRef.current?.start();
      revealedRef.current = false;
    };
  }, []);

  return (
    <section className="flight" id="top" ref={trackRef} aria-label="SPHEREx telescope">
      <div className="flight-sticky" ref={stickyRef}>
        <div className="flight-glow" aria-hidden="true" />
        <TelescopeSlot progress={progress} />
        <p className="header-cue">
          <span className="header-cue-arrow" aria-hidden="true" />
          Hover for header
        </p>
        {chapters.map((chapter, index) => {
          const Heading = chapter.heading;
          return (
            <article
              key={chapter.title}
              className={`flight-chapter ${chapter.align}`.trim()}
              ref={(node) => {
                nodes.current[index] = node;
              }}
              style={{ opacity: index === 0 ? 1 : 0 }}
            >
              <p className="kicker">{chapter.kicker}</p>
              <Heading id={index === 0 ? "hero-title" : undefined}>
                {index === 0 ? (
                  <>
                    See the sky <span className="flicker">flicker</span>.
                  </>
                ) : (
                  chapter.title
                )}
              </Heading>
              <p>{chapter.body}</p>
              {chapter.actions ? (
                <div className="hero-actions">
                  <DeckBtn href="#challenge">The challenge</DeckBtn>
                  <DeckBtn href="#approach">How the tool works</DeckBtn>
                </div>
              ) : null}
            </article>
          );
        })}
        <div className="flight-rail" aria-hidden="true">
          <i ref={railRef} />
        </div>
        <p className="flight-hint" ref={hintRef}>
          Scroll to fly past
        </p>
      </div>
    </section>
  );
}
