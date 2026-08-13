import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Box,
  Button,
  Cluster,
  Container,
  Grid,
  Link,
  Section,
  Stack,
  VisuallyHidden
} from "../components";
import { SR_ONLY_CLASS } from "../a11y";
import * as Core from "../index";

const coreRoot = fileURLToPath(new URL("..", import.meta.url));
const componentsRoot = join(coreRoot, "components");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("Core UI primitives", () => {
  it("exports the approved primitive surface", () => {
    expect(typeof Box).toBe("function");
    expect(typeof Stack).toBe("function");
    expect(typeof Cluster).toBe("function");
    expect(typeof Grid).toBe("function");
    expect(typeof Container).toBe("function");
    expect(typeof Section).toBe("function");
    expect(typeof Button).toBe("function");
    expect(typeof Link).toBe("function");
    expect(typeof VisuallyHidden).toBe("function");
  });

  it("keeps primitives on the stable Core entry and Candidate motion off it", () => {
    expect(Core.Button).toBe(Button);
    expect(Core.Container).toBe(Container);
    expect("useScrollReveal" in Core).toBe(false);
  });

  it("keeps Button semantic and defaults type=button", () => {
    const element = Button({ children: "Save" });
    expect(element.type).toBe("button");
    expect(element.props.type).toBe("button");
    expect(element.props["data-nx-focus"]).toBe("");
  });

  it("keeps Link as a semantic anchor", () => {
    const element = Link({ href: "/docs", children: "Docs" });
    expect(element.type).toBe("a");
    expect(element.props.href).toBe("/docs");
    expect(element.props["data-nx-focus"]).toBe("");
  });

  it("reuses the shared sr-only contract", () => {
    const element = VisuallyHidden({ children: "Hidden label" });
    expect(element.type).toBe("span");
    expect(element.props.className).toContain(SR_ONLY_CLASS);
  });

  it("uses Foundation token variables for structural spacing and container size", () => {
    const stack = Stack({ gap: "space.sm", children: "x" });
    const container = Container({ size: "container.md", children: "x" });
    expect(stack.props.style.gap).toBe("var(--space-sm)");
    expect(container.props.style.maxWidth).toBe("var(--container-md)");
  });

  it("does not introduce marketing-pattern components", () => {
    const index = readFileSync(join(componentsRoot, "index.ts"), "utf8");
    expect(index).not.toMatch(/\b(Hero|Features|CTA|Navbar|Footer|Pricing|Testimonials)\b/);
  });

  it("contains no brand colors, brand fonts, or client-component directives", () => {
    const source = sourceFiles(componentsRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgb(a)?\(/i);
    expect(source).not.toMatch(/\bhsl(a)?\(/i);
    expect(source).not.toMatch(/["']use client["']/);
  });

  it("does not couple components to motion, composition, apps, or experimental", () => {
    const source = sourceFiles(componentsRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/from\s+["'][^"']*\/motion(?:\/|["'])/);
    expect(source).not.toMatch(/from\s+["'][^"']*\/composition(?:\/|["'])/);
    expect(source).not.toContain("@nexus/experimental");
    expect(source).not.toMatch(/from\s+["'][^"']*apps\//);
  });
});
