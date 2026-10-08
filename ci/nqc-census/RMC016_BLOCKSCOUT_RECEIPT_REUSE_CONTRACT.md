# RMC-016 — Independent Blockscout receipts against exact 127 dRPC witnesses

## Source identities

- Source Blockscout full-window run 37718661409: immutable artifact 11524139188, SHA-256 6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204, 139 LiquidationCall events and 127 distinct transaction hashes.
- Original dRPC receipt run 37719091371: **failed overall** because BlastAPI returned HTTP 429 after six transactions. Artifact 11524199698, SHA-256 182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6 contains **127 verified dRPC receipts**, normalized and individually bound to the source events. Inner 127-row SHA-256 is c486bc5788e306965e0c3924fda1a0264ba0e67c8eb6ebfdc585072676575f78.
- The failed run must never be promoted to success. Only its authenticated complete dRPC subset can serve as source-specific evidence. Its Blockscout/dRPC full receipt consensus remains false until this new independent check passes.

## Independent verification

1. Independently verify original run identity, exact commit/tree, immutable artifact ID/name/outer SHA-256, inner SHA-256, original failure disposition and the precise 127 dRPC single-source gas witnesses. Every normalized receipt hash must match its canonical byte-level commitment, original event source block/hash/index, event count and gas multiplication.
2. Query the separate Blockscout operator for twelve deterministic receipt hashes as a preflight. A successful twelve-receipt sample is NOT a 127-receipt certificate.
3. Retrieve all 127 at a rate limited to five seconds between requests. Require exact block, canonical 139-event membership across 127 transactions and gas in wei to agree with the source dRPC receipt. No duplicated gas across multi-event transactions. Fail closed on 429/missing data/reorg/provider disagreements. Preserve exact sanitized partial receipts and hashes if a run fails.
4. Two-operator receipt agreement does not establish full independent discovery of unobserved historical opportunities; historical market liquidity and other bots' receipts cannot be attributed to Nexus. Never infer ETH/USD gas from aggregate oracle prices; never infer positive net or capture probability.
5. OWN_CAPITAL=0 remains mandatory, including actual principal and gas financing. No signing/broadcast/private data, no Canon Penal/Vercel changes, no D14/D17 closeout state mutation.

## Run boundary

GitHub Actions performs ten offline adversarial tests, exact source identity checks, twelve real Blockscout receipts (four seconds between requests), then the full 127 (five seconds). Any provider rate limit is evidence of insufficient source availability and does not authorize relaxing truth criteria.
