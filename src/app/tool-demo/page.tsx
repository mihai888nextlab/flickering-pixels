import SpherexBlinkDemo from "@/components/SpherexBlinkDemo";
import type { Metadata } from "next";
import { Suspense } from "react";
import "./spherex-demo.css";

export const metadata: Metadata = {
  title: "SPHEREx Blink demo · Flickering Pixels",
  description:
    "Live IRSA integration demo: blink SPHEREx survey passes, infrared colour, spectra, and Aladin context.",
};

export default function ToolDemoPage() {
  return (
    <Suspense
      fallback={
        <div className="spherex-demo">
          <p className="sx-status">Loading SPHEREx blink demo…</p>
        </div>
      }
    >
      <SpherexBlinkDemo />
    </Suspense>
  );
}
