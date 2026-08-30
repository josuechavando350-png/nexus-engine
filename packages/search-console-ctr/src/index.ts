import { createHash } from "node:crypto";

export type CtrDataStatus = "PASS" | "UNAVAILABLE" | "FAIL";
export type SearchDimension = "query" | "page" | "country" | "device" | "searchAppearance" | "date" | "hour";

export interface SearchAnalyticsRow {
  keys: readonly string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsRequest {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: readonly SearchDimension[];
  rowLimit?: number;
  startRow?: number;
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
}

export interface SearchAnalyticsDataset {
  request: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    dimensions: readonly SearchDimension[];
    rowLimit: number;
    startRow: number;
    type?: SearchAnalyticsRequest["type"];
  };
  rows: readonly SearchAnalyticsRow[];
  coverage: "TOP_ROWS_NOT_GUARANTEED_COMPLETE";
  sourceAuthority: "SEARCH_CONSOLE_API" | "CONTROLLED_TEST";
  datasetDigest: string;
}

export interface CtrCurvePoint {
  position: number;
  expectedCtr: number;
  impressions: number;
}

export interface CtrCurve {
  points: readonly CtrCurvePoint[];
  trainingRows: number;
  coverage: "TOP_ROWS_NOT_GUARANTEED_COMPLETE";
  curveDigest: string;
}

export interface CtrOpportunity {
  keys: readonly string[];
  position: number;
  impressions: number;
  actualCtr: number;
  expectedCtr: number;
  absoluteCtrGap: number;
  relativeCtrDelta: number | null;
  opportunityClicks: number;
}

export interface CtrAnalysis {
  opportunities: readonly CtrOpportunity[];
  curve: CtrCurve;
  datasetDigest: string;
  analysisDigest: string;
  nonClaim: "OBSERVATIONAL_NOT_CAUSAL";
}

