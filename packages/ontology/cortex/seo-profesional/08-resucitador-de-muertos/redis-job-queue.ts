import { createHash, randomUUID } from "node:crypto";
import type { RevivalCandidate } from "./revival-intelligence.js";
import type { RedisScriptPort } from "./redis-resp-client.js";

export class RedisRevivalQueueError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "STATE_CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "RedisRevivalQueueError";
  }
}

export interface RevivalQueueJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly candidate: RevivalCandidate;
  readonly attempt: number;
  readonly state: "PENDING" | "LEASED" | "DONE" | "FAILED";
  readonly leasedBy: string | null;
  readonly leaseUntil: number | null;
  readonly nextAttemptAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;
const MAX_ATTEMPTS = 8;

const ENQUEUE_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then return existing end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[2])
return ARGV[2]
`;

const CLAIM_SCRIPT = `
local now = tonumber(ARGV[1])
local leaseUntil = tonumber(ARGV[2])
local worker = ARGV[3]
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, 100)
for _, id in ipairs(expired) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then
    local job = cjson.decode(raw)
    if job.state == 'LEASED' and tonumber(job.leaseUntil or 0) <= now then
      job.state = 'PENDING'
      job.leasedBy = cjson.null
      job.leaseUntil = cjson.null
      job.updatedAt = now
      redis.call('HSET', KEYS[1], id, cjson.encode(job))
      redis.call('ZADD', KEYS[2], tonumber(job.nextAttemptAt or now), id)
    end
  end
  redis.call('ZREM', KEYS[3], id)
end
local candidates = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, 100)
for _, id in ipairs(candidates) do
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then
    redis.call('ZREM', KEYS[2], id)
  else
    local job = cjson.decode(raw)
    if job.state == 'PENDING' then
      job.state = 'LEASED'
      job.leasedBy = worker
      job.leaseUntil = leaseUntil
      job.updatedAt = now
      redis.call('HSET', KEYS[1], id, cjson.encode(job))
      redis.call('ZREM', KEYS[2], id)
      redis.call('ZADD', KEYS[3], leaseUntil, id)
      return cjson.encode(job)
    end
    redis.call('ZREM', KEYS[2], id)
  end
end
return false
`;

const COMPLETE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 'MISSING' end
local job = cjson.decode(raw)
if job.state ~= 'LEASED' or job.leasedBy ~= ARGV[2] then return 'CONFLICT' end
job.state = 'DONE'
job.leasedBy = cjson.null
job.leaseUntil = cjson.null
job.updatedAt = tonumber(ARGV[3])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(job))
redis.call('ZREM', KEYS[2], ARGV[1])
return 'OK'
`;

const RETRY_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 'MISSING' end
local job = cjson.decode(raw)
if job.state ~= 'LEASED' or job.leasedBy ~= ARGV[2] then return 'CONFLICT' end
local attempt = tonumber(job.attempt or 0) + 1
local now = tonumber(ARGV[4])
local maxAttempts = tonumber(ARGV[5])
job.attempt = attempt
job.leasedBy = cjson.null
job.leaseUntil = cjson.null
job.lastError = ARGV[3]
job.updatedAt = now
redis.call('ZREM', KEYS[3], ARGV[1])
if attempt >= maxAttempts then
  job.state = 'FAILED'
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(job))
  return 'FAILED'
