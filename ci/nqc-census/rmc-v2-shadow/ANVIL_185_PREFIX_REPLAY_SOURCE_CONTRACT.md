# NQC V2 — Isolated exact-head re-test with Foundry/Anvil v1.8.5

## Objective

Preserve PR721's precise failure at [run 38614220541](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38614220541), head af37313bb91ac6d9abc1553fcb99f203cb6aac8f, artifact 11919182033 SHA256 29c885e36d48be63742885f17f95fe142a34b92004f71985b12412f4e425f808. Anvil **v1.7.1** with `--fork-transaction-hash 0x08db...` returned the PREVIOUS BLOCK (26,142,066), borrower HF 1.006076184268984731, while authenticated PR698 tx-prefix pre-winner state after oracle tx0 within 26,142,067 was HF 0.996350145012801388. All six integer ABI words disagree; NO local EOA receipt and NO gasUsed authority.

Anvil upstream changed the transaction-hash replay mechanism in [foundry-rs/foundry PR #15952](https://github.com/foundry-rs/foundry/pull/15952), merged 2026-07-29, after release v1.7.1. The implementation was refactored to prepare and execute the exact historic block prefix in a separate overlay. The current official immutable **v1.8.5** release (published 2026-10-05) is a distinct experiment, not an automatic carry-over of the earlier certified v1.7.1 bytes.

## Experiment and supply-chain gate

- Fetch official Foundry v1.8.5 release metadata from GitHub's public API; require exact tag, non-draft and non-prerelease, select only `foundry_v1.8.5_linux_amd64.tar.gz`, and require its official SHA256 asset digest.
- Download that exact official immutable release archive and its official `.sha256` companion file. Fail closed unless **both independently reported checksum values** and downloaded SHA256 agree. Preserve release metadata, version, digest and downloaded checksum with the new CI evidence. This is an official-tag source verification; no novel local binaries uploaded.
- All Ethereum source/claim authentication and source Solidity is byte-identical to original PR721 and PR698. Keep chainId=1, exact winning tx, exact borrower/debt/flash/swap, exact 6-word `getUserAccountData` prestate and real route profit-floor rollback requirements. No Anvil state changes, oracle price override, fixture relaxation, substitute borrower, or workarounds to mask drift.
- Compare the local Anvil latest height/hash and six uint256 ABI values BEFORE any ephemeral signer generation, synthetic Anvil gas balance, or locally broadcast transaction. If the source prewinner snapshot differs, stop with the full six-word drift ledger and NEVER produce a fake gasUsed.
- Only if exact identity holds, run the existing four isolated-local transactions (three setup; one EOA funded liquidation and collateral monetization) and require a successful Anvil `eth_getTransactionReceipt` from exactly `127.0.0.1:18545`. Verify full EOA `gasUsed` strictly exceeds the previously measured 1,115,038 internal gasleft units; distinguish contract deployment setup gas, local gas paid by synthetic local EOA, mainnet fees, builder bids and failed attempts.
- Any full local result is a **historical counterfactual on a fork** with a hindsight-selected original competitor winner. It does not establish public mempool visibility, Chainlink SVR access, builder ordering, competitive capture, external gas sponsor, net EV or real revenues.

## No change to economic authorization

PFT CLOSED; RMC OPEN; P2 not certified; LIVE not authorized; OWN_CAPITAL USD0 including gas not sponsored; user MXN2,000 reserve untouched; NQC P&L realized USD0 and Commercial 5.9 unchanged. No merge, production deployment, external Ethereum transaction, signing with user keys or paid RPC service. This experiment uses only an ephemeral GitHub Actions runner and locally isolated synthetic EOA.

**Expected outcome:** definitive evidence whether the Foundry/Anvil version is the blocker. If after the upgrade exact transaction-prefix state is still mismatched, preserve the negative; do not continue attempts merely to get a green CI.
