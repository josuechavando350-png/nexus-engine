import { capturePublicPage, validateCompetitiveScope, type CompetitiveScope } from "./competitive-intelligence";
import { analyzeReputationShield, type ReputationReport } from "./reputation-shield";

const MAX_SOURCES = 50;
const MAX_ID = 200;
const MAX_LABEL = 500;
const MAX_URL = 4_096;

export interface ReputationRuntimeSource { readonly id: string; readonly label: string; readonly url: string }
export interface ReputationRuntimeRequest {
  readonly scope: CompetitiveScope;
  readonly subjectId: string;
  readonly observedAt: string;
  readonly sources: readonly ReputationRuntimeSource[];
  readonly monitoredTerms: readonly string[];
  readonly timeoutMs?: number;
}

function clean(label: string, value: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be non-empty and <= ${max} characters`);
  return normalized;
}

export async function runReputationShield(request: ReputationRuntimeRequest, signal?: AbortSignal): Promise<ReputationReport> {
  if (!request || typeof request !== "object") throw new Error("reputation runtime request must be an object");
  const scope = validateCompetitiveScope(request.scope);
  const subjectId = clean("subjectId", request.subjectId, MAX_ID);
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > MAX_SOURCES) {
    throw new Error(`sources must contain 1 to ${MAX_SOURCES} entries`);
  }
  const ids = new Set<string>();
  const observations = [];
  for (let index = 0; index < request.sources.length; index += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("reputation shield cancelled");
    const source = request.sources[index]!;
    const id = clean(`sources[${index}].id`, source.id, MAX_ID);
    if (ids.has(id)) throw new Error("reputation source ids must be unique");
    ids.add(id);
    const label = clean(`sources[${index}].label`, source.label, MAX_LABEL);
    const url = clean(`sources[${index}].url`, source.url, MAX_URL);
    observations.push({ id, label, observation: await capturePublicPage(url, request.observedAt, { scope, timeoutMs: request.timeoutMs, signal }) });
  }
  return analyzeReputationShield(scope, subjectId, observations, request.monitoredTerms);
}
