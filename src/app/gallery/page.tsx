import GalleryHall from "@/components/GalleryHall";
import Header from "@/components/Header";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gallery · Flickering Pixels",
  description:
    "Walk a daily infrared hall: two bas-relief sculptures and three SPHEREx plates or blink reels across one room.",
};

export default function GalleryPage() {
  return (
    <>
      <Header resting />
      <main className="gallery-page">
        <GalleryHall />
      </main>
    </>
  );
}
