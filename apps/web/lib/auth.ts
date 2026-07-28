import { redirect } from "next/navigation";
import { createServerSupabase } from "./supabase/server";

/** OWNER_EMAIL accepts a comma-separated list, so you can hold more than one
 *  address without weakening the allowlist to "any signed-in user". */
export function ownerEmails(): string[] {
  return (process.env.OWNER_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwner(email: string | undefined | null): boolean {
  if (!email) return false;
  const allowed = ownerEmails();
  // An empty allowlist locks everyone out rather than letting everyone in.
  if (allowed.length === 0) return false;
  return allowed.includes(email.toLowerCase());
}

/**
 * Single-owner app. RLS lets any authenticated user read, so this allowlist is
 * what stops a stray Supabase signup from seeing the book.
 */
export async function requireOwner() {
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  const user = data.user;

  if (!user) redirect("/login");

  if (!isOwner(user.email)) {
    await supabase.auth.signOut();
    redirect("/login?denied=1");
  }
  return user;
}
