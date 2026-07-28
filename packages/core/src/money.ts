/**
 * Round to 2dp using epsilon correction, so 2.675 -> 2.68 rather than 2.67.
 * Every monetary value in QuanTrade passes through here at each computation
 * boundary. Quantities never do — those are integers by construction.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`round2 received a non-finite value: ${value}`);
  }
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) * 100;
  // Nudge by one ulp-ish epsilon to defeat binary representation error.
  const rounded = Math.round(scaled + Number.EPSILON * scaled);
  return (sign * rounded) / 100;
}
