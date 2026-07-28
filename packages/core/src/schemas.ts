import { z } from "zod";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const BarSchema = z
  .object({
    symbol: z.string().min(1),
    date: z.string().regex(ISO_DATE, "date must be YYYY-MM-DD"),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative(),
  })
  .superRefine((bar, ctx) => {
    if (bar.high < Math.max(bar.open, bar.close)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "high is below the open or close" });
    }
    if (bar.low > Math.min(bar.open, bar.close)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "low is above the open or close" });
    }
    if (bar.high < bar.low) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "high is below the low" });
    }
  });

export const AgentProposalSchema = z
  .object({
    symbol: z.string().min(1),
    direction: z.enum(["long", "short"]),
    conviction: z.number().min(0).max(1),
    stop_loss: z.number().positive(),
    target: z.number().positive(),
    max_hold_sessions: z.number().int().min(1).max(10),
    thesis: z.string().min(1),
    rules_applied: z.array(z.string()),
    what_would_falsify_this: z.string().min(1),
  })
  .superRefine((p, ctx) => {
    if (p.direction === "long" && p.target <= p.stop_loss) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "long target must sit above the stop" });
    }
    if (p.direction === "short" && p.target >= p.stop_loss) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "short target must sit below the stop" });
    }
  });

export const AgentResponseSchema = z.object({
  market_view: z.string().min(1),
  proposals: z.array(AgentProposalSchema),
  no_trade_reason: z.string().optional(),
});

export type AgentProposal = z.infer<typeof AgentProposalSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
