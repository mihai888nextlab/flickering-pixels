import { NextResponse } from "next/server";
import {
  countBookmarks,
  createBookmark,
  listBookmarks,
  MAX_BOOKMARKS_PER_USER,
  parseBookmarkInput,
} from "@/lib/bookmarks";
import { getCurrentUser } from "@/lib/session";

/** The signed-in user's bookmarks, newest first. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in to see bookmarks" }, { status: 401 });
  return NextResponse.json({ bookmarks: await listBookmarks(user.id) });
}

/** Save a position: { label?, ra, dec, fov?, kind?, note? }. */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in to save bookmarks" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = parseBookmarkInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if ((await countBookmarks(user.id)) >= MAX_BOOKMARKS_PER_USER) {
    return NextResponse.json(
      { error: `Bookmark limit reached (${MAX_BOOKMARKS_PER_USER}). Delete some first.` },
      { status: 409 },
    );
  }
  const created = await createBookmark(user.id, parsed.value);
  return NextResponse.json({ bookmark: created }, { status: 201 });
}
