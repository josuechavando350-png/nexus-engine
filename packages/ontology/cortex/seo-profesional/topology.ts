export type SeoProfessionalStrategyNumber = 1 | 2 | 3;

export type SeoProfessionalStrategyId =
  | "detector-de-trampas"
  | "cazador-con-lupa"
  | "camaleon-web";

export interface SeoProfessionalStrategyDefinition {
  readonly number: SeoProfessionalStrategyNumber;
  readonly id: SeoProfessionalStrategyId;
  readonly implementationRef: string;
  readonly responsibility: string;
}

export type SeoProfessionalConnectionChannel =
  | "QUALIFIED_CONVERSION_FEEDBACK"
  | "PAID_SEARCH_TRAFFIC"
  | "ATTRIBUTED_LANDING_FEEDBACK";

export interface SeoProfessionalConnection {
  readonly from: SeoProfessionalStrategyNumber;
  readonly to: SeoProfessionalStrategyNumber;
  readonly channel: SeoProfessionalConnectionChannel;
  readonly boundary: "GOOGLE_ADS" | "WEB_REQUEST";
}

export const SEO_PROFESSIONAL_STRATEGIES: readonly SeoProfessionalStrategyDefinition[] = Object.freeze([
  Object.freeze({
    number: 1,
    id: "detector-de-trampas",
    implementationRef: "packages/ontology/cortex/seo-profesional/01-detector-de-trampas",
    responsibility: "invalid-traffic assessment and qualified offline conversion feedback",
  }),
  Object.freeze({
    number: 2,
    id: "cazador-con-lupa",
    implementationRef: "packages/ontology/cortex/seo-profesional/02-cazador-con-lupa",
    responsibility: "search-term evidence and exact-match materialization",
  }),
  Object.freeze({
    number: 3,
    id: "camaleon-web",
    implementationRef: "packages/core/cortex/ad-context-edge-workers",
    responsibility: "query/ad-context driven allowlisted landing personalization",
  }),
] as const);

export const SEO_PROFESSIONAL_CONNECTIONS: readonly SeoProfessionalConnection[] = Object.freeze([
  Object.freeze({ from: 1, to: 2, channel: "QUALIFIED_CONVERSION_FEEDBACK", boundary: "GOOGLE_ADS" }),
  Object.freeze({ from: 2, to: 3, channel: "PAID_SEARCH_TRAFFIC", boundary: "GOOGLE_ADS" }),
  Object.freeze({ from: 3, to: 1, channel: "ATTRIBUTED_LANDING_FEEDBACK", boundary: "WEB_REQUEST" }),
] as const);

function reachable(
  start: SeoProfessionalStrategyNumber,
  connections: readonly SeoProfessionalConnection[],
  reverse: boolean,
): Set<SeoProfessionalStrategyNumber> {
  const visited = new Set<SeoProfessionalStrategyNumber>();
  const queue: SeoProfessionalStrategyNumber[] = [start];
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

export function assertConnectedSeoProfessionalTopology(
  strategies: readonly SeoProfessionalStrategyDefinition[] = SEO_PROFESSIONAL_STRATEGIES,
  connections: readonly SeoProfessionalConnection[] = SEO_PROFESSIONAL_CONNECTIONS,
): void {
  if (!Array.isArray(strategies) || strategies.length === 0) throw new Error("SEO Profesional topology requires at least one strategy");
  if (!Array.isArray(connections) || connections.length === 0) throw new Error("SEO Profesional topology requires at least one connection");

  const numbers = new Set<SeoProfessionalStrategyNumber>();
  const ids = new Set<SeoProfessionalStrategyId>();
  for (const strategy of strategies) {
    if (numbers.has(strategy.number)) throw new Error(`duplicate SEO strategy number ${strategy.number}`);
    if (ids.has(strategy.id)) throw new Error(`duplicate SEO strategy id ${strategy.id}`);
    if (!strategy.implementationRef.trim()) throw new Error(`SEO strategy ${strategy.number} has no implementation reference`);
    numbers.add(strategy.number);
    ids.add(strategy.id);
  }

  for (const edge of connections) {
    if (!numbers.has(edge.from) || !numbers.has(edge.to)) throw new Error(`SEO connection ${edge.from}->${edge.to} references an unknown strategy`);
    if (edge.from === edge.to) throw new Error(`SEO strategy ${edge.from} cannot connect only to itself`);
  }

  for (const number of numbers) {
    if (!connections.some((edge) => edge.from === number)) throw new Error(`SEO strategy ${number} has no outgoing connection`);
    if (!connections.some((edge) => edge.to === number)) throw new Error(`SEO strategy ${number} has no incoming connection`);
  }

  const start = strategies[0]!.number;
  if (reachable(start, connections, false).size !== strategies.length || reachable(start, connections, true).size !== strategies.length) {
    throw new Error("SEO Profesional strategy graph must remain strongly connected");
  }
}

assertConnectedSeoProfessionalTopology();
