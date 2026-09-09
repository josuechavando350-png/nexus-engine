import {
  SEO_PROFESSIONAL_CONNECTIONS as CORE_CONNECTIONS,
  SEO_PROFESSIONAL_STRATEGIES as CORE_STRATEGIES,
} from "./topology.js";

export type SeoProfessionalMasterStrategyNumber =
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

export type SeoProfessionalMasterStrategyId =
  | "detector-de-trampas"
  | "cazador-con-lupa"
  | "camaleon-web"
  | "iman-del-mapa"
  | "emboscador-de-nacimientos"
  | "infiltrador-corporativo"
  | "recomendacion-de-dios"
  | "resucitador-de-muertos"
  | "parasito-inteligente"
  | "candado-invisible"
  | "guardian-latencia-cero"
  | "motor-rag-dinamico"
  | "inyector-semantico"
  | "matriz-de-enlaces"
  | "cola-fifo"
  | "inyector-indexacion";

export interface SeoProfessionalMasterStrategyDefinition {
  readonly number: SeoProfessionalMasterStrategyNumber;
  readonly id: SeoProfessionalMasterStrategyId;
  readonly implementationRef: string;
  readonly responsibility: string;
}

export type SeoProfessionalMasterConnectionChannel =
  | "QUALIFIED_CONVERSION_FEEDBACK"
  | "PAID_SEARCH_TRAFFIC"
  | "ATTRIBUTED_LANDING_FEEDBACK"
  | "LOCAL_STRUCTURED_PRESENCE"
  | "VERIFIED_LOCAL_ENTITY_CONTEXT"
  | "VERIFIED_SENDER_IDENTITY"
  | "CONSENTED_DOMAIN_BIRTH_OUTREACH"
  | "VERIFIED_SELLER_IDENTITY"
  | "QUALIFIED_PROCUREMENT_HANDOFF"
  | "VERIFIED_PUBLISHER_IDENTITY"
  | "GROUNDED_STRUCTURED_LANDING"
  | "VERIFIED_REVIVAL_OPERATOR_IDENTITY"
  | "QUALIFIED_REVIVAL_HANDOFF"
  | "VERIFIED_PSEO_OPERATOR_IDENTITY"
  | "AUTHORIZED_PROGRAMMATIC_LANDING"
  | "VERIFIED_EDGE_OPERATOR_IDENTITY"
  | "RESILIENT_EDGE_RUNTIME_HANDOFF"
  | "GUARDED_RAG_REQUEST"
  | "GROUNDED_DYNAMIC_CONTENT"
  | "SEMANTIC_HTML"
  | "EDGE_LINKED_LANDING"
  | "VERIFIED_INDEXABLE_PAGE_EVENT"
  | "ORDERED_INDEXING_ELIGIBILITY_EVENT"
  | "INDEXING_NOTIFICATION_STATUS";

export type SeoProfessionalMasterConnectionBoundary =
  | "GOOGLE_ADS"
  | "WEB_REQUEST"
  | "WHATSAPP_BUSINESS"
  | "PUBLIC_PROCUREMENT"
  | "EDGE_DELIVERY"
  | "EVENT_QUEUE"
  | "GOOGLE_INDEXING";

export interface SeoProfessionalMasterConnection {
  readonly from: SeoProfessionalMasterStrategyNumber;
  readonly to: SeoProfessionalMasterStrategyNumber;
  readonly channel: SeoProfessionalMasterConnectionChannel;
  readonly boundary: SeoProfessionalMasterConnectionBoundary;
}

