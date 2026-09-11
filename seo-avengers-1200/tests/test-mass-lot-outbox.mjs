import assert from "node:assert/strict";
import { buildSeoAvengers1200Envelope } from "../scripts/seo-avengers-1200-outbox.mjs";

const datasetKeys = [
  "edge_html_records",
  "semantic_text_records",
  "persistence_state_records",
  "edge_gateway_records",
  "search_intent_records",
  "cwv_edge_records",
  "canonicalization_records",
  "policy_audit_records",
];

const payload = Object.fromEntries(datasetKeys.map((key) => [key, [{ record_id: `${key}-1`, observed: 1 }]]));
payload.meta_telemetry = {};

const input = { siteId: "probe", sourceRevision: "fixture-revision", payload, runtimeConfig: {} };
const first = buildSeoAvengers1200Envelope(input);
const second = buildSeoAvengers1200Envelope(input);
assert.equal(first.input_hash, second.input_hash);
assert.equal(first.idempotency_key, first.input_hash);
for (const key of datasetKeys) {
  assert.deepEqual(first.payload[key], payload[key]);
}

assert.throws(
  () => buildSeoAvengers1200Envelope({
    siteId: "probe",
    sourceRevision: "fixture-revision",
    payload: { edge_html_records: [{ record_id: "bad", confidence: 0.5 }] },
    runtimeConfig: {},
  }),
  /safe integers/,
);

console.log("200-module mass-lot outbox transport + deterministic hash + float rejection verified");
