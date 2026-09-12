import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SEO_AVENGERS_2500_FLAG = "CONFIG_SEO_AVENGERS_2500";

export async function readSeoAvengers2500ProjectConfig(projectDir) {
  const manifestPath = join(resolve(projectDir), "package.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    const nexus = manifest?.nexus;
    const enabled = nexus?.[SEO_AVENGERS_2500_FLAG] === true;
    const siteId = typeof nexus?.siteId === "string" && nexus.siteId.trim()
      ? nexus.siteId.trim()
      : typeof manifest?.name === "string" && manifest.name.trim()
        ? manifest.name.replace(/^@nexus\//, "").trim()
        : null;
    const canonicalOrigin = typeof nexus?.canonicalOrigin === "string" && nexus.canonicalOrigin.trim()
      ? nexus.canonicalOrigin.trim()
      : null;

    return Object.freeze({
      enabled,
      siteId,
      canonicalOrigin,
      manifestPath,
    });
  } catch {
    return Object.freeze({
      enabled: false,
      siteId: null,
      canonicalOrigin: null,
      manifestPath,
    });
  }
}
