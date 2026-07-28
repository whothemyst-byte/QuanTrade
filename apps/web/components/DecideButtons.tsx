"use client";

import { useTransition, useState } from "react";
import { decideProposal, type Decision } from "@/actions/decide";

export function DecideButtons({ proposalId }: { proposalId: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  function decide(decision: Decision) {
    setError(null);
    startTransition(async () => {
      try {
        await decideProposal(proposalId, decision);
        setDone(decision);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  if (done) {
    return (
      <p className="text-sm text-muted">
        {done === "approved" ? "Approved — fills at the next open." : "Rejected — tracked in the shadow book."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          disabled={pending}
          onClick={() => decide("approved")}
          className="flex-1 rounded-md bg-long text-black font-medium py-2.5 text-sm disabled:opacity-50"
        >
          {pending ? "Saving…" : "Approve"}
        </button>
        <button
          disabled={pending}
          onClick={() => decide("rejected")}
          className="flex-1 rounded-md border border-border py-2.5 text-sm disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {error && <p className="text-xs text-short">{error}</p>}
    </div>
  );
}
