import { createEvidence, deliverEvidence, NullCreativeEvidenceSink, type CreativeEvidence, type CreativeEvidenceSink } from "../evidence";
import { assertCanonicalId, assertNonEmpty, assertScope, canonicalTimestamp, CreativeValidationError, lexicalCompare, type CreativeScope } from "../shared";

export type MemoryRecordKind = "OBSERVATION" | "DECISION" | "REJECTION" | "OUTCOME";
export type MemoryProvenance = Readonly<{
  sourceId: string;
  sourceType: "HUMAN" | "SYSTEM" | "RESEARCH" | "EXPERIENCE";
  capturedAt: string;
  evidenceIds: readonly string[];
}>;

export type MemoryPayload =
  | Readonly<{ kind: "OBSERVATION"; statement: string }>
  | Readonly<{ kind: "DECISION"; directionId: string; rationale: string }>
  | Readonly<{ kind: "REJECTION"; directionId: string; reason: string }>
  | Readonly<{ kind: "OUTCOME"; directionId: string; metric: string; value: number; interpretation: string }>;

export type ArtDirectionMemoryRecord = Readonly<{
  schemaVersion: 1;
  recordId: string;
  scope: CreativeScope;
  subjectId: string;
  createdAt: string;
  validFrom: string;
  validUntil?: string;
  confidence: number;
  keywords: readonly string[];
  provenance: MemoryProvenance;
  supersedes?: string;
  payload: MemoryPayload;
}>;

export type MemoryErrorCode =
  | "INVALID_RECORD"
  | "DUPLICATE_ID"
  | "IDENTITY_COLLISION"
  | "SCOPE_MISMATCH"
  | "BACKEND_OUTAGE"
  | "RETENTION_VIOLATION"
  | "SUPERSESSION_INCONSISTENT";

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface MemoryStore {
  append(record: ArtDirectionMemoryRecord): Promise<void>;
  get(scope: CreativeScope, recordId: string): Promise<ArtDirectionMemoryRecord | undefined>;
  list(scope: CreativeScope): Promise<readonly ArtDirectionMemoryRecord[]>;
}

export interface MemoryRetriever {
  retrieve(query: MemoryQuery): Promise<MemoryRetrieval>;
}

export type MemoryQuery = Readonly<{
  scope: CreativeScope;
  subjectId?: string;
  keywords: readonly string[];
  at: string;
  minimumConfidence: number;
  limit: number;
  correlationId: string;
  inputsDigest: string;
}>;

export type RankedMemory = Readonly<{
  record: ArtDirectionMemoryRecord;
  score: number;
  stale: boolean;
  superseded: boolean;
  conflicts: readonly string[];
}>;

export type MemoryRetrieval = Readonly<{
  authority: "EVIDENCE_ONLY";
  mayFinalizeDirection: false;
  results: readonly RankedMemory[];
  rejectedLowConfidence: readonly string[];
  evidence: readonly CreativeEvidence[];
}>;

function timestamp(value: string, field: string): number {
  try {
    return canonicalTimestamp(value, field);
  } catch (error) {
    if (error instanceof CreativeValidationError) throw new MemoryError("INVALID_RECORD", error.message);
    throw error;
  }
}

