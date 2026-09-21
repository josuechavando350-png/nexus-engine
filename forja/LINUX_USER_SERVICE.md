# FORJA on a free Linux user service (optional; not deployed)

`forja/linux-service.mjs` generates an inspectable `systemd --user` unit for the **existing local, read-only** FORJA queue. It does not install Linux, provision a virtual machine, create users, install a service, alter firewall settings, require sudo, start processes, provision operator keys or spend money. The existing unit requires a Linux system with `systemd --user`, Git, Node 24+, and an existing private `0700` state directory outside a clean, committed NEXUS checkout. All paths must be absolute without whitespace, `%`, shell syntax or path traversal; place the checkout/state at simple paths. The unit is tied to the exact source SHA when generated and its startup guard refuses later revisions, dirty checkouts and existing worker locks.

Review the generated unit **before installing it**. On a Linux host you control, while logged in as an unprivileged account that owns both directories, run from the root of the committed NEXUS checkout:

```sh
mkdir -p "$HOME/.config/systemd/user"
mkdir -m 700 "$HOME/forja-state"
node forja/linux-service.mjs render "$PWD" "$HOME/forja-state" > "$HOME/.config/systemd/user/forja.service"
systemd-analyze verify "$HOME/.config/systemd/user/forja.service"
systemctl --user daemon-reload
systemctl --user enable --now forja.service
systemctl --user status forja.service
```

These commands are **instructions for an operator**, not actions carried out by this repository or CI. Use an empty dedicated service state, not a home directory containing other files or keys. Do not commit its contents or use a shared/NFS filesystem. A user manager may stop when its login session ends; persistent operation across logout requires host-specific configuration such as lingering, which is **not** enabled here. CI validates unit syntax and the guard in disposable Ubuntu runners but cannot prove 24/7 uptime, an actual VM reboot or a production configuration.

For maintenance/backups, stop the service and all submitters/redeemers, verify they have exited and that no child processes remain before the offline backup procedure in [STATE_BACKUP.md](STATE_BACKUP.md). `KillMode=mixed` sends SIGTERM to the main worker first and waits up to 600 seconds for it to finish its bounded read-only job. After a forced kill or crash, an on-disk worker lock can remain: **do not remove it automatically**. Check the host and subprocesses, then use the explicit documented `recover` command only after verifying the old owner and children have exited. Interrupted jobs are not replayed automatically. Restarting a unit is not proof that old detached subprocess groups are dead. Never use old restored approval receipts as fresh authority. [SIGNED_BACKUP.md](SIGNED_BACKUP.md) documents the independent-key signature limits.

If the checkout advances to a new commit, stop the unit, review the new revision and its CI, rerun `render`, review the output, replace your unit file, reload and restart explicitly. An old unit intentionally fails on the new SHA rather than quietly executing modified code. This does **not** authorize merges, deployments, changes to client websites, payment operations or unattended upgrades; it operates only the fixed four-stage evidence queue. It is not a full independent infrastructure stack: `systemd`, Linux, Git, Node and the current GitHub repository remain upstream technologies. No paid hosting or commercial API is required for local operation, but a persistent computer and storage are required for persistent operation.
