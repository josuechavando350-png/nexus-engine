import path from "node:path";
import { cp, readFile } from "node:fs/promises";
import { integrity } from "./build.js";
import { collectObservedResources } from "./observed-resources.js";
import { routingRequestHeaders } from "./http-metadata.js";
import { newDirectory, saveJson, hash } from "./common.js";

export type MissingRequestLog = {
  schemaVersion: 1;
  sourceOrigin: string;
  requests: {
    path: string;
    method: "GET";
    requestHeaders: Record<string, string>;
  }[];
};

/** Resolve exact candidate GET misses against the declared public origin.
 * A candidate 404 is NOT recorded as a successful origin observation. Status 0
 * explicitly means unverified; only a real successful response becomes a resource.
 */
export async function completeRequests(
  captureDir: string,
  log: MissingRequestLog,
  out: string,
) {
  const { manifest, digest } = await integrity(captureDir);
  if (
    log.schemaVersion !== 1 ||
    log.sourceOrigin !== manifest.origin ||
    !Array.isArray(log.requests) ||
    log.requests.length > 1000
  )
    throw new Error("Registro de solicitudes inválido o de otro origen.");
  const requests = new Map<
    string,
    {
      url: string;
      status: number;
      mime: string;
      requestHeaders: Record<string, string>;
    }
  >();
  for (const r of log.requests) {
    if (
      !r ||
      r.method !== "GET" ||
      typeof r.path !== "string" ||
      !r.path.startsWith("/") ||
      r.path.startsWith("//") ||
      r.path.includes("\\") ||
      !r.requestHeaders ||
      typeof r.requestHeaders !== "object" ||
      Object.values(r.requestHeaders).some((v) => typeof v !== "string")
    )
      throw new Error("Solicitud no permitida.");
    const url = new URL(r.path, manifest.origin);
    const headers = routingRequestHeaders(r.requestHeaders);
    if (url.origin !== manifest.origin || url.hash || headers.rsc !== "1")
      throw new Error(
        "Solo se admiten variantes RSC GET del origen declarado.",
      );
    const previous = requests.get(url.href);
    const stable = (h: Record<string, string>) =>
      JSON.stringify(Object.entries(h).sort(([a], [b]) => a.localeCompare(b)));
    if (previous && stable(previous.requestHeaders) !== stable(headers))
      throw new Error("Una URL tiene variantes de cabecera ambiguas.");
    const existing = manifest.resources[url.href];
    if (
      existing &&
      (!existing.mime.includes("text/x-component") ||
        !existing.requestHeaders ||
        stable(routingRequestHeaders(existing.requestHeaders)) !==
          stable(headers))
    )
      throw new Error(
        "La URL existente tiene una variante de respuesta no comprobada para estas cabeceras.",
      );
    requests.set(url.href, {
      url: url.href,
      status: 0,
      mime: "text/x-component",
      requestHeaders: headers,
    });
  }
  if (
    path.resolve(out) === path.resolve(captureDir) ||
    path.resolve(out).startsWith(path.resolve(captureDir) + path.sep)
  )
    throw new Error("Usa una salida fuera de la captura original.");
  await newDirectory(out);
  await cp(captureDir, out, { recursive: true });
  const original = new Map(
    Object.values(manifest.resources).map((r) => [r.url, r.sha256]),
  );
  const added = await collectObservedResources(
    manifest,
    { source: manifest.origin, observedRequests: [...requests.values()] },
    out,
    { allowUnverifiedRequests: true },
  );
  const unresolved = [...requests.keys()].filter(
    (url) => !manifest.resources[url],
  );
  manifest.enrichment = {
    parentDigest: digest,
    createdAt: new Date().toISOString(),
    addedURLs: added,
  };
  await saveJson(path.join(out, "manifest.json"), manifest);
  const derivedDigest = hash(await readFile(path.join(out, "manifest.json")));
  await saveJson(path.join(out, "seal.json"), {
    algorithm: "sha256",
    manifestHash: derivedDigest,
  });
  const result = {
    schemaVersion: 1,
    sourceDigest: digest,
    derivedDigest,
    status: unresolved.length ? "incomplete" : "completed",
    requested: requests.size,
    added,
    unresolved,
    originalResourcesUnchanged: [...original].every(
      ([u, h]) => manifest.resources[u]?.sha256 === h,
    ),
  };
  await saveJson(path.join(out, "request-completion.json"), result);
  return result;
}
