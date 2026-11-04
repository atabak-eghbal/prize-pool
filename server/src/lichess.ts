/**
 * Lichess result source: decides, in code only, whether a Lichess game is a valid result for a
 * bracket match. Two identity modes:
 *  - "accounts": the game's white/black user ids must be the two teams' registered Lichess ids;
 *  - "issued": the app created the game itself (open challenge) and assigned each team a colour
 *    link, so the game id + colour is the identity (used for the no-account judge demo).
 */
import { checker, inWindow, type Expectation, type Verdict } from "./results.js";

export interface LichessGame {
  id: string;
  rated?: boolean;
  variant: string;
  speed?: string;
  createdAt: number; // ms
  lastMoveAt: number; // ms
  status: string; // created, started, aborted, mate, resign, stalemate, timeout, draw, outoftime, cheat, noStart, ...
  winner?: "white" | "black";
  players: {
    white: { user?: { id: string; name: string } };
    black: { user?: { id: string; name: string } };
  };
}

export type LichessIdentity =
  | { mode: "accounts" }
  | { mode: "issued"; gameId: string; whiteTeamId: string; blackTeamId: string };

export interface LichessExpectation extends Expectation {
  identity: LichessIdentity;
  variant: string; // usually "standard"
}

const DECISIVE = new Set(["mate", "resign", "outoftime", "timeout"]);
const DRAWN = new Set(["draw", "stalemate"]);
/** A game ended by Lichess's fair-play system is not a valid result for anyone. */
const VOID = new Set(["cheat", "aborted", "noStart", "unknownFinish"]);

export function verifyLichessGame(g: LichessGame, e: LichessExpectation): Verdict {
  const c = checker();
  const ref = `lichess:${g.id}`;
  const reused = e.usedRefs.includes(ref);
  c.add("not_reused", !reused, reused ? `game ${g.id} was already used for another result` : "not used before");
  c.add("finished", DECISIVE.has(g.status) || DRAWN.has(g.status), `status "${g.status}"${VOID.has(g.status) ? " (void)" : ""}`);
  c.add("variant", g.variant === e.variant, `variant ${g.variant}, expected ${e.variant}`);
  c.add("in_window", inWindow(g.createdAt, e), `created ${new Date(g.createdAt).toISOString()}; window ${e.windowStart} to ${e.windowEnd}`);

  let whiteTeam: string | null = null;
  let blackTeam: string | null = null;
  if (e.identity.mode === "issued") {
    const ok = g.id === e.identity.gameId;
    c.add("issued_game", ok, ok ? `game ${g.id} was issued for this match` : `game ${g.id} is not the game issued for this match (${e.identity.gameId})`);
    whiteTeam = e.identity.whiteTeamId;
    blackTeam = e.identity.blackTeamId;
  } else {
    const w = g.players.white.user?.id ?? "";
    const b = g.players.black.user?.id ?? "";
    const team = (id: string) => (e.teamA.ids.includes(id) ? e.teamA.teamId : e.teamB.ids.includes(id) ? e.teamB.teamId : null);
    whiteTeam = team(w);
    blackTeam = team(b);
    c.add("players_registered", !!whiteTeam && !!blackTeam && whiteTeam !== blackTeam,
      `white ${w || "anonymous"} → ${whiteTeam ?? "not registered"}, black ${b || "anonymous"} → ${blackTeam ?? "not registered"}`);
  }

  const draw = DRAWN.has(g.status);
  const ok = c.ok();
  const winner = ok && !draw && g.winner ? (g.winner === "white" ? whiteTeam : blackTeam) : null;
  const loser = winner ? (winner === whiteTeam ? blackTeam : whiteTeam) : null;
  return {
    ok,
    winnerTeamId: winner,
    loserTeamId: loser,
    checks: c.checks,
    facts: {
      source: "lichess",
      ref,
      startTime: new Date(g.createdAt).toISOString(),
      durationSec: Math.round((g.lastMoveAt - g.createdAt) / 1000),
      draw,
      details: { gameId: g.id, status: g.status, winnerColor: g.winner ?? null, whiteTeamId: whiteTeam, blackTeamId: blackTeam, speed: g.speed ?? null },
    },
  };
}
