import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteSemanticSearchIndex } from "./index.js";
import {
  planNegativeKeyword,
  type NegativeKeywordPlan,
  type SearchTermCoverageSnapshot,
  type SearchTermNegativePolicy,
} from "./pmax-coverage.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type Cortex35Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type NegativeKeywordActionStatus = "PREPARED" | "DISPATCHING" | "APPLIED" | "AMBIGUOUS" | "ROLLED_BACK";

export interface NegativeKeywordMutationGateway {
  collectCoverage(): Promise<SearchTermCoverageSnapshot>;
  applyCampaignNegative(plan: NegativeKeywordPlan, maxManagedNegativesPerCampaign: number): Promise<{ resourceName: string; requestId: string | null; alreadyExists: boolean }>;
}

export interface NegativeKeywordRollbackGateway {
  remove(resourceName: string, idempotencyKey: string): Promise<{ requestId: string | null }>;
}

export interface Cortex35WorkerPolicy extends SearchTermNegativePolicy {
  readonly maxMutationsPerRun: number;
}

export interface NegativeKeywordActionRecord {
  readonly actionId: string;
  readonly planDigest: `sha256:${string}`;
  readonly campaignId: string;
  readonly termHash: `sha256:${string}`;
  readonly sourceCoverage: NegativeKeywordPlan["sourceCoverage"];
  readonly resourceName: string | null;
  readonly status: NegativeKeywordActionStatus;
  readonly remoteRequestId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class Cortex35WorkerError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "CONFLICT" | "MODE_BLOCKED" | "INTEGRITY_FAILURE" | "AMBIGUOUS_REMOTE_STATE",
    message: string,
  ) {
    super(message);
    this.name = "Cortex35WorkerError";
  }
}

