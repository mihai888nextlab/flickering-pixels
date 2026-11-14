import Header from "@/components/Header";
import ToolBench from "@/components/ToolBench";
import ToolPageShell from "@/components/ToolPageShell";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "The tool · Flickering Pixels",
  description:
    "A preview of the Flickering Pixels sky tool: set an address, step through SPHEREx visits, and compare wavelengths.",
};

export default function ToolPage() {
  return (
    <ToolPageShell>
      <Header resting />
      <main className="tool-page">
        <p className="header-cue">
          <span className="header-cue-arrow" aria-hidden="true" />
          Hover for header
        </p>
        <ToolBench />
      </main>
    </ToolPageShell>
  );
}
