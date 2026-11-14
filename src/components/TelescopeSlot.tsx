"use client";

import dynamic from "next/dynamic";
import type { RefObject } from "react";

const TelescopeStage = dynamic(() => import("./TelescopeStage"), {
  ssr: false,
  loading: () => (
    <div className="flight-status" role="status">
      Preparing the telescope…
    </div>
  ),
});

export default function TelescopeSlot({ progress }: { progress: RefObject<number> }) {
  return <TelescopeStage progress={progress} />;
}
