import {
  SEO_PROFESSIONAL_CONNECTIONS as CORE_CONNECTIONS,
  SEO_PROFESSIONAL_STRATEGIES as CORE_STRATEGIES,
} from "./topology.js";

export type SeoProfessionalMasterStrategyNumber = 1 | 2 | 3 | 4 | 5;

export type SeoProfessionalMasterStrategyId =
  | "detector-de-trampas"
  | "cazador-con-lupa"
  | "camaleon-web"
  | "iman-del-mapa"
  | "emboscador-de-nacimientos";

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
  | "CONSENTED_DOMAIN_BIRTH_OUTREACH";

export interface SeoProfessionalMasterConnection {
  readonly from: SeoProfessionalMasterStrategyNumber;
  readonly to: SeoProfessionalMasterStrategyNumber;
  readonly channel: SeoProfessionalMasterConnectionChannel;
  readonly boundary: "GOOGLE_ADS" | "WEB_REQUEST" | "WHATSAPP_BUSINESS";
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
] as const);

export const SEO_PROFESSIONAL_MASTER_CONNECTIONS: readonly SeoProfessionalMasterConnection[] = Object.freeze([
  ...CORE_CONNECTIONS.map((connection) => Object.freeze({
    from: connection.from as SeoProfessionalMasterStrategyNumber,
    to: connection.to as SeoProfessionalMasterStrategyNumber,
    channel: connection.channel as SeoProfessionalMasterConnectionChannel,
    boundary: connection.boundary,
  })),
  Object.freeze({ from: 4 as const, to: 5 as const, channel: "VERIFIED_SENDER_IDENTITY" as const, boundary: "WHATSAPP_BUSINESS" as const }),
  Object.freeze({ from: 5 as const, to: 1 as const, channel: "CONSENTED_DOMAIN_BIRTH_OUTREACH" as const, boundary: "WHATSAPP_BUSINESS" as const }),
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
