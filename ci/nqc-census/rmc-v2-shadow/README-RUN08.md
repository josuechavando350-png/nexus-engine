# NQC RMC V2 RUN08 — Exact ABI multi-operator intake (read-only)

This package is a **local implementation and mock-tested candidate**, not a production GitHub commit, not a D11–D17 certificate and not a P2 or Shadow certification.

## Offline tests (no network, no keys)

```bash
python3 ci/nqc-census/rmc-v2-shadow/test_quorum_block_intake.py -v
```

## Real use on an authorized, networked host (not performed by this package)

Populate two genuinely separate operator URLs in an untracked copy of `providers.template.json`; do not commit the filled configuration or API tokens. Both RPC operators must support `eth_call` with EIP-1898 `blockHash` plus `requireCanonical=true`, and historical archive state for the targeted heights.

```bash
python3 ci/nqc-census/rmc-v2-shadow/quorum_block_intake.py \
  --seed-ledger ci/nqc-census/rmc-v2-shadow/fixtures/RUN07-immutable-seven-snapshot-ledger.jsonl \
  --config /secure/location/providers.json \
  --max-blocks 16 \
  --confirmation-depth 2 \
  --out-dir /secure/location/run08-out
```

For each later batch use the last `quorum-backfill-ledger.jsonl` as `--seed-ledger` and supply its **externally retained, validated** digest from the prior run with `--expected-seed-sha256`. A passed audit requires the manifest digest and raw-evidence digest to match the files, source/operator provenance review and no unresolved RPC divergences.

The tool does not use a wallet, sign, simulate execution, send transactions or claim prospective capture. It backfills block by block, checks declared independent operator IDs, exact bytes32 ABI values, canonical block-hash-pinned calls, ancestry, and refuses to continue on reorg or provider disagreement. **Reorg rollback/replay is not implemented**: the safe behavior is to stop and require a separate authorized reconciling operation; never edit or erase prior evidence silently.

The sample fixture inside `RESULTS/TEST_ONLY_SYNTHETIC_DO_NOT_IMPORT_TO_CENSUS/` is deliberately SYNTHETIC and MUST NOT be counted as Ethereum observation or real coverage. `RESULTS/run08-unrounded-precision-gate.json` is a manually transcribed, single-provider Blockscout observation that was **excluded from the integer-exact ledger because the MCP contract reader returns rounded JSON numbers**.

The connected Blockscout reader reports an upcoming PRO key requirement; this tool does not provision or use credentials and was not tested against live independently managed RPC operators.
