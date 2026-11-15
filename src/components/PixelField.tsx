"use client";

import { useEffect, useRef } from "react";

const pixels = [
  { top: "14%", left: "6%", size: 7, dx: 28, dy: 12, opacity: 0.85 },
  { top: "22%", left: "18%", size: 4, dx: -18, dy: 16, opacity: 0.4 },
  { top: "8%", left: "32%", size: 5, dx: 14, dy: -10, opacity: 0.55 },
  { top: "70%", left: "10%", size: 4, dx: -22, dy: 8, opacity: 0.35 },
  { top: "78%", left: "24%", size: 8, dx: 20, dy: -14, opacity: 0.7 },
  { top: "18%", left: "46%", size: 3, dx: -12, dy: 18, opacity: 0.3 },
  { top: "62%", left: "40%", size: 5, dx: 16, dy: 10, opacity: 0.28 },
  { top: "40%", left: "4%", size: 3, dx: 24, dy: -16, opacity: 0.45 },
];

export default function PixelField() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const section = root?.parentElement;
    if (!root || !section) return;

    function onMove(event: MouseEvent) {
      const rect = section!.getBoundingClientRect();
      const dx = (event.clientX - rect.left) / rect.width - 0.5;
      const dy = (event.clientY - rect.top) / rect.height - 0.5;
      root!.querySelectorAll<HTMLElement>("[data-dx]").forEach((node) => {
        const px = Number(node.dataset.dx);
        const py = Number(node.dataset.dy);
        node.style.transform = `translate(${dx * px}px, ${dy * py}px)`;
      });
    }

    section.addEventListener("mousemove", onMove);
    return () => section.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <div className="pixel-field" ref={rootRef} aria-hidden="true">
      {pixels.map((pixel) => (
        <span
          key={`${pixel.top}-${pixel.left}`}
          className="pixel"
          data-dx={pixel.dx}
          data-dy={pixel.dy}
          style={{
            top: pixel.top,
            left: pixel.left,
            width: pixel.size,
            height: pixel.size,
            opacity: pixel.opacity,
          }}
        />
      ))}
    </div>
  );
}
