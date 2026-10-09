# Current operator-funded gas evaluation and D16 source recovery

The operator declared USD 2,000 for gas on 2026-10-09. The current research
scenario is `operator-gas-scenario.json`: own gas capital, externally financed
atomic principal, no allocation of the gas budget to collateral or principal.
This supersedes the all-costs-zero-own-capital premise for **this evaluation**.
It does not rewrite historical source certificates or turn a budget declaration
into an authenticated native-token balance, permission to spend, or a successful
D11 capital certificate. Operator-paid failed transaction gas is a real cost.

## Recovered source

The original server file
`/root/workspace/RMC015_REPLAY_30D/rmc016-observed-transaction-economics.jsonl`
was located on 2026-10-09. The exact recovered 104,736 bytes are preserved in
`recovered-rmc016/rmc016-observed-transaction-economics.jsonl`.
SHA-256: `55d5d6be9e09f2e499e1ca8949c4305d05824dffa61e363f4371c615537dcb1c`.

That digest was already committed by the original D16 economic source (Git blob
`5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa`). The verifier authenticates the
unchanged original D15B/D16 artifact ZIPs and aggregate source before accepting
the raw rows. Discovery on the server is not used as independent authority.
The copied ledger has public transaction identifiers, not borrower-address rows.

The original schema records gross oracle edge, receipt gas and **omitted costs**.
It is deliberately not coerced into the later complete-cost ledger schema.
The existing complete-cost validator and original historical audit remain intact.
The new report is the current recovery result; the old aggregate-only report
continues to describe its restricted inputs.

## What the verifier establishes

- Exact source bytes; 127 unique transactions and 139 associated events.
- Transaction ordering, pinned block window, integer USD WAD arithmetic.
- Gas counted once per transaction, including multi-event transactions.
- Every gas charge equals gas used times effective gas price times historical
  ETH oracle price, with the original integer rounding.
- Principal, gross and gas sums reproduce the pinned D16 aggregates.
- 83 transactions have positive gross-minus-receipt-gas residual; 44 do not.
  Neither count is an NQC-executable or full-net-positive count.
- The USD 2,000 gas budget is evaluated at 1x/2x/4x observed winner costs and
  0/1/3 equal-cost failed attempts per winner. Those are explicit sensitivities,
  not measured NQC failure rates or gas prices.

The historical winner sample consumed USD 1,144.134260592713842029 of receipt
gas. Doubling that cost exceeds USD 2,000. This does not establish whether the
operator could capture those trades, whether an ETH balance would suffice at
each transaction, or whether gas-limit/max-fee upfront reservations would fit.

## Still open

Independent oracle/prestate evidence; complete
protocol/flash/route/builder/failure costs; causal NQC detection and capture;
native gas balance and transaction-specific upfront reservation; terminal
D11/D12/D13 authorities; structural D14 and final D15/D16/D17 admission. The
canonical closeout lock remains unchanged and Census is **not closed**.

## Reproduce

Use exact original artifacts 11504276505 and 11505504820 (the existing winner
audit workflow independently checks their run/head/tree, expiry and ZIP hashes):

```sh
python3 ci/nqc-census/test_rmc016_recovered_winner_ledger.py
python3 ci/nqc-census/rmc016_recovered_winner_ledger.py \
  --d15-archive /path/to/11504276505.zip \
  --d16-archive /path/to/11505504820.zip \
  --economic-source ci/nqc-census/rmc016-production-evidence.json \
  --original-ledger ci/nqc-census/recovered-rmc016/rmc016-observed-transaction-economics.jsonl \
  --scenario ci/nqc-census/operator-gas-scenario.json \
  --out /new/path/report.json
```

The workflow runs both audits twice and requires byte-identical output. It
publishes aggregate reports and hashes, not the raw transaction ledger.

## Independent receipt acquisition, 2026-10-09

Tenderly returned all 127 receipts plus chain identity and before/after pinned
headers during 21:25:20–21:26:10 UTC. Raw responses are preserved verbatim in
`recovered-rmc016/tenderly-receipts-20261009.jsonl.gz`, with acquisition timestamps
and raw/compressed hashes in `tenderly-acquisition.json`. The original acquisition
report correctly blocked on a provider dialect difference; no responses changed.

A narrow adapter handles `blobGasUsed=0x0` with absent `blobGasPrice` **only** for
explicit transaction type 0 or 2. The corpus contains 9 legacy and 118 type-2
transactions. Unknown types, blob transactions and nonzero blob gas still fail.
The EIP-4844 blob transaction type is 0x03:
https://eips.ethereum.org/EIPS/eip-4844#parameters.

Independent replay matches all 127 original dRPC normalized receipts, including
139 source-event logs, canonical block identities, transaction ordering and
448369976498898050 wei of whole-transaction gas. The dRPC source **workflow**
remains failed; only its independently SHA-authenticated complete dRPC checkpoint
is reused. This is receipt parity, not a new full-cost or Census certificate.

The workflow downloads and authenticates the exact original event and dRPC
archives, runs 13 adversarial cases against real recorded bytes, and requires
two byte-identical offline replays. No live RPC is required for replay CI.

Two repository validation jobs failed before checkout because Docker Hub rate
limited `node:24` downloads. They now use the repository's already-pinned
`actions/setup-node` action for Node 24 on the same Ubuntu runner, with explicit
pnpm 10.15.0 and all original validation commands retained.

## Full 7,200-block executed-event incidence

The new full-range producer obtained 144 contiguous 50-block log responses from
Nodies and 15 contiguous 480-block log responses from Tenderly for blocks
26095352 through 26102551 inclusive. Each operator passed an independent
positive historical control and matching before/after anchor header checks.
The full event sets match: **2 executed liquidations**, at blocks 26095959 and
26098187. These are outside the first previously certified 480-block segment.

Raw transcripts and their acquisition manifest are preserved alongside the
receipt evidence. Fourteen adversarial tests and duplicate offline replays
check no range gaps, real-event omission, pseudo-independent providers, reorgs,
positive controls and failure-to-zero misclassification. This is new whole-pool
incidence evidence; it does not retroactively mark the 14 failed shard artifacts
successful, reconstruct the cohort's full temporal state, detect unexecuted opportunities,
or certify terminal D15. The original final Census lock remains blocked.

The exact original 857-member watchlist was rebuilt privately from authenticated
D08/D09 archives with the pre-existing selector Git blob
`5542bbec0840335994cbbab272e6228756ba6eb0`. Its byte commitment remains
`e3c827033bec5fabd62701579a2b0e7d3f5cc5f5151659ee7e18a7d50fa7fdfb`.
**Neither of the two executed events belongs to that cohort.** CI repeats the
original selection before checking membership, rejects any changed watchlist,
and publishes only aggregate results and public event identifiers. It never
uses the future winners to reselect borrowers. This establishes executed-event
membership over the full window, not absence of transient/unexecuted eligible
positions, complete historical state reconstruction, or NQC capture.
