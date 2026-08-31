#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function unavailable(reason, detail = null) {
  process.stdout.write(`${JSON.stringify({
    authority: "NEXUS_QUERY_FANOUT_RUNTIME_AUDIT_V1",
    evidenceState: "UNAVAILABLE",
    interpretation: "SIMULATED_PLAUSIBLE_NOT_OBSERVED_GOOGLE_INTERNAL_QUERIES",
    reason,
    detail,
  }, null, 2)}\n`);
  process.exitCode = 2;
}

const args = process.argv.slice(2);
const inputIndex = args.indexOf("--input");
if (inputIndex < 0 || !args[inputIndex + 1]) {
  unavailable("INPUT_NOT_PROVIDED");
} else {
  try {
    const inputPath = resolve(args[inputIndex + 1]);
    const raw = await readFile(inputPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.fanOut || !Array.isArray(parsed.corpus)) {
      throw new Error("input must contain fanOut and corpus[]");
    }
    const moduleUrl = pathToFileURL(resolve("packages/query-fanout/dist/index.js")).href;
    const { assessFanOut } = await import(moduleUrl);
    const report = assessFanOut(parsed.fanOut, parsed.corpus);
    process.stdout.write(`${JSON.stringify({
      authority: "NEXUS_QUERY_FANOUT_RUNTIME_AUDIT_V1",
      evidenceState: "OBSERVED",
      externalCorpusVerification: "NOT_VERIFIED",
      interpretation: report.interpretation,
      report,
    }, null, 2)}\n`);
  } catch (error) {
    unavailable("AUDIT_EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
  }
}
