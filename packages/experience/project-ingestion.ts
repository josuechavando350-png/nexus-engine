import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ProjectInputKind = "BASE_SHELL" | "ASSET";
export type AssetRights = "CLIENT_SUPPLIED" | "OWNED" | "LICENSED" | "PUBLIC_DOMAIN";

export interface ProjectFileInput {
  id: string;
  kind: ProjectInputKind;
  filePath: string;
  expectedDigest: `sha256:${string}`;
  source: string;
  rights?: AssetRights;
  observedContent?: string;
}

export interface IngestedProjectFile {
  id: string;
  kind: ProjectInputKind;
  filePath: string;
  digest: `sha256:${string}`;
  byteLength: number;
  source: string;
  rights?: AssetRights;
  observedContent?: string;
}

export interface ProjectIngestionFinding {
  code: "INPUT_INVALID" | "INPUT_UNREADABLE" | "DIGEST_MISMATCH" | "RIGHTS_MISSING" | "BASE_SHELL_COUNT";
  inputId?: string;
  detail: string;
}

export interface ProjectIngestionReport {
  authority: "NEXUS_PROJECT_INGESTION_V1";
  verdict: "PASS" | "FAIL";
  files: readonly IngestedProjectFile[];
  findings: readonly ProjectIngestionFinding[];
  provenanceDigest: `sha256:${string}`;
}

const digest = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function canonicalExpected(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

export async function ingestProjectFiles(inputs: readonly ProjectFileInput[]): Promise<ProjectIngestionReport> {
  const findings: ProjectIngestionFinding[] = [];
  const files: IngestedProjectFile[] = [];
  const ids = new Set<string>();
  const baseShellCount = inputs.filter((input) => input.kind === "BASE_SHELL").length;
  if (baseShellCount !== 1) findings.push({ code: "BASE_SHELL_COUNT", detail: `exactly one BASE_SHELL is required; received ${baseShellCount}` });

  for (const input of inputs) {
    const id = input.id.trim();
    if (!id || ids.has(id) || !input.filePath.trim() || !input.source.trim() || !canonicalExpected(input.expectedDigest)) {
      findings.push({ code: "INPUT_INVALID", inputId: id || undefined, detail: "input requires unique id, filePath, source and canonical expectedDigest" });
      continue;
    }
    ids.add(id);
    if (input.kind === "ASSET" && !input.rights) {
      findings.push({ code: "RIGHTS_MISSING", inputId: id, detail: "asset rights/provenance must be explicit before ingestion" });
      continue;
    }
    try {
      const filePath = resolve(input.filePath);
      const bytes = await readFile(filePath);
      const actual = digest(bytes);
      if (actual !== input.expectedDigest) {
        findings.push({ code: "DIGEST_MISMATCH", inputId: id, detail: `expected ${input.expectedDigest} but observed ${actual}` });
        continue;
      }
      files.push(Object.freeze({
        id,
        kind: input.kind,
        filePath,
        digest: actual,
        byteLength: bytes.byteLength,
        source: input.source.trim(),
        rights: input.rights,
        observedContent: input.observedContent?.trim() || undefined,
      }));
    } catch (error) {
      findings.push({ code: "INPUT_UNREADABLE", inputId: id, detail: error instanceof Error ? error.message : `unable to read ${input.filePath}` });
    }
  }

  const canonical = JSON.stringify(files.map(({ id, kind, digest: fileDigest, byteLength, source, rights }) => ({ id, kind, digest: fileDigest, byteLength, source, rights: rights ?? null })).sort((a, b) => a.id.localeCompare(b.id, "en")));
  const provenanceDigest = `sha256:${createHash("sha256").update(canonical).digest("hex")}` as const;
  return Object.freeze({
    authority: "NEXUS_PROJECT_INGESTION_V1",
    verdict: findings.length ? "FAIL" : "PASS",
    files: Object.freeze(files),
    findings: Object.freeze(findings),
    provenanceDigest,
  });
}