export const SEO_PROFESSIONAL_MASTER_STRATEGIES: readonly SeoProfessionalMasterStrategyDefinition[] = Object.freeze([
  ...CORE_STRATEGIES.map((strategy) => Object.freeze({
    number: strategy.number as SeoProfessionalMasterStrategyNumber,
    id: strategy.id as SeoProfessionalMasterStrategyId,
    implementationRef: strategy.implementationRef,
    responsibility: strategy.responsibility,
  })),
  Object.freeze({
    number: 5 as const,
    id: "emboscador-de-nacimientos" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/05-emboscador-de-nacimientos",
    responsibility: "privacy-minimized RDAP/DNS domain-birth verification and consent-gated WhatsApp Cloud API outreach",
  }),
  Object.freeze({
    number: 6 as const,
    id: "infiltrador-corporativo" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/06-infiltrador-corporativo",
    responsibility: "public procurement intelligence through OCDS-first ingestion, robots-governed public HTML fallback, tenant-isolated asynchronous work and first-party opportunity handoff",
  }),
  Object.freeze({
    number: 7 as const,
    id: "recomendacion-de-dios" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/07-recomendacion-de-dios",
    responsibility: "verified semantic-graph grounding, page-visible Schema.org projection, Google structured-data policy gates and hash-bound first-party JSON-LD",
  }),
  Object.freeze({
    number: 8 as const,
    id: "resucitador-de-muertos" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/08-resucitador-de-muertos",
    responsibility: "passive public-homepage technology enrichment for authorized dormant relationships, Redis-backed distributed review jobs and first-party reactivation handoff without vulnerability scanning or automated outreach",
  }),
  Object.freeze({
    number: 9 as const,
    id: "parasito-inteligente" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/09-parasito-inteligente",
    responsibility: "owned-or-explicitly-authorized programmatic SEO publication by reusing the canonical CORTEX headless programmatic SEO engine behind DNS-scoped property authorization and governed first-party catalog sources",
  }),
  Object.freeze({
    number: 10 as const,
    id: "candado-invisible" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/10-candado-invisible",
    responsibility: "portable first-party edge resilience with bounded timeouts, circuit breaking, isolate bulkheads, privacy-safe cache policy and provider-specific Cloudflare/Vercel stale delivery semantics without uptime-immunity claims",
  }),
  Object.freeze({
    number: 11 as const,
    id: "guardian-latencia-cero" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/11-guardian-latencia-cero",
    responsibility: "portable global handler supervision layered inside #10 with cooperative deadlines, logical-operation circuit breaking, bounded fallback execution and isolate pressure containment without zero-latency or forced-GC claims",
  }),
  Object.freeze({
    number: 12 as const,
    id: "motor-rag-dinamico" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/12-motor-rag-dinamico",
    responsibility: "framework-neutral grounded Edge RAG using verified first-party knowledge and Workers AI or bounded OpenAI-compatible inference without allowing unsupported model answers",
  }),
  Object.freeze({
    number: 13 as const,
    id: "inyector-semantico" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/13-inyector-semantico",
    responsibility: "idempotent Schema.org JSON-LD interleaving from #7 hash-grounded artifacts with schema-dts-compatible TypeScript shape and Google Indexing eligibility derivation",
  }),
  Object.freeze({
    number: 14 as const,
    id: "matriz-de-enlaces" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/14-matriz-de-enlaces",
    responsibility: "same-origin Edge-compiled internal link matrices backed by Cloudflare Workers KV or Upstash Redis REST and injected safely before HTML delivery",
  }),
  Object.freeze({
    number: 15 as const,
    id: "cola-fifo" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/15-cola-fifo",
    responsibility: "distributed indexing-event queue with QStash strict FIFO semantics and an explicit non-FIFO Cloudflare Queues adapter that cannot masquerade as ordered delivery",
  }),
  Object.freeze({
    number: 16 as const,
    id: "inyector-indexacion" as const,
    implementationRef: "packages/ontology/cortex/seo-profesional/16-inyector-indexacion",
    responsibility: "serverless Google Indexing API publication through an official googleapis client boundary restricted to eligible JobPosting and livestream BroadcastEvent pages",
  }),
] as const);