function digest(value: unknown): `sha256:${string}` {
  const canonical = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function termHash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function negativeKeywordActionId(plan: NegativeKeywordPlan): string {
  return `neg-${createHash("sha256")
    .update(`${plan.campaignId}\0${plan.channel}\0${plan.searchTerm}\0${plan.matchType}\0${plan.sourceCoverage}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function planDigest(plan: NegativeKeywordPlan): `sha256:${string}` {
  return digest({
    campaignId: plan.campaignId,
    channel: plan.channel,
    matchType: plan.matchType,
    reason: plan.reason,
    relevanceScore: plan.relevanceScore,
    sourceCoverage: plan.sourceCoverage,
    termHash: termHash(plan.searchTerm),
  });
}

function safeMode(provider: () => Cortex35Mode): Cortex35Mode {
  try {
    const mode = provider();
    return mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED" ? mode : "KILLED";
  } catch {
    return "KILLED";
  }
}

export class SqliteNegativeKeywordActionLedger {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new Cortex35WorkerError("INVALID_CONFIG", "negative-keyword ledger databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex35_negative_actions_v2(
      action_id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      term_hash TEXT NOT NULL,
      source_coverage TEXT NOT NULL,
      resource_name TEXT,
      status TEXT NOT NULL CHECK(status IN ('PREPARED','DISPATCHING','APPLIED','AMBIGUOUS','ROLLED_BACK')),
      remote_request_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  get(id: string): NegativeKeywordActionRecord | undefined {
    if (!ID.test(id)) throw new Cortex35WorkerError("INVALID_INPUT", "negative actionId is malformed");
    const row = this.db.prepare("SELECT * FROM cortex35_negative_actions_v2 WHERE action_id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const status = String(row.status) as NegativeKeywordActionStatus;
    const record: NegativeKeywordActionRecord = {
      actionId: String(row.action_id),
      planDigest: String(row.plan_digest) as `sha256:${string}`,
      campaignId: String(row.campaign_id),
      termHash: String(row.term_hash) as `sha256:${string}`,
      sourceCoverage: String(row.source_coverage) as NegativeKeywordPlan["sourceCoverage"],
      resourceName: row.resource_name === null ? null : String(row.resource_name),
      status,
      remoteRequestId: row.remote_request_id === null ? null : String(row.remote_request_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (
      !SHA256.test(record.planDigest) ||
      !SHA256.test(record.termHash) ||
      !/^\d{1,20}$/u.test(record.campaignId) ||
      !(record.sourceCoverage === "SEARCH_TERM_VIEW" || record.sourceCoverage === "PMAX_CAMPAIGN_SEARCH_TERM_VIEW") ||
      !(record.status === "PREPARED" || record.status === "DISPATCHING" || record.status === "APPLIED" || record.status === "AMBIGUOUS" || record.status === "ROLLED_BACK") ||
      ((record.status === "APPLIED" || record.status === "ROLLED_BACK") && !record.resourceName) ||
      ((record.status === "PREPARED" || record.status === "DISPATCHING" || record.status === "AMBIGUOUS") && record.resourceName !== null) ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt))
    ) {
      throw new Cortex35WorkerError("INTEGRITY_FAILURE", "stored negative-keyword action is corrupt");
    }
    return Object.freeze(record);
  }

  prepare(plan: NegativeKeywordPlan): NegativeKeywordActionRecord {
    const id = negativeKeywordActionId(plan);
    const expectedDigest = planDigest(plan);
    const existing = this.get(id);
    if (existing) {
      if (existing.planDigest !== expectedDigest) throw new Cortex35WorkerError("CONFLICT", "negative action is already bound to different plan evidence");
      return existing;
    }
    const now = new Date(this.now()).toISOString();
    this.db.prepare(`INSERT INTO cortex35_negative_actions_v2(
      action_id,plan_digest,campaign_id,term_hash,source_coverage,resource_name,status,remote_request_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,NULL,'PREPARED',NULL,?,?)`).run(
      id,
      expectedDigest,
      plan.campaignId,
      termHash(plan.searchTerm),
      plan.sourceCoverage,
      now,
      now,
    );
    return this.get(id)!;
  }

  markDispatching(id: string): NegativeKeywordActionRecord {
    const current = this.get(id);
    if (!current) throw new Cortex35WorkerError("INVALID_INPUT", "negative action is not found");
    if (current.status !== "PREPARED") throw new Cortex35WorkerError("CONFLICT", `negative action cannot dispatch from ${current.status}`);
    const updatedAt = new Date(this.now()).toISOString();
    const changed = this.db.prepare("UPDATE cortex35_negative_actions_v2 SET status='DISPATCHING',updated_at=? WHERE action_id=? AND status='PREPARED'").run(updatedAt, id);
    if (changed.changes !== 1) throw new Cortex35WorkerError("CONFLICT", "negative dispatch lost compare-and-set boundary");
    return this.get(id)!;
  }

  markAmbiguous(id: string): NegativeKeywordActionRecord {
    const current = this.get(id);
    if (!current) throw new Cortex35WorkerError("INVALID_INPUT", "negative action is not found");
    if (current.status === "AMBIGUOUS") return current;
    if (current.status !== "DISPATCHING") throw new Cortex35WorkerError("CONFLICT", `negative action cannot become ambiguous from ${current.status}`);
    const updatedAt = new Date(this.now()).toISOString();
    const changed = this.db.prepare("UPDATE cortex35_negative_actions_v2 SET status='AMBIGUOUS',updated_at=? WHERE action_id=? AND status='DISPATCHING'").run(updatedAt, id);
    if (changed.changes !== 1) throw new Cortex35WorkerError("CONFLICT", "negative ambiguity transition lost compare-and-set boundary");
    return this.get(id)!;
  }

  commitApplied(plan: NegativeKeywordPlan, resourceName: string, requestId: string | null): NegativeKeywordActionRecord {
    const id = negativeKeywordActionId(plan);
    const expectedDigest = planDigest(plan);
    if (!resourceName) throw new Cortex35WorkerError("INTEGRITY_FAILURE", "negative mutation receipt is missing resourceName");
    const current = this.get(id);
    if (!current) throw new Cortex35WorkerError("INVALID_INPUT", "negative action was not prepared");
    if (current.planDigest !== expectedDigest) throw new Cortex35WorkerError("CONFLICT", "negative action plan evidence changed before commit");
    if (current.status === "APPLIED") {
      if (current.resourceName !== resourceName) throw new Cortex35WorkerError("CONFLICT", "negative action is bound to another remote resource");
      return current;
    }
    if (current.status !== "DISPATCHING") throw new Cortex35WorkerError("CONFLICT", `negative action cannot commit from ${current.status}`);
    const updatedAt = new Date(this.now()).toISOString();
    const changed = this.db.prepare("UPDATE cortex35_negative_actions_v2 SET status='APPLIED',resource_name=?,remote_request_id=?,updated_at=? WHERE action_id=? AND status='DISPATCHING'").run(resourceName, requestId, updatedAt, id);
    if (changed.changes !== 1) throw new Cortex35WorkerError("CONFLICT", "negative commit lost compare-and-set boundary");
    return this.get(id)!;
  }

  markRolledBack(id: string, requestId: string | null): NegativeKeywordActionRecord {
    const current = this.get(id);
    if (!current) throw new Cortex35WorkerError("INVALID_INPUT", "negative action is not found");
    if (current.status === "ROLLED_BACK") return current;
    if (current.status !== "APPLIED" || !current.resourceName) throw new Cortex35WorkerError("AMBIGUOUS_REMOTE_STATE", "only a confirmed applied negative can be rolled back");
    const updatedAt = new Date(this.now()).toISOString();
    const changed = this.db.prepare("UPDATE cortex35_negative_actions_v2 SET status='ROLLED_BACK',remote_request_id=?,updated_at=? WHERE action_id=? AND status='APPLIED'").run(requestId, updatedAt, id);
    if (changed.changes !== 1) throw new Cortex35WorkerError("CONFLICT", "negative rollback lost compare-and-set boundary");
    return this.get(id)!;
  }
}

export interface Cortex35WorkerOptions {
  readonly index: SqliteSemanticSearchIndex;
  readonly googleAds: NegativeKeywordMutationGateway;
  readonly rollbackGateway: NegativeKeywordRollbackGateway;
  readonly ledger: SqliteNegativeKeywordActionLedger;
  readonly policy: Cortex35WorkerPolicy;
  readonly readMode: () => Cortex35Mode;
}

export class Cortex35SearchTermWorker {
  constructor(private readonly options: Cortex35WorkerOptions) {
    if (!Number.isSafeInteger(options.policy.maxMutationsPerRun) || options.policy.maxMutationsPerRun < 1 || options.policy.maxMutationsPerRun > 1000) {
      throw new Cortex35WorkerError("INVALID_CONFIG", "maxMutationsPerRun is invalid");
    }
  }

  async runOnce(): Promise<{ terms: number; candidates: number; applied: number; observed: number; unknownCampaigns: number; quarantined: number }> {
    const mode = safeMode(this.options.readMode);
    if (mode === "KILLED") return Object.freeze({ terms: 0, candidates: 0, applied: 0, observed: 0, unknownCampaigns: 0, quarantined: 0 });
    const snapshot = await this.options.googleAds.collectCoverage();
    const unknownCampaigns = snapshot.campaigns.filter((campaign) => campaign.coverage === "UNKNOWN").length;
    const candidates: NegativeKeywordPlan[] = [];
    for (const term of snapshot.terms) {
      const plan = await planNegativeKeyword(this.options.index, term, this.options.policy);
      if (plan) candidates.push(plan);
    }
    let applied = 0;
    let observed = 0;
    let quarantined = 0;
    for (const plan of candidates.slice(0, this.options.policy.maxMutationsPerRun)) {
      if (mode === "OBSERVE_ONLY") {
        observed += 1;
        continue;
      }
      const id = negativeKeywordActionId(plan);
      const existing = this.options.ledger.get(id);
      if (existing?.status === "APPLIED" || existing?.status === "ROLLED_BACK") continue;
      if (existing?.status === "DISPATCHING" || existing?.status === "AMBIGUOUS") {
        quarantined += 1;
        continue;
      }
      this.options.ledger.prepare(plan);
      if (safeMode(this.options.readMode) !== "ACTIVE") {
        throw new Cortex35WorkerError("MODE_BLOCKED", "CORTEX #35 mode changed before Google Ads mutation");
      }
      // DISPATCHING is persisted before entering any remote mutation path. A process
      // loss from this point forward is quarantined on restart instead of retried.
      this.options.ledger.markDispatching(id);
      try {
        const receipt = await this.options.googleAds.applyCampaignNegative(plan, this.options.policy.maxManagedNegativesPerCampaign);
        this.options.ledger.commitApplied(plan, receipt.resourceName, receipt.requestId);
        applied += receipt.alreadyExists ? 0 : 1;
      } catch (error) {
        this.options.ledger.markAmbiguous(id);
        throw error;
      }
    }
    return Object.freeze({ terms: snapshot.terms.length, candidates: candidates.length, applied, observed, unknownCampaigns, quarantined });
  }

  async rollback(id: string): Promise<NegativeKeywordActionRecord> {
    const current = this.options.ledger.get(id);
    if (!current) throw new Cortex35WorkerError("INVALID_INPUT", "negative action is not found");
    if (current.status === "ROLLED_BACK") return current;
    if (current.status !== "APPLIED" || !current.resourceName) throw new Cortex35WorkerError("AMBIGUOUS_REMOTE_STATE", "cannot rollback an unconfirmed remote mutation");
    // Safety rollback is intentionally allowed while KILLED; no new negative keyword is created.
    const receipt = await this.options.rollbackGateway.remove(current.resourceName, `${current.actionId}-rollback`);
    return this.options.ledger.markRolledBack(id, receipt.requestId);
  }
}
