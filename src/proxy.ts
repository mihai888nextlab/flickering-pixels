import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gate for the tools: no session cookie → /login?next=<where you were going>.
 * It only checks that the cookie exists (cheap, runs on every matched request and prefetch);
 * the page itself verifies the session against the database (see <RequireUser>).
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // `:path*` also matches the bare route (/tool, /data-analysis, /tool-map, /tool-demo).
  matcher: ["/tool/:path*", "/data-analysis/:path*", "/tool-map/:path*", "/tool-demo/:path*"],
};
