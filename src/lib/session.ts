import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/**
 * Data Access Layer for the signed-in user (Server Components, Server Actions, Route Handlers).
 * With cacheComponents on, call these from inside a <Suspense> boundary: they read the request.
 * Always re-check in Server Actions / Route Handlers — UI checks alone don't protect data.
 */
export type CurrentUser = { id: string; name: string; email: string; image: string | null };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const { id, name, email, image } = session.user;
  return { id, name, email, image: image ?? null };
}

/** Only same-site paths, so ?next= can't bounce people to another site after login. */
export function safeNextPath(next: string | null | undefined, fallback = "/tool"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

/** For pages/actions that need a user: sends them to /login (and back to `next` after). */
export async function requireUser(next = "/tool"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`);
  return user;
}
