/**
 * PayPal REST client for the money path: Orders v2 holds (authorize), capture, void, reauthorize,
 * Payouts batches and webhook signature checks. Sandbox by default.
 *
 * Every POST carries a PayPal-Request-Id so a retried call never moves money twice.
 * Payouts are only sent through `sendGatedPayouts`, which refuses unless the policy gate passed.
 */
import type { PayoutPlan } from "./payouts.js";

export type PayPalEnv = "SANDBOX" | "LIVE";
const BASE: Record<PayPalEnv, string> = {
  SANDBOX: "https://api-m.sandbox.paypal.com",
  LIVE: "https://api-m.paypal.com",
};

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly debugId?: string, readonly details?: unknown) {
    super(message);
  }
}

/** 1234 -> "12.34". Integer cents only, so no float rounding ever reaches PayPal. */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`bad cents ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
/** "12.34" -> 1234 (PayPal returns amounts as strings). */
export function valueToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new Error(`bad amount ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env?: PayPalEnv;
  fetch?: typeof fetch;
  /** Called after every request (method, path, status, ms, debug id) for the ledger and logs. */
  onCall?: (c: { method: string; path: string; status: number; ms: number; debugId?: string }) => void;
}

export interface Authorization { id: string; status: string; amountCents: number; expiresAt?: string; orderId: string }
export interface PayoutItemStatus { payoutItemId: string; senderItemId: string; receiver: string; cents: number; status: string }
export interface PayoutBatch { batchId: string; status: string; items: PayoutItemStatus[] }

export function createPayPal(cfg: PayPalConfig) {
  const base = BASE[cfg.env ?? "SANDBOX"];
  const f = cfg.fetch ?? fetch;
  let token: { value: string; expires: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expires - 60_000) return token.value;
    const res = await f(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError(`PayPal auth failed (${res.status})`, res.status);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return token.value;
  }

  async function call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const t0 = Date.now();
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await f(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    cfg.onCall?.({ method, path, status: res.status, ms: Date.now() - t0, debugId });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const issue = json.details?.[0]?.issue ?? json.name ?? "ERROR";
      throw new PayPalError(`PayPal ${method} ${path} -> ${res.status} ${issue}`, res.status, debugId, json.details);
    }
    return json as T;
  }

  const toAuth = (a: any, orderId: string): Authorization => ({
    id: a.id, status: a.status, amountCents: valueToCents(a.amount.value), expiresAt: a.expiration_time, orderId,
  });

  return {
    accessToken,

    /** Step 1 of a pledge: an order with intent AUTHORIZE. The fan approves it with the JS SDK buttons. */
    createPledgeOrder: (o: { poolId: string; pledgeId: string; cents: number; description: string }) =>
      call<{ id: string; status: string; links: { rel: string; href: string }[] }>("POST", "/v2/checkout/orders", {
        intent: "AUTHORIZE",
        purchase_units: [{
          reference_id: o.pledgeId, custom_id: o.poolId, description: o.description.slice(0, 127),
          amount: { currency_code: "USD", value: centsToValue(o.cents) },
        }],
      }, `order-${o.pledgeId}`),

    /** Step 2: after approval, place the hold. Nothing is charged yet. */
    async authorizeOrder(orderId: string): Promise<Authorization> {
      const r = await call<any>("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
      return toAuth(r.purchase_units[0].payments.authorizations[0], orderId);
    },

    /** At the verified final: take the money that was held. */
    async capture(authId: string, cents: number): Promise<{ id: string; status: string; cents: number }> {
      const r = await call<any>("POST", `/v2/payments/authorizations/${authId}/capture`,
        { amount: { currency_code: "USD", value: centsToValue(cents) }, final_capture: true }, `cap-${authId}`);
      return { id: r.id, status: r.status, cents };
    },

    /** Cancelled event: release the hold. The fan was never charged, so there is nothing to refund. */
    void: (authId: string) => call<Record<string, never>>("POST", `/v2/payments/authorizations/${authId}/void`, undefined, `void-${authId}`),

    /** Past the 3-day honor period: renew the hold (allowed once per authorization, days 4-29). */
    async reauthorize(authId: string, cents: number, orderId: string): Promise<Authorization> {
      const r = await call<any>("POST", `/v2/payments/authorizations/${authId}/reauthorize`,
        { amount: { currency_code: "USD", value: centsToValue(cents) } }, `reauth-${authId}`);
      return toAuth(r, orderId);
    },

    getAuthorization: async (authId: string, orderId: string) => toAuth(await call<any>("GET", `/v2/payments/authorizations/${authId}`), orderId),

    /** Low level: prefer sendGatedPayouts. */
    async _createPayoutBatch(batchId: string, plan: PayoutPlan, eventName: string): Promise<PayoutBatch> {
      const r = await call<any>("POST", "/v1/payments/payouts", {
        sender_batch_header: {
          sender_batch_id: batchId,
          email_subject: `Your prize from ${eventName}`,
          email_message: `Verified result, automatic payout. Thanks for playing ${eventName}.`,
        },
        items: plan.items.map((i, n) => ({
          recipient_type: "EMAIL",
          receiver: i.paypalEmail,
          amount: { value: centsToValue(i.cents), currency: "USD" },
          sender_item_id: `${batchId}-${n}`,
          note: `${eventName}: place ${i.places.join("/")} (${i.playerName})`,
        })),
      }, batchId);
      return { batchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status, items: [] };
    },

    async getPayoutBatch(payoutBatchId: string): Promise<PayoutBatch> {
      const r = await call<any>("GET", `/v1/payments/payouts/${payoutBatchId}`);
      return {
        batchId: r.batch_header.payout_batch_id,
        status: r.batch_header.batch_status,
        items: (r.items ?? []).map((i: any) => ({
          payoutItemId: i.payout_item_id,
          senderItemId: i.payout_item.sender_item_id,
          receiver: i.payout_item.receiver,
          cents: valueToCents(i.payout_item.amount.value),
          status: i.transaction_status,
        })),
      };
    },

    /** True only if PayPal confirms the webhook came from PayPal for our webhook id. */
    async verifyWebhook(headers: Record<string, string | undefined>, event: unknown, webhookId: string): Promise<boolean> {
      const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
      const r = await call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId, webhook_event: event,
      });
      return r.verification_status === "SUCCESS";
    },
  };
}
export type PayPal = ReturnType<typeof createPayPal>;

/**
 * The only way money leaves the pool. The gate result is passed in, not trusted from the caller's
 * claim: the caller must hand over the errors array returned by checkPayoutBatch for this exact plan.
 */
export async function sendGatedPayouts(pp: PayPal, o: { poolId: string; plan: PayoutPlan; gateErrors: string[]; eventName: string }) {
  if (o.gateErrors.length) throw new Error(`payout blocked by policy gate: ${o.gateErrors.join("; ")}`);
  if (!o.plan.items.length) throw new Error("payout blocked: empty plan");
  // One batch per pool: PayPal rejects a reused sender_batch_id, which backs up our own alreadyPaid flag.
  return pp._createPayoutBatch(`pool-${o.poolId}`, o.plan, o.eventName);
}
