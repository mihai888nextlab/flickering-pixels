import type { Metadata } from "next";
import localFont from "next/font/local";
import { Inter, Outfit } from "next/font/google";
import { ReactLenis } from "lenis/react";
import "lenis/dist/lenis.css";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const structedBeginning = localFont({
  src: "../../the-structed-beginning-font/TheStructedBeginningRegular-q2rz6.ttf",
  weight: "400",
  style: "normal",
  variable: "--font-structed-beginning",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Flickering Pixels · Planet X and SPHEREx",
  description:
    "Flickering Pixels is building a public tool for the NASA Space Apps Challenge that blinks SPHEREx sky images so anyone can see what moves.",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png" }],
    apple: [{ url: "/apple-icon.png", type: "image/png" }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
      <html lang="en" className={`${inter.variable} ${outfit.variable} ${structedBeginning.variable}`}>
      <body>
        <ReactLenis
          root
          options={{
            lerp: 0.085,
            smoothWheel: true,
            anchors: true,
            stopInertiaOnNavigate: true,
            autoRaf: true,
          }}
        >
          {children}
        </ReactLenis>
      </body>
    </html>
  );
}
