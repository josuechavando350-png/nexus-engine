import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteDurableEventStream } from "../event-budget-stream/index";

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
  readonly frequencyWindowSeconds: number;
  readonly tiers: readonly CouponTier[];
}

export interface CouponDecision {
  readonly action: "NO_OFFER" | "OFFER";
  readonly reason: "INELIGIBLE" | "NO_POLICY_TIER" | "MARGIN_GUARDRAIL" | "OFFER_ALLOWED";
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
}

export class Cortex19Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "FREQUENCY_LIMIT" | "KILLED", message: string) {
    super(message);
    this.name = "Cortex19Error";
  }
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Cortex19Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}
function roundMoney(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }

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
  const price = finite(raw.price, "price", 0.01, 1e12); const variableCost = finite(raw.variableCost, "variableCost", 0, 1e12);
  if (variableCost > price) throw new Cortex19Error("INVALID_INPUT", "variableCost cannot exceed price");
  return Object.freeze({ requestId: raw.requestId, subjectHash: raw.subjectHash, sku: raw.sku, price, variableCost, currency: raw.currency, eligible: raw.eligible, probabilityEvidence: parseEvidence(raw.probabilityEvidence) });
}

function parsePolicy(value: unknown): CouponPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex19Error("INVALID_INPUT", "coupon policy must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "frequencyWindowSeconds,maxCouponsPerWindow,maxDiscountBps,minProfitAmount,tiers") throw new Cortex19Error("INVALID_INPUT", "coupon policy contract contains missing or unsupported fields");
  const minProfitAmount = finite(raw.minProfitAmount, "minProfitAmount", 0, 1e12);
  const maxDiscountBps = finite(raw.maxDiscountBps, "maxDiscountBps", 0, 10_000);
  const maxCouponsPerWindow = finite(raw.maxCouponsPerWindow, "maxCouponsPerWindow", 1, 100);
  const frequencyWindowSeconds = finite(raw.frequencyWindowSeconds, "frequencyWindowSeconds", 60, 31_536_000);
  if (!Number.isInteger(maxDiscountBps) || !Number.isInteger(maxCouponsPerWindow) || !Number.isInteger(frequencyWindowSeconds)) throw new Cortex19Error("INVALID_INPUT", "integer coupon policy fields must be integers");
  if (!Array.isArray(raw.tiers) || raw.tiers.length < 1 || raw.tiers.length > 20) throw new Cortex19Error("INVALID_INPUT", "coupon tiers must contain 1-20 entries");
  const tiers = raw.tiers.map((item): CouponTier => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).sort().join(",") !== "discountBps,probabilityAtOrBelow") throw new Cortex19Error("INVALID_INPUT", "coupon tier contract is invalid");
    const tier = item as Record<string, unknown>;
    const probabilityAtOrBelow = finite(tier.probabilityAtOrBelow, "probabilityAtOrBelow", 0, 1);
    const discountBps = finite(tier.discountBps, "discountBps", 0, maxDiscountBps);
    if (!Number.isInteger(discountBps)) throw new Cortex19Error("INVALID_INPUT", "discountBps must be an integer");
    return Object.freeze({ probabilityAtOrBelow, discountBps });
  }).sort((a, b) => a.probabilityAtOrBelow - b.probabilityAtOrBelow || b.discountBps - a.discountBps);
  return Object.freeze({ minProfitAmount, maxDiscountBps, maxCouponsPerWindow, frequencyWindowSeconds, tiers: Object.freeze(tiers) });
}

export function decideCoupon(requestInput: unknown, policyInput: unknown): CouponDecision {
  const request = parseRequest(requestInput); const policy = parsePolicy(policyInput);
  if (!request.eligible) return Object.freeze({ action: "NO_OFFER", reason: "INELIGIBLE", discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: roundMoney(request.price - request.variableCost) });
  const tier = policy.tiers.find((item) => request.probabilityEvidence.probability <= item.probabilityAtOrBelow);
  if (!tier || tier.discountBps <= 0) return Object.freeze({ action: "NO_OFFER", reason: "NO_POLICY_TIER", discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: roundMoney(request.price - request.variableCost) });
  const requestedDiscount = request.price * tier.discountBps / 10_000;
  const maxSafeDiscount = Math.max(0, request.price - request.variableCost - policy.minProfitAmount);
  if (requestedDiscount - maxSafeDiscount > 1e-9) return Object.freeze({ action: "NO_OFFER", reason: "MARGIN_GUARDRAIL", discountBps: 0, discountAmount: 0, priceAfterDiscount: request.price, profitAfterDiscount: roundMoney(request.price - request.variableCost) });
  const discountAmount = roundMoney(requestedDiscount); const priceAfterDiscount = roundMoney(request.price - discountAmount); const profitAfterDiscount = roundMoney(priceAfterDiscount - request.variableCost);
  return Object.freeze({ action: "OFFER", reason: "OFFER_ALLOWED", discountBps: tier.discountBps, discountAmount, priceAfterDiscount, profitAfterDiscount });
}

