import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { inside, json } from "./common.js";
import type { Build } from "./types.js";

export async function serve(dir: string, port = 0) {
  const index = await json<Build>(path.join(dir, "routes.json"));
  const missing: string[] = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
    );
    if (!["GET", "HEAD"].includes(req.method ?? "")) {
      res.writeHead(405);
      res.end("Solo lectura: no hay backend.");
      return;
    }
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      const route = index.routes[u.pathname + u.search];
      if (!route) {
        missing.push(u.pathname + u.search);
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Recurso no capturado: " + u.pathname);
        return;
      }
      const bytes = await readFile(inside(dir, route.file));
      res.writeHead(route.status, {
        ...route.responseHeaders,
        "Content-Type": route.mime,
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      res.writeHead(500);
      res.end("No se pudo servir el recurso.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Servidor no disponible.");
  return {
    url: "http://127.0.0.1:" + address.port,
    missing,
    index,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
