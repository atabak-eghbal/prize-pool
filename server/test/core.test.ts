import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TournamentSpec, type Team } from "../src/spec.js";
import { verifyMatch, type OdMatch, type Expectation } from "../src/verify.js";
import { createBracket, recordGame, placements, seedOrder, isComplete, type Bracket } from "../src/bracket.js";
import { planPayout, splitCents } from "../src/payouts.js";
import { checkPayoutBatch } from "../src/gate.js";

const real: OdMatch = JSON.parse(readFileSync(new URL("./fixtures/match_9076476183.json", import.meta.url), "utf8"));
const radIds = real.players.filter((p) => p.isRadiant).map((p) => p.account_id as number);
const direIds = real.players.filter((p) => !p.isRadiant).map((p) => p.account_id as number);

const baseExp = (over: Partial<Expectation> = {}): Expectation => ({
  teamA: { teamId: "alpha", accountIds: radIds },
  teamB: { teamId: "bravo", accountIds: direIds },
  windowStart: new Date((real.start_time - 3600) * 1000).toISOString(),
  windowEnd: new Date((real.start_time + 3600) * 1000).toISOString(),
  leagueId: real.leagueid ?? null,
  minRosterPlayers: 4,
  usedMatchIds: [],
  ...over,
});

describe("verifyMatch on a real OpenDota match", () => {
  it("accepts the right rosters and finds the winner (Dire won)", () => {
    const v = verifyMatch(real, baseExp());
    expect(v.ok).toBe(true);
    expect(v.winnerTeamId).toBe("bravo");
    expect(v.facts.radiantTeamId).toBe("alpha");
  });
  it("works when the teams are listed the other way round", () => {
    const v = verifyMatch(real, baseExp({ teamA: { teamId: "bravo", accountIds: direIds }, teamB: { teamId: "alpha", accountIds: radIds } }));
    expect(v.ok).toBe(true);
    expect(v.winnerTeamId).toBe("bravo");
  });
  it("rejects a match outside the window", () => {
    const v = verifyMatch(real, baseExp({ windowEnd: new Date((real.start_time - 1) * 1000).toISOString() }));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === "in_window")?.pass).toBe(false);
  });
  it("rejects the wrong league", () => {
    expect(verifyMatch(real, baseExp({ leagueId: 1 })).ok).toBe(false);
  });
  it("rejects a match whose players aren't the rostered team", () => {
    const strangers = [1, 2, 3, 4, 5];
    const v = verifyMatch(real, baseExp({ teamB: { teamId: "bravo", accountIds: strangers } }));
    expect(v.ok).toBe(false);
    expect(v.winnerTeamId).toBeNull();
  });
  it("allows one stand-in at minRosterPlayers=4 but not two", () => {
    const one = verifyMatch(real, baseExp({ teamB: { teamId: "bravo", accountIds: [...direIds.slice(0, 4), 7] } }));
    expect(one.ok).toBe(true);
    const two = verifyMatch(real, baseExp({ teamB: { teamId: "bravo", accountIds: [...direIds.slice(0, 3), 7, 8] } }));
    expect(two.ok).toBe(false);
  });
  it("rejects reusing a match id", () => {
    expect(verifyMatch(real, baseExp({ usedMatchIds: [real.match_id] })).ok).toBe(false);
  });
  it("rejects a mixed lobby (rostered players split across sides)", () => {
    const mixedA = [...radIds.slice(0, 3), ...direIds.slice(0, 2)];
    const mixedB = [...direIds.slice(2), ...radIds.slice(3)];
    expect(verifyMatch(real, baseExp({ teamA: { teamId: "alpha", accountIds: mixedA }, teamB: { teamId: "bravo", accountIds: mixedB } })).ok).toBe(false);
  });
});

const spec = TournamentSpec.parse({
  name: "Friday Night Cup",
  game: "dota2",
  format: "single_elimination",
  teamCount: 4,
  bestOf: { default: 1, final: 3 },
  window: { start: "2026-11-01T00:00:00Z", end: "2026-11-30T00:00:00Z" },
  prizeSplit: [
    { place: 1, percent: 60 },
    { place: 2, percent: 30 },
    { place: 3, percent: 10 },
  ],
  organizerFeePercent: 5,
  fundingGoalUsd: 500,
});

