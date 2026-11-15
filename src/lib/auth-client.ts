"use client";

import { createAuthClient } from "better-auth/react";

/** Browser auth client. Same origin as the app, so no baseURL is needed. */
export const authClient = createAuthClient();

export const { useSession, signIn, signOut } = authClient;

/** Only same-site paths, so ?next= can't bounce people to another site after login. */
export function safeNext(next: string | null | undefined, fallback = "/tool") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

/** Starts Google sign-in. Success lands on `next`; failures come back to /login with ?error=. */
export function signInWithGoogle(next: string) {
  const target = safeNext(next);
  return signIn.social({
    provider: "google",
    callbackURL: target,
    errorCallbackURL: `/login?next=${encodeURIComponent(target)}`,
  });
}
