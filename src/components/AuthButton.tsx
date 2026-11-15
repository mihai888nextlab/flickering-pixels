"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Header account control: "Sign in" (→ /login) when signed out, avatar + menu when signed in. */
export default function AuthButton({ variant = "bar" }: { variant?: "bar" | "menu" }) {
  const { data, isPending } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (isPending) {
    return <span className={`auth-btn is-${variant} is-pending`} aria-hidden="true" />;
  }

  const user = data?.user;
  if (!user) {
    if (pathname === "/login") return null;
    // Come back here after signing in; from the landing page, go straight to the tool.
    const next = pathname && pathname !== "/" ? pathname : "/tool";
    return (
      <Link className={`auth-btn is-${variant}`} href={`/login?next=${encodeURIComponent(next)}`}>
        <GoogleMark />
        <span>Sign in</span>
      </Link>
    );
  }

  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
  return (
    <div className={`auth-user is-${variant}`} ref={wrapRef}>
      <button
        type="button"
        className="auth-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.image} alt="" width={32} height={32} referrerPolicy="no-referrer" />
        ) : (
          <span>{initial}</span>
        )}
      </button>
      {open ? (
        <div className="auth-menu" role="menu">
          <p className="auth-menu-name">{user.name}</p>
          <p className="auth-menu-email">{user.email}</p>
          <Link role="menuitem" href="/data-analysis#bookmarks" onClick={() => setOpen(false)}>
            My bookmarks
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await signOut();
              // The tools need a session: leave them; elsewhere just refresh the page state.
              if (pathname?.startsWith("/tool") || pathname?.startsWith("/data-analysis")) router.replace("/login");
              else router.refresh();
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
