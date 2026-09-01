import { describe, expect, it } from "vitest";
import { enabledToolsFromEnv } from "../src/policy.js";

describe("disconnected MCP capabilities", () => {
  it("fails closed instead of remotely exposing the placeholder visual comparator", () => {
    expect(() => enabledToolsFromEnv("nexus_comparator")).toThrow(/not remotely enableable until its real runtime is connected/);
  });

  it("does not weaken unrelated enabled tools while the comparator is quarantined", () => {
    expect([...enabledToolsFromEnv("nexus_status,nexus_projects")]).toEqual(["nexus_status", "nexus_projects"]);
  });
});