export class SqliteCouponIssuer {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly signingSecret: string, private readonly modeProvider: () => "ACTIVE" | "OBSERVE_ONLY" | "KILLED", private readonly now: () => number = Date.now) {
    if (!databasePath || signingSecret.length < 32) throw new Cortex19Error("INVALID_INPUT", "coupon issuer configuration is invalid");
    this.db = new DatabaseSync(databasePath); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex19_issuances(
      request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,subject_hash TEXT NOT NULL,sku TEXT NOT NULL,code TEXT,issued_at TEXT,decision_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS cortex19_subject_time ON cortex19_issuances(subject_hash,issued_at);
    CREATE TABLE IF NOT EXISTS cortex19_outbox(event_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);`);
  }
  close(): void { this.db.close(); }

  issue(requestInput: unknown, policyInput: unknown): CouponIssuance {
    const request = parseRequest(requestInput); const policy = parsePolicy(policyInput); const decision = decideCoupon(request, policy);
    const requestDigest = `sha256:${createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex")}`;
    const existing = this.db.prepare("SELECT request_digest,decision_json FROM cortex19_issuances WHERE request_id=?").get(request.requestId) as Record<string, unknown> | undefined;
    if (existing) { if (existing.request_digest !== requestDigest) throw new Cortex19Error("CONFLICT", "requestId is already bound to different coupon content"); return JSON.parse(String(existing.decision_json)) as CouponIssuance; }
    if (this.modeProvider() === "KILLED") throw new Cortex19Error("KILLED", "coupon injector is killed");
    if (decision.action !== "OFFER" || this.modeProvider() !== "ACTIVE") {
      const issuance = Object.freeze({ ...decision, requestId: request.requestId, code: null, issuedAt: null, frequencyCount: 0 });
      this.db.prepare("INSERT INTO cortex19_issuances(request_id,request_digest,subject_hash,sku,code,issued_at,decision_json) VALUES(?,?,?,?,?,?,?)").run(request.requestId, requestDigest, request.subjectHash, request.sku, null, null, JSON.stringify(issuance));
      return issuance;
    }
    const policyWindowStart = new Date(this.now() - policy.frequencyWindowSeconds * 1_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const countRow = this.db.prepare("SELECT COUNT(*) count FROM cortex19_issuances WHERE subject_hash=? AND issued_at IS NOT NULL AND issued_at>=?").get(request.subjectHash, policyWindowStart) as { count?: unknown };
      const count = Number(countRow.count ?? 0);
      if (count >= policy.maxCouponsPerWindow) { this.db.exec("ROLLBACK"); throw new Cortex19Error("FREQUENCY_LIMIT", "coupon frequency limit reached"); }
      // Final kill-switch check after acquiring the ledger lock and immediately before issuance.
      if (this.modeProvider() !== "ACTIVE") { this.db.exec("ROLLBACK"); throw new Cortex19Error("KILLED", "coupon injector was disabled before issuance"); }
      const issuedAt = new Date(this.now()).toISOString();
      const code = `NX-${createHmac("sha256", this.signingSecret).update(`${request.requestId}\0${request.subjectHash}\0${request.sku}`, "utf8").digest("hex").slice(0, 12).toUpperCase()}`;
      const issuance: CouponIssuance = Object.freeze({ ...decision, requestId: request.requestId, code, issuedAt, frequencyCount: count + 1 });
      this.db.prepare("INSERT INTO cortex19_issuances(request_id,request_digest,subject_hash,sku,code,issued_at,decision_json) VALUES(?,?,?,?,?,?,?)").run(request.requestId, requestDigest, request.subjectHash, request.sku, code, issuedAt, JSON.stringify(issuance));
      const eventId = `coupon-${createHash("sha256").update(request.requestId).digest("hex").slice(0, 24)}`;
      const eventPayload = { stream: "coupon.issued", eventId, occurredAt: issuedAt, payload: { requestIdHash: `sha256:${createHash("sha256").update(request.requestId).digest("hex")}`, sku: request.sku, currency: request.currency, discountBps: decision.discountBps, discountAmount: decision.discountAmount, probabilityModelId: request.probabilityEvidence.modelId, probabilityModelDigest: request.probabilityEvidence.modelDigest } };
      this.db.prepare("INSERT INTO cortex19_outbox(event_id,payload_json,sent) VALUES(?,?,0)").run(eventId, JSON.stringify(eventPayload));
      this.db.exec("COMMIT"); return issuance;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  flushEvents(stream: SqliteDurableEventStream, limit = 100): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Cortex19Error("INVALID_INPUT", "flush limit is invalid");
    const rows = this.db.prepare("SELECT event_id,payload_json FROM cortex19_outbox WHERE sent=0 ORDER BY event_id LIMIT ?").all(limit) as Record<string, unknown>[];
    let sent = 0;
    for (const row of rows) { stream.append(JSON.parse(String(row.payload_json)) as unknown); this.db.prepare("UPDATE cortex19_outbox SET sent=1 WHERE event_id=?").run(String(row.event_id)); sent += 1; }
    return sent;
  }
}
