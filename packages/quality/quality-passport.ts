import { createHash } from "node:crypto";

export type PassportStatus = "PASS" | "FAIL" | "WARNING" | "NOT_TESTED" | "UNSUPPORTED";

export type PassportCheck = Readonly<{
  id: string;
  status: PassportStatus;
  detail: string;
  evidenceIds: readonly string[];
}>;

export type QualityPassportInput = Readonly<{
  projectId: string;
  engineVersion: string;
  sourceRevision: string;
  generatedAt: string;
  viewport: Readonly<{ width: number; height: number }>;
  artifactHashes: Readonly<Record<string, string>>;
  checks: readonly PassportCheck[];
}>;

export type QualityPassport = Readonly<{
  authority: "NEXUS_QUALITY_PASSPORT_V1";
  projectId: string;
  engineVersion: string;
  sourceRevision: string;
  generatedAt: string;
  viewport: Readonly<{ width: number; height: number }>;
  artifactHashes: Readonly<Record<string, string>>;
  checks: readonly PassportCheck[];
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  passportHash: string;
}>;

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCheck(check: PassportCheck): PassportCheck {
  const id = check.id.trim();
  const detail = check.detail.trim();
  if (!id || !detail) throw new Error("quality passport checks require non-empty id and detail");
  const evidenceIds = check.evidenceIds.map((value) => value.trim());
  if (evidenceIds.some((value) => !value)) throw new Error(`quality passport check ${id} contains an empty evidence id`);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error(`quality passport check ${id} contains duplicate evidence ids`);
  if (check.status === "PASS" && evidenceIds.length === 0) throw new Error(`quality passport check ${id} cannot PASS without evidence`);
  return Object.freeze({ ...check, id, detail, evidenceIds: Object.freeze(evidenceIds) });
}

export function createQualityPassport(input: QualityPassportInput): QualityPassport {
  const projectId = input.projectId.trim();
  const engineVersion = input.engineVersion.trim();
  if (!projectId || !engineVersion) throw new Error("quality passport requires projectId and engineVersion");
  if (!SHA1.test(input.sourceRevision)) throw new Error("quality passport sourceRevision must be a full lowercase git SHA-1");
  const generatedAt = new Date(input.generatedAt);
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("quality passport generatedAt must be a valid timestamp");
  if (!Number.isInteger(input.viewport.width) || !Number.isInteger(input.viewport.height) || input.viewport.width <= 0 || input.viewport.height <= 0) throw new Error("quality passport viewport must contain positive integer dimensions");

  const artifactHashes = Object.fromEntries(Object.entries(input.artifactHashes).sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, hash]) => {
    const normalizedPath = path.trim();
    if (!normalizedPath || !SHA256.test(hash)) throw new Error("quality passport artifact hashes require non-empty paths and lowercase SHA-256 values");
    return [normalizedPath, hash] as const;
  }));
  const checks = input.checks.map(normalizeCheck);
  if (new Set(checks.map((check) => check.id)).size !== checks.length) throw new Error("quality passport check ids must be unique");

  const verdict = checks.some((check) => check.status === "FAIL")
    ? "FAIL" as const
    : checks.some((check) => check.status === "NOT_TESTED" || check.status === "UNSUPPORTED")
      ? "INCOMPLETE" as const
      : "PASS" as const;

  const payload = {
    authority: "NEXUS_QUALITY_PASSPORT_V1" as const,
    projectId,
    engineVersion,
    sourceRevision: input.sourceRevision,
    generatedAt: generatedAt.toISOString(),
    viewport: Object.freeze({ ...input.viewport }),
    artifactHashes: Object.freeze(artifactHashes),
    checks: Object.freeze(checks),
    verdict,
  };
  const passportHash = createHash("sha256").update(canonical(payload)).digest("hex");
  return Object.freeze({ ...payload, passportHash });
}

export function verifyQualityPassport(passport: QualityPassport): boolean {
  const { passportHash, ...payload } = passport;
  if (!SHA256.test(passportHash)) return false;
  const expected = createHash("sha256").update(canonical(payload)).digest("hex");
  return expected === passportHash;
}
