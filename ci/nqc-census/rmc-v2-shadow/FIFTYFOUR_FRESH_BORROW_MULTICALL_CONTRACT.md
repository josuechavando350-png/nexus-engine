# NQC V2 — 54 previously debt-active Aave Borrow beneficiaries in ONE mainnet Multicall3 read

## Purpose

PR729 measured nine direct account queries in 3.56–4.53 seconds; threading was marginally slower with a legally paced per-provider RPC interval. PR730 then authenticated canonical Ethereum Multicall3 at block 26,193,554, full runtime code SHA256 **2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e**, and made exactly nine Aave getUserAccountData subcalls in one eth_call. That new PR730 real sample showed 0.399687732 s average (two readings) versus 4.528000195 s for nine direct reads, **11.3288× faster in this exact small A/B B/A measurement**, not guaranteed performance. The source (PR730 run 38643697015, artifact 11930913376 ZIP SHA256 a8e923e56b3c0b6e51d4dad456c3316767aced72bda316351a08ef7b448eca09) retains 21/21 manifest SHA256 checks.

Now test if this *same protocol-level method* enables one read of an economically more interesting, larger historically source-authenticated set of **54 debt-positive Aave Borrow beneficiaries**.

## Original independently authenticated source

PR715, exact code commit **c236e6305fea16086c037772ffd9fbcbee2d526d**, tree **0999aab56170c4825e5a6ce0ad4531ec24ff06d0**, [successful real Borrow cohort run 38575818030](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38575818030), original artifact **11900775541** ZIP SHA256 **4451facc60edba8e512699a9e637320f62e18a391bba459def0990d2a7d7826e**, **15/15 full SHA256 content manifest members**.

That historical source had 384 canonical Ethereum blocks 26,190,783–26,191,166, 83 indexed Aave V3 Borrow events, 58 distinct onBehalfOf borrowers, 58/58 same-block six-word Aave state checks with dRPC and PublicNode, **54 with debt, 4 with no debt**, zero HF<1, zero <=1.02, six HF in (1.02,1.10], no selected omitted. This is ONLY the single prior Borrow-derived bounded cohort; source history and previous HF must NOT be misrepresented as a new market-wide census or pre-inclusion signal.

The consumer authenticates whole ZIP digest, exact code commit/tree, all 15 source member hashes, complete 16 log shards and 72 event-bearing headers per provider, 2 original real Borrow receipts controls, identical event identities and all 58 accounts between dRPC/PublicNode. Then deterministically freezes **all 54 previously debt-positive** addresses ordered by their **OLD** HF before any new Ethereum RPC. It does NOT choose by latest HF or a historical liquidation winner. Archive old active-debt observations are not guaranteed active today.

## Current state + exact onchain batch

- Write original 54 address + old risk source SHA precommit BEFORE new mainnet RPC, no trimming. Exactly Ethereum mainnet chainId1, public dRPC and PublicNode, both tips within three blocks, min-tip-minus-two canonical pinned header hash/parent/stateRoot/timestamp identical.
- Require two sources' EIP-1898 eth_getCode at Multicall3 mainnet address **0xca11bde05977b3631167028862be2a173976ca11** have exactly 3,808 deployed bytecode bytes and sha256 **2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e**, previously validated from PR730. Fail closed if this official contract code differs.
- Build exactly ONE Multicall3 aggregate3 calldata with 54 Call3 structs, each target canonical Aave Pool, allowFailure=false, 36-byte getUserAccountData(address) with the precommitted borrower in original selected order. Every result must be ABI-canonical, successful, exactly 192 bytes, decoded as six uint256 words with original Solidity integer semantics. Require **54/54 same-block raw ABI match across dRPC and PublicNode**, not merely aggregate totals.
- Preselect EXACTLY five independent direct Pool eth_call controls **indices [0,1,2,27,53]** before new state read. They must equal the corresponding Multicall3 result byte-for-byte on both providers using the same EIP-1898 canonical blockHash. These five are positive controls; the remaining 49 have exact dual-RPC aggregate parity but not individual direct-call verification, a residual coverage limitation.
- Recheck canonical header on both sources after all reads, age <=135 seconds, max 20 RPC calls/provider, global 400ms minimum interval. No 429 retries or source substitution. Report real elapsed nanoseconds and account by account current debt/HF, min positive-debt HF and <1, 1–1.02, 1.02–1.10 bins. Any unavailable or inconsistent source is INCOMPLETE, not zero.

## Authority / safety limits

A newly observed HF<1 is just borrower risk at a PUBLIC block already mined, not a liquidation route, flash funding, positive net economics, private SVR access or ability to beat incumbent builder inclusion. A bounded older Borrow owner set is not all 25,000+ markets nor even all Aave Ethereum borrowers. A successful batch response cannot justify USD5k/month.

Use ONLY read-only eth_getCode/eth_call with original allowlisted providers, no keys, signing, mainnet/local EOA transactions, state modifications, deployment, paid RPC, new cloud bills, investor/customer access or sharing NQC proprietary source. MXN2000 untouched. OWN_CAPITAL=USD0 including native gas still unfinanced; RMC OPEN, P2 uncertified, LIVE unauthorized, Commercial5.9 unchanged, NQC actual settled PnL USD0.
