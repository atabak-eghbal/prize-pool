import type { TournamentSpec, Team } from "./spec.js";
import { isComplete, placements, type Bracket } from "./bracket.js";
import { planPayout, type PayoutPlan } from "./payouts.js";

/**
 * Policy gate: the last check before any PayPal Payouts call. The treasurer agent may
 * *propose* a batch, but money only moves if this returns no violations. The gate
 * recomputes the plan itself from verified state and compares, so a model cannot
 * change amounts or recipients.
 */
export interface GateInput {
  proposed: PayoutPlan;
  spec: TournamentSpec;
  bracket: Bracket;
  teams: Team[];
  capturedCents: number;
  openDisputes: number;
  alreadyPaid: boolean;
}

export function checkPayoutBatch(x: GateInput): string[] {
  const v: string[] = [];
  if (x.alreadyPaid) v.push("this tournament has already been paid out");
  if (!isComplete(x.bracket)) v.push("the bracket is not complete");
  if (x.openDisputes > 0) v.push(`${x.openDisputes} dispute(s) still open`);
  if (x.capturedCents <= 0) v.push("no captured funds");
  if (x.proposed.poolCents !== x.capturedCents)
    v.push(`proposed pool ${x.proposed.poolCents}¢ differs from captured funds ${x.capturedCents}¢`);
  if (v.length) return v;

  const expected = planPayout(x.capturedCents, x.spec, placements(x.bracket), x.teams);
  const key = (i: { paypalEmail: string; cents: number; teamId: string }) => `${i.teamId}|${i.paypalEmail.toLowerCase()}|${i.cents}`;
  const want = expected.items.map(key).sort();
  const got = x.proposed.items.map(key).sort();
  const missing = want.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !want.includes(k));
  for (const k of extra) v.push(`unexpected payout item ${k}`);
  for (const k of missing) v.push(`missing payout item ${k}`);
  const total = x.proposed.items.reduce((a, i) => a + i.cents, 0);
  if (total > x.capturedCents - expected.feeCents) v.push(`batch total ${total}¢ exceeds distributable ${x.capturedCents - expected.feeCents}¢`);
  const emails = x.proposed.items.map((i) => i.paypalEmail.toLowerCase());
  if (new Set(emails).size !== emails.length) v.push("a recipient appears twice");
  return v;
}
