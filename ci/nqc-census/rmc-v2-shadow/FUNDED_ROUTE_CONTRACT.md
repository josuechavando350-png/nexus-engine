# Historical funded route: limited evidence contract

This adds an isolated local fork harness, not a production deployment. It tests
the existing T36 flash coordinator (blob `aa3883fa141aa096006e90e56d8d4150c9ee14ef`)
without modifications. No signing, broadcast, keys, inventory injection, oracle
mutation, new server or paid RPC plan is included.

## Selection and provenance

The two borrowers and amounts were selected retrospectively from competitor
receipts. Selection has look-ahead bias and is not evidence of prospective
discovery, market coverage, win rate or recurring revenue.

Authenticate PR695 artifact 11861179989 and PR696 artifact 11864125025 by their
exact ZIP digests, producer heads and conclusions. PR696's full producer failed
because Blast was rate limited. Use only its successfully parsed, authenticated
dRPC pre-winner ABI as a reference. This does not convert the failed producer to
green or inherit a two-provider certificate. The new gate reconstructs and tests
both cases on both endpoints, with separate storage caches disabled.

`createSelectFork(rpc, winnerTxHash)` replays the preceding block transactions
and excludes the original winner. Validate chain, block, timestamp, parent hash
and all six Aave account fields. Check canonical block headers and transaction
ordering before and after each run. No winner-end-state substitution.

## Route, fixed before measurement

1. Real Aave V3 `flashLoanSimple`, debt asset USDC or USDT, competitor debt size.
2. `liquidationCall`, WETH collateral, same borrower, receive underlying WETH.
3. Real Uniswap v3 SwapRouter `exactInputSingle`, WETH to debt, fee tier 500.
4. Repay principal and the actual historical 5-bps flash fee, sweep surplus.

The router is `0xE592427A0AEce92De3Edee1F18E0157C05861564`; verify factory and
WETH9, resolve the fixed pool from the factory and record code hashes. No route
search or alternate pool selection after seeing results. The swap minimum is
principal + flash fee + one smallest debt unit. Inventory starts and ends at
zero in the strategy and coordinator. USDT optional ERC20 return semantics are
handled explicitly. All raw values use token base units (USDC/USDT 6, WETH 18).

Require exact historical debt and collateral amounts. Require actual token
balance changes to match swap output and the identity:

`swap_output = principal + flash_fee + swept_surplus`.

An impossible profit floor must revert with the coordinator's specific economic
error, restore account ABI, swap pool slot0 and token balances, and leave the
execution identity unconsumed. An unrelated revert is a failure, not a pass.

## What the results do and do not mean

Surplus includes the actual DEX fee and price impact of this specific historical
swap and the flash fee. It excludes native transaction gas, deployment,
calldata/intrinsic gas, builder/relay payments, sponsorship terms, failed bids and
operating costs. `gasleft` delta is a gross cross-contract measurement after
setup; warmed state and refunds mean it is NOT receipt gasUsed, a cold standalone
transaction estimate, or a net-profit certificate. Do not subtract it from
surplus as if it were a complete transaction cost.

Counterfactual insertion at the winner's position assumes inclusion. No evidence
shows that NQC could have observed the trigger, submitted in time or displaced
the winner. Two endpoint URLs do not establish independent backend operators.

Zero injected ERC20 inventory is not proof of production OWN_CAPITAL=0. An
external nonrecourse payer for native gas remains necessary and unproven.
RMC remains open, P2 Shadow uncertified, LIVE unauthorized, commercial score
unchanged and realized NQC P&L USD 0. Even a successful historical gate must not
change those fields. Any provider, provenance, economic or parity failure keeps
the new gate incomplete, preserving diagnostics rather than falling back to a
single provider or latest state.

## Primary interface references

- https://getfoundry.sh/reference/cheatcodes/create-select-fork
- https://www.aave.com/docs/aave-v3/guides/flash-loans
- https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
- https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/ISwapRouter.sol

These explain interfaces; the pinned historical fork supplies measured state.