export interface LiveSearchConsoleResult {
  status: CtrDataStatus;
  dataset?: SearchAnalyticsDataset;
  reason?: string;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("canonical JSON rejects cyclic object");
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) throw new Error("canonical JSON requires plain object");
    seen.add(object);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} is invalid`);
}

function normalizeRequest(input: SearchAnalyticsRequest): SearchAnalyticsDataset["request"] {
  assertDate(input.startDate, "startDate");
  assertDate(input.endDate, "endDate");
  if (input.startDate > input.endDate) throw new Error("startDate must be <= endDate");
  if (!input.siteUrl.trim()) throw new Error("siteUrl required");
  const dimensions = input.dimensions ?? [];
  if (new Set(dimensions).size !== dimensions.length) throw new Error("duplicate dimensions are forbidden");
  const rowLimit = input.rowLimit ?? 1_000;
  const startRow = input.startRow ?? 0;
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 25_000) throw new Error("rowLimit must be an integer from 1 to 25000");
  if (!Number.isInteger(startRow) || startRow < 0) throw new Error("startRow must be a non-negative integer");
  return Object.freeze({ siteUrl: input.siteUrl.trim(), startDate: input.startDate, endDate: input.endDate, dimensions: Object.freeze([...dimensions]), rowLimit, startRow, ...(input.type ? { type: input.type } : {}) });
}

function normalizeRow(row: SearchAnalyticsRow, dimensions: number): SearchAnalyticsRow {
  if (!row || typeof row !== "object") throw new Error("row must be an object");
  if (!Array.isArray(row.keys) || row.keys.length !== dimensions) throw new Error("row keys do not match requested dimensions");
  for (const key of row.keys) if (typeof key !== "string") throw new Error("row keys must be strings");
  for (const [label, value] of [["clicks", row.clicks], ["impressions", row.impressions], ["ctr", row.ctr], ["position", row.position]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  }
  if (row.ctr > 1) throw new Error("ctr must be between 0 and 1");
  if (row.clicks > row.impressions) throw new Error("clicks cannot exceed impressions");
  if (row.impressions === 0 && (row.clicks !== 0 || row.ctr !== 0)) throw new Error("zero-impression row must have zero clicks and ctr");
  if (row.impressions > 0) {
    const derived = row.clicks / row.impressions;
    if (Math.abs(derived - row.ctr) > 1e-6) throw new Error("row ctr is inconsistent with clicks/impressions");
  }
  return Object.freeze({ keys: Object.freeze([...row.keys]), clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position });
}

function createDatasetWithAuthority(input: SearchAnalyticsRequest, rows: readonly SearchAnalyticsRow[], sourceAuthority: SearchAnalyticsDataset["sourceAuthority"]): SearchAnalyticsDataset {
  const request = normalizeRequest(input);
  if (!Array.isArray(rows)) throw new Error("rows must be an array");
  if (rows.length > request.rowLimit) throw new Error("provider returned more rows than requested rowLimit");
  const normalizedRows = rows.map((row) => normalizeRow(row, request.dimensions.length));
  const core = { request, rows: normalizedRows, coverage: "TOP_ROWS_NOT_GUARANTEED_COMPLETE" as const, sourceAuthority };
  return Object.freeze({ ...core, rows: Object.freeze(normalizedRows), datasetDigest: digestValue(core) });
}

export function createControlledDataset(input: SearchAnalyticsRequest, rows: readonly SearchAnalyticsRow[]): SearchAnalyticsDataset {
  return createDatasetWithAuthority(input, rows, "CONTROLLED_TEST");
}

export function validateDataset(dataset: SearchAnalyticsDataset): void {
  const replay = createDatasetWithAuthority(dataset.request, dataset.rows, dataset.sourceAuthority);
  if (canonicalJson(replay) !== canonicalJson(dataset)) throw new Error("Search Analytics dataset replay mismatch");
}

interface PavaBlock {
  startPosition: number;
  endPosition: number;
  weightedCtrSum: number;
  weight: number;
}

function weightedMean(block: PavaBlock): number {
  return block.weight === 0 ? 0 : block.weightedCtrSum / block.weight;
}

export function buildMonotonicCtrCurve(dataset: SearchAnalyticsDataset): CtrCurve {
  validateDataset(dataset);
  const grouped = new Map<number, { weightedCtrSum: number; impressions: number }>();
  for (const row of dataset.rows) {
    if (row.impressions <= 0) continue;
    const position = Math.max(1, Math.round(row.position));
    const current = grouped.get(position) ?? { weightedCtrSum: 0, impressions: 0 };
    current.weightedCtrSum += row.ctr * row.impressions;
    current.impressions += row.impressions;
    grouped.set(position, current);
  }
  if (grouped.size === 0) throw new Error("cannot build CTR curve without positive-impression rows");

  const blocks: PavaBlock[] = [...grouped.entries()].sort(([a], [b]) => a - b).map(([position, value]) => ({
    startPosition: position,
    endPosition: position,
    weightedCtrSum: value.weightedCtrSum,
    weight: value.impressions,
  }));

  for (let index = 0; index < blocks.length - 1;) {
    if (weightedMean(blocks[index]!) >= weightedMean(blocks[index + 1]!)) {
      index += 1;
      continue;
    }
    const left = blocks[index]!;
    const right = blocks[index + 1]!;
    blocks.splice(index, 2, {
      startPosition: left.startPosition,
      endPosition: right.endPosition,
      weightedCtrSum: left.weightedCtrSum + right.weightedCtrSum,
      weight: left.weight + right.weight,
    });
    if (index > 0) index -= 1;
  }

  const points: CtrCurvePoint[] = [];
  for (const block of blocks) {
    const expectedCtr = weightedMean(block);
    for (let position = block.startPosition; position <= block.endPosition; position += 1) {
      const source = grouped.get(position);
      if (source) points.push(Object.freeze({ position, expectedCtr, impressions: source.impressions }));
    }
  }
  const core = { points, trainingRows: dataset.rows.length, coverage: dataset.coverage };
  return Object.freeze({ ...core, points: Object.freeze(points), curveDigest: digestValue(core) });
}

function expectedCtrAt(curve: CtrCurve, position: number): number {
  const rounded = Math.max(1, Math.round(position));
  let candidate = curve.points[0]!;
  for (const point of curve.points) {
    if (point.position > rounded) break;
    candidate = point;
  }
  return candidate.expectedCtr;
}

export function analyzeCtrOpportunities(dataset: SearchAnalyticsDataset, minimumImpressions = 50): CtrAnalysis {
  if (!Number.isFinite(minimumImpressions) || minimumImpressions < 0) throw new Error("minimumImpressions must be non-negative");
  const curve = buildMonotonicCtrCurve(dataset);
  const opportunities = dataset.rows.filter((row) => row.impressions >= minimumImpressions).map((row): CtrOpportunity => {
    const expectedCtr = expectedCtrAt(curve, row.position);
    const absoluteCtrGap = Math.max(0, expectedCtr - row.ctr);
    return Object.freeze({
      keys: Object.freeze([...row.keys]),
      position: row.position,
      impressions: row.impressions,
      actualCtr: row.ctr,
      expectedCtr,
      absoluteCtrGap,
      relativeCtrDelta: row.ctr === 0 ? null : absoluteCtrGap / row.ctr,
      opportunityClicks: absoluteCtrGap * row.impressions,
    });
  }).sort((a, b) => b.opportunityClicks - a.opportunityClicks || canonicalJson(a.keys).localeCompare(canonicalJson(b.keys)));
  const core = { opportunities, curve, datasetDigest: dataset.datasetDigest, nonClaim: "OBSERVATIONAL_NOT_CAUSAL" as const };
  return Object.freeze({ ...core, opportunities: Object.freeze(opportunities), analysisDigest: digestValue(core) });
}

export function validateCtrAnalysis(dataset: SearchAnalyticsDataset, analysis: CtrAnalysis, minimumImpressions = 50): void {
  validateDataset(dataset);
  if (analysis.datasetDigest !== dataset.datasetDigest) throw new Error("analysis dataset mismatch");
  const replay = analyzeCtrOpportunities(dataset, minimumImpressions);
  if (canonicalJson(replay) !== canonicalJson(analysis)) throw new Error("CTR analysis replay mismatch");
}

export async function fetchSearchAnalytics(input: SearchAnalyticsRequest, accessToken: string | undefined, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<LiveSearchConsoleResult> {
  if (!accessToken?.trim()) return Object.freeze({ status: "UNAVAILABLE", reason: "Search Console OAuth access token unavailable" });
  const request = normalizeRequest(input);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(request.siteUrl)}/searchAnalytics/query`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: request.startDate, endDate: request.endDate, dimensions: request.dimensions, rowLimit: request.rowLimit, startRow: request.startRow, ...(request.type ? { type: request.type } : {}) }),
      signal,
    });
  } catch (error) {
    return Object.freeze({ status: "FAIL", reason: `Search Console request failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) return Object.freeze({ status: "FAIL", reason: `Search Console API returned HTTP ${response.status}` });

  try {
    const body = await response.json() as { rows?: unknown };
    const rows = body.rows ?? [];
    if (!Array.isArray(rows)) throw new Error("rows must be an array");
    const dataset = createDatasetWithAuthority(input, rows as SearchAnalyticsRow[], "SEARCH_CONSOLE_API");
    validateDataset(dataset);
    return Object.freeze({ status: "PASS", dataset });
  } catch (error) {
    return Object.freeze({ status: "FAIL", reason: `Search Console response rejected: ${error instanceof Error ? error.message : String(error)}` });
  }
}
