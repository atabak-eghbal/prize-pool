/**
 * Live clients for the public result sources, with an on-disk cache so the demo and tests
 * never hammer the free APIs (OpenDota: 60/min, 3,000/day without a key).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { OdMatch } from "./verify.js";
import type { LichessGame } from "./lichess.js";

const CACHE_DIR = process.env.PRIZEPOOL_CACHE_DIR ?? join(process.cwd(), "data", "cache");
const UA = "prize-pool/0.1 (+https://github.com/atabak-eghbal/prize-pool)";

export class SourceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function getJson<T>(url: string, opts: { cacheKey?: string; accept?: string; timeoutMs?: number } = {}): Promise<T> {
  const path = opts.cacheKey ? join(CACHE_DIR, `${opts.cacheKey}.json`) : null;
  if (path && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: opts.accept ?? "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new SourceError(`${new URL(url).host} returned ${res.status} for ${new URL(url).pathname}`, res.status);
  const body = (await res.json()) as T;
  if (path) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(body));
  }
  return body;
}

export interface OdLeagueMatch {
  match_id: number;
  start_time: number;
  duration: number;
  radiant_win: boolean;
  radiant_team_id: number | null;
  dire_team_id: number | null;
  leagueid: number;
}

export const opendota = {
  /** A finished match never changes, so it is cached forever. */
  match: (id: number) => getJson<OdMatch & { radiant_team_id?: number; dire_team_id?: number }>(`https://api.opendota.com/api/matches/${id}`, { cacheKey: `od-match-${id}` }),
  /** League match lists change while a league runs: not cached. */
  leagueMatches: (leagueId: number) => getJson<OdLeagueMatch[]>(`https://api.opendota.com/api/leagues/${leagueId}/matches`),
};

export const lichess = {
  /** Only finished games are cached (an ongoing game's status changes). */
  async game(id: string): Promise<LichessGame> {
    const g = await getJson<LichessGame>(`https://lichess.org/game/export/${id}?moves=false`, { accept: "application/json" });
    const done = !["created", "started"].includes(g.status);
    if (done) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(join(CACHE_DIR, `li-game-${id}.json`), JSON.stringify(g));
    }
    return g;
  },
  /** Creates a game any two people can join from the colour links, with no accounts. */
  async openChallenge(name: string, clockLimitSec = 180, incrementSec = 2) {
    const res = await fetch("https://lichess.org/api/challenge/open", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "clock.limit": String(clockLimitSec), "clock.increment": String(incrementSec), name }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new SourceError(`lichess open challenge returned ${res.status}`, res.status);
    return (await res.json()) as { id: string; url: string; urlWhite: string; urlBlack: string; status: string };
  },
};
