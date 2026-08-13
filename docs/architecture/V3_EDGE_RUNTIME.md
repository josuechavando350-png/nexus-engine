# NEXUS V3 — Edge Protocol and WASM Runtime

## 1. Command protocol

Every message to a device carries:

```text
task_id  device_id  issued_at  expires_at  nonce
required_capabilities  safety_constraints  payload
signature  signer_id
```

The payload is a **typed command**, not opaque bytes. The command set is a
closed enum; a device cannot be asked to do something the protocol cannot
name, and there is no escape hatch that carries arbitrary data.

### Enforced at receipt

- **Expiry.** `issued_at`/`expires_at` bound validity. Expired is dead.
- **Anti-replay.** Nonces are recorded in a bounded window; a repeat is
  refused. The window is bounded on purpose — an unbounded nonce store is a
  memory-exhaustion vector on a device that runs for months.
- **Capability allowlist.** The task declares what it needs; the device
  declares what it has. Anything beyond the intersection is refused.
- **Device identity.** The task names one device and is refused elsewhere.
- **Signature.** Ed25519 over the canonical bytes of the task.

### Signing

`Signer` and `Verifier` are traits. The `ed25519` feature provides the real
implementation over `ed25519-dalek`.

`DevSigner` is the default in-tree implementation and it is **not
cryptography**. It exists for tests and `SIMULATION` mode, it is documented as
such at every point of use, and it **refuses to operate in
`PHYSICAL_NON_WEAPONIZED` mode**. A build that can move a real robot cannot be
signing with it.

## 2. WASM sandbox

`nexus-edge-wasm` executes task handlers under a capability sandbox.

| Control | Default |
|---|---|
| Memory | hard cap, `NEXUS_EDGE_MEMORY_LIMIT_BYTES` |
| CPU | fuel / execution budget |
| Wall clock | timeout |
| Filesystem | **none** |
| Network | **none** |
| Host functions | explicit allowlist, capability-token gated |
| Module identity | signed manifest plus SHA-256 hash validation |

A module whose hash does not match its manifest does not run. A module
requesting a host function outside its capability tokens does not run. A
module exceeding fuel, memory or time is terminated and the failure is
audited, not retried blindly.

### Two modes

```text
SIMULATION                 no physical actuation; used by CI and every example
PHYSICAL_NON_WEAPONIZED    real actuation, non-weaponized devices only
```

CI and the tests run exclusively in `SIMULATION`. The mode is explicit in
configuration; there is no implicit promotion.

### Host function surface

The allowlisted host functions are narrow and read-shaped: read a mock or real
sensor value, report progress, return an observation. There is no host
function that opens a socket, writes a file, spawns a process or actuates
anything outside the typed command already authorised.

## 3. Example module

The reference module receives a `collect_temperature` task, calls the
allowlisted sensor host function, and returns an observation that re-enters
the pipeline as ordinary telemetry — which is how the loop closes and how the
incident becomes traceable end to end.

## 4. Limits

- The `wasmtime` adapter is feature-gated and has not been compiled in the
  environment where it was written; the sandbox policy types and the
  simulation executor are in the default build and are tested.
- A sandbox constrains what a module can do. It does not make a malicious
  module harmless — it makes it harmless *within the allowlist*. Module
  provenance is enforced by manifest signature, which is the actual control.
