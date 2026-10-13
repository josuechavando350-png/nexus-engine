# RMC V2 — Content-addressed targeted Aave census checkpoints

## Authority

These commands are **read-only historical research only**. The parent targeted census is confined to Ethereum mainnet Aave V3 Pool `0x87870bca3f3fD6335C3f4Ce8392D69350B4fA4E2` and Aave `LiquidationCall` events where either **sUSDe** or **USDtb** is indexed as collateral or debt.

- Previous certified RMC016 window ends at **26,095,351**.
- New investigated inclusive window is **26,095,352–26,184,741**, precisely **89,390 blocks**.
- A segment is **not** the full corpus. No segment or merged file proves independent RPC operator quorum, P2, ex-ante capture, positive Nexus P&L, full Aave market coverage or commercial closure.
- Hashes authenticate recorded file bytes, **not provider honesty**.

## Bounded, restartable source acquisition

An authenticated historical archive RPC supporting `eth_getLogs`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`, and `eth_chainId` is necessary. The reader enforces a minimum **22-second pause between public RPC calls**; HTTP 401/403/429 and unrelated provider errors terminate acquisition. Requests are split only for **explicitly documented maximum block-range errors**, never to evade provider authorization.

Run sequentially on an authorized networked host. A 5,000-block segment can be queried using two 2,500-block shards per indexed-asset stream. Keep each output immutable and never substitute fixture/test data:

```bash
python3 ci/nqc-census/rmc-v2-shadow/targeted_aave_shard_checkpoint.py \
  --provider drpc \
  --scan-segment 26095352 26100351 \
  --span 2500 \
  --out evidence/segment-26095352-26100351.json

# Wait at least 22 seconds before the next run uses the same public endpoint.
python3 ci/nqc-census/rmc-v2-shadow/targeted_aave_shard_checkpoint.py \
  --provider drpc \
  --scan-segment 26100352 26105351 \
  --span 2500 \
  --out evidence/segment-26100352-26105351.json

python3 ci/nqc-census/rmc-v2-shadow/targeted_aave_shard_checkpoint.py \
  --merge-checkpoints \
    evidence/segment-26095352-26100351.json \
    evidence/segment-26100352-26105351.json \
  --out evidence/partial-manifest.json
```

The merge above **must remain PARTIAL**, since it covers only 10,000 of 89,390 blocks. The missing intervals are neither zero-event witnesses nor permitted extrapolation. Run through the remaining blocks in contiguous order; a genuine complete single-provider merge can be marked `COMPLETE_SINGLE_RPC_TARGETED_89390_BLOCKS_NOT_QUORUM` **only when every height is accounted for**.

### Required gates before trusting any segment

The scanner independently checks chain ID, original RMC016 boundary, target-end canonical hash and parent, indexed event ABI, deduplicated transaction/log identities, exact receipt log equality and gas denominations. The checkpoint layer additionally records the **first and final block headers** before and after reading, enforces event boundary/header agreement, validates every declared content hash, and requires a consecutive `parentHash` chain between adjacent checkpoints.

Any mismatched range, duplicate identity, missing positive-event receipt, changed header, counterfeit report digest, mixing of RPC providers into one source, or alleged Nexus revenue **must fail closed**.

### Reproduction

```bash
python3 -m unittest discover \
  -s ci/nqc-census/rmc-v2-shadow \
  -p 'test_targeted_aave_shard_checkpoint.py' -v
```

The companion GitHub workflow runs **synthetic tests only**; its success must never be represented as having run the historical scanner. GitHub branch work remains a draft PR until terminal source, build and merge review.

## Strategy consequences

Even complete coverage of sUSDe/USDtb cannot prove executable lending/DEX routes or profitable captures. Historically observed WETH/WETH Aave liquidity and a previous time-only positive liquidation fork are alternative **retrospective** research candidates, not prospective alerts or market-ready bots. The user-owned wallet is not required for the read-only census.

**Terminal requirements unchanged:** OWN_CAPITAL=0 USD must include funded gas and zero recourse; HF<1 must be observed without tampering; a full atomic transaction must repay all obligations and survive costs/MEV competition; Shadow P2 must capture candidates prospectively; RMC/D11–D17 remain unclosed; realized NQC P&L USD 0.
