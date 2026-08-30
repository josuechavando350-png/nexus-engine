import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTransportPolicy, curlHttp3OnlyCommand, verifyTransportObservation } from "../packages/transport-http3/src/index.ts";

function parseHeaderDump(text) {
  const blocks = text.replaceAll("\r\n", "\n").split(/\n\n+/).map((block) => block.trim()).filter(Boolean);
  const interim = [];
  const earlyHintLinks = [];
  const finalLinks = [];
  let observedProtocol = null;
  let finalStatus = null;

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const statusLine = lines[0] ?? "";
    const match = /^HTTP\/(\S+)\s+(\d{3})\b/i.exec(statusLine);
    if (!match) continue;
    observedProtocol = match[1] ?? observedProtocol;
    const status = Number(match[2]);
    const links = lines.filter((line) => /^link\s*:/i.test(line)).map((line) => line.replace(/^link\s*:\s*/i, ""));
    if (status >= 100 && status < 200) {
      interim.push(status);
      if (status === 103) earlyHintLinks.push(...links);
    } else {
      finalStatus = status;
      finalLinks.push(...links);
    }
  }
  return { observedProtocol, observedInterimStatuses: interim, earlyHintLinks, finalStatus, finalLinks };
}

async function main() {
  const args = process.argv.slice(2);
  const policyIndex = args.indexOf("--policy");
  const urlIndex = args.indexOf("--url");
  if (policyIndex < 0 || !args[policyIndex + 1] || urlIndex < 0 || !args[urlIndex + 1]) {
    throw new Error("usage: node scripts/verify-transport-http3.mjs --policy <json> --url <https-url>");
  }

  const rawPolicy = JSON.parse(await readFile(resolve(args[policyIndex + 1]), "utf8"));
  const policy = createTransportPolicy(rawPolicy);
  const command = curlHttp3OnlyCommand(args[urlIndex + 1]);
  const execution = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });

  let observation;
  if (execution.error || execution.status !== 0) {
    observation = {
      observedProtocol: null,
      observedInterimStatuses: [],
      earlyHintLinks: [],
      finalStatus: null,
      finalLinks: [],
      probeAvailable: false,
      probeAuthority: "LIVE_NETWORK",
    };
  } else {
    observation = { ...parseHeaderDump(execution.stdout), probeAvailable: true, probeAuthority: "LIVE_NETWORK" };
  }

  const verification = verifyTransportObservation(policy, observation);
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  process.exitCode = verification.status === "PASS" ? 0 : verification.status === "UNAVAILABLE" ? 2 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
