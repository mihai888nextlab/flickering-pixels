"use client";

import { useEffect, type ReactNode } from "react";
import { useLenis } from "lenis/react";

const DESKTOP_MIN = 1101;

export default function ToolPageShell({ children }: { children: ReactNode }) {
  const lenis = useLenis();

  useEffect(() => {
    const root = document.documentElement;

    function isDesktop() {
      return Math.min(window.innerWidth, root.clientWidth || window.innerWidth) >= DESKTOP_MIN;
    }

    function clearInlineScrollStyles() {
      for (const el of [root, document.body]) {
        el.style.removeProperty("overflow");
        el.style.removeProperty("overflow-x");
        el.style.removeProperty("overflow-y");
        el.style.removeProperty("height");
        el.style.removeProperty("max-height");
      }
    }

    function refreshScroll() {
      lenis?.resize();
    }

    function apply() {
      clearInlineScrollStyles();

      if (isDesktop()) {
        root.classList.add("tool-scroll-lock");
        root.classList.remove("tool-scroll-free");
        window.scrollTo(0, 0);
        lenis?.scrollTo(0, { immediate: true, force: true });
        lenis?.stop();
        return;
      }

      // Tablet / phone: full document scroll. Never leave Lenis in `.lenis-stopped`
      // (that sets overflow:clip and traps scroll to one viewport).
      root.classList.remove("tool-scroll-lock");
      root.classList.add("tool-scroll-free");
      lenis?.start();
      requestAnimationFrame(refreshScroll);
    }

    apply();

    const onResize = () => apply();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);

    // Panel content grows after loads — keep Lenis scroll height in sync.
    const wrap = document.querySelector(".tool-wrap");
    const ro =
      wrap && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (!isDesktop()) refreshScroll();
          })
        : null;
    if (wrap && ro) ro.observe(wrap);

    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      ro?.disconnect();
      root.classList.remove("tool-scroll-lock");
      root.classList.remove("tool-scroll-free");
      clearInlineScrollStyles();
      lenis?.start();
    };
  }, [lenis]);

  return <>{children}</>;
}
