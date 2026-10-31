import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixture",
);
export async function fixture() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/stats") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Nextjs-Prerender": "1",
      });
      res.end(JSON.stringify({ projects: 24, countries: 6 }));
      return;
    }
    if (pathname === "/assets/shape.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><radialGradient id="g" cx="30%" cy="25%"><stop stop-color="#b7d9ff"/><stop offset=".6" stop-color="#4373ae"/><stop offset="1" stop-color="#1b314e"/></radialGradient></defs><circle cx="150" cy="150" r="145" fill="url(#g)"/></svg>',
      );
      return;
    }
    if (pathname === "/assets/grid.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M24 0H0V24" fill="none" stroke="#d5dbe2" stroke-width=".5"/></svg>',
      );
      return;
    }
    const routes: Record<string, [string, string]> = {
      "/": ["index.html", "text/html"],
      "/work/": ["work.html", "text/html"],
      "/styles/main.css": ["main.css", "text/css"],
      "/styles/tokens.css": ["tokens.css", "text/css"],
      "/app.js": ["app.js", "application/javascript"],
    };
    const route = routes[pathname];
    if (!route) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      res.writeHead(200, { "Content-Type": route[1] + "; charset=utf-8" });
      res.end(await readFile(path.join(root, route[0])));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("fixture");
  return {
    url: "http://127.0.0.1:" + a.port + "/",
    close: () =>
      new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}
