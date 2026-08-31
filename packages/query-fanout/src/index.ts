import { createHash } from "node:crypto";

export type EvidenceNeed = "PRIMARY_SOURCE" | "FIRST_PARTY" | "EXPERIENCE" | "COMPARISON" | "LOCAL";

export interface FanOutFactor {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

export interface FanOutInput {
  readonly rootQuery: string;
  readonly locale: string;
  readonly intents: readonly FanOutFactor[];
  readonly entities: readonly FanOutFactor[];
  readonly attributes: readonly FanOutFactor[];
  readonly constraints: readonly FanOutFactor[];
  readonly evidenceNeeds: readonly EvidenceNeed[];
  readonly maximumQueries?: number;
}

export interface SimulatedSubquery {
  readonly authority: "NEXUS_SIMULATED_QUERY_V1";
  readonly id: string;
  readonly query: string;
  readonly intentId: string | null;
  readonly entityId: string | null;
  readonly entityLabel: string | null;
  readonly attributeId: string | null;
  readonly constraintId: string | null;
  readonly evidenceNeed: EvidenceNeed | null;
  readonly plausibilityWeight: number;
  readonly digest: string;
}

export interface CorpusPassage {
  readonly id: string;
  readonly url: string;
  readonly heading: string;
  readonly text: string;
  readonly topics: readonly string[];
  readonly entities: readonly string[];
  readonly evidence: readonly EvidenceNeed[];
}

export interface QueryCoverage {
  readonly queryId: string;
  readonly bestPassageId: string | null;
  readonly lexicalCoverage: number;
  readonly entityCoverage: number;
  readonly evidenceCoverage: number;
  readonly combinedCoverage: number;
}

export interface FanOutReport {
  readonly authority: "NEXUS_QUERY_FANOUT_SIMULATION_V1";
  readonly interpretation: "SIMULATED_PLAUSIBLE_NOT_OBSERVED_GOOGLE_INTERNAL_QUERIES";
  readonly rootQuery: string;
  readonly locale: string;
  readonly queries: readonly SimulatedSubquery[];
  readonly coverage: readonly QueryCoverage[];
  readonly weightedCoverage: number;
  readonly uncoveredQueryIds: readonly string[];
  readonly recommendations: readonly string[];
  readonly reportDigest: string;
}

function canon(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("Non-plain object");
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`Undefined at ${key}`);
      out[key] = canon(item);
    }
    return out;
  }
  throw new Error(`Unsupported value: ${typeof value}`);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalized(value: string): string {
  return clean(value)
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalized(value).split(/\s+/).filter((token) => token.length > 1));
}

function ratioIntersection(left: Set<string>, right: Set<string>): number {
  if (left.size === 0) return 1;
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count / left.size;
}

