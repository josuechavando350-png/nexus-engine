import path from "node:path";
import { cp, readFile } from "node:fs/promises";
import { request } from "playwright";
import { integrity } from "./build.js";
import {
  canonical,
  hash,
  inside,
  localPath,
  newDirectory,
  save,
  saveJson,
} from "./common.js";
import { allowedURL } from "./network.js";
import { rewriteCSS } from "./rewrite.js";
import { transportOptions } from "./transport.js";
import { replayResponseHeaders } from "./http-metadata.js";
import type { Manifest } from "./types.js";
import { refreshComponentResponses } from "./raw-responses.js";
import { readMotion } from "./motion.js";
import { collectObservedResources } from "./observed-resources.js";

/** Include unused CSS dependencies: viewport/state changes may request them later. */
export function cssDependencies(css: string, base: string) {
  const urls = new Set<string>();
  rewriteCSS(css, base, (value, source) => {
    if (!value || value.startsWith("#")) return value;
    const url = new URL(value, source);
    if (["https:", "http:"].includes(url.protocol))
      urls.add(canonical(url.href));
    return value;
  });
  return [...urls];
}

export async function collectCSSDependencies(manifest: Manifest, out: string) {
  const proxy = transportOptions();
  const client = await request.newContext({
    ...(proxy.server ? { proxy: proxy as { server: string } } : {}),
    timeout: manifest.config.navigationTimeoutMs,
  });
  const queue = Object.values(manifest.resources).filter((r) =>
    /text\/css/i.test(r.mime),
  );
  const attempted = new Set<string>();
  const added: string[] = [];
  let total = Object.values(manifest.resources).reduce(
    (n, r) => n + r.bytes,
    0,
  );
  try {
    for (let i = 0; i < queue.length; i++) {
      const css = queue[i];
      let urls: string[];
      try {
        urls = cssDependencies(
          await readFile(inside(out, css.file), "utf8"),
          css.url,
        );
      } catch (e) {
        manifest.issues.push({
          code: "CSS_PARSE_FAILED",
          detail: css.url + ": " + String(e),
        });
        continue;
      }
      for (const url of urls) {
        if (manifest.resources[url] || attempted.has(url)) continue;
        if (attempted.size >= 1000 || total >= manifest.config.maxTotalBytes) {
          manifest.issues.push({ code: "CSS_DEPENDENCY_LIMIT", detail: url });
          return added;
        }
        attempted.add(url);
        try {
          if (!(await allowedURL(url, manifest.config.allowLocalhost)))
            throw new Error("Destino bloqueado");
          // Redirect destinations need independent policy validation. Do not follow implicitly.
          const response = await client.get(url, { maxRedirects: 0 });
          try {
            if (!response.ok()) throw new Error("HTTP " + response.status());
            const headers = response.headers();
            if (
              Number(headers["content-length"] ?? 0) >
              manifest.config.maxResourceBytes
            )
              throw new Error("RESOURCE_LIMIT");
            const body = await response.body();
            if (
              body.length > manifest.config.maxResourceBytes ||
              total + body.length > manifest.config.maxTotalBytes
            )
              throw new Error("RESOURCE_LIMIT");
            const sha256 = hash(body);
            const resource = {
              url,
              status: response.status(),
              mime: headers["content-type"] ?? "application/octet-stream",
              kind: "css-dependency",
              sha256,
              bytes: body.length,
              file: "resources/" + sha256,
              localPath: localPath(url, manifest.origin),
              variants: [],
              responseHeaders: replayResponseHeaders(headers),
            };
            await save(inside(out, resource.file), body);
            manifest.resources[url] = resource;
            manifest.files[resource.file] = sha256;
            total += body.length;
            added.push(url);
            if (/text\/css/i.test(resource.mime)) queue.push(resource);
          } finally {
            await response.dispose();
          }
        } catch (e) {
          manifest.issues.push({
            code: "CSS_DEPENDENCY_FAILED",
            detail: url + ": " + String(e),
          });
        }
      }
    }
  } finally {
    await client.dispose();
  }
  return added;
}

/** Derive a new capture, preserving every original observation byte for byte. */
export async function enrich(
  captureDir: string,
  out: string,
  motionDir?: string,
) {
  if (path.resolve(out).startsWith(path.resolve(captureDir) + path.sep))
    throw new Error("La salida debe estar fuera de la captura original.");
  const { manifest, digest } = await integrity(captureDir);
  await newDirectory(out);
  await cp(captureDir, out, { recursive: true });
  const addedURLs = motionDir
    ? await collectObservedResources(manifest, await readMotion(motionDir), out)
    : [];
  addedURLs.push(...(await collectCSSDependencies(manifest, out)));
  await refreshComponentResponses(manifest, out);
  manifest.enrichment = {
    parentDigest: digest,
    createdAt: new Date().toISOString(),
    addedURLs,
  };
  await saveJson(path.join(out, "manifest.json"), manifest);
  await saveJson(path.join(out, "seal.json"), {
    algorithm: "sha256",
    manifestHash: hash(await readFile(path.join(out, "manifest.json"))),
    note: "Derivada de una captura sellada; conserva las observaciones originales. No es una firma externa.",
  });
  return { manifest, addedURLs };
}
