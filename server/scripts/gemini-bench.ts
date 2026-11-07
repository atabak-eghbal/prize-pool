/**
 * Measures latency and correctness of candidate models on the real compile step, with no fallback,
 * so the default model is picked from data. Usage: tsx scripts/gemini-bench.ts model1 model2 ...
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createGemini, withUsageLog } from "../src/llm.js";
import { compileSpec } from "../src/compile.js";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY must be set in .env");
const usagePath = fileURLToPath(new URL("../data/spend.jsonl", import.meta.url));
const description = `Saturday Night Dota is our Discord's monthly Dota 2 cup, league ticket 19944. Four teams, single elimination, every round best of one but the final is best of three. It runs next Saturday, November 14 2026, from 18:00 to 23:00 UTC. We want to raise $300. First place gets 70%, second gets 30%. I take no fee.
Rules: If a player disconnects in the first 5 minutes the game is replayed. Each team may use at most one stand-in.`;

for (const model of process.argv.slice(2)) {
  const llm = withUsageLog(createGemini({ apiKey, model, fallbacks: [], timeoutMs: 60_000 }), usagePath);
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    let outcome: string;
    try {
      const r = await compileSpec(llm, description, new Date("2026-11-06T12:00:00Z"));
      const right = r.status === "ok" && r.spec.leagueId === 19944 && r.spec.rules.length === 2 && r.spec.bestOf.final === 3;
      outcome = `${r.status} attempts=${r.attempts} correct=${right}`;
    } catch (e) {
      outcome = `error ${(e as Error).message.slice(0, 100)}`;
    }
    console.log(`${model}  run ${i + 1}: ${((Date.now() - t0) / 1000).toFixed(1)} s  ${outcome}`);
  }
}
