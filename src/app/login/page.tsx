import Header from "@/components/Header";
import LoginPanel from "@/components/LoginPanel";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Sign in · Flickering Pixels",
  description: "Sign in with Google to use the Flickering Pixels blink tool and sky map.",
};

export default function LoginPage() {
  return (
    <>
      <Header resting />
      <main className="login-page">
        {/* LoginPanel reads ?next= and ?error= (request data), so it streams in behind Suspense. */}
        <Suspense fallback={<section className="login-card" aria-busy="true" />}>
          <LoginPanel />
        </Suspense>
      </main>
    </>
  );
}
