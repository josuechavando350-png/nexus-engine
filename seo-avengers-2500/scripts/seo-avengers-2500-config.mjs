import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readClientActivation } from "./seo-avengers-2500-activation.mjs";

export const SEO_AVENGERS_2500_FLAG = "CONFIG_SEO_AVENGERS_2500";

export async function readSeoAvengers2500ProjectConfig(projectDir, options = {}) {
  const resolvedProject = resolve(projectDir);
  const manifestPath = join(resolvedProject, "package.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    const nexus = manifest?.nexus;
    const eligible = nexus?.[SEO_AVENGERS_2500_FLAG] === true;
    const siteId = typeof nexus?.siteId === "string" && nexus.siteId.trim()
      ? nexus.siteId.trim()
      : typeof manifest?.name === "string" && manifest.name.trim()
        ? manifest.name.replace(/^@nexus\//, "").trim()
        : null;
    const canonicalOrigin = typeof nexus?.canonicalOrigin === "string" && nexus.canonicalOrigin.trim()
      ? nexus.canonicalOrigin.trim()
      : null;
    const operatorEnabled = eligible && siteId
      ? await readClientActivation({ projectDir: resolvedProject, siteId, activationFile: options.activationFile ?? null })
      : false;

    return Object.freeze({
      enabled: eligible && operatorEnabled,
      eligible,
      operatorEnabled,
      siteId,
      canonicalOrigin,
      manifestPath,
    });
  } catch {
    return Object.freeze({
      enabled: false,
      eligible: false,
      operatorEnabled: false,
      siteId: null,
      canonicalOrigin: null,
      manifestPath,
    });
  }
}
