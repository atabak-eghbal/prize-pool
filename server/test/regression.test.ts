import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TournamentSpec, type Team } from "../src/spec.js";
import { createBracket, recordGame, placements, isComplete, type Bracket } from "../src/bracket.js";
import { planPayout, splitCents } from "../src/payouts.js";
import { checkPayoutBatch } from "../src/gate.js";
import { verifyDotaMatch, type OdMatch } from "../src/verify.js";
import type { Verdict } from "../src/results.js";

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const mkSpec = (teamCount: 2 | 4 | 8 | 16, split: { place: number; percent: number }[], fee = 0) =>
  TournamentSpec.parse({
    name: "Regression Cup", game: "chess", format: "single_elimination", teamCount,
    bestOf: { default: 1, final: 1 },
    window: { start: "2026-11-01T00:00:00Z", end: "2026-11-30T00:00:00Z" },
    prizeSplit: split, organizerFeePercent: fee, fundingGoalUsd: 1000,
  });
const mkTeams = (n: number, size: number): Team[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, name: `Team ${i + 1}`, seed: i + 1,
    players: Array.from({ length: size }, (_, k) => ({ name: `p${i}-${k}`, gameId: `u${i}x${k}`, paypalEmail: `p${i}-${k}@example.com` })),
  }));
const verdict = (winner: string, ref: string): Verdict => ({
  ok: true, winnerTeamId: winner, loserTeamId: null, checks: [],
  facts: { source: "lichess", ref, startTime: "", durationSec: 0, draw: false, details: {} },
});
/** Play a bracket where the lower seed number always wins. */
function playOut(spec: TournamentSpec, teams: Team[]): Bracket {
  let b = createBracket(spec, teams);
  const seed = new Map(teams.map((t) => [t.id, t.seed]));
  let n = 0;
  while (!isComplete(b)) {
    const s = b.series.find((x) => !x.winner && x.teamA && x.teamB)!;
    const w = seed.get(s.teamA!)! < seed.get(s.teamB!)! ? s.teamA! : s.teamB!;
    b = recordGame(b, s.id, verdict(w, `lichess:r${n++}`));
  }
  return b;
}

describe("money maths never creates or loses a cent", () => {
  it("splitCents sums exactly for 2,000 random cases", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const total = Math.floor(r() * 10_000_000);
      const w = Array.from({ length: 1 + Math.floor(r() * 12) }, () => r() * 100 + 0.01);
      const out = splitCents(total, w);
      expect(out.reduce((a, x) => a + x, 0)).toBe(total);
      expect(out.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });
  it("planPayout = pool - fee exactly, for every bracket size, team size and fee", () => {
    const r = rng(11);
    for (const n of [2, 4, 8, 16] as const)
      for (const size of [1, 5, 7])
        for (const fee of [0, 2.5, 10]) {
          const split = n === 2 ? [{ place: 1, percent: 65 }, { place: 2, percent: 35 }] : [{ place: 1, percent: 50 }, { place: 2, percent: 25 }, { place: 3, percent: 15 }, { place: 4, percent: 10 }];
          const spec = mkSpec(n, split, fee);
          const teams = mkTeams(n, size);
          const pool = 1 + Math.floor(r() * 5_000_000);
          const plan = planPayout(pool, spec, placements(playOut(spec, teams)), teams);
          expect(plan.feeCents + plan.items.reduce((a, i) => a + i.cents, 0)).toBe(pool);
        }
  });
  it("a 1-cent pool still balances (no negative or phantom cents)", () => {
    const spec = mkSpec(4, [{ place: 1, percent: 60 }, { place: 2, percent: 40 }]);
    const teams = mkTeams(4, 5);
    const plan = planPayout(1, spec, placements(playOut(spec, teams)), teams);
    expect(plan.items.reduce((a, i) => a + i.cents, 0)).toBe(1);
  });
});

