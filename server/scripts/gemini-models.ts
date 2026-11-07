/** Lists the Gemini models this API key can call for text generation. Never prints the key. */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY must be set in .env");

const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
  headers: { "x-goog-api-key": key },
});
if (!res.ok) throw new Error(`models list returned ${res.status}`);
const { models } = (await res.json()) as {
  models: { name: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number; outputTokenLimit?: number }[];
};
for (const m of models.filter((x) => x.supportedGenerationMethods?.includes("generateContent")))
  console.log(`${m.name.replace("models/", "")}  in=${m.inputTokenLimit} out=${m.outputTokenLimit}`);
