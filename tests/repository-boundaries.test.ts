import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("NEXUS repository structure", () => {
  it("contains the required physical boundaries", () => {
    const required = [
      "packages/core",
      "packages/experimental",
      "packages/config",
      "packages/experience",
      "apps/v2-probe-editorial",
      "apps/v2-probe-cinematic",
      "apps/v2-probe-industrial",
      "apps/v2-probe-asymmetric",
      "apps/reference-alfil",
      "apps/reference-meson",
      "apps/reference-nexus-bot",
      "apps/_experience-seed",
      "archive/_template-client-v1"
    ];

    expect(required.every((path) => existsSync(join(root, path)))).toBe(true);
  });

  it("_template-client is archived, not an active workspace app", () => {
    // NEXUS V1.2: archived out of apps/* so no tooling can accidentally
    // treat it as a client seed again. This is a structural guarantee,
    // not just a documentation note.
    expect(existsSync(join(root, "apps/_template-client"))).toBe(false);
  });

  it("does not make Core depend on Experimental", () => {
    const corePackage = readFileSync(
      join(root, "packages/core/package.json"),
      "utf8"
    );

    expect(corePackage).not.toContain("@nexus/experimental");
    expect(corePackage).not.toContain("@nexus/experience");
  });
});
