# Original RMC-011 source audits: historical replay and current compatibility

The seven-bounded-family and two-original-D08-debt audit workflows authenticate
historical source evidence. Their immutable audit input is the original nine-family
source-universe Git blob `c1b9f136a13f220af9dceaae50e5caa3105121eb`, preserved byte for
byte in `fixtures/rmc011-source-universe-nine-original-pins.json`.

The checked-out current registry may subsequently resolve the four native families
or admit family-universe discovery. That must neither invalidate the historical
proof nor silently reinterpret it as a current global closure certificate.

Each workflow therefore performs two distinct checks:

1. Validate the current registry with the current source-universe and relevant
   promotion validators. The compatibility guard additionally requires all nine
   historical family rows, including every original evidence/provenance field and
   JSON type, to remain unchanged. Missing or altered rows fail. This guard does
   not authenticate current native-family evidence or current global discovery.
2. Replay the unchanged original independent producer and all its existing
   adversarial tests in a separate temporary directory. Only that directory's
   source universe is replaced with the exact hash-pinned historical fixture.
   Original ZIP digests, run/head/artifact identities, D06–D10 source provenance,
   catalog hashes, member hashes, report self-hashes and nonclaims remain intact.

The checkout is never overwritten. Current catalog/input/final-lock pins are still
enforced, so a material change in those assumptions fails closed and requires an
explicit contract review.

The existing independent reports retain their original schema, provenance and
meaning. Their `9 resolved / 4 unresolved`, `NOT_CERTIFIED` discovery and false
terminal flags describe the historical replay only. The separately content-addressed
`historical-current-compatibility.json` explicitly labels that scope and records
the current registry's observed resolved count and discovery status separately.
Those observations do not authenticate discovery or authorize D11/Census closure.
Both reports are included in the artifact manifest. Original producer artifact
names, identities and bytes are never renamed or replaced.

Run the offline regressions with:

    python3 ci/nqc-census/test_rmc011_historical_source_compatibility.py -v

This change does not certify executable capital, an external native-gas sponsor,
profitability, D11 terminal closure or final Census closure.

## Separate thirteen-family historical transport audit

`rmc011_independent_thirteen_source_pins.py` is another historical auditor. Its
`SOURCE_BLOB` remains `9dee5fe5035fad450ede25462728eba26beffb49`, the thirteen-row
state before global discovery admission. Its `DISCOVERY_PENDING` report must not
be repurposed by changing that pin to the admitted current registry. These two
workflows do not invoke or modify that auditor.

To replay it later, use a separate temporary directory with the exact original
`9dee5fe5035fad450ede25462728eba26beffb49` source-universe bytes, authenticated
original ZIPs and run/artifact metadata required by its existing CLI, and its
unchanged gas/final-lock inputs. Verify the historical blob before replay and
compare all thirteen original family rows against the current registry in a
separate compatibility check. Do not use this nine-family fixture for that
thirteen-family audit, overwrite the current checkout, or treat its frozen
discovery-pending result as a current discovery-admission decision.
