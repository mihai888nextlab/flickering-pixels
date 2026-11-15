"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { safeNext, signInWithGoogle, useSession } from "@/lib/auth-client";

const ERRORS: Record<string, string> = {
  access_denied: "Google sign-in was cancelled.",
  state_mismatch: "That sign-in link expired. Please try again.",
  please_restart_the_process: "That sign-in link expired. Please try again.",
  unable_to_create_user: "We couldn't create your account. Please try again.",
  account_not_linked: "This email is already linked to a different sign-in method.",
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export default function LoginPanel() {
  const params = useSearchParams();
  const router = useRouter();
  const next = safeNext(params.get("next"));
  const errorCode = params.get("error");
  const { data, isPending } = useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Already signed in (e.g. opened /login in a second tab): go where they were headed.
  useEffect(() => {
    if (data?.user) router.replace(next);
  }, [data?.user, next, router]);

  const error =
    failed ?? (errorCode ? (ERRORS[errorCode] ?? `Sign-in failed (${errorCode.replace(/_/g, " ")}).`) : null);

  async function start() {
    setBusy(true);
    setFailed(null);
    try {
      const res = await signInWithGoogle(next); // navigates to Google on success
      if (res?.error) {
        setFailed(res.error.message || "Couldn't reach Google. Please try again.");
        setBusy(false);
      }
    } catch {
      setFailed("Couldn't reach the sign-in service. Is the server running?");
      setBusy(false);
    }
  }

  return (
    <section className="login-card" aria-labelledby="login-title">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="login-logo" src="/logo.png" alt="" width={64} height={64} />
      <h1 id="login-title">Sign in</h1>
      <p className="login-lead">
        The blink tool and sky map need an account, so your bookmarks and motion predictions are saved to you.
      </p>

      {data?.user ? (
        <p className="login-status">Signed in as {data.user.name}. Taking you back…</p>
      ) : (
        <button
          type="button"
          className="login-google"
          onClick={start}
          disabled={busy || isPending}
          aria-busy={busy}
        >
          <GoogleMark />
          <span>{busy ? "Opening Google…" : "Continue with Google"}</span>
        </button>
      )}

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="login-fine">
        We only use your Google name, email and picture. <Link href="/">Back to home</Link>
      </p>
    </section>
  );
}