function freezeRecord(record: ArtDirectionMemoryRecord): ArtDirectionMemoryRecord {
  const payload = Object.freeze({ ...record.payload }) as MemoryPayload;
  return Object.freeze({
    ...record,
    scope: Object.freeze({ ...record.scope }),
    keywords: Object.freeze([...record.keywords]),
    provenance: Object.freeze({ ...record.provenance, evidenceIds: Object.freeze([...record.provenance.evidenceIds]) }),
    payload
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => lexicalCompare(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateMemoryRecord(record: ArtDirectionMemoryRecord): ArtDirectionMemoryRecord {
  if (!record || record.schemaVersion !== 1 || !record.scope || !record.provenance || !record.payload || !Array.isArray(record.keywords) || !Array.isArray(record.provenance.evidenceIds)) {
    throw new MemoryError("INVALID_RECORD", "record structure is invalid");
  }
  if (
    typeof record.recordId !== "string" ||
    typeof record.subjectId !== "string" ||
    typeof record.provenance.sourceId !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.validFrom !== "string" ||
    (record.validUntil !== undefined && typeof record.validUntil !== "string")
  ) {
    throw new MemoryError("INVALID_RECORD", "record identifiers and timestamps must be strings");
  }
  if (!(["HUMAN", "SYSTEM", "RESEARCH", "EXPERIENCE"] as const).includes(record.provenance.sourceType) || typeof record.provenance.capturedAt !== "string") {
    throw new MemoryError("INVALID_RECORD", "provenance type or timestamp is invalid");
  }

  try {
    assertScope(record.scope);
    assertCanonicalId(record.recordId, "recordId");
    assertCanonicalId(record.subjectId, "subjectId");
    assertCanonicalId(record.provenance.sourceId, "provenance.sourceId");
    if (record.supersedes) assertCanonicalId(record.supersedes, "supersedes");
  } catch (error) {
    if (error instanceof CreativeValidationError) throw new MemoryError("INVALID_RECORD", error.message);
    throw error;
  }

  const created = timestamp(record.createdAt, "createdAt");
  const start = timestamp(record.validFrom, "validFrom");
  const end = record.validUntil ? timestamp(record.validUntil, "validUntil") : Infinity;
  if (created > start || start > end) throw new MemoryError("INVALID_RECORD", "record temporal order is invalid");
  timestamp(record.provenance.capturedAt, "provenance.capturedAt");

  if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) throw new MemoryError("INVALID_RECORD", "confidence must be in [0,1]");
  if (!record.provenance.evidenceIds.length) throw new MemoryError("INVALID_RECORD", "provenance evidence is required");
  for (const evidenceId of record.provenance.evidenceIds) {
    if (typeof evidenceId !== "string" || !evidenceId.trim()) throw new MemoryError("INVALID_RECORD", "provenance evidence IDs must be non-empty strings");
  }

  if (record.keywords.some((keyword) => typeof keyword !== "string")) throw new MemoryError("INVALID_RECORD", "keywords must be strings");
  const normalizedKeywords = record.keywords.map((keyword) => keyword.trim().toLowerCase());
  if (normalizedKeywords.some((keyword) => !keyword || keyword.length > 64) || new Set(normalizedKeywords).size !== normalizedKeywords.length) {
    throw new MemoryError("INVALID_RECORD", "keywords must be non-empty, unique, and at most 64 characters");
  }

  if (!(["OBSERVATION", "DECISION", "REJECTION", "OUTCOME"] as const).includes(record.payload.kind)) throw new MemoryError("INVALID_RECORD", "payload kind is invalid");
  const text =
    record.payload.kind === "OBSERVATION"
      ? record.payload.statement
      : record.payload.kind === "REJECTION"
        ? record.payload.reason
        : record.payload.kind === "DECISION"
          ? record.payload.rationale
          : record.payload.interpretation;
  if (typeof text !== "string" || !text.trim()) throw new MemoryError("INVALID_RECORD", "payload content is required");

  try {
    if (record.payload.kind !== "OBSERVATION") assertCanonicalId(record.payload.directionId, "payload.directionId");
    if (record.payload.kind === "OUTCOME") {
      assertCanonicalId(record.payload.metric, "payload.metric");
      if (!Number.isFinite(record.payload.value)) throw new MemoryError("INVALID_RECORD", "payload.value must be finite");
    }
  } catch (error) {
    if (error instanceof CreativeValidationError) throw new MemoryError("INVALID_RECORD", error.message);
    throw error;
  }
  return freezeRecord(record);
}

export class AppendOnlyMemoryService {
  constructor(private readonly store: MemoryStore, private readonly retentionMs: number) {
    if (retentionMs <= 0 || !Number.isFinite(retentionMs)) throw new MemoryError("RETENTION_VIOLATION", "retention must be positive and finite");
  }

  async append(record: ArtDirectionMemoryRecord): Promise<void> {
    const immutable = validateMemoryRecord(record);
    if (!immutable.validUntil || timestamp(immutable.validUntil, "validUntil") - timestamp(immutable.createdAt, "createdAt") > this.retentionMs) {
      throw new MemoryError("RETENTION_VIOLATION", "record validity exceeds retention policy");
    }

    let existing: ArtDirectionMemoryRecord | undefined;
    try {
      const rawExisting = await this.store.get(immutable.scope, immutable.recordId);
      existing = rawExisting ? validateMemoryRecord(rawExisting) : undefined;
    } catch (error) {
      if (error instanceof MemoryError && error.code === "INVALID_RECORD") throw error;
      throw new MemoryError("BACKEND_OUTAGE", "memory backend unavailable");
    }
    if (existing) {
      if (stableJson(existing) === stableJson(immutable)) throw new MemoryError("DUPLICATE_ID", `record ${immutable.recordId} already exists`);
      throw new MemoryError("IDENTITY_COLLISION", `record ${immutable.recordId} collides with different content`);
    }

    if (immutable.supersedes) {
      if (immutable.supersedes === immutable.recordId) throw new MemoryError("SUPERSESSION_INCONSISTENT", "record cannot supersede itself");
      const visited = new Set([immutable.recordId]);
      let priorId: string | undefined = immutable.supersedes;
      while (priorId) {
        if (visited.has(priorId)) throw new MemoryError("SUPERSESSION_INCONSISTENT", "supersession cycle detected");
        visited.add(priorId);
        let prior: ArtDirectionMemoryRecord | undefined;
        try {
          const rawPrior = await this.store.get(immutable.scope, priorId);
          prior = rawPrior ? validateMemoryRecord(rawPrior) : undefined;
        } catch (error) {
          if (error instanceof MemoryError && error.code === "INVALID_RECORD") throw error;
          throw new MemoryError("BACKEND_OUTAGE", "memory backend unavailable");
        }
        if (!prior || prior.subjectId !== immutable.subjectId || prior.scope.tenantId !== immutable.scope.tenantId || prior.scope.brandId !== immutable.scope.brandId) {
          throw new MemoryError("SUPERSESSION_INCONSISTENT", "supersession chain is absent or outside the same subject/scope");
        }
        if (timestamp(prior.createdAt, "createdAt") >= timestamp(immutable.createdAt, "createdAt")) {
          throw new MemoryError("SUPERSESSION_INCONSISTENT", "supersession must point to an older record");
        }
        priorId = prior.supersedes;
      }

      let records: readonly ArtDirectionMemoryRecord[];
      try {
        records = (await this.store.list(immutable.scope)).map((candidate) => validateMemoryRecord(candidate));
      } catch (error) {
        if (error instanceof MemoryError && error.code === "INVALID_RECORD") throw error;
        throw new MemoryError("BACKEND_OUTAGE", "memory backend unavailable");
      }
      const competing = records.find((candidate) => candidate.supersedes === immutable.supersedes && candidate.recordId !== immutable.recordId);
      if (competing) throw new MemoryError("SUPERSESSION_INCONSISTENT", `supersession fork already exists at ${competing.recordId}`);
    }

    try {
      await this.store.append(immutable);
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("BACKEND_OUTAGE", "memory backend unavailable");
    }
  }
}

function keywordScore(record: ArtDirectionMemoryRecord, keywords: readonly string[]): number {
  const recordKeys = new Set(record.keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean));
  const queryKeys = [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
  if (!queryKeys.length) return 0;
  return queryKeys.filter((keyword) => recordKeys.has(keyword)).length / queryKeys.length;
}

function outcomeKey(record: ArtDirectionMemoryRecord): string | undefined {
  return record.payload.kind === "OUTCOME" ? `${record.subjectId}:${record.payload.directionId}:${record.payload.metric}` : undefined;
}

export class DeterministicMemoryRetriever implements MemoryRetriever {
  constructor(private readonly store: MemoryStore, private readonly evidenceSink: CreativeEvidenceSink = new NullCreativeEvidenceSink()) {}

  async retrieve(query: MemoryQuery): Promise<MemoryRetrieval> {
    try {
      assertScope(query.scope);
      if (query.subjectId) assertCanonicalId(query.subjectId, "query.subjectId");
      assertCanonicalId(query.correlationId, "query.correlationId");
      assertNonEmpty(query.inputsDigest, "query.inputsDigest");
    } catch (error) {
      throw new MemoryError("INVALID_RECORD", error instanceof Error ? error.message : "invalid query");
    }
    if (!Number.isFinite(query.minimumConfidence) || query.minimumConfidence < 0 || query.minimumConfidence > 1 || !Number.isInteger(query.limit) || query.limit < 1) {
      throw new MemoryError("INVALID_RECORD", "invalid retrieval bounds");
    }
    if (!Array.isArray(query.keywords) || query.keywords.some((keyword) => typeof keyword !== "string" || !keyword.trim() || keyword.trim().length > 64)) {
      throw new MemoryError("INVALID_RECORD", "query keywords must be non-empty strings");
    }

    const at = timestamp(query.at, "query.at");
    let records: readonly ArtDirectionMemoryRecord[];
    try {
      records = (await this.store.list(query.scope)).map((record) => validateMemoryRecord(record));
    } catch (error) {
      if (error instanceof MemoryError && error.code === "INVALID_RECORD") throw error;
      const failure = await this.emit(query, "BACKEND_FAILURE", "memory-store", { operation: "list" });
      throw Object.assign(new MemoryError("BACKEND_OUTAGE", "memory backend unavailable"), { evidence: failure });
    }

    const events: CreativeEvidence[] = [];
    const wrongScope = records.filter((record) => record.scope.tenantId !== query.scope.tenantId || record.scope.brandId !== query.scope.brandId);
    for (const record of wrongScope) events.push(await this.emit(query, "SCOPE_REJECTION", record.recordId, {}));

    const scoped = records.filter(
      (record) =>
        record.scope.tenantId === query.scope.tenantId &&
        record.scope.brandId === query.scope.brandId &&
        (!query.subjectId || record.subjectId === query.subjectId)
    );

    const supersededIds = new Set(scoped.map((record) => record.supersedes).filter((id): id is string => !!id));
    const outcomeGroups = new Map<string, ArtDirectionMemoryRecord[]>();
    for (const record of scoped) {
      const key = outcomeKey(record);
      if (key) outcomeGroups.set(key, [...(outcomeGroups.get(key) ?? []), record]);
    }
    const conflicts = new Map<string, string[]>();
    for (const group of outcomeGroups.values()) {
      const values = new Set(group.map((record) => (record.payload.kind === "OUTCOME" ? record.payload.value : 0)));
      if (values.size > 1) {
        for (const record of group) {
          conflicts.set(
            record.recordId,
            group.filter((other) => other.recordId !== record.recordId).map((other) => other.recordId).sort(lexicalCompare)
          );
        }
      }
    }

    const low: string[] = [];
    const ranked: RankedMemory[] = [];
    for (const record of scoped) {
      const stale = at < timestamp(record.validFrom, "validFrom") || (!!record.validUntil && at > timestamp(record.validUntil, "validUntil"));
      const superseded = supersededIds.has(record.recordId);
      if (stale || superseded) events.push(await this.emit(query, "MEMORY_STALE_OR_SUPERSEDED", record.recordId, { stale, superseded }));
      if (record.confidence < query.minimumConfidence) {
        low.push(record.recordId);
        continue;
      }
      if (stale || superseded) continue;
      const relevance = keywordScore(record, query.keywords);
      ranked.push({
        record,
        score: Number((relevance * 0.7 + record.confidence * 0.3).toFixed(9)),
        stale,
        superseded,
        conflicts: Object.freeze([...(conflicts.get(record.recordId) ?? [])])
      });
    }

    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        timestamp(b.record.validFrom, "validFrom") - timestamp(a.record.validFrom, "validFrom") ||
        lexicalCompare(a.record.recordId, b.record.recordId)
    );
    const results = ranked.slice(0, query.limit).map((entry) => Object.freeze({ ...entry, record: freezeRecord(entry.record) }));
    events.push(await this.emit(query, "MEMORY_RETRIEVAL", query.subjectId ?? "all", { resultCount: results.length, lowConfidenceCount: low.length, authority: "EVIDENCE_ONLY" }));
    events.push(await this.emit(query, "DETERMINISTIC_INPUTS", query.subjectId ?? "all", { keywordOrder: [...query.keywords].sort(lexicalCompare).join(","), minimumConfidence: query.minimumConfidence, limit: query.limit }));

    return Object.freeze({
      authority: "EVIDENCE_ONLY",
      mayFinalizeDirection: false,
      results: Object.freeze(results),
      rejectedLowConfidence: Object.freeze(low.sort(lexicalCompare)),
      evidence: Object.freeze(events)
    });
  }

  private async emit(query: MemoryQuery, kind: CreativeEvidence["kind"], subjectId: string, details: CreativeEvidence["details"]): Promise<CreativeEvidence> {
    const event = createEvidence({
      kind,
      occurredAt: query.at,
      correlationId: query.correlationId,
      scope: query.scope,
      subjectId,
      inputsDigest: query.inputsDigest,
      details
    });
    return deliverEvidence(this.evidenceSink, event);
  }
}
