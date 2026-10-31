import test from "node:test";
import assert from "node:assert/strict";
import {
  replayResponseHeaders,
  routingRequestHeaders,
  optionalPrefetchCancelled,
} from "../src/http-metadata.js";

test("Next.js replay retains routing metadata while omitting cookies and transport headers", () => {
  const selected = replayResponseHeaders({
    "x-nextjs-postponed": "2",
    "x-nextjs-prerender": "1",
    "x-nextjs-stale-time": "300",
    vary: "rsc, next-router-prefetch",
    "content-encoding": "br",
    "content-length": "8",
    "set-cookie": "session=private",
    "content-security-policy": "default-src 'none'",
  });
  assert.deepEqual(selected, {
    "x-nextjs-postponed": "2",
    "x-nextjs-prerender": "1",
    "x-nextjs-stale-time": "300",
    vary: "rsc, next-router-prefetch",
  });
  assert.deepEqual(
    routingRequestHeaders({
      rsc: "1",
      "next-router-prefetch": "1",
      authorization: "secret",
      cookie: "private",
    }),
    { rsc: "1", "next-router-prefetch": "1" },
  );
});
test("only browser-cancelled recorded RSC prefetches are classified as optional", () => {
  assert.equal(
    optionalPrefetchCancelled(
      "net::ERR_ABORTED",
      { "next-router-prefetch": "1" },
      "text/x-component",
    ),
    true,
  );
  assert.equal(
    optionalPrefetchCancelled(
      "net::ERR_FAILED",
      { "next-router-prefetch": "1" },
      "text/x-component",
    ),
    false,
  );
  assert.equal(
    optionalPrefetchCancelled("net::ERR_ABORTED", {}, "text/x-component"),
    false,
  );
  assert.equal(
    optionalPrefetchCancelled(
      "net::ERR_ABORTED",
      { "next-router-prefetch": "1" },
      undefined,
    ),
    false,
  );
  assert.equal(
    optionalPrefetchCancelled(
      "net::ERR_ABORTED",
      { "next-router-prefetch": "1" },
      "text/html",
    ),
    false,
  );
});
