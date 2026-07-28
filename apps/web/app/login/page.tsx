"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const denied =
    typeof window !== "undefined" && window.location.search.includes("denied=1");

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    // refresh() forces the middleware to re-run and see the new session cookie
    // before any other route is allowed through.
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="min-h-dvh grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="serif text-4xl mb-1">
          Quan<span className="text-accent">Trade</span>
        </h1>
        <p className="text-sm text-muted mb-6">Sign in to your book.</p>

        {denied && (
          <p className="mb-4 text-sm text-short border border-short rounded-md px-3 py-2">
            That account is not an owner of this book.
          </p>
        )}

        <form onSubmit={signIn} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-md bg-surface border border-border px-3 py-2 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md bg-surface border border-border px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent text-black font-medium px-3 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>

          {error && <p className="text-sm text-short">{error}</p>}
        </form>

        <p className="mt-6 text-xs text-muted">
          Paper trading only. No real money is ever at risk.
        </p>
      </div>
    </div>
  );
}
