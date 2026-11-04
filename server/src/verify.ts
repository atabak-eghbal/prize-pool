/**
 * Dota 2 result source: decides, in code only, whether an OpenDota match is a valid result
 * for a scheduled bracket match. Only league-ticketed lobbies are visible in public match data,
 * so tournaments using this source must set a league id.
 */
import { checker, inWindow, type Expectation, type Roster, type Verdict } from "./results.js";

export interface OdPlayer {
  account_id: number | null;
  isRadiant?: boolean;
  player_slot?: number;
  leaver_status?: number;
}
export interface OdMatch {
  match_id: number;
  start_time: number; // unix seconds
  duration: number; // seconds
  radiant_win: boolean;
  leagueid?: number;
  human_players?: number;
  players: OdPlayer[];
}

export interface DotaExpectation extends Expectation {
  leagueId: number | null;
  minRosterPlayers: number;
}

const isRadiant = (p: OdPlayer) => p.isRadiant ?? (p.player_slot ?? 0) < 128;

export function verifyDotaMatch(m: OdMatch, e: DotaExpectation): Verdict {
  const c = checker();
  const ref = `dota:${m.match_id}`;
  const radiant = m.players.filter(isRadiant);
  const dire = m.players.filter((p) => !isRadiant(p));
  const ids = (ps: OdPlayer[]) =>
    ps.map((p) => p.account_id).filter((x): x is number => typeof x === "number" && x > 0).map(String);
  const count = (ps: OdPlayer[], r: Roster) => ids(ps).filter((id) => r.ids.includes(id)).length;

  const reused = e.usedRefs.includes(ref);
  c.add("not_reused", !reused, reused ? `match ${m.match_id} was already used for another result` : "not used before");
  c.add("ten_players", m.players.length === 10 && (m.human_players ?? 10) === 10, `${m.players.length} players, ${m.human_players ?? "?"} human`);

  const start = m.start_time * 1000;
  c.add("in_window", inWindow(start, e), `started ${new Date(start).toISOString()}; window ${e.windowStart} to ${e.windowEnd}`);
  if (e.leagueId !== null) c.add("league", m.leagueid === e.leagueId, `match league ${m.leagueid ?? "none"}, expected ${e.leagueId}`);

  const overlap = e.teamA.ids.filter((id) => e.teamB.ids.includes(id));
  c.add("rosters_disjoint", overlap.length === 0, overlap.length ? `players on both rosters: ${overlap.join(", ")}` : "no shared players");

  // Which team played which side? Try both assignments, keep the better one.
  const aRad = count(radiant, e.teamA) + count(dire, e.teamB);
  const aDire = count(dire, e.teamA) + count(radiant, e.teamB);
  const radTeam = aRad >= aDire ? e.teamA : e.teamB;
  const direTeam = radTeam === e.teamA ? e.teamB : e.teamA;
  const onRad = count(radiant, radTeam);
  const onDire = count(dire, direTeam);
  const wrongSide = count(radiant, direTeam) + count(dire, radTeam);
  c.add("rosters_present", onRad >= e.minRosterPlayers && onDire >= e.minRosterPlayers,
    `${radTeam.teamId}: ${onRad}/5 rostered on Radiant, ${direTeam.teamId}: ${onDire}/5 rostered on Dire (need ${e.minRosterPlayers})`);
  c.add("no_side_mixing", wrongSide === 0, wrongSide ? `${wrongSide} rostered player(s) on the opposing side` : "each roster on one side");

  const teamOf = (id: number | null) => {
    const s = id === null ? "" : String(id);
    return e.teamA.ids.includes(s) ? e.teamA.teamId : e.teamB.ids.includes(s) ? e.teamB.teamId : null;
  };
  const ok = c.ok();
  const winner = m.radiant_win ? radTeam : direTeam;
  const loser = winner === radTeam ? direTeam : radTeam;
  return {
    ok,
    winnerTeamId: ok ? winner.teamId : null,
    loserTeamId: ok ? loser.teamId : null,
    checks: c.checks,
    facts: {
      source: "dota",
      ref,
      startTime: new Date(start).toISOString(),
      durationSec: m.duration,
      draw: false,
      details: {
        matchId: m.match_id,
        leagueId: m.leagueid ?? null,
        radiantTeamId: radTeam.teamId,
        direTeamId: direTeam.teamId,
        rosteredOnRadiant: onRad,
        rosteredOnDire: onDire,
        leavers: m.players
          .filter((p) => (p.leaver_status ?? 0) > 0)
          .map((p) => ({ accountId: p.account_id, teamId: teamOf(p.account_id), status: p.leaver_status ?? 0 })),
      },
    },
  };
}
