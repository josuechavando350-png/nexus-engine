# RMC-016 — Recover exact historical economics from the DigitalOcean snapshot

## Blocked economic evidence

The retained historical source snapshot is DigitalOcean image 248761092, taken from droplet 606773701, completed by action 3455949449. The GitHub D15B/D16 terminal artifacts contain certified aggregates, not the actual 127-row winner ledger. The exact authoritative source byte fingerprints are:

| Source label | Exact SHA-256 |
|---|---|
| D16_TRANSACTION_ECONOMICS | 55d5d6be9e09f2e499e1ca8949c4305d05824dffa61e363f4371c615537dcb1c |
| D16_EVENT_ECONOMICS | ea1f62091175c8c67b8763411f72a6071bfe528c1f969d19c9cff5679677c98b |
| D16_WINNER_REPLAY | 29133f3b7ab34b74f92f5e8a3101e04a3cb2b1b389d4b8728813fbbae7f461be |
| D15B_EPISODE_LEDGER | a7fe40d752ee43ea507e9723d056248ca28dd6fb5884f49f33bed60950e3782a |
| D15B_CENSORED_LEDGER | c64b6050ff7a3cd5ee7119c9b2f041dad6341fb0cd7b53884e8f1bba1efb9252 |
| D16_LIQUIDATION_PRICE_AUTHORITY | 7c08ec2708e5d1d4d5ee4687ef960e440328683f1f6e7771805bc03c5b34f61a |
| D16_DAILY_BASELINE | 1d06b56a28400bbf1102d614cd615543e855b3b1a01b78ed513300cff32d660f |
| D15B_FULL_BLOCK_ORACLE_TRANSITIONS | bbad1eb1a6fba097bd642b1abb5aa417fc86686dfe271da7c66017609bd3c519 |

These are byte hashes; a similarly named file is not sufficient. ZIP members and gzip members are hashed incrementally, without extracting contents into an external tool.

## Execute on authorized mounted recovery snapshot

This script intentionally cannot run its real recovery on GitHub because GitHub runners cannot access the snapshot's private filesystem. Once Desktop Commander Remote is connected and the correct mounted source directories identified:

    python3 ci/nqc-census/rmc016_snapshot_evidence_finder.py \
      --root /home --root /opt --root /mnt \
      --out /tmp/nqc-rmc016-recovery-manifest-01.json

Only use roots that actually exist on that device. The script never scans the filesystem root automatically, does not follow symlinks, excludes common secret/config directories and files, and creates a local 0600 report with O_EXCL rather than overwriting prior evidence. It never uploads raw borrower or transaction rows to GitHub. The report includes only file paths, content hashes and byte lengths: treat it as local sensitive metadata.

If the exact D16 transaction economics source is found, perform a separate read-only semantic audit against its real schema, prove 127 unique transaction hashes / 139 events, receipts and costs, then adapt the existing RMC-016 winner audit without repacking or inventing any rows. If not found, preserve a SOURCE_NOT_FOUND blocker and recover chain data only with independently corroborated RPC providers. Do not claim an independently reconstructed file matches the unpublished hash unless it actually does.

## Non-claims and safety

This is a source-location aid, not a certification of net profitability or a forecast. No live transaction is signed or broadcast; no capital or gas funding is presumed. OWN_CAPITAL = 0 is a mandatory operational constraint. D14 and D17 are unchanged. No changes to Cano Penal, Vercel, DigitalOcean infrastructure or user funds. GitHub CI tests use only synthetic temporary files and must not upload the real snapshot contents.
