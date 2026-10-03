# RMC-001 Canonical Market Identity Contract

Status: implementation contract for Real Market Census CENSUS-1 identity only.

Certified base: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`, tree
`ef3498da528f85cdb9fdd82222d64773a557f853`. Protocol/Fork Truth remains
`PROTOCOL_FORK_TRUTH_CLOSED`. This contract does not reopen or extend that
certification.

## Purpose and hard boundary

RMC-001 defines stable identifiers before discovery, state reconstruction, capital,
routing, competition, or economics are allowed to count anything. The identity core
has no RPC provider, signer, secret, mempool, price, balance, P&L, or execution I/O.
It proves serialization and semantic separation only; it does not prove that any
market exists on-chain.

The unit hierarchy is explicit:

- a base market has exactly one `MarketId`;
- state/configuration at a block has a `MarketStateId`, never a new `MarketId`;
- a market may expose zero or many action surfaces, each with an
  `ActionSurfaceId`;
- aliases bind an external locator to an existing `MarketId` only with evidence;
- migrations link two distinct market identities and never collapse them.

## Chain and deployment identity

`ChainDomain` is `chain_id + genesis_hash + fork_lineage`. The fork-lineage
anchor is a stable, adapter-proven lineage identifier. An ordinary canonical reorg
does not change it. Two chains that reuse chain ID and genesis but belong to
different declared lineages must not collide.

`DeploymentKey` adds protocol family, stable deployment address, and a
`deployment_instance` evidence digest. A proxy upgrade does not create a new
deployment instance. Destruction/redeployment or a distinct deployment must use a
different instance binding even when an address is reused.

Implementation code hash, configuration hash, oracle configuration, and compatible
semantic version belong to `DeploymentSemanticsVersion`; they affect
`MarketStateId`, not persistent market identity.

## Initial market units

The first tagged market union is intentionally narrow:

- `AavePool`: one Aave V2/V3/V4 pool deployment;
- `AaveReserve`: one reserve-asset contract inside one Aave deployment;
- `V2Pair`: one Uniswap-V2-semantics pair bound to its factory deployment,
  pair address, and canonical token0/token1 ordering.

Ticker, symbol, display name, registry index, source order, and dashboard labels are
not identity. Wrapped and underlying assets remain different contract identities.
A reserve rename therefore preserves identity, while replacing the reserve asset
contract does not.

For V2, token0 must be strictly lower than token1 by address bytes. The pair
address must differ from the factory and from both of its tokens. A token may be
the factory address (Amendment 1). This core checks consistency of provided
identity data; a later adapter must prove those values from chain state.

## Action surfaces

`ActionSurfaceKey` is separate from the base-market counter. It binds:

`MarketId + collateral_asset + debt_asset + StrategySemanticsKey`.

Reversing collateral/debt is a different surface. Strategy semantics is versioned
and content-addressed. Action surfaces must never inflate counts of base markets.

## Canonical bytes and IDs

Canonical objects use:

`MAGIC("NQC-CENSUS-ID") || schema_version:u16-be || object_tag:u8 || TLV fields`.

Each field is `tag:u8 || length:u32-be || value`. Field tags are strictly
increasing and unknown/missing/duplicated/reordered fields are rejected by the
decoder. Integers are unsigned big-endian. Addresses are exactly 20 bytes; hashes
are exactly 32 bytes. Text casing and source ordering cannot affect canonical bytes.

IDs use SHA-256 with explicit domain separation and a zero delimiter:

- `SHA256("NQC-CENSUS-MARKET-ID-V1" || 0x00 || canonical_market_bytes)`;
- `SHA256("NQC-CENSUS-MARKET-STATE-ID-V1" || 0x00 || canonical_state_bytes)`;
- `SHA256("NQC-CENSUS-ACTION-SURFACE-ID-V1" || 0x00 || canonical_action_bytes)`.

An evidence artifact SHA-256 is a different namespace and must never be substituted
for a semantic identity.

## Alias, migration, and dedup rules

An `AliasEvidence` requires a non-zero source namespace, source locator digest,
target MarketId, and evidence digest. The same source locator may repeat only when
it resolves to the same target. Conflicting targets fail closed.

A `MigrationEvidence` requires distinct source and destination MarketIds. Migration
does not mutate or replace the old identity. Historical balances remain attributable
to their original market and later conflict analysis may link the two.

Deduplication is by canonical ID plus canonical bytes. Equal bytes may repeat across
discovery sources. The impossible-but-safety-critical case of one ID mapping to
different canonical bytes is a hard hash-collision error. An action surface that
references a market absent from the supplied base-market inventory is rejected.

## Required invariants

RMC-001 must prove:

1. independently computed golden bytes and IDs match Rust exactly;
2. case-only hexadecimal representation aliases normalize identically;
3. chain, deployment instance, protocol family, and fork-lineage separation;
4. ordinary reorg keeps MarketId while observation changes MarketStateId;
5. proxy/config/oracle changes keep MarketId and change MarketStateId;
6. migration to another deployment remains a distinct MarketId;
7. reserve rename/source duplication cannot duplicate a market;
8. wrapped versus underlying contracts remain distinct;
9. collateral/debt orientation changes the action-surface ID;
10. zero/invalid/overflow/unknown/ambiguous/contradictory inputs fail closed;
11. counts distinguish pool, reserve, pair, and action-surface denominators;
12. input ordering does not change the result;
13. no network, secrets, signer, price, or economic I/O exists in this crate.

The JSON vectors under `ci/nqc-census/identity-vectors.json` are synthetic
serialization vectors only. They are explicitly forbidden as market, liquidity,
profitability, or production evidence.

## Deliberately not solved

RMC-001 does not establish deployment discovery completeness, archive/RPC authority,
bytecode admission, borrower enumeration, current state, capital or gas funding,
routes, simulation, gas/net EV, MEV, conflict graphs, temporal distributions,
Shadow, Canary, live P&L, or Census certification. Those remain downstream gaps.

A later consumer of certified Protocol/Fork code must resolve the effective-source
overlay problem separately; this PR does not copy or alter recovered protocol source.

## Amendment 1: a V2 token may be the factory (RMC-001-A1)

**Original premise.** For `V2Pair`, the pair, token and factory addresses were
all required to be distinct. That included `token0 != factory` and
`token1 != factory`.

**Falsifying evidence.** The RMC-007 reconciliation of the complete Ethereum
mainnet Uniswap V2 factory (`allPairsLength` = 514,624 at the census anchor;
acquisition run 36589054151, offline replay run 36634878867 on
7702a8c98579f336994ebc4877cc00cb4e97620c) stopped with
`contradictory V2 pair identity`. Run 36653692047
(`nqc-census-rmc001-amendment-evidence.yml`, head
0522f71ecc47ccd73afa6a0fc67ff9c79cf5e376) then:

1. Located every factory-token pair in the 48 verified stage extracts. Two
   providers per surface; the allPairs enumeration and the PairCreated logs
   named exactly the same two pairs.
2. Asked blastapi-public, mevblocker-rpc and nodies-public, all pinned by
   EIP-1898 `{blockHash, requireCanonical: true}`.

The anchor was chain 1, block 25437474, hash
`0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8`, below the
finalized height 26086841 of every provider. All three providers agree on
every value:

| field | pair A | pair B |
|---|---|---|
| pair | `0x14c336ebeb7a78668b5cd8b592d1124456c853ce` | `0x3b66602f04c64a3201eec700a47be72ee86b8446` |
| token0 | `0x5a1912749d2b7c3cdb832b81601c8c3f437a0de8` | `0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f` (factory) |
| token1 | `0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f` (factory) | `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` |
| allPairs index | 61996 | 336738 |
| creation | block 14108735, tx `0x1ffef3af…0cfc5`, log 123 | block 20176626, tx `0x00c30ffc…b2c2`, log 136 |

For both pairs, at the anchor:

- `pair.factory()` is the factory;
- `pair.token0()` and `pair.token1()` are the tokens above;
- `factory.getPair(token0, token1)`, `factory.getPair(token1, token0)` and
  `factory.allPairs(index)` return the pair;
- the PairCreated log is in its block;
- `CREATE2(factory, keccak256(token0 ‖ token1), init code hash 0x96e8ac42…845f)`
  recomputes the pair address independently;
- the pair has code, with keccak `0x5b83bdbc…9ce5`, the same for both pairs.

The factory, used as a token, reverts `decimals()`, `symbol()`,
`totalSupply()` and `balanceOf(pair)`. Both pairs hold zero reserves.

The evidence is kept byte for byte. `ci/nqc-census/rmc001-amendment-1/` holds:

- the deterministic evidence tarball: tar SHA-256
  `8541fc8b2f1d9428cccf5c0912e2cb26517e25112f229deb8586a33ebb40ca23`, gzip
  SHA-256 `6ae6e1677b3396be198e7b63d9da9cb789718d9f61d69423b5e6f36a71033b87`.
  It contains the 108 exact request/response exchanges and `SHA256SUMS`;
- its `summary.json`, SHA-256
  `87c6f45113ed74e90c818eb2ea9882bd99f6ef68c0e486e8acd336ca4c0f3a96`.

Artifact `nqc-rmc001-a1-evidence-0522f71e…-36653692047-1` keeps the same
evidence. `nqc-census-identity.yml` re-verifies the tarball offline on every run.

**Triggering case.** A Uniswap V2 factory accepts any two distinct non-zero
addresses, so anyone can pair a token with the factory address. Pairs A and B
are such pairs. Refusing them made the census incomplete; it did not make it
safer.

**Exact contract change.** `CanonicalMarketKey::v2_pair` no longer refuses a
pair because `token0 == factory` or `token1 == factory`. Nothing else changes.

**Invariants that remain.** `token0 < token1` (so `token0 != token1`);
`pair != token0`; `pair != token1`; `pair != factory`; a V2 pair requires a
Uniswap V2 deployment; zero addresses and hashes are refused. Every invariant in
"Required invariants" above also holds.

**Impact on existing IDs.** None. Canonical bytes and ids are computed exactly
as before; only the admission predicate widened. `tests/identity_amendment_1.rs`
proves this exhaustively over a corpus of 10,704 pool, reserve and pair
identities, covering every protocol family, two chain lineages and a
six-address alphabet. With the newly admitted class written as the original
rule answered it, the amended code reproduces the original corpus digest
`79be63c8d9f0d0036abbd53743b26e3e0cbb7593a52a14b89caff1cc80c8feed`. CI
recomputes that digest by compiling the same corpus against the original
authority cea25577. So every identity admitted before keeps its bytes and id,
every refusal keeps its reason, and the only change is the admission of the
factory-as-token class. `identity-vectors.json` is unchanged.

**Impact on discovery and canonicalization.** RMC-007 can now admit all
514,624 mainnet Uniswap V2 pairs; it previously stopped at the first
factory-token pair. Admission is still decided by chain evidence (enumeration,
creation log, runtime calls, getPair). No pair is excluded and no expected
count changes.

**Why this does not silently widen economic semantics.** Identity says only
that a market exists and names it uniquely. It says nothing about
executability. Pairs A and B remain subject to every downstream admission.
Their factory token implements no ERC-20 interface, and they hold zero
reserves, so state, oracle and token admission (RMC-008) and every later
economic layer must classify them explicitly, for example
`UNSUPPORTED_TOKEN_BEHAVIOR` or not executable. They must never be dropped.
The identity layer must not hide a real market, and it does not make one
executable.

**Freeze.** `ci/nqc-census/rmc001-freeze-manifest.json` pins every RMC-001
file by SHA-256, together with the authority commit and tree, the evidence and
the certification record. Every workflow that depends on RMC-001 verifies the
manifest. Any further change to these files needs another amendment.
