import { Suspense, type ReactNode } from "react";
import { requireUser } from "@/lib/session";

async function Gate({ next, children }: { next: string; children: ReactNode }) {
  await requireUser(next); // redirects to /login when the session is missing or expired
  return <>{children}</>;
}

/**
 * Renders `children` only for a signed-in user (checked against the database on the server).
 * The session read sits behind Suspense, as Cache Components requires.
 */
export default function RequireUser({
  next,
  children,
  fallback = null,
}: {
  next: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <Gate next={next}>{children}</Gate>
    </Suspense>
  );
}
