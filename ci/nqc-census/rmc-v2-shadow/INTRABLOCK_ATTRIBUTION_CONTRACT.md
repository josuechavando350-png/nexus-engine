# Historical time and transaction-prefix attribution

PR695 showed HF >= 1 at the end of both selected parent blocks. This experiment
isolates the 12-second time change, then locally replays the canonical 1 / 10
transactions before each competitor winner. It does not add an NQC trade route.

The SHA256-pinned PR695 Actions ZIP binds its exact successful producer, original
indexer and receipt ZIPs, borrower, parent/winner headers, six-word Aave account
ABI, winner index, transaction prefix and original LiquidationCall topics/data.
Fresh two-endpoint canonical header checks occur before and after each fork.

The Foundry test performs three independent local forks:

1. End of parent: match the entire source account ABI; warp/roll only to winner time.
2. Winner transaction hash: Foundry replays the preceding transactions and excludes
   the winner. Read the exact reference account before the winner.
3. Index-zero transaction hash: require its starting account to match time-only,
   replay each preceding transaction and record HF after every one. Require the
   entire final account ABI to match the reference. Replay the original competitor
   winner and require exactly one matching Aave event (emitter, topics and data).

`NQC_FIRST_PREFIX_CROSSING_INDEX` means first prefix position observed with HF<1;
when the time-only account is already below one it is not a causal crossing claim.
No individual internal call or oracle is identified by these account-level metrics.
The winning transaction may contain other trades; neither its transaction gas nor
its other revenue can be attributed to NQC. Forge test gas is not transaction gas.

Run the same experiment against dRPC and Blast; require identical integer metrics
and complete account ABI. URL parity does not certify operator independence.
Failed or missing RPC, fork, event, prefix, parser or provenance gates stay blocked,
and attempts are retained. No latest fallback, edited oracle, artificial token
funding, private key or broadcast is present. VM transaction replay is local only.

Selection uses hindsight. Passing is historical reconstruction and competitor
event parity, NOT prospective detection, NQC atomic route success, profitable
capture, external nonrecourse gas funding, RMC/P2 closeout or LIVE authorization.
NQC realized P&L remains USD0 and Comercial5.9 is unchanged by this gate alone.

Foundry semantics: https://getfoundry.sh/reference/cheatcodes/create-select-fork
and https://getfoundry.sh/cheatcodes/transact ; binary pinned to v1.7.1 and SHA256.
