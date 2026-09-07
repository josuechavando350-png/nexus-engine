import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

export interface CouponProbabilityEvidence {
  readonly probability: number;
  readonly modelId: string;
  readonly modelDigest: string;
}

export interface CouponRequest {
  readonly requestId: string;
  readonly subjectHash: string;
  readonly sku: string;
  readonly price: number;
  readonly variableCost: number;
  readonly currency: string;
  readonly eligible: boolean;
  readonly probabilityEvidence: CouponProbabilityEvidence;
}

export interface CouponTier {
  readonly probabilityAtOrBelow: number;
  readonly discountBps: number;
}

export interface CouponPolicy {
  readonly minProfitAmount: number;
  readonly maxDiscountBps: number;
  readonly maxCouponsPerWindow: number;
  readonly maxDiscountCostPerWindow: number;
  readonly frequencyWindowSeconds: number;
  readonly tiers: readonly CouponTier[];
}

export type CouponDecisionReason = "INELIGIBLE" | "NO_POLICY_TIER" | "MARGIN_GUARDRAIL" | "FREQUENCY_CAP" | "COST_CAP" | "OFFER_ALLOWED";

export interface CouponDecision {
  readonly action: "NO_OFFER" | "OFFER";
  readonly reason: CouponDecisionReason;
  readonly discountBps: number;
  readonly discountAmount: number;
  readonly priceAfterDiscount: number;
  readonly profitAfterDiscount: number;
}

export interface CouponIssuance extends CouponDecision {
  readonly requestId: string;
  readonly code: string | null;
  readonly issuedAt: string | null;
  readonly frequencyCount: number;
  readonly windowDiscountCost: number;
}

export interface DurableCouponEventInput {
  readonly stream: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export class Cortex19Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "KILLED" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "Cortex19Error";
  }
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Cortex19Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}
function moneyCents(value: unknown, label: string): number {
  const parsed = finite(value, label, 0, 1e12);
  const cents = Math.round(parsed * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(parsed * 100 - cents) > 1e-7) throw new Cortex19Error("INVALID_INPUT", `${label} must use at most two decimal places`);
  return cents;
}
function fromCents(value: number): number { return value / 100; }

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function parseEvidence(value: unknown): CouponProbabilityEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex19Error("INVALID_INPUT", "probabilityEvidence must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "modelDigest,modelId,probability" || typeof raw.modelId !== "string" || !ID.test(raw.modelId) || typeof raw.modelDigest !== "string" || !SHA256.test(raw.modelDigest)) throw new Cortex19Error("INVALID_INPUT", "probability evidence identity is invalid");
  return Object.freeze({ probability: finite(raw.probability, "probability", 0, 1), modelId: raw.modelId, modelDigest: raw.modelDigest });
}

function parseRequest(value: unknown): CouponRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex19Error("INVALID_INPUT", "coupon request must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "currency,eligible,price,probabilityEvidence,requestId,sku,subjectHash,variableCost") throw new Cortex19Error("INVALID_INPUT", "coupon request contract contains missing or unsupported fields");
  if (typeof raw.requestId !== "string" || !ID.test(raw.requestId) || typeof raw.subjectHash !== "string" || !SHA256.test(raw.subjectHash) || typeof raw.sku !== "string" || !ID.test(raw.sku) || typeof raw.currency !== "string" || !CURRENCY.test(raw.currency) || typeof raw.eligible !== "boolean") throw new Cortex19Error("INVALID_INPUT", "coupon request identity is invalid");
  const priceCents = moneyCents(raw.price, "price"); const variableCostCents = moneyCents(raw.variableCost, "variableCost");
  if (priceCents < 1 || variableCostCents > priceCents) throw new Cortex19Error("INVALID_INPUT", "price/variableCost are inconsistent");
  return Object.freeze({ requestId: raw.requestId, subjectHash: raw.subjectHash, sku: raw.sku, price: fromCents(priceCents), variableCost: fromCents(variableCostCents), currency: raw.currency, eligible: raw.eligible, probabilityEvidence: parseEvidence(raw.probabilityEvidence) });
}

