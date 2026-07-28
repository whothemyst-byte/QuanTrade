"use client";

import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await createBrowserSupabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button onClick={signOut} className="text-xs text-muted hover:text-text transition-colors">
      Sign out
    </button>
  );
}
