import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type RedisRespValue = string | number | null | readonly RedisRespValue[];

export class RedisRespClientError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_COMMAND" | "CONNECT_FAILURE" | "TIMEOUT" | "PROTOCOL_ERROR" | "REDIS_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "RedisRespClientError";
  }
}

export interface RedisScriptPort {
  eval(script: string, keys: readonly string[], args: readonly string[]): Promise<RedisRespValue>;
}

export function encodeRedisCommand(parts: readonly string[]): Buffer {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 512 || parts.some((part) => typeof part !== "string" || Buffer.byteLength(part, "utf8") > 2_000_000)) {
    throw new RedisRespClientError("INVALID_COMMAND", "Redis command parts are invalid");
  }
  const chunks = [`*${parts.length}\r\n`];
  for (const part of parts) chunks.push(`$${Buffer.byteLength(part, "utf8")}\r\n${part}\r\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

interface ParsedResp {
  readonly value: RedisRespValue;
  readonly next: number;
}

function lineEnd(buffer: Buffer, offset: number): number {
  return buffer.indexOf("\r\n", offset, "utf8");
}

function parseInteger(raw: string, label: string): number {
  if (!/^-?\d+$/u.test(raw)) throw new RedisRespClientError("PROTOCOL_ERROR", `${label} is not an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new RedisRespClientError("PROTOCOL_ERROR", `${label} exceeds safe integer range`);
  return value;
}

function tryParseResp(buffer: Buffer, offset = 0): ParsedResp | null {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]!);
  const end = lineEnd(buffer, offset + 1);
  if (end < 0) return null;
  const header = buffer.toString("utf8", offset + 1, end);
  if (prefix === "+") return { value: header, next: end + 2 };
  if (prefix === "-") throw new RedisRespClientError("REDIS_ERROR", header.slice(0, 2_000));
  if (prefix === ":") return { value: parseInteger(header, "Redis integer response"), next: end + 2 };
  if (prefix === "$") {
    const length = parseInteger(header, "Redis bulk length");
    if (length === -1) return { value: null, next: end + 2 };
    if (length < 0 || length > 8_000_000) throw new RedisRespClientError("PROTOCOL_ERROR", "Redis bulk response length is invalid");
    const start = end + 2;
    const finish = start + length;
    if (buffer.length < finish + 2) return null;
    if (buffer[finish] !== 13 || buffer[finish + 1] !== 10) throw new RedisRespClientError("PROTOCOL_ERROR", "Redis bulk response terminator is invalid");
    return { value: buffer.toString("utf8", start, finish), next: finish + 2 };
  }
  if (prefix === "*") {
    const count = parseInteger(header, "Redis array length");
    if (count === -1) return { value: null, next: end + 2 };
    if (count < 0 || count > 10_000) throw new RedisRespClientError("PROTOCOL_ERROR", "Redis array response length is invalid");
    const values: RedisRespValue[] = [];
    let cursor = end + 2;
    for (let index = 0; index < count; index += 1) {
      const parsed = tryParseResp(buffer, cursor);
      if (!parsed) return null;
      values.push(parsed.value);
      cursor = parsed.next;
    }
    return { value: Object.freeze(values), next: cursor };
  }
  throw new RedisRespClientError("PROTOCOL_ERROR", `unsupported Redis RESP2 prefix ${JSON.stringify(prefix)}`);
}

export function decodeRedisResponse(buffer: Buffer): RedisRespValue {
  const parsed = tryParseResp(buffer);
  if (!parsed || parsed.next !== buffer.length) throw new RedisRespClientError("PROTOCOL_ERROR", "Redis response is incomplete or contains trailing bytes");
  return parsed.value;
}

function localPlaintextHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export class RedisRespScriptClient implements RedisScriptPort {
  private readonly url: URL;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly database: number;

  constructor(input: {
    readonly url: string;
    readonly allowPlaintextLocalhost?: boolean;
    readonly connectTimeoutMs?: number;
    readonly commandTimeoutMs?: number;
  }) {
    let url: URL;
    try { url = new URL(input?.url ?? ""); }
    catch { throw new RedisRespClientError("INVALID_CONFIG", "Redis URL is invalid"); }
    if (url.protocol !== "rediss:" && url.protocol !== "redis:") throw new RedisRespClientError("INVALID_CONFIG", "Redis URL must use rediss:// or redis://");
    if (url.search || url.hash) throw new RedisRespClientError("INVALID_CONFIG", "Redis URL cannot contain query or fragment data");
    if (url.protocol === "redis:" && !(input.allowPlaintextLocalhost === true && localPlaintextHost(url.hostname))) {
      throw new RedisRespClientError("INVALID_CONFIG", "plaintext Redis is allowed only for explicitly enabled localhost development");
    }
    if (url.username && !url.password) throw new RedisRespClientError("INVALID_CONFIG", "Redis ACL username requires a password");
    const dbRaw = url.pathname === "" || url.pathname === "/" ? "0" : url.pathname.slice(1);
    if (!/^\d{1,3}$/u.test(dbRaw)) throw new RedisRespClientError("INVALID_CONFIG", "Redis database path is invalid");
    const database = Number(dbRaw);
    if (!Number.isSafeInteger(database) || database < 0 || database > 999) throw new RedisRespClientError("INVALID_CONFIG", "Redis database number is invalid");
    this.connectTimeoutMs = input.connectTimeoutMs ?? 5_000;
    this.commandTimeoutMs = input.commandTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 500 || this.connectTimeoutMs > 30_000 || !Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 500 || this.commandTimeoutMs > 30_000) {
      throw new RedisRespClientError("INVALID_CONFIG", "Redis client timeouts are invalid");
    }
    this.url = url;
    this.database = database;
  }

  private async open(): Promise<Socket> {
    const port = this.url.port ? Number(this.url.port) : 6379;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RedisRespClientError("INVALID_CONFIG", "Redis port is invalid");
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new RedisRespClientError("CONNECT_FAILURE", "Redis connection timed out"));
      }, this.connectTimeoutMs);
      const onReady = (socket: Socket) => {
        if (settled) { socket.destroy(); return; }
        settled = true;
        clearTimeout(timeout);
        socket.setNoDelay(true);
        resolve(socket);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new RedisRespClientError("CONNECT_FAILURE", `Redis connection failed: ${error.message}`));
      };
      if (this.url.protocol === "rediss:") {
        const socket = tlsConnect({ host: this.url.hostname, port, servername: this.url.hostname, rejectUnauthorized: true }, () => onReady(socket));
        socket.once("error", onError);
      } else {
        const socket = createConnection({ host: this.url.hostname, port }, () => onReady(socket));
        socket.once("error", onError);
      }
    });
  }

  private async issue(socket: Socket, parts: readonly string[]): Promise<RedisRespValue> {
    const payload = encodeRedisCommand(parts);
    return await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const finish = (error: Error | null, value?: RedisRespValue) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value ?? null);
      };
      const onData = (chunk: Buffer) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > 8_500_000) return finish(new RedisRespClientError("PROTOCOL_ERROR", "Redis response exceeded client bound"));
          const parsed = tryParseResp(buffer);
          if (!parsed) return;
          if (parsed.next !== buffer.length) return finish(new RedisRespClientError("PROTOCOL_ERROR", "Redis returned unexpected trailing response bytes"));
          finish(null, parsed.value);
        } catch (error) {
          finish(error instanceof Error ? error : new RedisRespClientError("PROTOCOL_ERROR", "Redis response parsing failed"));
        }
      };
      const onError = (error: Error) => finish(new RedisRespClientError("CONNECT_FAILURE", `Redis socket failed: ${error.message}`));
      const onClose = () => finish(new RedisRespClientError("CONNECT_FAILURE", "Redis socket closed before a complete response"));
      const timer = setTimeout(() => finish(new RedisRespClientError("TIMEOUT", "Redis command timed out")), this.commandTimeoutMs);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.write(payload, (error) => { if (error) finish(new RedisRespClientError("CONNECT_FAILURE", `Redis command write failed: ${error.message}`)); });
    });
  }

  async eval(script: string, keys: readonly string[], args: readonly string[]): Promise<RedisRespValue> {
    if (typeof script !== "string" || script.length < 1 || Buffer.byteLength(script, "utf8") > 1_000_000 || !Array.isArray(keys) || keys.length > 64 || !Array.isArray(args) || args.length > 256) {
      throw new RedisRespClientError("INVALID_COMMAND", "Redis EVAL input is invalid");
    }
    const socket = await this.open();
    try {
      const username = decodeURIComponent(this.url.username);
      const password = decodeURIComponent(this.url.password);
      if (password) {
        const auth = username ? ["AUTH", username, password] : ["AUTH", password];
        const reply = await this.issue(socket, auth);
        if (reply !== "OK") throw new RedisRespClientError("REDIS_ERROR", "Redis AUTH did not return OK");
      }
      if (this.database !== 0) {
        const reply = await this.issue(socket, ["SELECT", String(this.database)]);
        if (reply !== "OK") throw new RedisRespClientError("REDIS_ERROR", "Redis SELECT did not return OK");
      }
      return await this.issue(socket, ["EVAL", script, String(keys.length), ...keys, ...args]);
    } finally {
      socket.destroy();
    }
  }
}
