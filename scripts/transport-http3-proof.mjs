import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTransportHttp3Policy, probeTransportHttp3 } from "../packages/quality/transport-http3.ts";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) return undefined;
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const policyPath = valueAfter(args, "--policy");
  if (!policyPath) throw new Error("usage: node scripts/transport-http3-proof.mjs --policy <json> [--url <https-url>]");
  const raw = JSON.parse(await readFile(resolve(policyPath), "utf8"));
  const policy = createTransportHttp3Policy({
    host: raw.host,
    hints: raw.hints ?? [],
    enableZeroRtt: raw.enableZeroRtt ?? false,
  });
  const evidence = await probeTransportHttp3(policy, valueAfter(args, "--url"));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = evidence.verdict === "PASS" ? 0 : evidence.verdict === "UNAVAILABLE" ? 3 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
