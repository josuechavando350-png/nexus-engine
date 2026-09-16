import assert from "node:assert/strict";
import test from "node:test";

import { renyiDivergence } from "../core/layers/information.mjs";

test("Renyi keeps finite support-mismatch divergence immediately below alpha=1", () => {
  const alpha = 1 - 1e-10;
  const result = renyiDivergence({ p: [0.5, 0.5], q: [1, 0], alpha });
  assert.equal(result.divergenceKind, "FINITE");
  assert(Number.isFinite(result.divergence));
  assert(result.divergence > 1e9);
  const above = renyiDivergence({ p: [0.5, 0.5], q: [1, 0], alpha: 1 + 1e-10 });
  assert.equal(above.divergenceKind, "POSITIVE_INFINITY");
  assert.equal(renyiDivergence({ p: [0.5, 0.5], q: [1, 0], alpha: 1 }).divergenceKind, "POSITIVE_INFINITY");
});

test("Renyi approaches KL continuously with full support on either side of alpha=1", () => {
  const p = [0.7, 0.2, 0.1];
  const q = [0.2, 0.5, 0.3];
  const kl = renyiDivergence({ p, q, alpha: 1 });
  assert.equal(kl.divergenceKind, "FINITE");
  for (const alpha of [1 - 1e-10, 1 + 1e-10, 1 - 1e-7, 1 + 1e-7]) {
    const value = renyiDivergence({ p, q, alpha });
    assert.equal(value.divergenceKind, "FINITE");
    assert(Math.abs(value.divergence - kl.divergence) < 1e-6, `alpha=${alpha}`);
  }
});

test("Renyi uses actual discrete distributions when probabilities differ from unit mass by accepted round-off", () => {
  const nearOne = renyiDivergence({
    p: [0.3, 0.7 + 1e-10],
    q: [0.5, 0.5],
    alpha: 1 + 1e-10,
  });
  assert.equal(nearOne.divergenceKind, "FINITE");
  assert(Number.isFinite(nearOne.divergence));
  assert(nearOne.divergence >= 0);
});
