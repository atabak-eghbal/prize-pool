/**
 * Smoke test against LIVE public data (free APIs, no keys, no money):
 *  1. OpenDota: find a real 4-team mini-bracket inside a league (two semis + a final between
 *     the semi winners), build rosters from the real lobbies, run the whole pipeline:
 *     spec -> bracket -> verify each real match -> placements -> payout plan -> policy gate.
 *  2. Negative checks on live data: wrong league, reused match, tampered payout.
 *  3. Lichess: fetch a real finished game and verify it; optionally create an open challenge.
 * Usage: npx tsx scripts/smoke.ts [leagueId] [--challenge]
 */
import { opendota, lichess } from "../src/sources.js";
import { verifyDotaMatch, type DotaExpectation } from "../src/verify.js";
import { verifyLichessGame } from "../src/lichess.js";
import { TournamentSpec, type Team } from "../src/spec.js";
import { createBracket, recordGame, placements, isComplete } from "../src/bracket.js";
import { planPayout } from "../src/payouts.js";
import { checkPayoutBatch } from "../src/gate.js";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

async function dota(leagueId: number) {
  const all = (await opendota.leagueMatches(leagueId))
    .filter((m) => m.radiant_team_id && m.dire_team_id)
    .sort((a, b) => a.start_time - b.start_time);
  ok(all.length > 0, `OpenDota league ${leagueId}: ${all.length} matches with team ids`);
  const winnerOf = (m: (typeof all)[number]) => (m.radiant_win ? m.radiant_team_id : m.dire_team_id)!;
  const loserOf = (m: (typeof all)[number]) => (m.radiant_win ? m.dire_team_id : m.radiant_team_id)!;
  // Find semi1, semi2 (four distinct teams) and a later final between their winners.
  let found: [typeof all[number], typeof all[number], typeof all[number]] | null = null;
  outer: for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const teams = new Set([a.radiant_team_id, a.dire_team_id, b.radiant_team_id, b.dire_team_id]);
      if (teams.size !== 4 || b.start_time - a.start_time > 3 * 86400) continue; // same event weekend
      const fin = all.find((f) => f.start_time > Math.max(a.start_time, b.start_time) &&
        f.start_time - b.start_time < 3 * 86400 &&
        new Set([f.radiant_team_id, f.dire_team_id, winnerOf(a), winnerOf(b)]).size === 2);
      if (fin) { found = [a, b, fin]; break outer; }
    }
  ok(!!found, "found a real semi/semi/final chain in the league");
  if (!found) return;
  const [s1, s2, fin] = found;
  const details = await Promise.all([s1, s2, fin].map((m) => opendota.match(m.match_id)));
  ok(details.every((d) => d.players?.length === 10), "fetched full match details (10 players each)");

  // Rosters from the semi-final lobbies (pseudonymous names; real account ids).
  const rosterOf = (d: (typeof details)[number], teamId: number) => {
    const radiant = d.radiant_team_id === teamId;
    return d.players.filter((p) => (p.isRadiant ?? (p.player_slot ?? 0) < 128) === radiant).map((p) => String(p.account_id));
  };
  const ids = [s1.radiant_team_id!, s1.dire_team_id!, s2.radiant_team_id!, s2.dire_team_id!];
  // Seeds so that the semis are 1v4 and 2v3 as in the real league.
  const seeds = [1, 4, 2, 3];
  const teams: Team[] = ids.map((tid, k) => {
    const d = k < 2 ? details[0] : details[1];
    return {
      id: `t${tid}`, name: `Team ${String.fromCharCode(65 + k)}`, seed: seeds[k],
      players: rosterOf(d, tid).map((gid, n) => ({ name: `P${k + 1}.${n + 1}`, gameId: gid, paypalEmail: `p${k + 1}${n + 1}@example.com` })),
    };
  });
  const starts = [s1, s2, fin].map((m) => m.start_time * 1000);
  const spec = TournamentSpec.parse({
    name: "Smoke Cup", game: "dota2", format: "single_elimination", teamCount: 4,
    bestOf: { default: 1, final: 1 },
    window: { start: new Date(Math.min(...starts) - 3600e3).toISOString(), end: new Date(Math.max(...starts) + 3600e3).toISOString() },
    leagueId, minRosterPlayers: 4,
    prizeSplit: [{ place: 1, percent: 70 }, { place: 2, percent: 30 }],
    fundingGoalUsd: 300,
  });
  let b = createBracket(spec, teams);
  const used: string[] = [];
  const exp = (a: string, c: string): DotaExpectation => ({
    teamA: { teamId: a, ids: teams.find((t) => t.id === a)!.players.map((p) => p.gameId) },
    teamB: { teamId: c, ids: teams.find((t) => t.id === c)!.players.map((p) => p.gameId) },
    windowStart: spec.window.start, windowEnd: spec.window.end, usedRefs: used, leagueId, minRosterPlayers: 4,
  });
  for (const [k, sid] of [[0, "r1m1"], [1, "r1m2"], [2, "r2m1"]] as const) {
    const s = b.series.find((x) => x.id === sid)!;
    const v = verifyDotaMatch(details[k], exp(s.teamA!, s.teamB!));
    const real = `t${k < 2 ? winnerOf([s1, s2][k]) : winnerOf(fin)}`;
    ok(v.ok && v.winnerTeamId === real, `${sid} match ${details[k].match_id}: verified, winner ${v.winnerTeamId} (real ${real})`);
    if (!v.ok) { console.log(v.checks.filter((c) => !c.pass)); return; }
    b = recordGame(b, sid, v);
    used.push(v.facts.ref);
  }
  ok(isComplete(b), "bracket complete");
  const groups = placements(b);
  ok(groups[0].teamIds[0] === `t${winnerOf(fin)}` && groups[1].teamIds[0] === `t${loserOf(fin)}`, "placements match the real final");
  const plan = planPayout(30_000, spec, groups, teams);
  ok(plan.items.reduce((a, i) => a + i.cents, 0) === 30_000, `payout plan sums exactly to $300 (${plan.items.length} items)`);
  const base = { spec, bracket: b, teams, capturedCents: 30_000, openDisputes: 0, alreadyPaid: false };
  ok(checkPayoutBatch({ ...base, proposed: plan }).length === 0, "gate passes the recomputed plan");
  const evil = structuredClone(plan); evil.items[0].paypalEmail = "attacker@example.com";
  ok(checkPayoutBatch({ ...base, proposed: evil }).length > 0, "gate blocks a redirected payout");

  // Negative checks on live data.
  ok(!verifyDotaMatch(details[0], { ...exp(b.series[0].teamA!, b.series[0].teamB!), leagueId: leagueId + 1 }).ok, "wrong league rejected");
  ok(!verifyDotaMatch(details[0], { ...exp(b.series[0].teamA!, b.series[0].teamB!), usedRefs: [`dota:${details[0].match_id}`] }).ok, "reused match rejected");
  ok(!verifyDotaMatch(details[2], exp(b.series[0].teamA!, b.series[0].teamB!)).ok || b.series[0].teamA === b.series[2].teamA,
    "a match between other teams is rejected for this series");
}

async function chess(withChallenge: boolean) {
  const g = await lichess.game("MgCqgD99");
  const v = verifyLichessGame(g, {
    teamA: { teamId: "kings", ids: ["see-hear-feel"] }, teamB: { teamId: "rooks", ids: ["jaime_sonho01"] },
    windowStart: new Date(g.createdAt - 60e3).toISOString(), windowEnd: new Date(g.createdAt + 60e3).toISOString(),
    usedRefs: [], identity: { mode: "accounts" }, variant: "standard",
  });
  ok(v.ok && v.winnerTeamId === "rooks", `Lichess game ${g.id} (${g.status}, winner ${g.winner}) verified live`);
  if (withChallenge) {
    const c = await lichess.openChallenge("Prize Pool smoke");
    ok(!!c.urlWhite && !!c.urlBlack, `open challenge created without an account: ${c.url}`);
  }
}

const leagueId = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 19944);
const t0 = Date.now();
await dota(leagueId).catch((e) => ok(false, `dota smoke threw: ${e.message}`));
await chess(process.argv.includes("--challenge")).catch((e) => ok(false, `chess smoke threw: ${e.message}`));
console.log(`\n${failures === 0 ? "SMOKE OK" : `SMOKE FAILED (${failures})`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