function validateFactors(values: readonly FanOutFactor[], label: string): FanOutFactor[] {
  const ids = new Set<string>();
  return values
    .map((value) => {
      const id = clean(value.id);
      const itemLabel = clean(value.label);
      if (!id || !itemLabel || ids.has(id)) throw new Error(`Invalid or duplicate ${label} factor`);
      if (!Number.isFinite(value.weight) || value.weight <= 0 || value.weight > 1) {
        throw new Error(`${label} weight must be in (0,1]`);
      }
      ids.add(id);
      return Object.freeze({ id, label: itemLabel, weight: value.weight });
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
}

function makeSubquery(
  root: string,
  intent: FanOutFactor | null,
  entity: FanOutFactor | null,
  attribute: FanOutFactor | null,
  constraint: FanOutFactor | null,
  evidenceNeed: EvidenceNeed | null,
): SimulatedSubquery {
  const parts = [
    root,
    entity?.label,
    attribute?.label,
    constraint?.label,
    intent?.label,
    evidenceNeed?.toLowerCase().replaceAll("_", " "),
  ].filter((part): part is string => Boolean(part));
  const query = clean([...new Set(parts)].join(" "));
  const plausibilityWeight = [intent?.weight, entity?.weight, attribute?.weight, constraint?.weight]
    .filter((weight): weight is number => weight !== undefined)
    .reduce((left, right) => left * right, 1);
  const core = {
    authority: "NEXUS_SIMULATED_QUERY_V1" as const,
    query,
    intentId: intent?.id ?? null,
    entityId: entity?.id ?? null,
    entityLabel: entity?.label ?? null,
    attributeId: attribute?.id ?? null,
    constraintId: constraint?.id ?? null,
    evidenceNeed,
    plausibilityWeight,
  };
  const queryDigest = digest(core);
  return Object.freeze({ ...core, id: `qf_${queryDigest.slice(0, 16)}`, digest: queryDigest });
}

export function simulateFanOut(input: FanOutInput): readonly SimulatedSubquery[] {
  const root = clean(input.rootQuery);
  const locale = clean(input.locale);
  if (root.length < 2) throw new Error("rootQuery is required");
  if (!locale) throw new Error("locale is required");
  const maximumQueries = input.maximumQueries ?? 96;
  if (!Number.isInteger(maximumQueries) || maximumQueries < 1 || maximumQueries > 512) {
    throw new Error("maximumQueries must be in [1,512]");
  }
  const intents = validateFactors(input.intents, "intent");
  const entities = validateFactors(input.entities, "entity");
  const attributes = validateFactors(input.attributes, "attribute");
  const constraints = validateFactors(input.constraints, "constraint");
  const evidenceNeeds = [...new Set(input.evidenceNeeds)].sort();
  const output = new Map<string, SimulatedSubquery>();
  const add = (query: SimulatedSubquery) => {
    if (!output.has(query.query)) output.set(query.query, query);
  };

  for (const intent of [null, ...intents]) {
    for (const entity of [null, ...entities]) {
      for (const attribute of [null, ...attributes]) {
        for (const constraint of [null, ...constraints]) {
          for (const evidenceNeed of [null, ...evidenceNeeds]) {
            if (!intent && !entity && !attribute && !constraint && !evidenceNeed) {
              add(makeSubquery(root, null, null, null, null, null));
              continue;
            }
            add(makeSubquery(root, intent, entity, attribute, constraint, evidenceNeed));
          }
        }
      }
    }
  }

  return Object.freeze(
    [...output.values()]
      .sort((a, b) => b.plausibilityWeight - a.plausibilityWeight || a.id.localeCompare(b.id, "en"))
      .slice(0, maximumQueries),
  );
}

function coverageFor(query: SimulatedSubquery, passage: CorpusPassage): Omit<QueryCoverage, "queryId"> {
  const queryTokens = tokens(query.query);
  const passageTokens = tokens(`${passage.heading} ${passage.text} ${passage.topics.join(" ")} ${passage.entities.join(" ")}`);
  const lexicalCoverage = ratioIntersection(queryTokens, passageTokens);
  const entityCoverage = query.entityLabel === null
    ? 1
    : passage.entities.some((entity) => {
        const corpusEntity = normalized(entity);
        const expectedEntity = normalized(query.entityLabel ?? "");
        return corpusEntity === expectedEntity || tokens(entity).size > 0 && ratioIntersection(tokens(entity), tokens(query.entityLabel ?? "")) === 1;
      }) ? 1 : 0;
  const evidenceCoverage = query.evidenceNeed === null ? 1 : passage.evidence.includes(query.evidenceNeed) ? 1 : 0;
  const combinedCoverage = lexicalCoverage * 0.65 + entityCoverage * 0.2 + evidenceCoverage * 0.15;
  return { bestPassageId: passage.id, lexicalCoverage, entityCoverage, evidenceCoverage, combinedCoverage };
}

export function assessFanOut(input: FanOutInput, corpus: readonly CorpusPassage[]): FanOutReport {
  const queries = simulateFanOut(input);
  const passageIds = new Set<string>();
  for (const passage of corpus) {
    const passageId = clean(passage.id);
    const passageUrl = clean(passage.url);
    if (!passageId || !passageUrl || passageIds.has(passageId)) throw new Error("Invalid or duplicate corpus passage");
    try {
      new URL(passageUrl);
    } catch {
      throw new Error("Corpus passage URL must be absolute");
    }
    passageIds.add(passageId);
  }
  const coverage: QueryCoverage[] = queries.map((query) => {
    const best = corpus
      .map((passage) => coverageFor(query, passage))
      .sort((a, b) => b.combinedCoverage - a.combinedCoverage || String(a.bestPassageId).localeCompare(String(b.bestPassageId), "en"))[0];
    return Object.freeze({
      queryId: query.id,
      ...(best ?? { bestPassageId: null, lexicalCoverage: 0, entityCoverage: 0, evidenceCoverage: 0, combinedCoverage: 0 }),
    });
  });
  const totalWeight = queries.reduce((sum, query) => sum + query.plausibilityWeight, 0);
  const weightedCoverage = totalWeight === 0
    ? 0
    : queries.reduce((sum, query, index) => sum + query.plausibilityWeight * coverage[index]!.combinedCoverage, 0) / totalWeight;
  const uncoveredQueryIds = Object.freeze(
    coverage.filter((item) => item.combinedCoverage < 0.55).map((item) => item.queryId).sort(),
  );
  const recommendations: string[] = [];
  if (uncoveredQueryIds.length) {
    recommendations.push("Strengthen existing useful pages/passages for uncovered simulated needs; do not create doorway or scaled pages solely to satisfy the simulator.");
  }
  if (coverage.some((item) => item.evidenceCoverage < 1)) {
    recommendations.push("Add the required real evidence near the relevant claim when it exists; never fabricate first-party data or primary sources.");
  }
  if (coverage.some((item) => item.entityCoverage < 1)) {
    recommendations.push("Clarify entity references in existing content and connect them to Entity Intelligence; do not keyword-stuff entity names.");
  }
  const core = {
    authority: "NEXUS_QUERY_FANOUT_SIMULATION_V1" as const,
    interpretation: "SIMULATED_PLAUSIBLE_NOT_OBSERVED_GOOGLE_INTERNAL_QUERIES" as const,
    rootQuery: clean(input.rootQuery),
    locale: clean(input.locale),
    queries,
    coverage: Object.freeze(coverage),
    weightedCoverage,
    uncoveredQueryIds,
    recommendations: Object.freeze(recommendations),
  };
  return Object.freeze({ ...core, reportDigest: digest(core) });
}