describe("bracket sizes", () => {
  it.each([2, 4, 8, 16] as const)("%i teams: favourites win, seed 1 is champion, all places assigned once", (n) => {
    const spec = mkSpec(n, [{ place: 1, percent: 100 }]);
    const teams = mkTeams(n, 1);
    const groups = placements(playOut(spec, teams));
    expect(groups[0].teamIds).toEqual(["t1"]);
    const all = groups.flatMap((g) => g.teamIds);
    expect(new Set(all).size).toBe(n);
    expect(groups.flatMap((g) => g.places).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });
});

describe("payout gate attacks (all must be blocked)", () => {
  const spec = mkSpec(4, [{ place: 1, percent: 60 }, { place: 2, percent: 30 }, { place: 3, percent: 10 }], 5);
  const teams = mkTeams(4, 5);
  const bracket = playOut(spec, teams);
  const good = planPayout(100_000, spec, placements(bracket), teams);
  const base = { spec, bracket, teams, capturedCents: 100_000, openDisputes: 0, alreadyPaid: false };
  const attacks: [string, (p: typeof good) => void][] = [
    ["swap amounts between a winner and a runner-up (same total)", (p) => {
      const a = p.items.find((i) => i.teamId === "t1")!, b = p.items.find((i) => i.teamId === "t2")!;
      [a.cents, b.cents] = [b.cents, a.cents];
    }],
    ["drop one player", (p) => void p.items.pop()],
    ["add an extra recipient", (p) => void p.items.push({ ...p.items[0], paypalEmail: "x@example.com", cents: 1 })],
    ["duplicate a recipient", (p) => void p.items.push({ ...p.items[0] })],
    ["move the fee to a player", (p) => void (p.items[0].cents += p.feeCents)],
    ["inflate the claimed pool", (p) => void (p.poolCents += 500)],
    ["pay a losing team instead of the champion", (p) => p.items.filter((i) => i.teamId === "t1").forEach((i) => (i.teamId = "t4"))],
    ["change an email's case-insensitive identity to another player", (p) => void (p.items[0].paypalEmail = p.items[1].paypalEmail.toUpperCase())],
  ];
  it.each(attacks)("%s", (_, mutate) => {
    const evil = structuredClone(good);
    mutate(evil);
    expect(checkPayoutBatch({ ...base, proposed: evil }).length).toBeGreaterThan(0);
  });
  it("the honest plan passes", () => expect(checkPayoutBatch({ ...base, proposed: good })).toEqual([]));
});

describe("spec guards", () => {
  it("dota2 without a league id is rejected with a clear message", () => {
    const r = TournamentSpec.safeParse({ ...mkSpec(4, [{ place: 1, percent: 100 }]), game: "dota2", leagueId: null });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("league id");
  });
  it("a place beyond the team count is rejected", () => {
    expect(TournamentSpec.safeParse({ ...mkSpec(4, [{ place: 1, percent: 100 }]), prizeSplit: [{ place: 5, percent: 100 }] }).success).toBe(false);
  });
});

describe("regression: roster turnover (found by the live smoke test)", () => {
  // A league "final" months after the semis had only 1/5 and 3/5 of the semi rosters. It must not count.
  const real: OdMatch = JSON.parse(readFileSync(new URL("./fixtures/match_9076476183.json", import.meta.url), "utf8"));
  const rad = real.players.filter((p) => p.isRadiant).map((p) => String(p.account_id));
  const dire = real.players.filter((p) => !p.isRadiant).map((p) => String(p.account_id));
  const exp = (a: string[], b: string[]) => ({
    teamA: { teamId: "a", ids: a }, teamB: { teamId: "b", ids: b }, usedRefs: [],
    windowStart: "2000-01-01T00:00:00Z", windowEnd: "2100-01-01T00:00:00Z", leagueId: real.leagueid ?? null, minRosterPlayers: 4,
  });
  it("3 of 5 rostered players is not the registered team", () => {
    const v = verifyDotaMatch(real, exp(rad, [...dire.slice(0, 3), "1", "2"]));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === "rosters_present")?.pass).toBe(false);
  });
});
