import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FABRIC_DOMAINS,
  MATURITY_STATES,
  V7_FABRIC_CONTRACTS
} from "../packages/kernel/index";

const root = process.cwd();

describe("NEXUS V7 runtime boundaries", () => {
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

  it("does not claim production proof through Kernel descriptors", () => {
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
});
