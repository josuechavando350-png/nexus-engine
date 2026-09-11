import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SEO_AVENGERS_1200_FLAG = "CONFIG_SEO_AVENGERS_1200";
export const SEO_AVENGERS_200_FLAG = "CONFIG_SEO_AVENGERS_200";

export async function readSeoAvengers1200ProjectConfig(projectDir) {
  const manifestPath = join(resolve(projectDir), "package.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    const nexus = manifest?.nexus;
    const baseEnabled = nexus?.[SEO_AVENGERS_200_FLAG] === true;
    const extensionEnabled = nexus?.[SEO_AVENGERS_1200_FLAG] === true;

    return Object.freeze({
      enabled: baseEnabled && extensionEnabled,
      baseEnabled,
      extensionEnabled,
      siteId: typeof nexus?.siteId === "string" && nexus.siteId.trim()
        ? nexus.siteId.trim()
        : typeof manifest?.name === "string" && manifest.name.trim()
          ? manifest.name.replace(/^@nexus\//, "").trim()
          : null,
      canonicalOrigin: typeof nexus?.canonicalOrigin === "string" && nexus.canonicalOrigin.trim()
        ? nexus.canonicalOrigin.trim()
        : null,
      manifestPath,
    });
  } catch {
    return Object.freeze({
      enabled: false,
      baseEnabled: false,
      extensionEnabled: false,
      siteId: null,
      canonicalOrigin: null,
      manifestPath,
    });
  }
}
