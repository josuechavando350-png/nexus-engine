import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  childProcessEnvironment,
  NEXUS_MCP_CHILD_ENV_ALLOWLIST,
  NEXUS_MCP_CHILD_ENV_EXTENSION_ALLOWLIST,
} from "../src/child-env.js";

const exec = promisify(execFile);

it("passes fixed operational variables but hides credentials from a real child", async () => {
  const parentHome = "/server-home-must-not-propagate";
  const environment = childProcessEnvironment({
    PATH: process.env.PATH,
    HOME: parentHome,
    CI: "true",
    SOURCE_DATE_EPOCH: "1700000000",
    NEXUS_GITHUB_TOKEN: "github-secret",
    NEXUS_MCP_TOKEN_SHA256: "read-hash",
    NEXUS_MCP_WRITE_TOKEN_SHA256: "write-hash",
  });
  const { stdout } = await exec(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: environment });
  const child = JSON.parse(stdout) as NodeJS.ProcessEnv;
  expect(child.CI).toBe("true");
  expect(child.SOURCE_DATE_EPOCH).toBe("1700000000");
  expect(child.HOME).toBeTruthy();
  expect(child.HOME).not.toBe(parentHome);
  expect(child.XDG_CONFIG_HOME).toBe(join(child.HOME!, ".config"));
  expect(child.XDG_CACHE_HOME).toBe(join(child.HOME!, ".cache"));
  expect(child.NPM_CONFIG_USERCONFIG).toBe(join(child.HOME!, ".npmrc"));
  expect(child.GIT_TERMINAL_PROMPT).toBe("0");
  expect(child.NEXUS_GITHUB_TOKEN).toBeUndefined();
  expect(child.NEXUS_MCP_TOKEN_SHA256).toBeUndefined();
  expect(child.NEXUS_MCP_WRITE_TOKEN_SHA256).toBeUndefined();
});

it("does not expose credential-like files from the parent HOME to a real child", async () => {
  const parentHome = await mkdtemp(join(tmpdir(), "nexus-mcp-parent-home-"));
  const marker = join(parentHome, ".git-credentials");
  await writeFile(marker, "credential-marker\n", "utf8");
  try {
    const environment = childProcessEnvironment({ PATH: process.env.PATH, HOME: parentHome });
    const script = "const {existsSync}=require('node:fs');const {join}=require('node:path');process.stdout.write(String(existsSync(join(process.env.HOME,'.git-credentials'))))";
    const { stdout } = await exec(process.execPath, ["-e", script], { env: environment });
    expect(environment.HOME).not.toBe(parentHome);
    expect(stdout).toBe("false");
  } finally {
    await rm(parentHome, { recursive: true, force: true });
  }
});

it("exports fixed and reviewed extension allowlists for audit", () => {
  expect(NEXUS_MCP_CHILD_ENV_ALLOWLIST).toContain("PATH");
  expect(NEXUS_MCP_CHILD_ENV_ALLOWLIST).toContain("SOURCE_DATE_EPOCH");
  expect(NEXUS_MCP_CHILD_ENV_ALLOWLIST).not.toContain("HOME");
  expect(NEXUS_MCP_CHILD_ENV_EXTENSION_ALLOWLIST).toEqual(["TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR"]);
});

it("forwards only explicitly requested reviewed extensions", () => {
  const environment = childProcessEnvironment({
    NEXUS_MCP_CHILD_ENV_ALLOW: "TERM,FORCE_COLOR",
    TERM: "xterm-256color",
    FORCE_COLOR: "1",
    COLORTERM: "truecolor",
  });
  expect(environment.TERM).toBe("xterm-256color");
  expect(environment.FORCE_COLOR).toBe("1");
  expect(environment.COLORTERM).toBeUndefined();
});

it("fails closed for sensitive or unreviewed configured additions", () => {
  expect(() => childProcessEnvironment({ NEXUS_MCP_CHILD_ENV_ALLOW: "API_TOKEN", API_TOKEN: "secret" })).toThrow(/rejects sensitive variable/);
  expect(() => childProcessEnvironment({ NEXUS_MCP_CHILD_ENV_ALLOW: "DATABASE_URL", DATABASE_URL: "secret" })).toThrow(/not in the reviewed extension allowlist/);
  expect(() => childProcessEnvironment({ NEXUS_MCP_CHILD_ENV_ALLOW: "PUBLIC_SETTING", PUBLIC_SETTING: "visible" })).toThrow(/not in the reviewed extension allowlist/);
});
