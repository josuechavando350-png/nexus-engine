import test from "node:test";
import assert from "node:assert/strict";
import { remoteDNSAllowed, transportOptions } from "../src/transport.js";
import { allowedURL } from "../src/network.js";

test("proxy DNS delegation is explicit, exact-host and cannot allow private IP literals", async () => {
  const oldURL = process.env.REPLICA_PROXY_URL,
    oldHosts = process.env.REPLICA_PROXY_HOSTS;
  try {
    process.env.REPLICA_PROXY_URL =
      "http://test-user:test-password@127.0.0.1:8080";
    process.env.REPLICA_PROXY_HOSTS =
      "dakshgajjar.com,127.0.0.1,metadata.internal";
    assert.equal(remoteDNSAllowed("dakshgajjar.com"), true);
    assert.equal(remoteDNSAllowed("dakshgajjar.com.evil.test"), false);
    assert.equal(remoteDNSAllowed("metadata.internal"), false);
    assert.equal(await allowedURL("http://127.0.0.1", false), false);
    const options = transportOptions();
    assert.equal(options.server, "http://127.0.0.1:8080");
    assert.equal(options.username, "test-user");
    assert.equal(options.password, "test-password");
    delete process.env.REPLICA_PROXY_URL;
    assert.equal(remoteDNSAllowed("dakshgajjar.com"), false);
  } finally {
    if (oldURL === undefined) delete process.env.REPLICA_PROXY_URL;
    else process.env.REPLICA_PROXY_URL = oldURL;
    if (oldHosts === undefined) delete process.env.REPLICA_PROXY_HOSTS;
    else process.env.REPLICA_PROXY_HOSTS = oldHosts;
  }
});
