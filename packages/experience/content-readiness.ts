import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ReadinessVerdict = "PASS" | "FAIL" | "NOT_TESTED";
export type PhotoRights = "OWNED" | "LICENSED" | "CLIENT_SUPPLIED" | "PUBLIC_DOMAIN";

export interface PhotoAssetInput {
  role: string;
  filePath: string;
  rights: PhotoRights;
  source: string;
}

export interface CopyAssetInput {
  role: string;
  text: string;
  source: string;
}

export interface ContentReadinessPolicy {
  requiredPhotoRoles: readonly string[];
  requiredCopyRoles: readonly string[];
  minimumPhotoWidthPx?: number;
  minimumPhotoHeightPx?: number;
}

export interface VerifiedPhotoAsset {
  role: string;
  filePath: string;
  source: string;
  rights: PhotoRights;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  byteLength: number;
  digest: string;
}

export interface VerifiedCopyAsset {
  role: string;
  source: string;
  characterCount: number;
  digest: string;
}

export interface ContentReadinessFinding {
  code: string;
  verdict: Exclude<ReadinessVerdict, "PASS">;
  message: string;
  role?: string;
}

export interface ContentReadinessReport {
  verdict: ReadinessVerdict;
  photos: readonly VerifiedPhotoAsset[];
  copy: readonly VerifiedCopyAsset[];
  findings: readonly ContentReadinessFinding[];
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const sof = marker >= 0xc0 && marker <= 0xc3;
    if (sof && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function inspectImage(bytes: Uint8Array, filePath: string): { mediaType: "image/png" | "image/jpeg"; width: number; height: number } {
  const png = pngDimensions(bytes);
  if (png) return { mediaType: "image/png", ...png };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mediaType: "image/jpeg", ...jpeg };
  throw new Error(`Unsupported or undecodable image: ${filePath}`);
}

const PLACEHOLDER_PATTERNS = [
  /\blorem ipsum\b/i,
  /\byour (company|brand|product|text) here\b/i,
  /\b(?:TODO|FIXME|XXX|XXXX|HACK|TBD|PLACEHOLDER|COMING SOON)\b/,
  /\b([\p{L}\p{N}]{2,})\b(?:\s+\1\b){3,}/iu,
];

function normalizedRoles(values: readonly string[], field: string): readonly string[] {
  const roles = values.map((value) => value.trim()).filter(Boolean);
  if (roles.length !== values.length) throw new Error(`${field} cannot contain empty roles`);
  if (new Set(roles).size !== roles.length) throw new Error(`${field} cannot contain duplicate roles`);
  return roles;
}

export async function evaluateContentReadiness(input: {
  photos: readonly PhotoAssetInput[];
  copy: readonly CopyAssetInput[];
  policy: ContentReadinessPolicy;
}): Promise<ContentReadinessReport> {
  const requiredPhotoRoles = normalizedRoles(input.policy.requiredPhotoRoles, "requiredPhotoRoles");
  const requiredCopyRoles = normalizedRoles(input.policy.requiredCopyRoles, "requiredCopyRoles");
  const findings: ContentReadinessFinding[] = [];
  const photos: VerifiedPhotoAsset[] = [];
  const copy: VerifiedCopyAsset[] = [];

  const photoRoles = new Set<string>();
  for (const asset of input.photos) {
    const role = asset.role.trim();
    if (!role || !asset.source.trim() || !asset.filePath.trim()) {
      findings.push({ code: "PHOTO_PROVENANCE_INCOMPLETE", verdict: "FAIL", message: "Photo requires role, source and filePath", role: role || undefined });
      continue;
    }
    if (photoRoles.has(role)) {
      findings.push({ code: "PHOTO_ROLE_DUPLICATE", verdict: "FAIL", message: `Duplicate photo role: ${role}`, role });
      continue;
    }
    photoRoles.add(role);
    try {
      const filePath = resolve(asset.filePath);
      const bytes = await readFile(filePath);
      const decoded = inspectImage(bytes, filePath);
      if ((input.policy.minimumPhotoWidthPx ?? 0) > decoded.width || (input.policy.minimumPhotoHeightPx ?? 0) > decoded.height) {
        findings.push({ code: "PHOTO_DIMENSIONS_BELOW_POLICY", verdict: "FAIL", message: `${role} is ${decoded.width}x${decoded.height}, below policy`, role });
      }
      photos.push({ role, filePath, source: asset.source.trim(), rights: asset.rights, ...decoded, byteLength: bytes.byteLength, digest: sha256(bytes) });
    } catch (error) {
      findings.push({ code: "PHOTO_UNREADABLE", verdict: "FAIL", message: error instanceof Error ? error.message : `Unreadable photo: ${asset.filePath}`, role });
    }
  }

  for (const role of requiredPhotoRoles) {
    if (!photoRoles.has(role)) findings.push({ code: "PHOTO_ROLE_MISSING", verdict: "FAIL", message: `Required photo role is missing: ${role}`, role });
  }

  const copyRoles = new Set<string>();
  for (const asset of input.copy) {
    const role = asset.role.trim();
    const text = asset.text.trim();
    if (!role || !asset.source.trim() || !text) {
      findings.push({ code: "COPY_INCOMPLETE", verdict: "FAIL", message: "Copy requires role, source and non-empty text", role: role || undefined });
      continue;
    }
    if (copyRoles.has(role)) {
      findings.push({ code: "COPY_ROLE_DUPLICATE", verdict: "FAIL", message: `Duplicate copy role: ${role}`, role });
      continue;
    }
    copyRoles.add(role);
    if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) {
      findings.push({ code: "COPY_PLACEHOLDER", verdict: "FAIL", message: `Placeholder copy detected for ${role}`, role });
    }
    copy.push({ role, source: asset.source.trim(), characterCount: text.length, digest: sha256(text) });
  }

  for (const role of requiredCopyRoles) {
    if (!copyRoles.has(role)) findings.push({ code: "COPY_ROLE_MISSING", verdict: "FAIL", message: `Required copy role is missing: ${role}`, role });
  }

  const policyHasRequirements = requiredPhotoRoles.length > 0 || requiredCopyRoles.length > 0;
  const verdict: ReadinessVerdict = findings.some((finding) => finding.verdict === "FAIL")
    ? "FAIL"
    : policyHasRequirements
      ? "PASS"
      : "NOT_TESTED";

  return Object.freeze({ verdict, photos: Object.freeze(photos), copy: Object.freeze(copy), findings: Object.freeze(findings) });
}
