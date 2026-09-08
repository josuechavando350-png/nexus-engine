import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PYME_CAPABILITIES, resolvePymeProfile, type PymeCapabilityEvidence } from "./profile";
import { loadPymeProductionProfile } from "./production-profile";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const SHA = "b".repeat(40);

function evidence(): Record<string, PymeCapabilityEvidence> {
  return Object.fromEntries(PYME_CAPABILITIES.map((entry) => [entry.capabilityId, {
    installed: true,
    runtimeReady: true,
    controlReady: true,
    policyDigest: [27, 30, 31, 33].includes(entry.technologyNumber) ? DIGEST : null,
    consentRegistryReady: [30, 31].includes(entry.technologyNumber) ? true : undefined,
    certificationDigest: entry.technologyNumber === 33 ? DIGEST : null,
    sourceRevision: entry.technologyNumber === 33 ? SHA : null,
    statisticalEvidenceReady: entry.technologyNumber === 21 ? false : undefined,
  }]));
}

function fileFor(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-pyme-profile-")); dirs.push(dir);
  const path = join(dir, "profile.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("CORTEX PyME production profile gate", () => {
  it("loads only an exact ready profile whose digest matches deployment config", () => {
    const value = evidence();
    const expected = resolvePymeProfile(value);
    const loaded = loadPymeProductionProfile({ NEXUS_CORTEX_PROFILE: "PYME", NEXUS_CORTEX_PYME_PROFILE_EVIDENCE_FILE: fileFor(value), NEXUS_CORTEX_PYME_PROFILE_DIGEST: expected.profileDigest });
    expect(loaded).toEqual(expected);
    expect(loaded?.capabilities.find((entry) => entry.technologyNumber === 21)?.mode).toBe("FALLBACK_ONLY");
  });

  it("fails closed on digest mismatch or blocked capability evidence", () => {
    const value = evidence();
    expect(() => loadPymeProductionProfile({ NEXUS_CORTEX_PROFILE: "PYME", NEXUS_CORTEX_PYME_PROFILE_EVIDENCE_FILE: fileFor(value), NEXUS_CORTEX_PYME_PROFILE_DIGEST: `sha256:${"f".repeat(64)}` })).toThrow(/does not match/u);
    value["webhook-relay-consent-registry"] = { ...value["webhook-relay-consent-registry"]!, consentRegistryReady: false };
    const blocked = resolvePymeProfile(value);
    expect(() => loadPymeProductionProfile({ NEXUS_CORTEX_PROFILE: "PYME", NEXUS_CORTEX_PYME_PROFILE_EVIDENCE_FILE: fileFor(value), NEXUS_CORTEX_PYME_PROFILE_DIGEST: blocked.profileDigest })).toThrow(/blocked capabilities/u);
  });

  it("leaves Core deployments untouched when no profile is selected", () => {
    expect(loadPymeProductionProfile({})).toBeNull();
  });
});
