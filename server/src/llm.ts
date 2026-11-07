/**
 * The model boundary. Everything that needs a model goes through LlmProvider, so the provider can
 * change without touching the compiler, the ruling step or anything that handles money.
 * Models return data only. Each reply is validated in code, and validation errors are fed back.
 */
import { GoogleGenAI } from "@google/genai";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

export interface LlmRequest {
  /** Names the step in the spend log, e.g. "compile" or "ruling". */
  step: string;
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
}
export interface LlmUsage { inputTokens: number; outputTokens: number; thoughtTokens: number }
export interface LlmReply {
  text: string;
  finishReason: string;
  usage: LlmUsage;
  latencyMs: number;
  /** The model that really answered, which can be a fallback. */
  model?: string;
}
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generateJson(req: LlmRequest): Promise<LlmReply>;
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** Tried in order when the first model stays overloaded or out of quota. */
export const GEMINI_FALLBACKS = ["gemini-3.1-flash-lite", "gemini-3.5-flash"];

/** Overload and quota errors can clear with time or on another model. Anything else (a bad key, a bad request) won't. */
export function isTransient(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  return status === 429 || status === 500 || status === 503 || status === 504;
}

/** Retries a transient failure on the same model, then moves down the list. */
export async function withModelFallback<T>(
  models: string[],
  call: (model: string) => Promise<T>,
  opts: { retriesPerModel?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ model: string; result: T }> {
  const retries = opts.retriesPerModel ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return { model, result: await call(model) };
      } catch (e) {
        if (!isTransient(e)) throw e;
        last = e;
        if (attempt < retries) await sleep(2000 * 2 ** attempt);
      }
    }
  }
  throw last;
}

/** A person is waiting on these calls, so a slow model counts as an outage and the next one is tried. */
export const CALL_TIMEOUT_MS = 30_000;

/** Rejects with a transient 504 if the call takes too long. */
export function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`model call took over ${ms} ms`), { status: 504 })), ms);
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

export function createGemini(cfg: { apiKey: string; model?: string; fallbacks?: string[]; timeoutMs?: number }): LlmProvider {
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
  const model = cfg.model ?? DEFAULT_GEMINI_MODEL;
  const models = [model, ...(cfg.fallbacks ?? GEMINI_FALLBACKS).filter((m) => m !== model)];
  return {
    name: "gemini",
    model,
    async generateJson(req) {
      const t0 = Date.now();
      const { model: used, result: r } = await withModelFallback(models, (m) => withTimeout(ai.models.generateContent({
        model: m,
        contents: req.prompt,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: req.jsonSchema,
          maxOutputTokens: req.maxOutputTokens ?? 8000,
        },
      }), cfg.timeoutMs ?? CALL_TIMEOUT_MS), { retriesPerModel: 1 });
      const u = r.usageMetadata;
      return {
        text: r.text ?? "",
        finishReason: String(r.candidates?.[0]?.finishReason ?? "UNKNOWN"),
        usage: {
          inputTokens: u?.promptTokenCount ?? 0,
          outputTokens: u?.candidatesTokenCount ?? 0,
          thoughtTokens: u?.thoughtsTokenCount ?? 0,
        },
        latencyMs: Date.now() - t0,
        model: used,
      };
    },
  };
}

/** Logs provider, model, step, tokens and latency for every call. Prompts and replies are not logged. */
export function withUsageLog(p: LlmProvider, path: string): LlmProvider {
  return {
    name: p.name,
    model: p.model,
    async generateJson(req) {
      const r = await p.generateJson(req);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({
        at: new Date().toISOString(), provider: p.name, model: r.model ?? p.model, step: req.step,
        ...r.usage, latencyMs: r.latencyMs, finishReason: r.finishReason,
      })}\n`);
      return r;
    },
  };
}

export type ExtraCheck<T> = (value: T) => string[];
export class LlmValidationError extends Error {
  constructor(message: string, readonly errors: string[], readonly attempts: number) {
    super(message);
  }
}

/**
 * Calls the model until its reply parses, matches the schema and passes the extra checks, feeding
 * the errors back each time. Throws LlmValidationError when the attempts run out.
 */
export async function generateValidated<S extends z.ZodTypeAny>(
  provider: LlmProvider,
  req: LlmRequest,
  schema: S,
  opts: { maxAttempts?: number; extraCheck?: ExtraCheck<z.infer<S>> } = {},
): Promise<{ value: z.infer<S>; attempts: number }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let prompt = req.prompt;
  let errors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reply = await provider.generateJson({ ...req, prompt });
    errors = validate(reply.text, schema, opts.extraCheck);
    if (reply.finishReason === "MAX_TOKENS") errors = ["the reply was cut off: answer more briefly", ...errors];
    if (!errors.length) return { value: schema.parse(JSON.parse(reply.text)), attempts: attempt };
    prompt = `${req.prompt}\n\nYour previous reply was rejected. Previous reply:\n${reply.text.slice(0, 6000)}\n\nFix these errors and reply again in full:\n- ${errors.join("\n- ")}`;
  }
  throw new LlmValidationError(`no valid reply after ${maxAttempts} attempts`, errors, maxAttempts);
}

function validate<S extends z.ZodTypeAny>(text: string, schema: S, extra?: ExtraCheck<z.infer<S>>): string[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return ["the reply was not valid JSON"];
  }
  const r = schema.safeParse(json);
  if (!r.success) return r.error.issues.map((i: z.ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return extra ? extra(r.data) : [];
}
