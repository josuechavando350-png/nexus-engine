import { request } from "playwright";
import { hash, inside, save } from "./common.js";
import { allowedURL } from "./network.js";
import { transportOptions } from "./transport.js";
import { replayResponseHeaders } from "./http-metadata.js";
import type { Manifest } from "./types.js";

/** Chromium's decoded CDP response body can misdecode charset-less RSC text.
 * Re-fetch exact GET variants as bytes; never guess an encoding correction.
 * Observations stay unchanged and both resource hashes remain auditable.
 */
export async function refreshComponentResponses(
  manifest: Manifest,
  out: string,
) {
  const proxy = transportOptions();
  const client = await request.newContext({
    ...(proxy.server ? { proxy: proxy as { server: string } } : {}),
    timeout: manifest.config.navigationTimeoutMs,
  });
  let total = Object.values(manifest.resources).reduce(
    (sum, r) => sum + r.bytes,
    0,
  );
  try {
    for (const r of Object.values(manifest.resources)) {
      if (!/^text\/x-component\b/i.test(r.mime)) continue;
      try {
        if (!(await allowedURL(r.url, manifest.config.allowLocalhost)))
          throw new Error("Destino bloqueado");
        const response = await client.get(r.url, {
          headers: r.requestHeaders,
          maxRedirects: 0,
        });
        try {
          const headers = response.headers();
          if (
            !response.ok() ||
            !/^text\/x-component\b/i.test(headers["content-type"] ?? "")
          )
            throw new Error(
              "La variante RSC no está disponible: HTTP " + response.status(),
            );
          if (
            Number(headers["content-length"] ?? 0) >
            manifest.config.maxResourceBytes
          )
            throw new Error("RESOURCE_LIMIT");
          const body = await response.body();
          if (
            body.length > manifest.config.maxResourceBytes ||
            total - r.bytes + body.length > manifest.config.maxTotalBytes
          )
            throw new Error("RESOURCE_LIMIT");
          const currentHash = hash(body),
            previousHash = r.sha256;
          await save(inside(out, "resources/" + currentHash), body);
          manifest.rawResponseRefresh ??= [];
          manifest.rawResponseRefresh.push({
            url: r.url,
            previousHash,
            currentHash,
            fetchedAt: new Date().toISOString(),
          });
          // Keep the original observed body in the seal, even when replacing its replay route.
          manifest.files[r.file] = previousHash;
          total += body.length - r.bytes;
          Object.assign(r, {
            sha256: currentHash,
            file: "resources/" + currentHash,
            bytes: body.length,
            mime: headers["content-type"],
            responseHeaders: replayResponseHeaders(headers),
          });
          manifest.files[r.file] = currentHash;
        } finally {
          await response.dispose();
        }
      } catch (e) {
        manifest.issues.push({
          code: "RAW_RESPONSE_FAILED",
          detail: r.url + ": " + String(e),
        });
      }
    }
  } finally {
    await client.dispose();
  }
}
