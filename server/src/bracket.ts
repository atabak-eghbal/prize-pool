import type { TournamentSpec, Team } from "./spec.js";
import type { Verdict } from "./verify.js";

export interface Game {
  matchId: number;
  winnerTeamId: string;
}
export interface Series {
  id: string; // e.g. "r1m2"
  round: number; // 1 = first round
  index: number; // position within round, 0-based
  bestOf: number;
  teamA: string | null;
  teamB: string | null;
  games: Game[];
  winner: string | null;
}
export interface Bracket {
  rounds: number;
  series: Series[];
}

/** Standard seeding order, e.g. 8 teams -> [1,8,4,5,2,7,3,6]. */
export function seedOrder(n: number): number[] {
  let order = [1, 2];
  while (order.length < n) {
    const m = order.length * 2 + 1;
    order = order.flatMap((s) => [s, m - s]);
  }
  return order;
}

export function createBracket(spec: TournamentSpec, teams: Team[]): Bracket {
  if (teams.length !== spec.teamCount) throw new Error(`need ${spec.teamCount} teams, have ${teams.length}`);
  const bySeed = new Map(teams.map((t) => [t.seed, t.id]));
  if (bySeed.size !== teams.length) throw new Error("seeds must be unique");
  const rounds = Math.log2(spec.teamCount);
  const order = seedOrder(spec.teamCount).map((s) => {
    const id = bySeed.get(s);
    if (!id) throw new Error(`missing seed ${s}`);
    return id;
  });
  const series: Series[] = [];
  for (let r = 1; r <= rounds; r++) {
    const n = spec.teamCount >> r;
    for (let i = 0; i < n; i++) {
      series.push({
        id: `r${r}m${i + 1}`,
        round: r,
        index: i,
        bestOf: r === rounds ? spec.bestOf.final : spec.bestOf.default,
        teamA: r === 1 ? order[2 * i] : null,
        teamB: r === 1 ? order[2 * i + 1] : null,
        games: [],
        winner: null,
      });
    }
  }
  return { rounds, series };
}

export const winsNeeded = (bestOf: number) => Math.floor(bestOf / 2) + 1;

export function getSeries(b: Bracket, id: string): Series {
  const s = b.series.find((x) => x.id === id);
  if (!s) throw new Error(`no series ${id}`);
  return s;
}

/** Apply a verified game result. Throws if the verdict doesn't fit this series. */
export function recordGame(b: Bracket, seriesId: string, v: Verdict): Bracket {
  const next: Bracket = structuredClone(b);
  const s = getSeries(next, seriesId);
  if (!v.ok || !v.winnerTeamId) throw new Error("only verified results can be recorded");
  if (s.winner) throw new Error(`series ${seriesId} is already decided`);
  if (!s.teamA || !s.teamB) throw new Error(`series ${seriesId} has no opponents yet`);
  if (![s.teamA, s.teamB].includes(v.winnerTeamId)) throw new Error("winner is not in this series");
  if (next.series.some((x) => x.games.some((g) => g.matchId === v.facts.matchId)))
    throw new Error(`match ${v.facts.matchId} already recorded`);
  s.games.push({ matchId: v.facts.matchId, winnerTeamId: v.winnerTeamId });
  const need = winsNeeded(s.bestOf);
  for (const t of [s.teamA, s.teamB]) {
    if (s.games.filter((g) => g.winnerTeamId === t).length >= need) s.winner = t;
  }
  if (s.winner && s.round < next.rounds) {
    const parent = getSeries(next, `r${s.round + 1}m${Math.floor(s.index / 2) + 1}`);
    if (s.index % 2 === 0) parent.teamA = s.winner;
    else parent.teamB = s.winner;
  }
  return next;
}

export const isComplete = (b: Bracket) => getSeries(b, `r${b.rounds}m1`).winner !== null;

export interface PlaceGroup {
  /** Places shared by this group, e.g. [3,4] for semi-final losers. */
  places: number[];
  teamIds: string[];
}

/** Final placements; teams knocked out in the same round share the places of that round. */
export function placements(b: Bracket): PlaceGroup[] {
  if (!isComplete(b)) throw new Error("bracket not complete");
  const final = getSeries(b, `r${b.rounds}m1`);
  const loserOf = (s: Series) => (s.winner === s.teamA ? s.teamB : s.teamA) as string;
  const groups: PlaceGroup[] = [
    { places: [1], teamIds: [final.winner as string] },
    { places: [2], teamIds: [loserOf(final)] },
  ];
  for (let r = b.rounds - 1; r >= 1; r--) {
    const losers = b.series.filter((s) => s.round === r).map(loserOf);
    const first = (1 << (b.rounds - r)) + 1; // round r losers take places first..2*first-2
    groups.push({ places: losers.map((_, i) => first + i), teamIds: losers });
  }
  return groups;
}
