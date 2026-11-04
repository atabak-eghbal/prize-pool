import { z } from "zod";

/**
 * Event-level tournament configuration. Claude compiles the organizer's plain-English
 * description into this shape; code validates it and feeds errors back to the model.
 * Teams register separately (see Team) because the organizer's text has no account ids.
 */

export const RuleClause = z.object({
  id: z.string().regex(/^R\d{1,2}$/, "rule ids look like R1, R2, ..."),
  /** The organizer's own wording, kept verbatim so rulings can quote it. */
  text: z.string().min(5).max(600),
  /** Machine-checkable parameters the clause implies, when it implies any. */
  kind: z
    .enum(["remake_if_early_disconnect", "stand_in_limit", "forfeit_no_show", "other"])
    .default("other"),
  params: z.record(z.string(), z.number()).default({}),
});
export type RuleClause = z.infer<typeof RuleClause>;

export const PrizeShare = z.object({
  place: z.number().int().min(1).max(16),
  percent: z.number().gt(0).max(100),
});

export const TournamentSpec = z
  .object({
    name: z.string().min(3).max(80),
    game: z.literal("dota2"),
    format: z.literal("single_elimination"),
    teamCount: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
    bestOf: z.object({
      default: z.union([z.literal(1), z.literal(3)]),
      final: z.union([z.literal(1), z.literal(3), z.literal(5)]),
    }),
    /** Matches must start inside this window (ISO 8601, UTC). */
    window: z.object({ start: z.string().datetime(), end: z.string().datetime() }),
    /** Optional Dota league ticket id; when set, every match must belong to it. */
    leagueId: z.number().int().positive().nullable().default(null),
    /** Minimum rostered players per side for a match to count (5 = no stand-ins). */
    minRosterPlayers: z.number().int().min(3).max(5).default(4),
    prizeSplit: z.array(PrizeShare).min(1).max(16),
    organizerFeePercent: z.number().min(0).max(20).default(0),
    fundingGoalUsd: z.number().positive().max(100000),
    rules: z.array(RuleClause).max(20).default([]),
  })
  .superRefine((s, ctx) => {
    const total = s.prizeSplit.reduce((a, p) => a + p.percent, 0);
    if (Math.abs(total - 100) > 1e-6)
      ctx.addIssue({ code: "custom", path: ["prizeSplit"], message: `prize split sums to ${total}%, must be 100%` });
    const places = s.prizeSplit.map((p) => p.place);
    if (new Set(places).size !== places.length)
      ctx.addIssue({ code: "custom", path: ["prizeSplit"], message: "each place may appear once" });
    if (Math.max(...places) > s.teamCount)
      ctx.addIssue({ code: "custom", path: ["prizeSplit"], message: `a place exceeds the number of teams (${s.teamCount})` });
    if (Date.parse(s.window.end) <= Date.parse(s.window.start))
      ctx.addIssue({ code: "custom", path: ["window"], message: "window end must be after start" });
    const ids = s.rules.map((r) => r.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["rules"], message: "rule ids must be unique" });
  });
export type TournamentSpec = z.infer<typeof TournamentSpec>;

export const Player = z.object({
  name: z.string().min(1).max(40),
  /** 32-bit Steam account id as used by OpenDota. */
  accountId: z.number().int().positive(),
  paypalEmail: z.string().email(),
});

export const Team = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,24}$/),
  name: z.string().min(2).max(40),
  seed: z.number().int().min(1).max(16),
  players: z.array(Player).min(5).max(7),
});
export type Team = z.infer<typeof Team>;
