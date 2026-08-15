import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const architecture = readFileSync(join(root, "NEXUS_V8_ARCHITECTURE_PLAN.md"), "utf8");
const baseline = readFileSync(join(root, "docs/architecture/V8_BASELINE_AUDIT.md"), "utf8");
const benchmarks = readFileSync(join(root, "docs/evidence/NEXUS_V8_BENCHMARK_PLAN.md"), "utf8");

describe("NEXUS V8 baseline architecture", () => {
  it("accounts for every mandatory capability without claiming implementation", () => {
    for (const capability of [
      "Art Direction Engine",
      "Creative Vault",
      "Art Direction Memory",
      "Shader primitives",
      "Gesture / interaction primitives",
      "GPU Governor",
      "Benchmark framework"
    ]) {
      expect(architecture).toContain(capability);
      expect(baseline).toContain(capability);
    }
    expect(architecture).toContain("Art Direction Engine | PLANNED");
    expect(architecture).toContain("Benchmark framework | PLANNED");
  });

  it("preserves the V7, Kernel, Experience, and Industrial boundaries", () => {
    expect(architecture).toContain("V7 remains closed");
    expect(architecture).toContain("V7 Kernel remains small");
    expect(architecture).toContain("V8 Experience packages do not import Rust");
    expect(architecture).toContain("No Rust crate is planned for V8 Experience");
    expect(architecture).toContain("V9 is not started");
  });

  it("requires honest benchmark evidence before maturity promotion", () => {
    expect(benchmarks).toContain("PLAN ONLY / NOT MEASURED");
    expect(benchmarks).toContain("real measurements and raw results");
    expect(benchmarks).toContain("Do not force NEXUS to win");
    expect(architecture).toContain("Nothing is `BENCHMARKED`");
    expect(architecture).not.toMatch(/\|[^\n]+\|\s*BENCHMARKED\s*\|/);
  });

  it("defines deterministic, accessible degradation as architecture contracts", () => {
    expect(architecture).toContain("Every compilation receives an explicit seed");
    expect(architecture).toContain("Reduced motion replaces spatial travel");
    expect(architecture).toContain("Pointer gestures require keyboard");
    expect(architecture).toContain("Fail toward the lowest semantically complete tier");
  });

  it("treats major creative technologies as optional workload-selected adapters", () => {
    for (const technology of ["GSAP", "Three.js", "Rive", "Lottie", "Web Animations API", "WebGL", "WebGPU"]) {
      expect(architecture).toContain(technology);
    }
    expect(architecture).toContain("No technology is selected globally");
  });
});
