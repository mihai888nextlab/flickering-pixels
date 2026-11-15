import Header from "@/components/Header";
import ToolBench from "@/components/ToolBench";
import ToolPageShell from "@/components/ToolPageShell";
import RequireUser from "@/components/RequireUser";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Data analysis · Flickering Pixels",
  description:
    "Lock a sky position, step through SPHEREx visits, retune infrared bands, and sample spectra.",
};

export default function DataAnalysisPage() {
  return (
    <ToolPageShell>
      <Header resting />
      <main className="tool-page">
        <p className="header-cue">
          <span className="header-cue-arrow" aria-hidden="true" />
          Hover for header
        </p>
        <RequireUser next="/data-analysis" fallback={<p className="tool-auth-wait">Checking your session…</p>}>
          <ToolBench />
        </RequireUser>
      </main>
    </ToolPageShell>
  );
}
