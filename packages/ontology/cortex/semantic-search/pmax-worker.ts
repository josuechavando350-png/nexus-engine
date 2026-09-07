import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteSemanticSearchIndex } from "./index.js";
import {
  Cortex35Error,
  GoogleAdsSearchTermCoverageClient,
  planNegativeKeyword,
  type NegativeKeywordPlan,
  type SearchTermNegativePolicy,
} from "./pmax-coverage.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type Cortex35Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

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
  readonly resourceName: string;
  readonly status: "APPLIED" | "ROLLED_BACK";
  readonly remoteRequestId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class Cortex35WorkerError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "CONFLICT" | "MODE_BLOCKED" | "INTEGRITY_FAILURE",
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

function actionId(plan: NegativeKeywordPlan): string {
  return `neg-${createHash("sha256")
    .update(`${plan.campaignId}\0${plan.channel}\0${plan.searchTerm}\0${plan.matchType}\0${plan.sourceCoverage}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex35_negative_actions(
      action_id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      term_hash TEXT NOT NULL,
      source_coverage TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('APPLIED','ROLLED_BACK')),
      remote_request_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  get(id: string): NegativeKeywordActionRecord | undefined {
    if (!ID.test(id)) throw new Cortex35WorkerError("INVALID_INPUT", "negative actionId is malformed");
    const row = this.db.prepare("SELECT * FROM cortex35_negative_actions WHERE action_id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record: NegativeKeywordActionRecord = {
      actionId: String(row.action_id),
      planDigest: String(row.plan_digest) as `sha256:${string}`,
      campaignId: String(row.campaign_id),
      termHash: String(row.term_hash) as `sha256:${string}`,
      sourceCoverage: String(row.source_coverage) as NegativeKeywordPlan["sourceCoverage"],
      resourceName: String(row.resource_name),
      status: row.status === "APPLIED" ? "APPLIED" : "ROLLED_BACK",
      remoteRequestId: row.remote_request_id === null ? null : String(row.remote_request_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (
      !SHA256.test(record.planDigest) ||
      !SHA256.test(record.termHash) ||
      !/^\d{1,20}$/u.test(record.campaignId) ||
      !(record.sourceCoverage === "SEARCH_TERM_VIEW" || record.sourceCoverage === "PMAX_CAMPAIGN_SEARCH_TERM_VIEW") ||
      !record.resourceName ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt))
    ) {
      throw new Cortex35WorkerError("INTEGRITY_FAILURE", "stored negative-keyword action is corrupt");
    }
    return Object.freeze(record);
  }

  commitApplied(plan: NegativeKeywordPlan, resourceName: string, requestId: string | null): NegativeKeywordActionRecord {
    const id = actionId(plan);
    const planDigest = digest({
      campaignId: plan.campaignId,
      channel: plan.channel,
      matchType: plan.matchType,
      reason: plan.reason,
      relevanceScore: plan.relevanceScore,
      sourceCoverage: plan.sourceCoverage,
      termHash: termHash(plan.searchTerm),
    });
    const existing = this.get(id);
    if (existing) {
      if (existing.planDigest !== planDigest || existing.resourceName !== resourceName) {
        throw new Cortex35WorkerError("CONFLICT", "negative action is already bound to different mutation evidence");
      }
      return existing;
    }
    const now = new Date(this.now()).toISOString();
    this.db.prepare(`INSERT INTO cortex35_negative_actions(
      action_id,plan_digest,campaign_id,term_hash,source_coverage,resource_name,status,remote_request_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      planDigest,
      plan.campaignId,
      termHash(plan.searchTerm),
      plan.sourceCoverage,
      resourceName,
      "APPLIED",
      requestId,
      now,
      now,
    );
    return this.get(id)!;
  }

  markRolledBack(id: string, requestId: string | null): NegativeKeywordActionRecord {
    const current = this.get(id);
    if (!current) throw new Cortex35WorkerError("INVALID_INPUT", "negative action is not found");
    if (current.status === "ROLLED_BACK") return current;
    const updatedAt = new Date(this.now()).toISOString();
    const changed = this.db.prepare("UPDATE cortex35_negative_actions SET status='ROLLED_BACK',remote_request_id=?,updated_at=? WHERE action_id=? AND status='APPLIED'").run(requestId, updatedAt, id);
    if (changed.changes !== 1) throw new Cortex35WorkerError("CONFLICT", "negative rollback lost compare-and-set boundary");
    return this.get(id)!;
  }
}

export interface Cortex35WorkerOptions {
  readonly index: SqliteSemanticSearchIndex;
  readonly googleAds: GoogleAdsSearchTermCoverageClient;
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

  async runOnce(): Promise<{ terms: number; candidates: number; applied: number; observed: number; unknownCampaigns: number }> {
    const mode = safeMode(this.options.readMode);
    if (mode === "KILLED") return Object.freeze({ terms: 0, candidates: 0, applied: 0, observed: 0, unknownCampaigns: 0 });
    const snapshot = await this.options.googleAds.collectCoverage();
    const unknownCampaigns = snapshot.campaigns.filter((campaign) => campaign.coverage === "UNKNOWN").length;
    const candidates: NegativeKeywordPlan[] = [];
    for (const term of snapshot.terms) {
      const plan = await planNegativeKeyword(this.options.index, term, this.options.policy);
      if (plan) candidates.push(plan);
    }
    let applied = 0;
    let observed = 0;
    for (const plan of candidates.slice(0, this.options.policy.maxMutationsPerRun)) {
      if (mode === "OBSERVE_ONLY") {
        observed += 1;
        continue;
      }
      const id = actionId(plan);
      const existing = this.options.ledger.get(id);
      if (existing?.status === "APPLIED") continue;
      if (existing?.status === "ROLLED_BACK") continue;
      if (safeMode(this.options.readMode) !== "ACTIVE") {
        throw new Cortex35WorkerError("MODE_BLOCKED", "CORTEX #35 mode changed before Google Ads mutation");
      }
      const receipt = await this.options.googleAds.applyCampaignNegative(plan, this.options.policy.maxManagedNegativesPerCampaign);
      this.options.ledger.commitApplied(plan, receipt.resourceName, receipt.requestId);
      applied += receipt.alreadyExists ? 0 : 1;
    }
    return Object.freeze({ terms: snapshot.terms.length, candidates: candidates.length, applied, observed, unknownCampaigns });
  }

  async rollback(id: string): Promise<NegativeKeywordActionRecord> {
    const current = this.options.ledger.get(id);
    if (!current) throw new Cortex35WorkerError("INVALID_INPUT", "negative action is not found");
    if (current.status === "ROLLED_BACK") return current;
    // Safety rollback is intentionally allowed while KILLED; no new negative keyword is created.
    const receipt = await this.options.rollbackGateway.remove(current.resourceName, `${current.actionId}-rollback`);
    return this.options.ledger.markRolledBack(id, receipt.requestId);
  }
}
