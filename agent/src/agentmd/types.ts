import { z } from "zod";

export type RuleStatus = "active" | "probation" | "retired";

export interface Rule {
  id: string;
  title: string;
  born: string;
  evidence: string[];
  applications: number;
  wins: number;
  avgReturn: number;
  status: RuleStatus;
  retiredReason?: string;
}

export interface AgentDoc {
  coreMandate: string;
  beliefs: string[];
  rules: Rule[];
  failureModes: string[];
}

export interface NewRule {
  title: string;
  evidence: string[];
}

export interface Amendment {
  addBeliefs?: string[];
  removeBeliefs?: string[];
  addRules?: NewRule[];
  retireRuleIds?: string[];
  addFailureModes?: string[];
}

export interface AmendContext {
  today: string;
  reflectionNumber: number;
}

/**
 * The shape the model is allowed to return. There is deliberately no field for
 * the Core Mandate — the model cannot request a change it has no way to
 * express, so immutability is structural rather than a matter of instruction.
 */
export const AmendmentResponseSchema = z.object({
  summary: z.string().min(1),
  add_beliefs: z.array(z.string()).default([]),
  remove_beliefs: z.array(z.string()).default([]),
  add_rules: z
    .array(z.object({ title: z.string().min(1), evidence: z.array(z.string()).min(1) }))
    .default([]),
  retire_rule_ids: z.array(z.string()).default([]),
  add_failure_modes: z.array(z.string()).default([]),
});

export type AmendmentResponse = z.infer<typeof AmendmentResponseSchema>;
