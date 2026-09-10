import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SEO_AVENGERS_FLAG = "CONFIG_SEO_AVENGERS_200";

export async function readSeoAvengersProjectConfig(projectDir) {
  const manifestPath = join(resolve(projectDir), "package.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    return Object.freeze({
      enabled: manifest?.nexus?.[SEO_AVENGERS_FLAG] === true,
      siteId: typeof manifest?.nexus?.siteId === "string" && manifest.nexus.siteId.trim()
        ? manifest.nexus.siteId.trim()
        : typeof manifest?.name === "string"
          ? manifest.name.replace(/^@nexus\//, "")
          : null,
      canonicalOrigin: typeof manifest?.nexus?.canonicalOrigin === "string"
        ? manifest.nexus.canonicalOrigin.trim()
        : null,
      manifestPath,
    });
  } catch {
    return Object.freeze({ enabled: false, siteId: null, canonicalOrigin: null, manifestPath });
  }
}
