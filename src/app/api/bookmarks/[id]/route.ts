import { NextResponse } from "next/server";
import { deleteBookmark } from "@/lib/bookmarks";
import { getCurrentUser } from "@/lib/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, ctx: RouteContext<"/api/bookmarks/[id]">) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Bad bookmark id" }, { status: 400 });
  // Scoped to the user, so nobody can delete someone else's bookmark by guessing an id.
  const removed = await deleteBookmark(user.id, id);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