export const SEO_PROFESSIONAL_MASTER_CONNECTIONS: readonly SeoProfessionalMasterConnection[] = Object.freeze([
  ...CORE_CONNECTIONS.map((connection) => Object.freeze({
    from: connection.from as SeoProfessionalMasterStrategyNumber,
    to: connection.to as SeoProfessionalMasterStrategyNumber,
    channel: connection.channel as SeoProfessionalMasterConnectionChannel,
    boundary: connection.boundary as SeoProfessionalMasterConnectionBoundary,
  })),
  Object.freeze({ from: 4 as const, to: 5 as const, channel: "VERIFIED_SENDER_IDENTITY" as const, boundary: "WHATSAPP_BUSINESS" as const }),
  Object.freeze({ from: 5 as const, to: 1 as const, channel: "CONSENTED_DOMAIN_BIRTH_OUTREACH" as const, boundary: "WHATSAPP_BUSINESS" as const }),
  Object.freeze({ from: 4 as const, to: 6 as const, channel: "VERIFIED_SELLER_IDENTITY" as const, boundary: "PUBLIC_PROCUREMENT" as const }),
  Object.freeze({ from: 6 as const, to: 1 as const, channel: "QUALIFIED_PROCUREMENT_HANDOFF" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 4 as const, to: 7 as const, channel: "VERIFIED_PUBLISHER_IDENTITY" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 7 as const, to: 1 as const, channel: "GROUNDED_STRUCTURED_LANDING" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 4 as const, to: 8 as const, channel: "VERIFIED_REVIVAL_OPERATOR_IDENTITY" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 8 as const, to: 1 as const, channel: "QUALIFIED_REVIVAL_HANDOFF" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 4 as const, to: 9 as const, channel: "VERIFIED_PSEO_OPERATOR_IDENTITY" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 9 as const, to: 1 as const, channel: "AUTHORIZED_PROGRAMMATIC_LANDING" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 4 as const, to: 10 as const, channel: "VERIFIED_EDGE_OPERATOR_IDENTITY" as const, boundary: "EDGE_DELIVERY" as const }),
  Object.freeze({ from: 10 as const, to: 11 as const, channel: "RESILIENT_EDGE_RUNTIME_HANDOFF" as const, boundary: "EDGE_DELIVERY" as const }),
  Object.freeze({ from: 11 as const, to: 12 as const, channel: "GUARDED_RAG_REQUEST" as const, boundary: "EDGE_DELIVERY" as const }),
  Object.freeze({ from: 12 as const, to: 13 as const, channel: "GROUNDED_DYNAMIC_CONTENT" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 13 as const, to: 14 as const, channel: "SEMANTIC_HTML" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 14 as const, to: 1 as const, channel: "EDGE_LINKED_LANDING" as const, boundary: "WEB_REQUEST" as const }),
  Object.freeze({ from: 13 as const, to: 15 as const, channel: "VERIFIED_INDEXABLE_PAGE_EVENT" as const, boundary: "EVENT_QUEUE" as const }),
  Object.freeze({ from: 15 as const, to: 16 as const, channel: "ORDERED_INDEXING_ELIGIBILITY_EVENT" as const, boundary: "EVENT_QUEUE" as const }),
  Object.freeze({ from: 16 as const, to: 13 as const, channel: "INDEXING_NOTIFICATION_STATUS" as const, boundary: "GOOGLE_INDEXING" as const }),
] as const);

function reachable(
  start: SeoProfessionalMasterStrategyNumber,
  connections: readonly SeoProfessionalMasterConnection[],
  reverse: boolean,
): Set<SeoProfessionalMasterStrategyNumber> {
  const visited = new Set<SeoProfessionalMasterStrategyNumber>();
  const queue: SeoProfessionalMasterStrategyNumber[] = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const edge of connections) {
      const source = reverse ? edge.to : edge.from;
      const target = reverse ? edge.from : edge.to;
      if (source === current && !visited.has(target)) queue.push(target);
    }
  }
  return visited;
}

export function assertConnectedSeoProfessionalMasterTopology(
  strategies: readonly SeoProfessionalMasterStrategyDefinition[] = SEO_PROFESSIONAL_MASTER_STRATEGIES,
  connections: readonly SeoProfessionalMasterConnection[] = SEO_PROFESSIONAL_MASTER_CONNECTIONS,
): void {
  if (!Array.isArray(strategies) || strategies.length === 0) throw new Error("SEO Profesional master topology requires at least one strategy");
  if (!Array.isArray(connections) || connections.length === 0) throw new Error("SEO Profesional master topology requires at least one connection");
  const numbers = new Set<SeoProfessionalMasterStrategyNumber>();
  const ids = new Set<SeoProfessionalMasterStrategyId>();
  for (const strategy of strategies) {
    if (numbers.has(strategy.number)) throw new Error(`duplicate SEO master strategy number ${strategy.number}`);
    if (ids.has(strategy.id)) throw new Error(`duplicate SEO master strategy id ${strategy.id}`);
    if (!strategy.implementationRef.trim()) throw new Error(`SEO master strategy ${strategy.number} has no implementation reference`);
    numbers.add(strategy.number);
    ids.add(strategy.id);
  }
  for (const edge of connections) {
    if (!numbers.has(edge.from) || !numbers.has(edge.to)) throw new Error(`SEO master connection ${edge.from}->${edge.to} references an unknown strategy`);
    if (edge.from === edge.to) throw new Error(`SEO master strategy ${edge.from} cannot connect only to itself`);
  }
  for (const number of numbers) {
    if (!connections.some((edge) => edge.from === number)) throw new Error(`SEO master strategy ${number} has no outgoing connection`);
    if (!connections.some((edge) => edge.to === number)) throw new Error(`SEO master strategy ${number} has no incoming connection`);
  }
  const start = strategies[0]!.number;
  if (reachable(start, connections, false).size !== strategies.length || reachable(start, connections, true).size !== strategies.length) {
    throw new Error("SEO Profesional master strategy graph must remain strongly connected");
  }
}

assertConnectedSeoProfessionalMasterTopology();
