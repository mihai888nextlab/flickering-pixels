import Header from "@/components/Header";
import ToolMapClient from "@/components/ToolMapClient";
import ToolPageShell from "@/components/ToolPageShell";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "The tool · Flickering Pixels",
  description:
    "Pan and zoom SPHEREx sky tiles, blink visits, and spot movers before opening data analysis.",
};

export default function ToolPage() {
  return (
    <ToolPageShell>
      <Header resting />
      <main className="tool-page sky-map-page">
        <ToolMapClient />
      </main>
    </ToolPageShell>
  );
}
