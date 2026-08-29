const PREVIEW_EXCEPTION_FIELDS = Object.freeze([
  "previewModeId",
  "previewModeSigningKey",
  "previewModeEncryptionKey",
]);

export const NEXT_PREVIEW_MODE_EXCEPTION = Object.freeze({
  invariant: "byte-for-byte deterministic prerender-manifest.json",
  file: ".next/prerender-manifest.json",
  fields: PREVIEW_EXCEPTION_FIELDS,
  status: "INVARIANT_NOT_ENFORCEABLE",
});

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function canonicalizeDeterministicBuildFile(path, bytes) {
  if (!path.endsWith("/.next/prerender-manifest.json")) return { bytes, exceptions: [] };

  const text = bytes.toString("utf8");
  const manifest = JSON.parse(text);
  if (!manifest.preview || typeof manifest.preview !== "object") return { bytes, exceptions: [] };

  let canonical = text;
  const applied = [];
  for (const field of PREVIEW_EXCEPTION_FIELDS) {
    const value = manifest.preview[field];
    if (typeof value !== "string") continue;
    const pattern = new RegExp(`("${field}"\\s*:\\s*)"${escapeRegExp(value)}"`);
    const replaced = canonical.replace(pattern, `$1"<NEXUS_DECLARED_NEXT_PREVIEW_EXCEPTION_${field}>"`);
    if (replaced === canonical) throw new Error(`could not canonicalize declared Next preview exception: ${field}`);
    canonical = replaced;
    applied.push(field);
  }
  return { bytes: Buffer.from(canonical, "utf8"), exceptions: applied };
}
