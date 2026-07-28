export function money(value: number | null | undefined, currency: "INR" | "USD"): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
}

export function signedPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/**
 * Format a plain YYYY-MM-DD without letting Date drag it across a timezone.
 * `new Date("2026-07-28")` parses as UTC midnight, which renders as 27 July
 * for anyone west of Greenwich — a trade journal with wrong dates is worse
 * than one with no dates.
 */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[(m ?? 1) - 1]} ${y}`;
}

/** Minutes until an ISO instant, floored at zero. */
export function minutesUntil(iso: string, now = new Date()): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - now.getTime()) / 60_000));
}

export function countdown(iso: string, now = new Date()): string {
  const mins = minutesUntil(iso, now);
  if (mins === 0) return "expired";
  if (mins < 60) return `${mins}m left`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m left`;
}

/** Reward-to-risk implied by a stop and target around a reference price. */
export function rewardToRisk(
  reference: number,
  stopLoss: number,
  target: number,
): number | null {
  const risk = Math.abs(reference - stopLoss);
  if (risk === 0) return null;
  return Math.round((Math.abs(target - reference) / risk) * 10) / 10;
}
