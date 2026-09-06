import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { SqliteDurableEventStream, arbitrateBudget, Cortex17Error } from "./index";

const MAX_BODY_BYTES = 65_536;
type Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

function mode(): Mode {
  const value = process.env.NEXUS_CORTEX_17_MODE;
  return value === "ACTIVE" || value === "OBSERVE_ONLY" ? value : "KILLED";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") && secureEqual(header.slice(7), expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex17Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex17Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new Cortex17Error("INVALID_INPUT", "request body is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof Cortex17Error) {
    const status = error.code === "CONFLICT" || error.code === "OFFSET_REGRESSION" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
    send(response, status, { error: error.code });
    return;
  }
  console.error(JSON.stringify({ component: "cortex-17-server", error: "INTERNAL" }));
  send(response, 500, { error: "INTERNAL" });
}

export function startCortex17Server(): { close(): Promise<void> } {
  const databasePath = required("NEXUS_CORTEX_17_DATABASE");
  const writeToken = required("NEXUS_CORTEX_17_WRITE_TOKEN");
  const readToken = required("NEXUS_CORTEX_17_READ_TOKEN");
  if (writeToken === readToken) throw new Error("CORTEX #17 read and write credentials must be distinct");
  const configuredPort = Number(process.env.NEXUS_CORTEX_17_PORT ?? "8787");
  if (!Number.isSafeInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) throw new Error("NEXUS_CORTEX_17_PORT is invalid");
  const stream = new SqliteDurableEventStream(databasePath);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid.local"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        send(response, mode() === "KILLED" ? 503 : 200, { mode: mode() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        if (!authorized(request, writeToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (mode() !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const body = await readJson(request);
        // Final control read immediately before the durable mutation.
        if (mode() !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const event = stream.append(body);
        console.info(JSON.stringify({ component: "cortex-17-stream", operation: "APPEND", stream: event.stream, sequence: event.sequence, digest: event.digest }));
        return send(response, 201, event);
      }

      if (request.method === "GET" && url.pathname === "/v1/events") {
        if (!authorized(request, readToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (mode() === "KILLED") return send(response, 503, { error: "KILLED" });
        const streamName = url.searchParams.get("stream") ?? "";
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        return send(response, 200, { events: stream.read(streamName, after, limit) });
      }

      if (request.method === "POST" && url.pathname === "/v1/offsets") {
        if (!authorized(request, writeToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (mode() !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const body = await readJson(request) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "consumerId,sequence,stream") throw new Cortex17Error("INVALID_INPUT", "offset contract is invalid");
        if (mode() !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const sequence = stream.commitOffset(String(body.consumerId ?? ""), String(body.stream ?? ""), Number(body.sequence));
        return send(response, 200, { sequence });
      }

      if (request.method === "POST" && url.pathname === "/v1/budget/arbitrate") {
        if (!authorized(request, readToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        const currentMode = mode();
        if (currentMode === "KILLED") return send(response, 503, { error: "KILLED" });
        const result = arbitrateBudget(await readJson(request));
        return send(response, 200, { mode: currentMode, result });
      }

      send(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  server.listen(configuredPort, "127.0.0.1");
  return {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => {
      stream.close();
      if (error) reject(error); else resolve();
    })),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startCortex17Server();
}
