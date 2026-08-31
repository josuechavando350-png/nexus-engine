#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { runPricingIntelligence, type PricingRuntimeRequest } from "./pricing-intelligence-runtime";

const MAX_INPUT_BYTES = 1_000_000;

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("usage: nexus-pricing-intelligence <request.json>");
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw,"utf8") > MAX_INPUT_BYTES) throw new Error("pricing request exceeds input byte budget");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("pricing request must be a JSON object");
  const allowed = new Set(["scope","subjectId","observedAt","url","timeoutMs"]);
  for (const key of Object.keys(parsed)) if (!allowed.has(key)) throw new Error(`unknown pricing request field: ${key}`);
  const report = await runPricingIntelligence(parsed as PricingRuntimeRequest);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
