import { describe, expect, it } from "vitest";
import { canonicalizeDeterministicBuildFile, describeDeterminismDifferences, NEXT_PREVIEW_MODE_EXCEPTION } from "../scripts/deterministic-build-canonicalization.mjs";

const path = "apps/probe/.next/prerender-manifest.json";
const manifest = (previewModeId: string, other = "unchanged") => Buffer.from(JSON.stringify({
  version: 4,
  routes: { "/": { dataRoute: "/index.rsc", other } },
  preview: {
    previewModeId,
    previewModeSigningKey: `signing-${previewModeId}`,
    previewModeEncryptionKey: `encryption-${previewModeId}`,
  },
}), "utf8");

describe("declared Next preview-mode determinism exception", () => {
  it("canonicalizes exactly the three declared preview fields", () => {
    const first = canonicalizeDeterministicBuildFile(path, manifest("first-preview-value"));
    const second = canonicalizeDeterministicBuildFile(path, manifest("second-preview-value"));
    expect(first.bytes).toEqual(second.bytes);
    expect(first.exceptions).toEqual(NEXT_PREVIEW_MODE_EXCEPTION.fields);
  });

  it("stays red for another prerender manifest difference", () => {
    const first = canonicalizeDeterministicBuildFile(path, manifest("first-preview-value", "first-route-value"));
    const second = canonicalizeDeterministicBuildFile(path, manifest("second-preview-value", "injected-route-difference"));
    expect(first.bytes).not.toEqual(second.bytes);
  });

  it("does not canonicalize the same field names in any other file", () => {
    const first = canonicalizeDeterministicBuildFile("apps/probe/.next/other.json", manifest("first-preview-value"));
    const second = canonicalizeDeterministicBuildFile("apps/probe/.next/other.json", manifest("second-preview-value"));
    expect(first.bytes).not.toEqual(second.bytes);
    expect(first.exceptions).toEqual([]);
  });

  it("separates failing differences from the declared raw-only exception", () => {
    const rawOnly = { path, first: {}, second: {} };
    const modified = { path: "apps/probe/.next/routes-manifest.json", first: {}, second: {} };
    const report = describeDeterminismDifferences({ added: [], removed: [], modified: [modified], rawOnlyDifferences: [rawOnly] });
    expect(report.declaredDeterminismException).toEqual(NEXT_PREVIEW_MODE_EXCEPTION);
    expect(report.exceptionObservedIn).toEqual([path]);
    expect(report.failingDifferences).toEqual({ added: [], removed: [], modified: [modified] });
    expect(report.informationalRawOnlyDifferences).toEqual([rawOnly]);
  });
});
