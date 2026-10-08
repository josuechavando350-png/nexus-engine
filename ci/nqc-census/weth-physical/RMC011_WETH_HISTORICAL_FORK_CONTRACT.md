# RMC-011: WETH9 physical compatibility at the authoritative A1 census anchor

**Scope: historical read-only fork witness, not a real execution eligibility certificate.**

This narrowly scoped test answers whether canonical Ethereum WETH9 has the basic transfer and asset conservation semantics required by a future Aave liquidator at the **RMC-008 / RMC-012 historical state anchor**:

- Ethereum mainnet chain ID 1; block **26,095,351**, hash `0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781`.
- Canonical WETH9 address `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`.
- D08 original authenticated closeout: workflow 36964016388, archive 11237887761, ZIP SHA-256 `9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913`.
- D08 token admission at that anchor remains entirely `BLOCKED`; see [RMC-012 root-cause PR #630](https://github.com/josuechavando350-png/nexus-engine/pull/630) and its report `11532075440`. That PR identified fee-on-transfer, rebasing, transfer hooks, code/proxy identity and other missing proofs without modifying D08.

## Physical test method

1. A read-only Python script queries **dRPC and BlastAPI**, two independently operated public JSON-RPC providers, for Ethereum chain ID, exact original block header/state root, and full WETH runtime bytecode at block 26,095,351. It refuses different block hashes, state roots, code SHA-256 or missing contract. This is exactly one historical code observation per provider, **not** a global absence-of-upgrades proof.
2. A pinned Foundry 1.7.1 / Solidity 0.8.24 local Ethereum **fork** at the same state/block executes nine physical behavior checks against the deployed WETH9 contract: fixed metadata and decimals; exact deposit mint/supply; exact ordinary transfer without fee-on-transfer; approval and `transferFrom` deltas; rejected excess-allowance spend with unchanged state; non-ERC777 hook invocation to a recipient that reverts on callbacks; exact WETH withdraw/burn/ETH return; zero-token transfer/supply invariance; and unfunded transfer rejection.
3. **Critical fixture limitation:** the test harness uses Foundry `vm.deal` to mint fake native ETH for the *test-only deposit/withdraw path*. It does not count as externally financed gas or capital, does not satisfy `OWN_CAPITAL=0`, and never touches a wallet or broadcasts a transaction. Tests are not price observations or liquidation cost measurements.
4. Original test source SHA-256, formatted/tested source SHA-256, runtime code digest, provider header witnesses and fork log are retained with SHA-256 checksums. The source identity is pinned to the exact GitHub branch commit through Actions checkout.

## Explicit nonclaims and terminal boundary

A pass may justify requesting a **separate, independently reviewed token-specific compatibility admission** only after additional coverage of actual flash-loan callback semantics, reserve constraints, code provenance, proxy/upgrade history, relevant decimals/rounding, gas and collateral-sale behavior, inter-provider replay, real decision-time state, full atomic liquidation and financing. **This PR never writes a token eligibility field or removes D08 blockers.**

Passing these tests does **not** establish Aave flash principal availability to NQC, the ability to originate a liquidation, gas sponsorship by a separate approved third party, successful searcher inclusion, production capture, complete route/slippage/gas/MEV costs or realized profit. RMC-011 terminal, RMC-014, RMC-015, RMC-016, RMC-017 and the USD 300k/month target remain unchanged.

GitHub Actions only. No user funds, private keys, signed transactions, wallet creation, remote server provisioning or production execution.
