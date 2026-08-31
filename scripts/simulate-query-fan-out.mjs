import { simulateQueryFanOut } from "../packages/query-fan-out/dist/index.js";

const query = process.argv[2];
if (!query) throw new Error("usage: node scripts/simulate-query-fan-out.mjs <query>");
const result = simulateQueryFanOut({ tenantId: "local-operator", scope: "diagnostic", query, maxDepth: 1, maxNodes: 16, seeds: [
  { kind: "INTENT", text: `Understand ${query}` },
  { kind: "RELATED_QUESTION", text: `What evidence supports ${query}?` },
] });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
