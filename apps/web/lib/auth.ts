import { redirect } from "next/navigation";
import { createServerSupabase } from "./supabase/server";

/**
 * Single-owner app. RLS lets any authenticated user read, so this allowlist is
 * what stops a stray Supabase signup from seeing the book.
 */
export async function requireOwner() {
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  const user = data.user;

  if (!user) redirect("/login");

  const owner = process.env.OWNER_EMAIL ?? "";
  if (user.email?.toLowerCase() !== owner.toLowerCase()) {
    await supabase.auth.signOut();
    redirect("/login?denied=1");
  }
  return user;
}
