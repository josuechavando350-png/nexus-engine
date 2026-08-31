# @nexus/query-fanout

Deterministic, auditable simulation of plausible query fan-out against a supplied site corpus.

## Evidence boundary

This package does **not** expose or infer an internal Google AI Mode / AI Overviews query log. Every generated subquery is labeled `NEXUS_SIMULATED_QUERY_V1`, and every assessment declares `SIMULATED_PLAUSIBLE_NOT_OBSERVED_GOOGLE_INTERNAL_QUERIES`.

The algorithm expands explicit intent, entity, attribute, constraint, and evidence factors supplied by the caller, then scores the simulated needs against supplied passages. The output may identify coverage gaps, but it must not be represented as search-engine telemetry.

Corpus content passed by a caller is not independently verified by this package. The operational audit consumer therefore reports execution as `OBSERVED` while external corpus verification remains `NOT_VERIFIED` unless another NEXUS evidence boundary establishes provenance.

## Safety and quality invariants

- factor weights must be finite and in `(0, 1]`;
- duplicate factor and passage identifiers are rejected;
- passage URLs must be absolute;
- fan-out is bounded to at most 512 candidates and defaults to 96;
- ordering and digests are deterministic for equivalent deterministic inputs;
- missing corpus coverage never becomes PASS-like evidence;
- recommendations strengthen useful existing content and explicitly reject doorway/scaled-page generation solely for simulator coverage;
- no network call or model provider is hidden inside the deterministic evaluator.

## Runtime consumer

Build the package, then provide an explicit JSON corpus and fan-out specification:

```bash
pnpm --filter @nexus/query-fanout build
node scripts/audit-query-fanout.mjs --input ./query-fanout-input.json
```

Input shape:

```json
{
  "fanOut": {
    "rootQuery": "abogado fiscal colima",
    "locale": "es-MX",
    "intents": [{ "id": "compare", "label": "comparar opciones", "weight": 0.8 }],
    "entities": [{ "id": "colima", "label": "Colima", "weight": 1 }],
    "attributes": [{ "id": "cost", "label": "costos", "weight": 0.7 }],
    "constraints": [],
    "evidenceNeeds": ["EXPERIENCE"]
  },
  "corpus": []
}
```

Missing or malformed runtime input produces `UNAVAILABLE` and a non-zero exit code. A successful run means the deterministic assessment executed; it does not certify live search-engine behavior or externally verify the corpus.