function parsePolicy(value: unknown): CouponPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex19Error("INVALID_INPUT", "coupon policy must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "frequencyWindowSeconds,maxCouponsPerWindow,maxDiscountBps,maxDiscountCostPerWindow,minProfitAmount,tiers") throw new Cortex19Error("INVALID_INPUT", "coupon policy contract contains missing or unsupported fields");
  const minProfitAmount = fromCents(moneyCents(raw.minProfitAmount, "minProfitAmount"));
  const maxDiscountBps = finite(raw.maxDiscountBps, "maxDiscountBps", 0, 10_000);
  const maxCouponsPerWindow = finite(raw.maxCouponsPerWindow, "maxCouponsPerWindow", 1, 100_000);
  const maxDiscountCostPerWindow = fromCents(moneyCents(raw.maxDiscountCostPerWindow, "maxDiscountCostPerWindow"));
  const frequencyWindowSeconds = finite(raw.frequencyWindowSeconds, "frequencyWindowSeconds", 60, 31_536_000);
  if (!Number.isInteger(maxDiscountBps) || !Number.isInteger(maxCouponsPerWindow) || !Number.isInteger(frequencyWindowSeconds)) throw new Cortex19Error("INVALID_INPUT", "integer coupon policy fields must be integers");
  if (!Array.isArray(raw.tiers) || raw.tiers.length < 1 || raw.tiers.length > 20) throw new Cortex19Error("INVALID_INPUT", "coupon tiers must contain 1-20 entries");
  const thresholds = new Set<number>();
  const tiers = raw.tiers.map((item): CouponTier => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).sort().join(",") !== "discountBps,probabilityAtOrBelow") throw new Cortex19Error("INVALID_INPUT", "coupon tier contract is invalid");
    const tier = item as Record<string, unknown>;
    const probabilityAtOrBelow = finite(tier.probabilityAtOrBelow, "probabilityAtOrBelow", 0, 1);
    const discountBps = finite(tier.discountBps, "discountBps", 0, maxDiscountBps);
    if (!Number.isInteger(discountBps) || thresholds.has(probabilityAtOrBelow)) throw new Cortex19Error("INVALID_INPUT", "coupon tier threshold is duplicated or discountBps is not an integer");
    thresholds.add(probabilityAtOrBelow);
    return Object.freeze({ probabilityAtOrBelow, discountBps });
  }).sort((a, b) => a.probabilityAtOrBelow - b.probabilityAtOrBelow || b.discountBps - a.discountBps);
  return Object.freeze({ minProfitAmount, maxDiscountBps, maxCouponsPerWindow, maxDiscountCostPerWindow, frequencyWindowSeconds, tiers: Object.freeze(tiers) });
}

export function decideCoupon(requestInput: unknown, policyInput: unknown): CouponDecision {
  const request = parseRequest(requestInput); const policy = parsePolicy(policyInput);
  const priceCents = moneyCents(request.price, "price"); const variableCostCents = moneyCents(request.variableCost, "variableCost"); const minProfitCents = moneyCents(policy.minProfitAmount, "minProfitAmount");
  if (!request.eligible) return Object.freeze({ action: "NO_OFFER", reason: "INELIGIBLE", discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: fromCents(priceCents - variableCostCents) });
  const tier = policy.tiers.find((item) => request.probabilityEvidence.probability <= item.probabilityAtOrBelow);
  if (!tier || tier.discountBps <= 0) return Object.freeze({ action: "NO_OFFER", reason: "NO_POLICY_TIER", discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: fromCents(priceCents - variableCostCents) });
  const discountCents = Math.floor(priceCents * tier.discountBps / 10_000);
  if (discountCents < 1) return Object.freeze({ action: "NO_OFFER", reason: "NO_POLICY_TIER", discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: fromCents(priceCents - variableCostCents) });
  const maxSafeDiscountCents = Math.max(0, priceCents - variableCostCents - minProfitCents);
  if (discountCents > maxSafeDiscountCents) return Object.freeze({ action: "NO_OFFER", reason: "MARGIN_GUARDRAIL", discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: fromCents(priceCents - variableCostCents) });
  const priceAfterCents = priceCents - discountCents; const profitAfterCents = priceAfterCents - variableCostCents;
  return Object.freeze({ action: "OFFER", reason: "OFFER_ALLOWED", discountBps: tier.discountBps, discountAmount: fromCents(discountCents), priceAfterDiscount: fromCents(priceAfterCents), profitAfterDiscount: fromCents(profitAfterCents) });
}

