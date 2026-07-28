"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase/server";

export type Decision = "approved" | "rejected";

export async function decideProposal(id: string, decision: Decision) {
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`Invalid decision "${decision}"`);
  }
  await requireOwner();

  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("proposals")
    .update({ status: decision, decided_at: new Date().toISOString() })
    // Scoping to pending makes this idempotent: a double-tap on a phone, or a
    // stale tab, cannot flip a decision the settle job may already have acted on.
    .eq("id", id)
    .eq("status", "pending")
    .select();

  if (error) throw new Error(`Failed to record the decision: ${error.message}`);
  revalidatePath("/");
}
