"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SkyMap, { type SkyMapTourApi } from "@/components/SkyMap";
import ToolTour, { type MapTourActions } from "@/components/tool-onboarding/ToolTour";
import { TOUR_STORAGE_KEY } from "@/components/tool-onboarding/tourSteps";

function hasFinishedTour() {
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function ToolMapClient() {
  const [tourActive, setTourActive] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoading, setMapLoading] = useState(true);
  const mapApiRef = useRef<SkyMapTourApi | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const forceTour = params.get("tour") === "1" || params.get("enter") === "1";
    const firstVisit = !hasFinishedTour();

    if (forceTour || firstVisit) {
      setTourActive(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("enter");
      if (forceTour) url.searchParams.set("tour", "1");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  const endTour = useCallback((markDone: boolean) => {
    setTourActive(false);
    if (markDone) {
      try {
        window.localStorage.setItem(TOUR_STORAGE_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("tour");
    url.searchParams.delete("enter");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const startTour = useCallback(() => {
    setTourActive(true);
    const url = new URL(window.location.href);
    url.searchParams.set("tour", "1");
    url.searchParams.delete("enter");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const onTourApi = useCallback((api: SkyMapTourApi) => {
    mapApiRef.current = api;
    setMapReady(api.ready);
    setMapLoading(api.loading);
  }, []);

  const tourActions: MapTourActions = {
    goPreset: async (key) => {
      if (!mapApiRef.current) throw new Error("Map is still starting…");
      await mapApiRef.current.goPreset(key);
    },
    goName: async (name) => {
      if (!mapApiRef.current) throw new Error("Map is still starting…");
      await mapApiRef.current.goName(name);
    },
    setTimeMode: (mode) => mapApiRef.current?.setTimeMode(mode),
    setShowKnown: (on) => mapApiRef.current?.setShowKnown(on),
    zoomIn: () => mapApiRef.current?.zoomIn(),
    getState: () => mapApiRef.current?.getState() ?? null,
    openAnalysis: (target) => {
      if (target) {
        const url = new URL("/data-analysis", window.location.origin);
        url.searchParams.set("mode", "expert");
        url.searchParams.set("name", target);
        window.location.href = url.toString();
        return;
      }
      const viewLink = document.querySelector<HTMLAnchorElement>('a[data-tour="analyze"]');
      window.location.href = viewLink?.href || "/data-analysis?mode=expert";
    },
    ready: mapReady,
    loading: mapLoading || !mapApiRef.current,
  };

  return (
    <>
      <SkyMap onTourApi={onTourApi} onRequestTour={startTour} />
      <ToolTour
        active={tourActive}
        actions={tourActions}
        onExit={() => endTour(true)}
        onFinished={() => endTour(true)}
      />
    </>
  );
}
