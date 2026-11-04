/**
 * Result checker: decides, in code only, whether an OpenDota match is a valid result
 * for a scheduled bracket match. No model is involved in this decision.
 */

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

export interface Roster {
  teamId: string;
  accountIds: number[];
}

export interface Expectation {
  teamA: Roster;
  teamB: Roster;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  leagueId: number | null;
  minRosterPlayers: number;
  /** Matches already accepted for any bracket slot; a match id counts once. */
  usedMatchIds: number[];
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface MatchFacts {
  matchId: number;
  startTime: string;
  durationSec: number;
  radiantTeamId: string | null;
  direTeamId: string | null;
  rosteredOnRadiant: number;
  rosteredOnDire: number;
  leavers: { accountId: number | null; teamId: string | null; status: number }[];
}

export interface Verdict {
  ok: boolean;
  winnerTeamId: string | null;
  loserTeamId: string | null;
  checks: Check[];
  facts: MatchFacts;
}

const isRadiant = (p: OdPlayer) => (p.isRadiant ?? (p.player_slot ?? 0) < 128);

export function verifyMatch(m: OdMatch, e: Expectation): Verdict {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  const radiant = m.players.filter(isRadiant);
  const dire = m.players.filter((p) => !isRadiant(p));
  const ids = (ps: OdPlayer[]) => ps.map((p) => p.account_id).filter((x): x is number => typeof x === "number" && x > 0);
  const count = (ps: OdPlayer[], r: Roster) => ids(ps).filter((id) => r.accountIds.includes(id)).length;

  add("not_reused", !e.usedMatchIds.includes(m.match_id), `match ${m.match_id} ${e.usedMatchIds.includes(m.match_id) ? "was already used for another result" : "not used before"}`);
  add("ten_players", m.players.length === 10 && (m.human_players ?? 10) === 10, `${m.players.length} players, ${m.human_players ?? "?"} human`);

  const start = m.start_time * 1000;
  const inWindow = start >= Date.parse(e.windowStart) && start <= Date.parse(e.windowEnd);
  add("in_window", inWindow, `started ${new Date(start).toISOString()}; window ${e.windowStart} to ${e.windowEnd}`);

  if (e.leagueId !== null)
    add("league", m.leagueid === e.leagueId, `match league ${m.leagueid ?? "none"}, expected ${e.leagueId}`);

  const overlap = e.teamA.accountIds.filter((id) => e.teamB.accountIds.includes(id));
  add("rosters_disjoint", overlap.length === 0, overlap.length ? `players on both rosters: ${overlap.join(", ")}` : "no shared players");

  // Which team played which side? Try both assignments, keep the better one.
  const aRad = count(radiant, e.teamA) + count(dire, e.teamB);
  const aDire = count(dire, e.teamA) + count(radiant, e.teamB);
  const aIsRadiant = aRad >= aDire;
  const radTeam = aIsRadiant ? e.teamA : e.teamB;
  const direTeam = aIsRadiant ? e.teamB : e.teamA;
  const onRad = count(radiant, radTeam);
  const onDire = count(dire, direTeam);
  // An opponent's rostered player on the wrong side means the lobby doesn't match the bracket.
  const wrongSide = count(radiant, direTeam) + count(dire, radTeam);
  add("rosters_present", onRad >= e.minRosterPlayers && onDire >= e.minRosterPlayers,
    `${radTeam.teamId}: ${onRad}/5 rostered on Radiant, ${direTeam.teamId}: ${onDire}/5 rostered on Dire (need ${e.minRosterPlayers})`);
  add("no_side_mixing", wrongSide === 0, wrongSide ? `${wrongSide} rostered player(s) on the opposing side` : "each roster on one side");

  const teamOf = (id: number | null) =>
    id === null ? null : e.teamA.accountIds.includes(id) ? e.teamA.teamId : e.teamB.accountIds.includes(id) ? e.teamB.teamId : null;
  const facts: MatchFacts = {
    matchId: m.match_id,
    startTime: new Date(start).toISOString(),
    durationSec: m.duration,
    radiantTeamId: radTeam.teamId,
    direTeamId: direTeam.teamId,
    rosteredOnRadiant: onRad,
    rosteredOnDire: onDire,
    leavers: m.players
      .filter((p) => (p.leaver_status ?? 0) > 0)
      .map((p) => ({ accountId: p.account_id, teamId: teamOf(p.account_id), status: p.leaver_status ?? 0 })),
  };

  const ok = checks.every((c) => c.pass);
  const winner = m.radiant_win ? radTeam : direTeam;
  const loser = m.radiant_win ? direTeam : radTeam;
  return { ok, winnerTeamId: ok ? winner.teamId : null, loserTeamId: ok ? loser.teamId : null, checks, facts };
}
