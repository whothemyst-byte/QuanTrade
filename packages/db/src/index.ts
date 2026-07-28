import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as q from "./queries.js";

export * from "./mappers.js";
export * from "./queries.js";

export function createSupabase(url: string, serviceKey: string): SupabaseClient {
  if (!url || !serviceKey) throw new Error("Supabase URL and service key are both required");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * Bind every query to one client. Jobs take this object, so tests can pass a
 * hand-written fake with the same shape and never touch a network.
 */
export function createDb(url: string, serviceKey: string) {
  const sb = createSupabase(url, serviceKey);
  return {
    raw: sb,
    getBook: (id: string) => q.getBook(sb, id),
    updateBookCash: (id: string, cash: number) => q.updateBookCash(sb, id, cash),
    insertEquitySnapshot: q.insertEquitySnapshot.bind(null, sb),
    getBars: q.getBars.bind(null, sb),
    latestBarDate: q.latestBarDate.bind(null, sb),
    upsertBars: q.upsertBars.bind(null, sb),
    upsertInstruments: q.upsertInstruments.bind(null, sb),
    startRun: q.startRun.bind(null, sb),
    finishRun: q.finishRun.bind(null, sb),
    insertProposals: q.insertProposals.bind(null, sb),
    getPendingProposals: q.getPendingProposals.bind(null, sb),
    getUnsettledProposals: q.getUnsettledProposals.bind(null, sb),
    expireStaleProposals: q.expireStaleProposals.bind(null, sb),
    insertPositions: q.insertPositions.bind(null, sb),
    getOpenPositions: q.getOpenPositions.bind(null, sb),
    closePositions: q.closePositions.bind(null, sb),
    getClosedPositions: q.getClosedPositions.bind(null, sb),
    insertPostMortem: q.insertPostMortem.bind(null, sb),
    countClosedSinceLastReflection: q.countClosedSinceLastReflection.bind(null, sb),
    countReflections: q.countReflections.bind(null, sb),
    insertReflection: q.insertReflection.bind(null, sb),
  };
}

export type Db = ReturnType<typeof createDb>;
