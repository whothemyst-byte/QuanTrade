"use client";

import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const denied = typeof window !== "undefined" && window.location.search.includes("denied=1");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="min-h-dvh grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-[family-name:var(--font-display)] text-4xl mb-1">
          Quan<span className="text-[--color-accent]">Trade</span>
        </h1>
        <p className="text-sm text-[--color-muted] mb-6">Sign in with a magic link.</p>

        {denied && (
          <p className="mb-4 text-sm text-[--color-short] border border-[--color-short] rounded-md px-3 py-2">
            That account is not the owner of this book.
          </p>
        )}

        {sent ? (
          <p className="text-sm">Check your email for the sign-in link.</p>
        ) : (
          <form onSubmit={send} className="flex flex-col gap-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-md bg-[--color-surface] border border-[--color-border] px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="rounded-md bg-[--color-accent] text-black font-medium px-3 py-2 text-sm"
            >
              Send link
            </button>
            {error && <p className="text-sm text-[--color-short]">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
