import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolvePymeProfile, type PymeCapabilityEvidence, type PymeProfileResolution } from "./profile.js";

const MAX_PROFILE_BYTES = 64 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export class PymeProductionProfileError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "PROFILE_BLOCKED" | "DIGEST_MISMATCH", message: string) {
    super(message);
    this.name = "PymeProductionProfileError";
  }
}

function evidenceFile(path: string): Readonly<Record<string, PymeCapabilityEvidence>> {
  if (!isAbsolute(path)) throw new PymeProductionProfileError("INVALID_CONFIG", "PyME profile evidence file must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_PROFILE_BYTES) throw new PymeProductionProfileError("INVALID_CONFIG", "PyME profile evidence file must be a bounded regular file");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new PymeProductionProfileError("INVALID_CONFIG", "PyME profile evidence file is malformed JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new PymeProductionProfileError("INVALID_CONFIG", "PyME profile evidence must be a plain object");
  return parsed as Readonly<Record<string, PymeCapabilityEvidence>>;
}

export function loadPymeProductionProfile(env: NodeJS.ProcessEnv): PymeProfileResolution | null {
  const profile = env.NEXUS_CORTEX_PROFILE?.trim();
  if (!profile) return null;
  if (profile !== "PYME") throw new PymeProductionProfileError("INVALID_CONFIG", "NEXUS_CORTEX_PROFILE must be PYME when set");
  const evidencePath = env.NEXUS_CORTEX_PYME_PROFILE_EVIDENCE_FILE?.trim();
  if (!evidencePath) throw new PymeProductionProfileError("INVALID_CONFIG", "NEXUS_CORTEX_PYME_PROFILE_EVIDENCE_FILE is required for the PyME profile");
  const expectedDigest = env.NEXUS_CORTEX_PYME_PROFILE_DIGEST?.trim();
  if (!expectedDigest || !SHA256.test(expectedDigest)) throw new PymeProductionProfileError("INVALID_CONFIG", "NEXUS_CORTEX_PYME_PROFILE_DIGEST must be a lowercase sha256 digest");
  const resolution = resolvePymeProfile(evidenceFile(evidencePath));
  if (resolution.profileDigest !== expectedDigest) throw new PymeProductionProfileError("DIGEST_MISMATCH", "PyME profile evidence does not match the deployment digest");
  if (!resolution.ready) {
    const blocked = resolution.capabilities.filter((entry) => entry.mode === "BLOCKED").map((entry) => `${entry.capabilityId}:${entry.reasons.join("+")}`).join(",");
    throw new PymeProductionProfileError("PROFILE_BLOCKED", `PyME profile has blocked capabilities: ${blocked}`);
  }
  return resolution;
}
