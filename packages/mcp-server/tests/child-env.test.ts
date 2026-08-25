import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { childProcessEnvironment, NEXUS_MCP_CHILD_ENV_ALLOWLIST } from "../src/child-env.js";

const exec = promisify(execFile);

it("passes allowlisted variables but hides MCP credentials from a real child", async () => {
  const environment = childProcessEnvironment({
    PATH: process.env.PATH,
    HOME: "/safe-home",
    CI: "true",
    SOURCE_DATE_EPOCH: "1700000000",
    NEXUS_GITHUB_TOKEN: "github-secret",
    NEXUS_MCP_TOKEN_SHA256: "read-hash",
    NEXUS_MCP_WRITE_TOKEN_SHA256: "write-hash",
  });
  const { stdout } = await exec(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: environment });
  const child = JSON.parse(stdout) as NodeJS.ProcessEnv;
  expect(child).toMatchObject({ HOME: "/safe-home", CI: "true", SOURCE_DATE_EPOCH: "1700000000" });
  expect(child.NEXUS_GITHUB_TOKEN).toBeUndefined();
  expect(child.NEXUS_MCP_TOKEN_SHA256).toBeUndefined();
  expect(child.NEXUS_MCP_WRITE_TOKEN_SHA256).toBeUndefined();
});

it("exports the fixed allowlist for audit", () => {
  expect(NEXUS_MCP_CHILD_ENV_ALLOWLIST).toContain("PATH");
  expect(NEXUS_MCP_CHILD_ENV_ALLOWLIST).toContain("SOURCE_DATE_EPOCH");
});

it("rejects sensitive configured additions by name", () => {
  const environment = childProcessEnvironment({
    NEXUS_MCP_CHILD_ENV_ALLOW: "PUBLIC_SETTING,API_TOKEN,clientSecret,PRIVATE_KEY,dbPassword",
    PUBLIC_SETTING: "visible",
    API_TOKEN: "hidden",
    clientSecret: "hidden",
    PRIVATE_KEY: "hidden",
    dbPassword: "hidden",
  });
  expect(environment).toEqual({ PUBLIC_SETTING: "visible" });
});
