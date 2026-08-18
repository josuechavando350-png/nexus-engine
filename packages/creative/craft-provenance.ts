import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { VerdictState } from "./shared";

export type CraftResourceKind = "FONT" | "IMAGE" | "VIDEO" | "ICON" | "MOTION_LIBRARY" | "THREE_D" | "SHADER" | "AUDIO";
export type CraftRights = "OWNED" | "LICENSED" | "OPEN_SOURCE" | "PUBLIC_DOMAIN" | "CLIENT_SUPPLIED" | "REFERENCE_ONLY";

export interface LocalCraftResource {
  id: string;
  kind: CraftResourceKind;
  mode: "LOCAL_FILE";
  filePath: string;
  source: string;
  rights: Exclude<CraftRights, "REFERENCE_ONLY">;
  licenseRef: string;
  family?: string;
  version?: string;
}

export interface ExternalCraftResource {
  id: string;
  kind: CraftResourceKind;
  mode: "EXTERNAL_REFERENCE";
  sourceUri: string;
  source: string;
  rights: CraftRights;
  licenseRef: string;
  family?: string;
  version?: string;
}

export type CraftResource = LocalCraftResource | ExternalCraftResource;

export interface VerifiedCraftResource {
  id: string;
  kind: CraftResourceKind;
  mode: CraftResource["mode"];
  source: string;
  rights: CraftRights;
  licenseRef: string;
  family?: string;
  version?: string;
  filePath?: string;
  sourceUri?: string;
  digest?: string;
  byteLength?: number;
}

export interface CraftProvenanceFinding {
  resourceId: string;
  verdict: Exclude<VerdictState, "PASS">;
  code: "MISSING_METADATA" | "UNREADABLE_FILE" | "INSECURE_SOURCE" | "FONT_IDENTITY_MISSING" | "VERSION_MISSING";
  message: string;
}

export interface CraftProvenanceReport {
  authority: "NEXUS_CRAFT_PROVENANCE_GATE";
  verdict: VerdictState;
  resources: readonly VerifiedCraftResource[];
  findings: readonly CraftProvenanceFinding[];
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function needsVersion(kind: CraftResourceKind): boolean {
  return kind === "MOTION_LIBRARY" || kind === "THREE_D" || kind === "SHADER";
}

export async function evaluateCraftProvenance(resources: readonly CraftResource[]): Promise<CraftProvenanceReport> {
  if (!resources.length) return Object.freeze({ authority: "NEXUS_CRAFT_PROVENANCE_GATE", verdict: "NOT_TESTED", resources: Object.freeze([]), findings: Object.freeze([]) });
  if (new Set(resources.map((resource) => resource.id)).size !== resources.length) throw new Error("craft resources require unique ids");

  const findings: CraftProvenanceFinding[] = [];
  const verified: VerifiedCraftResource[] = [];

  for (const resource of resources) {
    if (!resource.id.trim()) throw new Error("craft resource id is required");
    if (!resource.source.trim() || !resource.licenseRef.trim()) {
      findings.push({ resourceId: resource.id, verdict: "FAIL", code: "MISSING_METADATA", message: "source and licenseRef are required" });
      continue;
    }
    if (resource.kind === "FONT" && !resource.family?.trim()) {
      findings.push({ resourceId: resource.id, verdict: "FAIL", code: "FONT_IDENTITY_MISSING", message: "font provenance requires an explicit family name" });
      continue;
    }
    if (needsVersion(resource.kind) && !resource.version?.trim()) {
      findings.push({ resourceId: resource.id, verdict: "FAIL", code: "VERSION_MISSING", message: `${resource.kind} provenance requires an explicit version` });
      continue;
    }

    if (resource.mode === "LOCAL_FILE") {
      const filePath = resolve(resource.filePath);
      try {
        const bytes = await readFile(filePath);
        if (!bytes.byteLength) throw new Error("file is empty");
        verified.push(Object.freeze({
          id: resource.id,
          kind: resource.kind,
          mode: resource.mode,
          source: resource.source.trim(),
          rights: resource.rights,
          licenseRef: resource.licenseRef.trim(),
          family: resource.family?.trim(),
          version: resource.version?.trim(),
          filePath,
          digest: hash(bytes),
          byteLength: bytes.byteLength,
        }));
      } catch (error) {
        findings.push({ resourceId: resource.id, verdict: "FAIL", code: "UNREADABLE_FILE", message: error instanceof Error ? error.message : `cannot read ${filePath}` });
      }
      continue;
    }

    let uri: URL;
    try {
      uri = new URL(resource.sourceUri);
    } catch {
      findings.push({ resourceId: resource.id, verdict: "FAIL", code: "INSECURE_SOURCE", message: "external provenance requires a valid HTTPS sourceUri" });
      continue;
    }
    if (uri.protocol !== "https:") {
      findings.push({ resourceId: resource.id, verdict: "FAIL", code: "INSECURE_SOURCE", message: "external provenance requires HTTPS" });
      continue;
    }
    verified.push(Object.freeze({
      id: resource.id,
      kind: resource.kind,
      mode: resource.mode,
      source: resource.source.trim(),
      rights: resource.rights,
      licenseRef: resource.licenseRef.trim(),
      family: resource.family?.trim(),
      version: resource.version?.trim(),
      sourceUri: uri.toString(),
    }));
  }

  const verdict: VerdictState = findings.some((finding) => finding.verdict === "FAIL") ? "FAIL" : "PASS";
  return Object.freeze({ authority: "NEXUS_CRAFT_PROVENANCE_GATE", verdict, resources: Object.freeze(verified), findings: Object.freeze(findings) });
}
