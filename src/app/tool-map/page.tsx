import Header from "@/components/Header";
import SkyMap from "@/components/SkyMap";
import ToolPageShell from "@/components/ToolPageShell";
import RequireUser from "@/components/RequireUser";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sky map test · Flickering Pixels",
  description: "Pan and zoom a grid of neighboring SPHEREx cutouts.",
};

export default function ToolMapPage() {
  return (
    <ToolPageShell>
      <Header resting />
      <main className="tool-page sky-map-page">
        <RequireUser next="/tool-map" fallback={<p className="tool-auth-wait">Checking your session…</p>}>
          <SkyMap />
        </RequireUser>
      </main>
    </ToolPageShell>
  );
}
