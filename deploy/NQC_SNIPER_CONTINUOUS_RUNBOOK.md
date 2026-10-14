# Continuous read-only observer: deployment and evidence

The user authorized continuous read-only activation on 2026-10-13. This changes
the prior opt-in status. It does not authorize mainnet writes, wallet keys, gas,
new servers, paid RPC plans or other new purchases. Deploy on an existing host.

Current access blocker: Desktop Commander monthly quota is exhausted; local SSH
has no configured identity/session. Do not retry/reconnect that quota block or
provision a replacement server. Committing the service is not deploying it.
ChatGPT task `NQC vigilancia horaria` is an enabled hourly interim snapshot task;
it is neither a daemon nor a substitute for per-block monitoring.

## Behavior and scope

- One process, OS exclusive writer lock; target cadence 60 seconds, no overlapping
  observations. Slow samples can take up to 180 seconds. No catch-up request burst.
- Existing strict read-only observer, three configured RPC endpoints, four fixed
  historical borrower identities, min-tip minus three blocks. This is a research
  watchlist, not exhaustive discovery, mempool observation or competitive latency.
- Fresh directory per UTC day, existing journal hash-chain audit before appending,
  no overwrite/deletion, maximum 2,000 samples/day, stop below 1 GiB free. Chains
  are per day; this does not claim a cryptographically linked cross-day ledger.
- Atomic mutable health pointer refers to immutable journal/snapshot evidence.
  Health validates that evidence, timestamp age, observed block freshness and two
  agreeing endpoints. A live process with unusable RPC data is unhealthy.
- systemd starts at boot, restarts failed processes after 90 seconds, runs an
  unprivileged dedicated identity, restricts filesystem writes and caps resources.
  Host/network/provider outages still cause observation gaps.
- Interrupted journal writes, orphan snapshots or corruption fail closed. Never
  delete evidence to regain a green status. An operator must preserve and inspect
  the original directory, then document any repaired chain or new segment.

## First installation on the authorized host

Use an authenticated Git checkout at the reviewed exact PR head. The installer
verifies every deployed source byte against that commit and runs offline tests.
It refuses to overwrite an unknown service, symlink, release or existing service
identity. Inspect existing installations before writing an explicit upgrade.

```bash
sudo bash deploy/install-nqc-sniper-readonly.sh "$PWD" "$(git rev-parse HEAD)"
sudo systemctl show nqc-v2-sniper-readonly.service -p ActiveState -p SubState -p MainPID -p NRestarts
sudo -u nqc-sniper python3 /opt/nqc/sniper-readonly/current/sniper_continuous_service.py --out-dir /var/lib/nqc-sniper-readonly --health
sudo journalctl -u nqc-v2-sniper-readonly.service --since '-10 minutes' --no-pager
```

The health command must pass after the first completed sample. Record exact source
commit, hostname, boot ID, PID, service enablement, UTC sample times, hashes and
source errors. Check at least three fresh increasing-block samples. Restart only
this service and confirm sequence continuity without overwriting snapshots.
Verify restart-on-failure for this dedicated process once, then confirm the next
sample. A VM reboot affects every service on that host: do not reboot a shared
host without explicit authorization. Boot recovery remains unverified until an
authorized reboot or naturally occurring reboot is observed and documented.

For actual 24-hour evidence, calculate the gaps and valid sample coverage from
the daily journals. `is-active`, a short CI run or one fresh health result cannot
certify 24/7 uptime. No check here certifies liquidation capture, P2, RMC closure,
gas sponsorship, net margin or revenue. NQC P&L remains zero.

Rollback: stop/disable only `nqc-v2-sniper-readonly.service`; keep its state and
release files for audit. No command should touch other services or delete data.