const team = (id: string, seed: number, base: number): Team => ({
  id,
  name: id.toUpperCase(),
  seed,
  players: [0, 1, 2, 3, 4].map((k) => ({ name: `${id}-${k}`, accountId: base + k, paypalEmail: `${id}${k}@example.com` })),
});
const teams = [team("aa", 1, 100), team("bb", 2, 200), team("cc", 3, 300), team("dd", 4, 400)];
const win = (b: Bracket, sid: string, winner: string, matchId: number) =>
  recordGame(b, sid, { ok: true, winnerTeamId: winner, loserTeamId: null, checks: [], facts: { matchId } as never });

function finished(): Bracket {
  let b = createBracket(spec, teams);
  b = win(b, "r1m1", "aa", 1); // aa vs dd
  b = win(b, "r1m2", "cc", 2); // bb vs cc, upset
  b = win(b, "r2m1", "aa", 3);
  b = win(b, "r2m1", "cc", 4);
  b = win(b, "r2m1", "aa", 5);
  return b;
}

describe("spec validation", () => {
  it("rejects a split that doesn't sum to 100", () => {
    const r = TournamentSpec.safeParse({ ...spec, prizeSplit: [{ place: 1, percent: 70 }] });
    expect(r.success).toBe(false);
  });
});

describe("bracket", () => {
  it("seeds 8 teams in standard order", () => expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]));
  it("plays a best-of-3 final to completion and ranks the semi losers together", () => {
    const b = finished();
    expect(isComplete(b)).toBe(true);
    expect(placements(b)).toEqual([
      { places: [1], teamIds: ["aa"] },
      { places: [2], teamIds: ["cc"] },
      { places: [3, 4], teamIds: ["dd", "bb"] },
    ]);
  });
  it("refuses a result for an already decided series and a reused match", () => {
    const b = finished();
    expect(() => win(b, "r1m1", "aa", 99)).toThrow();
    let c = createBracket(spec, teams);
    c = win(c, "r1m1", "aa", 1);
    expect(() => win(c, "r1m2", "cc", 1)).toThrow();
  });
});

describe("payouts", () => {
  it("splitCents is exact", () => {
    expect(splitCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitCents(1, [1, 1])).toEqual([1, 0]);
  });
  it("plans an exact split: fee, shared 3rd place, per-player shares", () => {
    const plan = planPayout(50_000, spec, placements(finished()), teams);
    expect(plan.feeCents).toBe(2_500);
    const sum = plan.items.reduce((a, i) => a + i.cents, 0);
    expect(sum).toBe(47_500);
    const byTeam = (t: string) => plan.items.filter((i) => i.teamId === t).reduce((a, i) => a + i.cents, 0);
    expect(byTeam("aa")).toBe(28_500);
    expect(byTeam("cc")).toBe(14_250);
    expect(byTeam("dd") + byTeam("bb")).toBe(4_750);
  });
});

describe("policy gate", () => {
  const b = finished();
  const good = planPayout(50_000, spec, placements(b), teams);
  const base = { spec, bracket: b, teams, capturedCents: 50_000, openDisputes: 0, alreadyPaid: false };
  it("passes the recomputed plan", () => expect(checkPayoutBatch({ ...base, proposed: good })).toEqual([]));
  it("blocks a redirected recipient", () => {
    const evil = structuredClone(good);
    evil.items[0].paypalEmail = "attacker@example.com";
    expect(checkPayoutBatch({ ...base, proposed: evil }).length).toBeGreaterThan(0);
  });
  it("blocks an inflated amount", () => {
    const evil = structuredClone(good);
    evil.items[0].cents += 100;
    expect(checkPayoutBatch({ ...base, proposed: evil }).length).toBeGreaterThan(0);
  });
  it("blocks while a dispute is open, before completion, and on a second payout", () => {
    expect(checkPayoutBatch({ ...base, proposed: good, openDisputes: 1 })).toContain("1 dispute(s) still open");
    expect(checkPayoutBatch({ ...base, proposed: good, alreadyPaid: true }).length).toBeGreaterThan(0);
    expect(checkPayoutBatch({ ...base, bracket: createBracket(spec, teams), proposed: good }).length).toBeGreaterThan(0);
  });
});
