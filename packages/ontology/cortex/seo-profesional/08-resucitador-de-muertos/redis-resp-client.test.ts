import { describe, expect, it } from "vitest";
import { decodeRedisResponse, encodeRedisCommand, RedisRespScriptClient } from "./redis-resp-client.js";

describe("RedisRespScriptClient primitives", () => {
  it("encodes RESP2 commands without lossy character counts", () => {
    expect(encodeRedisCommand(["SET", "clave", "México"]).toString("utf8")).toBe("*3\r\n$3\r\nSET\r\n$5\r\nclave\r\n$7\r\nMéxico\r\n");
  });

  it("decodes nested RESP2 values and rejects server errors", () => {
    expect(decodeRedisResponse(Buffer.from("*3\r\n$3\r\none\r\n:2\r\n$-1\r\n", "utf8"))).toEqual(["one", 2, null]);
    expect(() => decodeRedisResponse(Buffer.from("-ERR denied\r\n", "utf8"))).toThrow(/denied/u);
    expect(() => decodeRedisResponse(Buffer.from("$5\r\nabc", "utf8"))).toThrow(/incomplete/u);
  });

  it("requires TLS for non-local Redis endpoints and allows explicit localhost development only", () => {
    expect(() => new RedisRespScriptClient({ url: "redis://redis.example:6379/0" })).toThrow(/plaintext Redis/u);
    expect(() => new RedisRespScriptClient({ url: "redis://127.0.0.1:6379/0", allowPlaintextLocalhost: true })).not.toThrow();
    expect(() => new RedisRespScriptClient({ url: "rediss://user:secret@redis.example:6380/2" })).not.toThrow();
  });
});
