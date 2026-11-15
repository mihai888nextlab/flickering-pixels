"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Former sky-map route — keep bookmarks working. */
export default function ToolMapRedirect() {
  const router = useRouter();
  useEffect(() => {
    const suffix = window.location.search || "";
    router.replace(`/tool${suffix}`);
  }, [router]);
  return (
    <main className="tool-page sky-map-page" style={{ padding: "2rem", color: "#9bb0c2" }}>
      Opening the sky map…
    </main>
  );
}
