/**
 * Game-agnostic result types. Each result source (Dota 2 via OpenDota, chess via Lichess, ...)
 * turns a public match record into a Verdict, in code only. Money logic never sees raw game data.
 */

export type SourceId = "dota" | "lichess";

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Facts {
  source: SourceId;
  /** Stable, unique id of the result, e.g. "dota:9076476183" or "lichess:MgCqgD99". */
  ref: string;
  startTime: string; // ISO
  durationSec: number;
  /** A finished game with no winner (chess draw). The bracket needs a replay. */
  draw: boolean;
  /** Source-specific details shown to people and to the ruling agent (leavers, termination, ...). */
  details: Record<string, unknown>;
}

export interface Verdict {
  ok: boolean;
  winnerTeamId: string | null;
  loserTeamId: string | null;
  checks: Check[];
  facts: Facts;
}

export interface Roster {
  teamId: string;
  /** Source identities: Dota 32-bit account ids as strings, Lichess user ids (lowercase). */
  ids: string[];
}

export interface Expectation {
  teamA: Roster;
  teamB: Roster;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  /** Result refs already accepted for any bracket slot; a result counts once. */
  usedRefs: string[];
}

export const checker = () => {
  const checks: Check[] = [];
  return {
    checks,
    add(name: string, pass: boolean, detail: string) {
      checks.push({ name, pass, detail });
    },
    ok: () => checks.every((c) => c.pass),
  };
};

export const inWindow = (startMs: number, e: Expectation) =>
  startMs >= Date.parse(e.windowStart) && startMs <= Date.parse(e.windowEnd);