end
local delay = math.min(3600000, 5000 * (2 ^ (attempt - 1)))
job.state = 'PENDING'
job.nextAttemptAt = now + delay
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(job))
redis.call('ZADD', KEYS[2], job.nextAttemptAt, ARGV[1])
return 'PENDING'
`;

function validCandidate(value: RevivalCandidate): boolean {
  return Boolean(value && typeof value === "object" && ID.test(value.tenantId) && ID.test(value.candidateId) && typeof value.websiteUrl === "string" && typeof value.dormantSince === "string" && (value.relationship === "FIRST_PARTY_CRM" || value.relationship === "OWNED_PORTFOLIO"));
}

function parseJob(raw: string): RevivalQueueJob {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "stored revival job JSON is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "stored revival job is invalid");
  const row = value as Record<string, unknown>;
  if (typeof row.jobId !== "string" || typeof row.tenantId !== "string" || !validCandidate(row.candidate as RevivalCandidate) || !Number.isSafeInteger(row.attempt) ||
    (row.state !== "PENDING" && row.state !== "LEASED" && row.state !== "DONE" && row.state !== "FAILED") ||
    (row.leasedBy !== null && typeof row.leasedBy !== "string") || (row.leaseUntil !== null && !Number.isSafeInteger(row.leaseUntil)) || !Number.isSafeInteger(row.nextAttemptAt) ||
    !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt) || (row.lastError !== null && typeof row.lastError !== "string")) {
    throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "stored revival job contract is invalid");
  }
  return Object.freeze({
    jobId: row.jobId,
    tenantId: row.tenantId,
    candidate: Object.freeze({ ...(row.candidate as RevivalCandidate) }),
    attempt: row.attempt,
    state: row.state,
    leasedBy: row.leasedBy,
    leaseUntil: row.leaseUntil,
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastError: row.lastError,
  } as RevivalQueueJob);
}

export class RedisRevivalJobQueue {
  private readonly namespace: string;

  constructor(private readonly redis: RedisScriptPort, namespace = "nexus:seo8") {
    if (!redis || typeof redis.eval !== "function" || !/^[A-Za-z0-9:_-]{3,96}$/u.test(namespace)) throw new RedisRevivalQueueError("INVALID_INPUT", "Redis revival queue configuration is invalid");
    this.namespace = namespace;
  }

  private keys(tenantId: string) {
    if (!ID.test(tenantId)) throw new RedisRevivalQueueError("INVALID_INPUT", "tenantId is invalid");
    const tag = `{${tenantId}}`;
    return Object.freeze({
      dedupe: `${this.namespace}:${tag}:dedupe`,
      jobs: `${this.namespace}:${tag}:jobs`,
      pending: `${this.namespace}:${tag}:pending`,
      leased: `${this.namespace}:${tag}:leased`,
    });
  }

  async enqueue(candidate: RevivalCandidate, scanKey: string, nowMs: number): Promise<string> {
    if (!validCandidate(candidate) || !ID.test(scanKey) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new RedisRevivalQueueError("INVALID_INPUT", "revival enqueue input is invalid");
    const keys = this.keys(candidate.tenantId);
    const fingerprint = createHash("sha256").update(`${candidate.tenantId}\n${candidate.candidateId}\n${candidate.websiteUrl}\n${candidate.dormantSince}\n${scanKey}`, "utf8").digest("hex");
    const jobId = `revjob_${randomUUID()}`;
    const job: RevivalQueueJob = Object.freeze({
      jobId,
      tenantId: candidate.tenantId,
      candidate: Object.freeze({ ...candidate }),
      attempt: 0,
      state: "PENDING",
      leasedBy: null,
      leaseUntil: null,
      nextAttemptAt: nowMs,
      createdAt: nowMs,
      updatedAt: nowMs,
      lastError: null,
    });
    const reply = await this.redis.eval(ENQUEUE_SCRIPT, [keys.dedupe, keys.jobs, keys.pending], [fingerprint, jobId, JSON.stringify(job), String(nowMs)]);
    if (typeof reply !== "string" || !/^revjob_[0-9a-f-]{36}$/u.test(reply)) throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "Redis enqueue returned an invalid job id");
    return reply;
  }

  async claim(tenantId: string, workerId: string, nowMs: number, leaseMs = 60_000): Promise<RevivalQueueJob | null> {
    if (!ID.test(workerId) || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
      throw new RedisRevivalQueueError("INVALID_INPUT", "revival claim input is invalid");
    }
    const keys = this.keys(tenantId);
    const reply = await this.redis.eval(CLAIM_SCRIPT, [keys.jobs, keys.pending, keys.leased], [String(nowMs), String(nowMs + leaseMs), workerId]);
    if (reply === null || reply === 0) return null;
    if (typeof reply !== "string") throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "Redis claim returned an invalid payload");
    const job = parseJob(reply);
    if (job.tenantId !== tenantId || job.state !== "LEASED" || job.leasedBy !== workerId) throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "Redis claim returned a job outside the requested lease");
    return job;
  }

  async complete(job: RevivalQueueJob, workerId: string, nowMs: number): Promise<void> {
    if (!job || job.state !== "LEASED" || !ID.test(workerId) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new RedisRevivalQueueError("INVALID_INPUT", "revival completion input is invalid");
    const keys = this.keys(job.tenantId);
    const reply = await this.redis.eval(COMPLETE_SCRIPT, [keys.jobs, keys.leased], [job.jobId, workerId, String(nowMs)]);
    if (reply === "CONFLICT" || reply === "MISSING") throw new RedisRevivalQueueError("STATE_CONFLICT", "revival completion does not own the active Redis lease");
    if (reply !== "OK") throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "Redis completion returned an invalid response");
  }

  async retry(job: RevivalQueueJob, workerId: string, errorMessage: string, nowMs: number): Promise<"PENDING" | "FAILED"> {
    if (!job || job.state !== "LEASED" || !ID.test(workerId) || typeof errorMessage !== "string" || errorMessage.length < 1 || errorMessage.length > 2_000 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RedisRevivalQueueError("INVALID_INPUT", "revival retry input is invalid");
    }
    const keys = this.keys(job.tenantId);
    const reply = await this.redis.eval(RETRY_SCRIPT, [keys.jobs, keys.pending, keys.leased], [job.jobId, workerId, errorMessage, String(nowMs), String(MAX_ATTEMPTS)]);
    if (reply === "CONFLICT" || reply === "MISSING") throw new RedisRevivalQueueError("STATE_CONFLICT", "revival retry does not own the active Redis lease");
    if (reply !== "PENDING" && reply !== "FAILED") throw new RedisRevivalQueueError("INTEGRITY_FAILURE", "Redis retry returned an invalid response");
    return reply;
  }
}
