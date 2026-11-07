/**
 * First contact with the PayPal sandbox (free, no real money). Prints statuses, never credentials.
 * 1. OAuth token  2. create an AUTHORIZE order (buyer approval comes later, via the JS SDK)
 * 3. send a $1 payout batch  4. read the item status back.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createPayPal, PayPalError } from "../src/paypal.js";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret, PAYPAL_ENVIRONMENT: env } = process.env;
if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env");
if (env && env !== "SANDBOX") throw new Error("this script only runs against the sandbox");

const pp = createPayPal({ clientId: id, clientSecret: secret, env: "SANDBOX" });
// --status <batchId>: only read an earlier batch back, send nothing.
const statusAt = process.argv.indexOf("--status");
if (statusAt > 0) {
  const s = await pp.getPayoutBatch(process.argv[statusAt + 1]);
  console.log(`batch ${s.status}; items ${s.items.map((i) => `$${i.cents / 100} ${i.status}`).join(", ")}`);
  process.exit(0);
}
const run = Date.now().toString(36);
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    const r = await fn();
    console.log(`PASS  ${name}`);
    return r;
  } catch (e) {
    const p = e as PayPalError;
    console.log(`FAIL  ${name}: ${p.message}${p.debugId ? ` (debug ${p.debugId})` : ""}`);
    if (p.details) console.log(JSON.stringify(p.details));
    return null;
  }
};

await step("OAuth token", () => pp.accessToken());
const order = await step("create AUTHORIZE order for $25.00", () =>
  pp.createPledgeOrder({ poolId: `probe-${run}`, pledgeId: `pl-${run}`, cents: 2500, description: "Sandbox probe pledge" }));
if (order) console.log(`      order ${order.id} status ${order.status}`);

const batch = await step("send $1.00 payout batch", () =>
  pp._createPayoutBatch(`probe-${run}`, {
    poolCents: 100, feeCents: 0, distributableCents: 100,
    items: [{ teamId: "t", places: [1], playerName: "Probe", gameId: "0", paypalEmail: "prize-pool-probe@example.com", cents: 100 }],
  }, "Sandbox Probe"));
if (batch) {
  console.log(`      batch ${batch.batchId} status ${batch.status}`);
  await new Promise((r) => setTimeout(r, 8000));
  const s = await step("read batch status", () => pp.getPayoutBatch(batch.batchId));
  if (s) console.log(`      batch ${s.status}; items ${s.items.map((i) => `$${i.cents / 100} ${i.status}`).join(", ")}`);
}
