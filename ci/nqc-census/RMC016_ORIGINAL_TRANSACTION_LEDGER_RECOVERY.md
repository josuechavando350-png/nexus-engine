# RMC-016 — Original 127-transaction economics ledger SHA recovery

**Source lock:** original D16 Git blob 5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa, at ci/nqc-census/rmc016-production-evidence.json. This authority commits to transaction_economics_sha256=55d5d6be9e09f2e499e1ca8949c4305d05824dffa61e363f4371c615537dcb1c for 127 historical *third-party* winner transactions and 139 liquidation events. A hash commitment alone is not a published original ledger.

## Genuine source gap

Existing rmc016_winner_net_audit.py verified that the original D15B artifact 11504276505 and D16 artifact 11505504820 did not publish transaction-economics.jsonl. Full historical cost/routing cannot be established from the aggregate source, much less net NQC capture.

The original source snapshot is registered as DigitalOcean image 248761092, but this experiment DOES NOT restore, boot, change, create, or read any droplet or image. It searches **only existing GitHub Actions archives** and opens no account, RPC service, wallet or trade.

## Strictly bounded experiment

1. Enumerate existing repository Actions artifact metadata via the authorized GitHub Actions token. Keep exact original run/head, artifact ID and SHA256 digest.
2. Ignore unrelated names, expired/missing digest/zero-sized/over 3 MB ZIPs; select at most 48 candidates, prioritize economics/ledger/winner terms plus original D15/D16 artifacts. Explicitly report excluded and unselected counts.
3. Recheck the candidate run's completed SUCCESS, exact head, artifact metadata and original ZIP SHA256 before inspecting any bytes. Any missing/run-failed candidate remains unscanned, not treated as empty.
4. Scan in-memory ZIP members with bounded count/size and path/symlink/duplicate checks. A positive match requires original file bytes whose SHA256 is *exactly* the D16 precommitted transaction_economics_sha256. Filenames, invented totals or an approximated 127-row sample are insufficient.
5. Upload only source artifact IDs, hashes, selected scope, counts, and outcome. No raw original accounts/trades/ZIPs and no credentials.

Both positive and negative results remain only search evidence. A source found by SHA still needs the independent adapter and historical cost replay; a source not found in this bounded sample is **NOT globally absent**. In both branches, NQC REALIZED P&L is USD 0, no native gas sponsor is admitted, and Census stays open.

## Run

    python3 ci/nqc-census/test_rmc016_source_artifact_recovery.py

The workflow NQC RMC-016 Original Ledger SHA Recovery (GitHub Archives ONLY) runs this test first, enumerates GH artifact metadata, performs bounded source checks and publishes the append-only aggregate evidence. It performs no Ethereum RPC, wallet or market operation.

If no original source is found, request explicitly authorized read-only access to the original existing snapshot/filesystem or another independently authenticated original source. Do not generate new recovery instances or substitute fabricated economic rows.

The experiment modifies no RMC-011/012/013/014/015/016/017 terminal authority source locks, no main, no provider registry, and no verified profit.
