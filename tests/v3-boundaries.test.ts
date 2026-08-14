import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const root = process.cwd();
const runtime = join(root, "runtime");

function walk(dir: string, filter: (path: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "target", ".next", "dist", "coverage"].includes(entry.name)) continue;
      walk(full, filter, acc);
    } else if (filter(full)) {
      acc.push(full);
    }
  }
  return acc;
}

const rustFiles = walk(runtime, (path) => extname(path) === ".rs");

describe("NEXUS V3 plane separation", () => {
  it("keeps the Rust runtime physically separate from the TypeScript workspace", () => {
    expect(existsSync(join(runtime, "Cargo.toml"))).toBe(true);
    expect(rustFiles.length).toBeGreaterThan(20);
  });

  it("does not add the runtime to the pnpm workspace", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toContain("runtime");
  });

  it("contains no web assets inside the runtime tree", () => {
    const webAssets = walk(runtime, (path) =>
      [".ts", ".tsx", ".jsx", ".js", ".mjs", ".css"].includes(extname(path)),
    );
    expect(webAssets).toEqual([]);
  });

  it("does not make @nexus/core or @nexus/experience depend on the runtime", () => {
    for (const pkg of ["packages/core/package.json", "packages/experience/package.json"]) {
      const manifest = readFileSync(join(root, pkg), "utf8");
      expect(manifest).not.toMatch(/runtime|cargo|rust/i);
    }
  });

  it("does not let any TypeScript source import from the runtime", () => {
    const tsFiles = [
      ...walk(join(root, "packages"), (path) => [".ts", ".tsx"].includes(extname(path))),
      ...walk(join(root, "apps"), (path) => [".ts", ".tsx"].includes(extname(path))),
    ];
    const offenders = tsFiles.filter((file) =>
      /from\s+["'].*\/runtime\//.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("NEXUS V3 safety invariants", () => {
  const invariantsPath = join(runtime, "crates/nexus-policy/src/invariants.rs");

  it("ships the hard invariants module", () => {
    expect(existsSync(invariantsPath)).toBe(true);
  });

  it("keeps the weapon and human-targeting prohibitions compiled in", () => {
    const source = readFileSync(invariantsPath, "utf8");
    for (const invariant of [
      "NoWeaponCapability",
      "NoHumanTargeting",
      "NoHighImpactWithoutApproval",
      "NoPhysicalActionWithoutSimulation",
    ]) {
      expect(source).toContain(invariant);
    }
    for (const term of ["weapon", "targeting", "lethal", "munition", "fire_control"]) {
      expect(source).toContain(`"${term}"`);
    }
  });

  it("keeps the detection class set closed and free of person identification", () => {
    const detection = readFileSync(join(runtime, "crates/nexus-event/src/detection.rs"), "utf8");
    expect(detection).toContain("DetectionClass");
    // No open fallback variant that would let an arbitrary class through.
    expect(detection).not.toMatch(/\bOther\s*\(/);
    expect(detection).not.toMatch(/facial_recognition|face_recognition|reidentify/i);
  });

  it("forbids unsafe code in every runtime crate", () => {
    const libRoots = rustFiles.filter((path) => path.endsWith(join("src", "lib.rs")));
    expect(libRoots.length).toBeGreaterThan(5);
    for (const file of libRoots) {
      expect(readFileSync(file, "utf8")).toContain("#![forbid(unsafe_code)]");
    }
  });
});

describe("NEXUS V3 honesty gates", () => {
  it("never claims software provides physical unidirectionality", () => {
    const oneway = readFileSync(join(runtime, "crates/nexus-oneway/src/lib.rs"), "utf8");
    expect(oneway).toMatch(/not a (physical )?data diode|is not a data diode/i);
  });

  it("does not claim exactly-once delivery anywhere in the runtime", () => {
    // Mentioning exactly-once is fine and necessary; claiming it is not.
    // The disclaimer usually precedes the phrase ("nothing here claims
    // exactly-once"), so the surrounding window is what must be inspected,
    // not the text after it.
    const offenders: string[] = [];
    for (const file of rustFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/exactly[- ]once/gi)) {
        const index = match.index ?? 0;
        const window = source.slice(Math.max(0, index - 160), index + 160).toLowerCase();

        // Only evaluate exactly-once statements about message/event delivery semantics.
        // Unrelated invariants such as "a resource version must advance exactly once"
        // are not delivery guarantees and must not be treated as honesty-gate violations.
        const deliveryContext =
          /\b(delivery|processing|message|event|broker|transaction|end[- ]to[- ]end)\b/.test(window);
        if (!deliveryContext) continue;

        if (!/\bnot\b|\bnever\b|\bcannot\b|\bnothing\b|\bno\b|\bwithout\b/.test(window)) {
          offenders.push(`${file}: ${window.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps credentials out of the repository", () => {
    expect(existsSync(join(runtime, ".env.example"))).toBe(true);
    expect(existsSync(join(runtime, ".env"))).toBe(false);
  });
});

describe("NEXUS V3 required artifacts", () => {
  it("ships the architecture, security and research documentation", () => {
    const required = [
      "docs/architecture/V3_ARCHITECTURE.md",
      "docs/architecture/V3_DATA_PLANE.md",
      "docs/architecture/V3_ONTOLOGY.md",
      "docs/architecture/V3_ORCHESTRATION.md",
      "docs/architecture/V3_EDGE_RUNTIME.md",
      "docs/architecture/V3_ONEWAY_SECURITY.md",
      "docs/architecture/V3_PHYSICAL_AGENTS.md",
      "docs/security/V3_THREAT_MODEL.md",
      "docs/security/V3_TRUST_BOUNDARIES.md",
      "docs/research/V3_PERFORMANCE_TARGETS.md",
      "docs/research/V3_FAILURE_MODES.md",
      "runtime/README.md",
      "runtime/deny.toml",
      "runtime/rust-toolchain.toml",
      "runtime/docker/docker-compose.yml",
    ];
    const missing = required.filter((path) => !existsSync(join(root, path)));
    expect(missing).toEqual([]);
  });

  it("keeps the V2 experience plane intact", () => {
    for (const path of [
      "packages/core",
      "packages/experience",
      "apps/v2-probe-editorial",
      "apps/v2-probe-cinematic",
      "apps/v2-probe-industrial",
      "apps/v2-probe-asymmetric",
    ]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
  });
});
