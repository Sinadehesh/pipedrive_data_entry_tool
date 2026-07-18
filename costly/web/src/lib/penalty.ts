/**
 * Pure money/penalty math. All amounts are integer cents.
 * Keep this module free of IO so it stays trivially testable.
 */

/** Working hours assumed per month when deriving an hourly wage. */
const WORK_HOURS_PER_MONTH = 160;

/** Share of every penalty that is permanently captured ("the burn"). */
export const BURN_SHARE = 0.2;

/** Minutes of verified walking owed per minute of scrolling. */
export const SWEAT_RATIO = 2;

/** Hours the purgatory hold survives before capture. */
export const REDEMPTION_WINDOW_HOURS = 24;

export function hourlyWageCents(monthlyIncomeCents: number): number {
  return Math.round(monthlyIncomeCents / WORK_HOURS_PER_MONTH);
}

/**
 * Income-indexed per-minute penalty: one minute of scrolling costs one
 * minute of the user's working life, floored at €0.10/min so low incomes
 * still feel the meter move.
 */
export function penaltyRateCentsPerMin(monthlyIncomeCents: number): number {
  return Math.max(10, Math.round(hourlyWageCents(monthlyIncomeCents) / 60));
}

export interface PenaltySplit {
  totalCents: number;
  burnCents: number; // 20% — captured immediately, permanent
  purgatoryCents: number; // 80% — held for REDEMPTION_WINDOW_HOURS
}

export function splitPenalty(totalCents: number): PenaltySplit {
  const burnCents = Math.round(totalCents * BURN_SHARE);
  return { totalCents, burnCents, purgatoryCents: totalCents - burnCents };
}

/** Billable seconds → penalty, clamped to the user's per-session hard cap. */
export function sessionPenaltyCents(
  activeSeconds: number,
  rateCentsPerMin: number,
  capCents: number,
): { penaltyCents: number; capReached: boolean } {
  const raw = Math.round((activeSeconds / 60) * rateCentsPerMin);
  return { penaltyCents: Math.min(raw, capCents), capReached: raw >= capCents };
}

export function requiredWalkingMinutes(activeSeconds: number): number {
  return Math.ceil((activeSeconds / 60) * SWEAT_RATIO);
}

/** "You have burned 2.4% of your AirPods." */
export function anchorPercent(penaltyCents: number, anchorPriceCents: number): number {
  if (anchorPriceCents <= 0) return 0;
  return Math.round((penaltyCents / anchorPriceCents) * 1000) / 10;
}
