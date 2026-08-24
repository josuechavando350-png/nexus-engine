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

export function describeDeterminismDifferences(diff) {
  return {
    declaredDeterminismException: NEXT_PREVIEW_MODE_EXCEPTION,
    exceptionObservedIn: diff.rawOnlyDifferences
      .filter((entry) => entry.path.endsWith("/.next/prerender-manifest.json"))
      .map((entry) => entry.path),
    failingDifferences: {
      added: diff.added,
      removed: diff.removed,
      modified: diff.modified,
    },
    informationalRawOnlyDifferences: diff.rawOnlyDifferences,
  };
}

const stableJson = (value) => Array.isArray(value)
  ? value.map(stableJson)
  : value && typeof value === "object"
    ? Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, stableJson(child)]),
    )
    : value;

export function canonicalizeDeterministicBuildFile(path, bytes) {
  if (!path.endsWith(".json")) return { bytes, exceptions: [] };

  const manifest = JSON.parse(bytes.toString("utf8"));
  const exceptions = [];
  if (path.endsWith("/.next/prerender-manifest.json") && manifest.preview && typeof manifest.preview === "object") {
    for (const field of PREVIEW_EXCEPTION_FIELDS) {
      if (typeof manifest.preview[field] !== "string") continue;
      manifest.preview[field] = `<NEXUS_DECLARED_NEXT_PREVIEW_EXCEPTION_${field}>`;
      exceptions.push(field);
    }
  }

  return { bytes: Buffer.from(`${JSON.stringify(stableJson(manifest))}\n`, "utf8"), exceptions };
}
