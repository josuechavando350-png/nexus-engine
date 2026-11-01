import { request } from "playwright";
import { canonical, hash, inside, localPath, save } from "./common.js";
import { allowedURL } from "./network.js";
import { transportOptions } from "./transport.js";
import {
  replayResponseHeaders,
  routingRequestHeaders,
} from "./http-metadata.js";
import type { Manifest } from "./types.js";
import type { MotionTrace } from "./experience-types.js";

/** Add exact GET variants observed with motion active; never strip routing query parameters. */
export async function collectObservedResources(
  manifest: Manifest,
  trace: Pick<MotionTrace, "source" | "observedRequests">,
  out: string,
  options: { allowUnverifiedRequests?: boolean } = {},
) {
  if (new URL(trace.source).origin !== manifest.origin)
    throw new Error("La traza pertenece a otro origen.");
  const observations = trace.observedRequests;
  if (!observations)
    throw new Error(
      "La traza no registró solicitudes. Genera una nueva traza remota.",
    );
  if (observations.length > 1000)
    throw new Error("Demasiadas solicitudes observadas.");
  const proxy = transportOptions(),
    client = await request.newContext({
      ...(proxy.server ? { proxy: proxy as { server: string } } : {}),
      timeout: manifest.config.navigationTimeoutMs,
    });
  let total = Object.values(manifest.resources).reduce(
    (n, r) => n + r.bytes,
    0,
  );
  const added: string[] = [];
  try {
    for (const observed of observations) {
      const url = canonical(observed.url);
      if (
        manifest.resources[url] ||
        (!(options.allowUnverifiedRequests && observed.status === 0) &&
          (observed.status < 200 || observed.status >= 300))
      )
        continue;
      try {
        if (!(await allowedURL(url, manifest.config.allowLocalhost)))
          throw new Error("Destino bloqueado");
        const headers = routingRequestHeaders(observed.requestHeaders);
        const response = await client.get(url, { headers, maxRedirects: 0 });
        try {
          if (!response.ok()) throw new Error("HTTP " + response.status());
          const received = response.headers();
          if (
            observed.mime.split(";")[0].toLowerCase() !==
            (received["content-type"] ?? "").split(";")[0].toLowerCase()
          )
            throw new Error("Cambió el tipo de respuesta observado.");
          if (
            Number(received["content-length"] ?? 0) >
            manifest.config.maxResourceBytes
          )
            throw new Error("RESOURCE_LIMIT");
          const body = await response.body();
          if (
            body.length > manifest.config.maxResourceBytes ||
            total + body.length > manifest.config.maxTotalBytes
          )
            throw new Error("RESOURCE_LIMIT");
          const sha256 = hash(body),
            file = "resources/" + sha256;
          await save(inside(out, file), body);
          manifest.resources[url] = {
            url,
            status: response.status(),
            mime: received["content-type"] ?? "application/octet-stream",
            kind:
              observed.status === 0
                ? "candidate-requested-get"
                : "motion-observed-get",
            sha256,
            bytes: body.length,
            file,
            localPath: localPath(url, manifest.origin),
            variants: [],
            requestHeaders: headers,
            responseHeaders: replayResponseHeaders(received),
          };
          manifest.files[file] = sha256;
          total += body.length;
          added.push(url);
        } finally {
          await response.dispose();
        }
      } catch (error) {
        manifest.issues.push({
          code:
            observed.status === 0
              ? "REQUEST_RESOURCE_FAILED"
              : "MOTION_RESOURCE_FAILED",
          detail: url + ": " + String(error),
        });
      }
    }
  } finally {
    await client.dispose();
  }
  return added;
}
