#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  InMemoryReplayStore,
  decide,
  parseTrustedRuntimeSignalJson,
  validateDecision,
  verifyEnvelope,
} from "../packages/passive-bot-defense/src/index.ts";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputPath = argument("--input") ?? process.env.NEXUS_BOT_EDGE_SIGNAL_PATH;
const envelopePath = argument("--envelope") ?? process.env.NEXUS_BOT_EDGE_ENVELOPE_PATH;
const secretEnv = argument("--secret-env") ?? "NEXUS_BOT_EDGE_HMAC_SECRET";
const expectedMethod = argument("--method") ?? process.env.NEXUS_BOT_EDGE_METHOD;
const expectedPath = argument("--path") ?? process.env.NEXUS_BOT_EDGE_PATH;
const denyEnabled = process.argv.includes("--enable-deny");

if (!inputPath && !envelopePath) {
  process.stdout.write(`${JSON.stringify({
    status: "UNAVAILABLE",
    evidence: "UNAVAILABLE",
    reason: "Provide --input for a trusted runtime adapter record or --envelope for signed edge evidence. No TLS/edge evidence was invented.",
  }, null, 2)}\n`);
  process.exitCode = 2;
} else {
  try {
    let signal;
    let authority;
    if (envelopePath) {
      const secret = process.env[secretEnv];
      if (!secret || !expectedMethod || !expectedPath) {
        process.stdout.write(`${JSON.stringify({
          status: "UNAVAILABLE",
          evidence: "UNAVAILABLE",
          reason: `Signed edge verification requires ${secretEnv}, --method/NEXUS_BOT_EDGE_METHOD and --path/NEXUS_BOT_EDGE_PATH.`,
          deployment: "NOT_VERIFIED",
        }, null, 2)}\n`);
        process.exitCode = 2;
      } else {
        const raw = JSON.parse(await readFile(resolve(envelopePath), "utf8"));
        const payload = await verifyEnvelope({
          encoded: raw.encoded,
          signature: raw.signature,
          keyId: raw.keyId,
          secret,
          now: new Date().toISOString(),
          expectedMethod,
          expectedPath,
          replayStore: new InMemoryReplayStore(),
        });
        signal = payload.signal;
        authority = "HMAC_VERIFIED_SIGNED_EDGE";
      }
    } else {
      signal = parseTrustedRuntimeSignalJson(await readFile(resolve(inputPath), "utf8"));
      authority = `${signal.provider}_${signal.trust}`;
    }

    if (signal) {
      const decision = decide(signal, { denyEnabled });
      validateDecision(signal, decision, { denyEnabled });
      process.stdout.write(`${JSON.stringify({
        status: "ASSESSED",
        evidence: "OBSERVED",
        authority,
        decision,
        distributedReplayProtection: envelopePath ? "NOT_VERIFIED_PROCESS_LOCAL_ONLY" : "NOT_APPLICABLE",
        liveTlsEdgeDeployment: "NOT_VERIFIED",
      }, null, 2)}\n`);
      if (decision.action === "DENY" || decision.action === "RATE_LIMIT") process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      evidence: "OBSERVED",
      reason: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