function issuanceProjection(decision: CouponDecision, request: CouponRequest): CouponIssuance {
  return Object.freeze({ ...decision, requestId: request.requestId, code: null, issuedAt: null, frequencyCount: 0, windowDiscountCost: 0 });
}
function noOfferFrom(reason: "FREQUENCY_CAP" | "COST_CAP", request: CouponRequest, frequencyCount: number, windowDiscountCostCents: number): CouponIssuance {
  const priceCents = moneyCents(request.price, "price"); const variableCostCents = moneyCents(request.variableCost, "variableCost");
  return Object.freeze({ action: "NO_OFFER", reason, discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: fromCents(priceCents - variableCostCents), requestId: request.requestId, code: null, issuedAt: null, frequencyCount, windowDiscountCost: fromCents(windowDiscountCostCents) });
}

function safeMode(provider: () => "ACTIVE" | "OBSERVE_ONLY" | "KILLED"): "ACTIVE" | "OBSERVE_ONLY" | "KILLED" {
  try { const mode = provider(); return mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED" ? mode : "KILLED"; }
  catch { return "KILLED"; }
}

export class SqliteCouponIssuer {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly signingSecret: string, private readonly modeProvider: () => "ACTIVE" | "OBSERVE_ONLY" | "KILLED", private readonly now: () => number = Date.now) {
    if (!databasePath || signingSecret.length < 32 || signingSecret.length > 4096 || /[\r\n\0]/u.test(signingSecret) || typeof modeProvider !== "function") throw new Cortex19Error("INVALID_INPUT", "coupon issuer configuration is invalid");
    this.db = new DatabaseSync(databasePath); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex19_issuances(
      request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,subject_hash TEXT NOT NULL,sku TEXT NOT NULL,currency TEXT NOT NULL,
      code TEXT,issued_at TEXT,discount_cents INTEGER NOT NULL CHECK(discount_cents>=0),decision_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS cortex19_subject_time ON cortex19_issuances(subject_hash,issued_at);
    CREATE INDEX IF NOT EXISTS cortex19_currency_time ON cortex19_issuances(currency,issued_at);
    CREATE TABLE IF NOT EXISTS cortex19_outbox(event_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)));`);
  }
  close(): void { this.db.close(); }

  issue(requestInput: unknown, policyInput: unknown): CouponIssuance {
    const request = parseRequest(requestInput); const policy = parsePolicy(policyInput); const decision = decideCoupon(request, policy);
    const requestDigest = `sha256:${createHash("sha256").update(canonical({ request, policy }), "utf8").digest("hex")}`;
    const existing = this.db.prepare("SELECT request_digest,decision_json FROM cortex19_issuances WHERE request_id=?").get(request.requestId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Cortex19Error("CONFLICT", "requestId is already bound to different coupon request or policy content");
      return JSON.parse(String(existing.decision_json)) as CouponIssuance;
    }
    const initialMode = safeMode(this.modeProvider);
    if (initialMode === "KILLED") throw new Cortex19Error("KILLED", "coupon injector is killed");
    if (initialMode === "OBSERVE_ONLY") return issuanceProjection(decision, request);

    const nowMs = this.now(); if (!Number.isFinite(nowMs)) throw new Cortex19Error("INTEGRITY_FAILURE", "clock returned an invalid value");
    const policyWindowStart = new Date(nowMs - policy.frequencyWindowSeconds * 1_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.db.prepare("SELECT request_digest,decision_json FROM cortex19_issuances WHERE request_id=?").get(request.requestId) as Record<string, unknown> | undefined;
      if (raced) {
        if (raced.request_digest !== requestDigest) throw new Cortex19Error("CONFLICT", "requestId is already bound to different coupon request or policy content");
        this.db.exec("COMMIT"); return JSON.parse(String(raced.decision_json)) as CouponIssuance;
      }
      const countRow = this.db.prepare("SELECT COUNT(*) count FROM cortex19_issuances WHERE subject_hash=? AND issued_at IS NOT NULL AND issued_at>=?").get(request.subjectHash, policyWindowStart) as { count?: unknown };
      const count = Number(countRow.count ?? 0);
      const costRow = this.db.prepare("SELECT COALESCE(SUM(discount_cents),0) cost_cents FROM cortex19_issuances WHERE currency=? AND issued_at IS NOT NULL AND issued_at>=?").get(request.currency, policyWindowStart) as { cost_cents?: unknown };
      const currentWindowCostCents = Number(costRow.cost_cents ?? 0);
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(currentWindowCostCents) || currentWindowCostCents < 0) throw new Cortex19Error("INTEGRITY_FAILURE", "coupon ledger is invalid");
      if (safeMode(this.modeProvider) !== "ACTIVE") throw new Cortex19Error("KILLED", "coupon injector was disabled before durable decision");

      let issuance: CouponIssuance;
      if (decision.action !== "OFFER") {
        issuance = issuanceProjection(decision, request);
      } else if (count >= policy.maxCouponsPerWindow) {
        issuance = noOfferFrom("FREQUENCY_CAP", request, count, currentWindowCostCents);
      } else {
        const discountCents = moneyCents(decision.discountAmount, "discountAmount");
        const maxWindowCostCents = moneyCents(policy.maxDiscountCostPerWindow, "maxDiscountCostPerWindow");
        if (currentWindowCostCents + discountCents > maxWindowCostCents) {
          issuance = noOfferFrom("COST_CAP", request, count, currentWindowCostCents);
        } else {
          const issuedAt = new Date(nowMs).toISOString();
          const code = `NX-${createHmac("sha256", this.signingSecret).update(`${request.requestId}\0${request.subjectHash}\0${request.sku}`, "utf8").digest("hex").slice(0, 12).toUpperCase()}`;
          issuance = Object.freeze({ ...decision, requestId: request.requestId, code, issuedAt, frequencyCount: count + 1, windowDiscountCost: fromCents(currentWindowCostCents + discountCents) });
          const eventId = `coupon-${createHash("sha256").update(request.requestId).digest("hex").slice(0, 24)}`;
          const eventPayload: DurableCouponEventInput = { stream: "coupon.issued", eventId, occurredAt: issuedAt, payload: { requestIdHash: `sha256:${createHash("sha256").update(request.requestId).digest("hex")}`, sku: request.sku, currency: request.currency, discountBps: decision.discountBps, discountAmount: decision.discountAmount, probabilityModelId: request.probabilityEvidence.modelId, probabilityModelDigest: request.probabilityEvidence.modelDigest } };
          this.db.prepare("INSERT INTO cortex19_outbox(event_id,payload_json,sent) VALUES(?,?,0)").run(eventId, JSON.stringify(eventPayload));
        }
      }
      this.db.prepare("INSERT INTO cortex19_issuances(request_id,request_digest,subject_hash,sku,currency,code,issued_at,discount_cents,decision_json) VALUES(?,?,?,?,?,?,?,?,?)").run(request.requestId, requestDigest, request.subjectHash, request.sku, request.currency, issuance.code, issuance.issuedAt, moneyCents(issuance.discountAmount, "discountAmount"), JSON.stringify(issuance));
      this.db.exec("COMMIT"); return issuance;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}