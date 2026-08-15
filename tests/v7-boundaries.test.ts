import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FABRIC_DOMAINS,
  MATURITY_STATES,
  V7_FABRIC_CONTRACTS
} from "../packages/kernel/index";

const root = process.cwd();

describe("NEXUS V7 boundaries", () => {
  it("has canonical Kernel artifacts in both TypeScript and Rust workspaces", () => {
    expect(existsSync(join(root, "packages/kernel/index.ts"))).toBe(true);
    expect(existsSync(join(root, "runtime/crates/nexus-kernel/src/lib.rs"))).toBe(true);
  });

  it("keeps the TypeScript Kernel free of Experience and app dependencies", () => {
    const source = readFileSync(join(root, "packages/kernel/index.ts"), "utf8");
    expect(source).not.toMatch(/from ["']react/);
    expect(source).not.toMatch(/from ["']next/);
    expect(source).not.toContain("@nexus/core");
    expect(source).not.toContain("@nexus/experience");
    expect(source).not.toContain("apps/");
  });

  it("keeps the Rust Kernel dependency-free and away from edge execution", () => {
    const cargo = readFileSync(join(root, "runtime/crates/nexus-kernel/Cargo.toml"), "utf8");
    const deps = cargo.split("[dependencies]")[1]?.trim() ?? "";
    expect(deps).toBe("");

    const source = readFileSync(join(root, "runtime/crates/nexus-kernel/src/lib.rs"), "utf8");
    expect(source).not.toContain("EdgeTask");
    expect(source).not.toContain("nexus_edge_protocol");
    expect(source).not.toContain("nexus_policy");
  });

  it("does not claim V7 production proof through Kernel descriptors", () => {
    expect(MATURITY_STATES).toContain("PRODUCTION_PROVEN");
    expect(FABRIC_DOMAINS).toHaveLength(11);
    expect(V7_FABRIC_CONTRACTS.every((descriptor) => descriptor.maturity !== "PRODUCTION_PROVEN")).toBe(true);
  });

  it("keeps TypeScript and Rust contract semantics and evidence ids equivalent", () => {
    const rust = readFileSync(join(root, "runtime/crates/nexus-kernel/src/lib.rs"), "utf8");

    for (const descriptor of V7_FABRIC_CONTRACTS) {
      const slug = descriptor.contract.id.replace("nexus.v7.", "");
      expect(rust).toContain(`=> "${slug}"`);
      expect(descriptor.evidence[0]?.evidenceId).toBe(`ev.v7.${slug}.contract`);
    }

    expect(rust).toContain('format!("ev.v7.{}.contract", domain_slug(domain))');
    expect(rust).toContain("contract_id_for(reference.domain) != reference.id");
  });

  it("does not promote a benchmark without measurements, thresholds and stored results", () => {
    const plan = readFileSync(join(root, "NEXUS_V7_ARCHITECTURE_PLAN.md"), "utf8");
    const currentState = readFileSync(join(root, "docs/architecture/V7_CURRENT_STATE.md"), "utf8");
    const baseline = readFileSync(join(root, "docs/evidence/NEXUS_V7_BENCHMARK_BASELINE.md"), "utf8");
    const evidence = readFileSync(join(root, "docs/evidence/NEXUS_V7_EVIDENCE.md"), "utf8");

    expect(currentState).toContain("no measurements, thresholds or stored results exist");
    expect(currentState).not.toMatch(/\| V7 benchmark baseline \| BENCHMARKED \|/);
    expect(baseline).toContain("Performance measurements with thresholds | PLANNED");
    expect(evidence).toContain("Not present;");
    expect(plan).toContain("BENCHMARKED | NOT ACHIEVED");
    expect(plan).not.toMatch(/\| Benchmarks recorded \| BENCHMARKED \|/);
  });

  it("closes only the foundation and architecture scope while preserving later maturity gaps", () => {
    const plan = readFileSync(join(root, "NEXUS_V7_ARCHITECTURE_PLAN.md"), "utf8");
    const currentState = readFileSync(join(root, "docs/architecture/V7_CURRENT_STATE.md"), "utf8");
    const evidence = readFileSync(join(root, "docs/evidence/NEXUS_V7_EVIDENCE.md"), "utf8");

    expect(plan).toContain("All mandatory foundation/architecture criteria are satisfied");
    expect(plan).toContain("OPERATIONALLY_EVIDENCED | NOT ACHIEVED");
    expect(plan).toContain("PRODUCTION_PROVEN | NOT ACHIEVED");
    expect(currentState).toContain("V7 CLOSED — foundation/architecture scope");
    expect(evidence).toContain("closed for that scope");
    expect(plan).not.toContain("V8 Architecture");
  });

  it("does not print a group PASS after that group records a failure", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "nexus-v7-gate-"));
    const artifacts = [
      "NEXUS_V7_ARCHITECTURE_PLAN.md",
      "docs/architecture/V7_CURRENT_STATE.md",
      "docs/evidence/NEXUS_V7_EVIDENCE.md",
      "packages/kernel/package.json",
      "packages/kernel/index.ts",
      "runtime/Cargo.toml",
      "runtime/crates/nexus-kernel/Cargo.toml",
      "runtime/crates/nexus-kernel/src/lib.rs",
      "tests/v7-boundaries.test.ts"
    ];

    for (const artifact of artifacts) {
      const destination = join(sandbox, artifact);
      mkdirSync(join(destination, ".."), { recursive: true });
      cpSync(join(root, artifact), destination);
    }
    const kernelPath = join(sandbox, "packages/kernel/index.ts");
    writeFileSync(kernelPath, `${readFileSync(kernelPath, "utf8")}\nimport React from "react";\n`);

    let output = "";
    try {
      execFileSync(process.execPath, [join(root, "scripts/v7-architecture-gates.mjs")], {
        cwd: sandbox,
        encoding: "utf8",
        stdio: "pipe"
      });
    } catch (error) {
      const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer };
      output = `${failed.stdout?.toString() ?? ""}${failed.stderr?.toString() ?? ""}`;
    }

    expect(output).toContain("FAIL  TypeScript Kernel imports forbidden dependency react");
    expect(output).not.toContain("PASS  TypeScript Kernel has no forbidden Experience/Core imports");
  });
});
