import { describe, it, expect } from "vitest";
import { createPayPal, sendGatedPayouts, centsToValue, valueToCents, PayPalError } from "../src/paypal.js";
import type { PayoutPlan } from "../src/payouts.js";

type Req = { url: string; method: string; headers: Record<string, string>; body: any };

/** A fake PayPal that records requests and answers from a route table. */
function fakePayPal(routes: Record<string, (r: Req) => { status?: number; json?: unknown }>) {
  const log: Req[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body && headers["Content-Type"] === "application/json" ? JSON.parse(String(init.body)) : init.body;
    const req = { url, method: init.method ?? "GET", headers, body };
    log.push(req);
    const path = new URL(url).pathname;
    const key = Object.keys(routes).find((k) => new RegExp(`^${k}$`).test(`${req.method} ${path}`));
    if (!key) return new Response(JSON.stringify({ name: "NOT_ROUTED" }), { status: 404 });
    const out = routes[key](req);
    return new Response(out.json === undefined ? null : JSON.stringify(out.json), {
      status: out.status ?? 200, headers: { "paypal-debug-id": "dbg123" },
    });
  }) as unknown as typeof fetch;
  return { f, log };
}
const tokenRoute = { "POST /v1/oauth2/token": () => ({ json: { access_token: "tok", expires_in: 3600 } }) };

describe("amounts", () => {
  it("cents <-> PayPal strings, exact", () => {
    expect(centsToValue(0)).toBe("0.00");
    expect(centsToValue(5)).toBe("0.05");
    expect(centsToValue(123456)).toBe("1234.56");
    expect(valueToCents("12.3")).toBe(1230);
    expect(valueToCents("12.34")).toBe(1234);
    expect(valueToCents("7")).toBe(700);
    for (let c = 0; c < 2000; c += 7) expect(valueToCents(centsToValue(c))).toBe(c);
    expect(() => centsToValue(1.5)).toThrow();
    expect(() => centsToValue(-1)).toThrow();
  });
});

describe("pledge lifecycle", () => {
  it("order AUTHORIZE -> hold -> capture, with idempotency keys and one token", async () => {
    const { f, log } = fakePayPal({
      ...tokenRoute,
      "POST /v2/checkout/orders": () => ({ status: 201, json: { id: "O1", status: "CREATED", links: [] } }),
      "POST /v2/checkout/orders/O1/authorize": () => ({ status: 201, json: { purchase_units: [{ payments: { authorizations: [{ id: "A1", status: "CREATED", amount: { value: "25.00" }, expiration_time: "2026-12-04T00:00:00Z" }] } }] } }),
      "POST /v2/payments/authorizations/A1/capture": () => ({ status: 201, json: { id: "C1", status: "COMPLETED" } }),
    });
    const pp = createPayPal({ clientId: "id", clientSecret: "sec", fetch: f });
    const o = await pp.createPledgeOrder({ poolId: "p1", pledgeId: "pl1", cents: 2500, description: "Pledge to Smoke Cup" });
    expect(o.id).toBe("O1");
    const a = await pp.authorizeOrder("O1");
    expect(a).toMatchObject({ id: "A1", amountCents: 2500, orderId: "O1" });
    const c = await pp.capture("A1", 2500);
    expect(c.status).toBe("COMPLETED");

    expect(log.filter((r) => r.url.endsWith("/oauth2/token"))).toHaveLength(1);
    const order = log.find((r) => r.url.endsWith("/v2/checkout/orders"))!;
    expect(order.body.intent).toBe("AUTHORIZE");
    expect(order.body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "25.00" });
    expect(order.headers["PayPal-Request-Id"]).toBe("order-pl1");
    expect(log.find((r) => r.url.endsWith("/capture"))!.body).toEqual({ amount: { currency_code: "USD", value: "25.00" }, final_capture: true });
    expect(log.filter((r) => r.method === "POST" && !r.url.endsWith("/token")).every((r) => r.headers["PayPal-Request-Id"])).toBe(true);
    expect(log.every((r) => r.url.startsWith("https://api-m.sandbox.paypal.com"))).toBe(true);
  });

  it("void returns cleanly on 204 and errors carry the PayPal issue and debug id", async () => {
    const { f } = fakePayPal({
      ...tokenRoute,
      "POST /v2/payments/authorizations/A1/void": () => ({ status: 204 }),
      "POST /v2/payments/authorizations/A2/capture": () => ({ status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] } }),
    });
    const pp = createPayPal({ clientId: "id", clientSecret: "sec", fetch: f });
    await expect(pp.void("A1")).resolves.toEqual({});
    const err = await pp.capture("A2", 100).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.message).toContain("AUTHORIZATION_VOIDED");
    expect(err.debugId).toBe("dbg123");
  });
});

const plan: PayoutPlan = {
  poolCents: 10_000, feeCents: 0, distributableCents: 10_000,
  items: [
    { teamId: "t1", places: [1], playerName: "Ana", gameId: "1", paypalEmail: "ana@example.com", cents: 7000 },
    { teamId: "t2", places: [2], playerName: "Bo", gameId: "2", paypalEmail: "bo@example.com", cents: 3000 },
  ],
};

describe("payouts", () => {
  it("refuses to send when the gate reported anything", async () => {
    const { f, log } = fakePayPal({ ...tokenRoute });
    const pp = createPayPal({ clientId: "id", clientSecret: "sec", fetch: f });
    await expect(sendGatedPayouts(pp, { poolId: "p1", plan, gateErrors: ["recipient mismatch"], eventName: "Cup" })).rejects.toThrow(/policy gate/);
    expect(log).toHaveLength(0); // not even a token request
  });

  it("sends one batch per pool with exact amounts, then reads item statuses", async () => {
    const { f, log } = fakePayPal({
      ...tokenRoute,
      "POST /v1/payments/payouts": () => ({ status: 201, json: { batch_header: { payout_batch_id: "B1", batch_status: "PENDING" } } }),
      "GET /v1/payments/payouts/B1": () => ({ json: { batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" }, items: [
        { payout_item_id: "I1", transaction_status: "SUCCESS", payout_item: { sender_item_id: "pool-p1-0", receiver: "ana@example.com", amount: { value: "70.00" } } },
        { payout_item_id: "I2", transaction_status: "UNCLAIMED", payout_item: { sender_item_id: "pool-p1-1", receiver: "bo@example.com", amount: { value: "30.00" } } },
      ] } }),
    });
    const pp = createPayPal({ clientId: "id", clientSecret: "sec", fetch: f });
    const b = await sendGatedPayouts(pp, { poolId: "p1", plan, gateErrors: [], eventName: "Cup" });
    expect(b).toMatchObject({ batchId: "B1", status: "PENDING" });
    const sent = log.find((r) => r.url.endsWith("/v1/payments/payouts"))!;
    expect(sent.body.sender_batch_header.sender_batch_id).toBe("pool-p1");
    expect(sent.headers["PayPal-Request-Id"]).toBe("pool-p1");
    expect(sent.body.items.map((i: any) => [i.receiver, i.amount.value])).toEqual([["ana@example.com", "70.00"], ["bo@example.com", "30.00"]]);
    const s = await pp.getPayoutBatch("B1");
    expect(s.items.map((i) => [i.cents, i.status])).toEqual([[7000, "SUCCESS"], [3000, "UNCLAIMED"]]);
  });
});
