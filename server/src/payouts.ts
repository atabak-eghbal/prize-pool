import type { TournamentSpec, Team } from "./spec.js";
import type { PlaceGroup } from "./bracket.js";

export interface PayoutItem {
  teamId: string;
  places: number[];
  playerName: string;
  gameId: string;
  paypalEmail: string;
  cents: number;
}
export interface PayoutPlan {
  poolCents: number;
  feeCents: number;
  distributableCents: number;
  items: PayoutItem[];
}

/**
 * Split `weights` into integer cents summing exactly to `total` (largest remainder;
 * ties go to the earlier entry, so the result is deterministic).
 */
export function splitCents(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error("total must be non-negative integer cents");
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0) throw new Error("weights must sum to > 0");
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, x) => a + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k++, rest--) out[order[k % order.length].i]++;
  return out;
}

/** Pool -> organizer fee -> places (shared groups pool their percents) -> teams -> each rostered player equally. */
export function planPayout(poolCents: number, spec: TournamentSpec, groups: PlaceGroup[], teams: Team[]): PayoutPlan {
  const feeCents = Math.round((poolCents * spec.organizerFeePercent) / 100);
  const distributableCents = poolCents - feeCents;
  const pct = new Map(spec.prizeSplit.map((p) => [p.place, p.percent]));
  // Places not listed in the split get 0; if the split leaves places unpaid, their share stays in the weights' normalization.
  const teamWeights: { teamId: string; places: number[]; w: number }[] = [];
  for (const g of groups) {
    const groupPct = g.places.reduce((a, p) => a + (pct.get(p) ?? 0), 0);
    if (groupPct === 0) continue;
    for (const teamId of g.teamIds) teamWeights.push({ teamId, places: g.places, w: groupPct / g.teamIds.length });
  }
  const teamCents = splitCents(distributableCents, teamWeights.map((t) => t.w));
  const byId = new Map(teams.map((t) => [t.id, t]));
  const items: PayoutItem[] = [];
  teamWeights.forEach((tw, i) => {
    const team = byId.get(tw.teamId);
    if (!team) throw new Error(`unknown team ${tw.teamId}`);
    const each = splitCents(teamCents[i], team.players.map(() => 1));
    team.players.forEach((p, j) =>
      items.push({ teamId: team.id, places: tw.places, playerName: p.name, gameId: p.gameId, paypalEmail: p.paypalEmail, cents: each[j] }),
    );
  });
  return { poolCents, feeCents, distributableCents, items: items.filter((x) => x.cents > 0) };
}
