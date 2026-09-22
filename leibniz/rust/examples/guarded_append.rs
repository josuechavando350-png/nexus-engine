//! Append-only operator entrypoint: no legacy append, witness proposal or
//! policy override. The two witnesses and source pins MUST originate from
//! independently authenticated authorities; this executable cannot provide
//! that external trust or a trusted clock.
//! Usage: guarded_append STATE STATE_PIN STATE_HEAD BATCH BATCH_PIN SEQUENCE
//!        POLICY POLICY_PIN POLICY_HEAD AS_OF_UTC_MS NEW_STATE
use nexus_leibniz::policy_witness::append_with_policy_witness;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

const MAX_BYTES: u64 = 83 * 1024 * 1024;

fn regular_bytes(path: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("cannot inspect input: {e}"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_BYTES {
        return Err("input must be a bounded regular file, not a symlink".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read input: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("input changed or exceeds maximum size".into());
    }
    Ok(bytes)
}

fn separate(left: &str, right: &str) -> Result<(), String> {
    if fs::canonicalize(left).map_err(|e| e.to_string())?
        == fs::canonicalize(right).map_err(|e| e.to_string())?
    {
        return Err("separately supplied inputs refer to the same file".into());
    }
    #[cfg(unix)]
    {
        let left = fs::metadata(left).map_err(|e| e.to_string())?;
        let right = fs::metadata(right).map_err(|e| e.to_string())?;
        if left.dev() == right.dev() && left.ino() == right.ino() {
            return Err("separately supplied inputs are hardlinks".into());
        }
    }
    Ok(())
}

fn write_new(path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|e| format!("cannot create new checkpoint: {e}"))?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!("cannot persist new checkpoint: {error}"));
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [state, state_pin, state_head, batch, batch_pin, sequence, policy, policy_pin, policy_head, at, output] =
        args.as_slice()
    else {
        return Err("expected STATE STATE_PIN STATE_HEAD BATCH BATCH_PIN SEQUENCE POLICY POLICY_PIN POLICY_HEAD AS_OF_UTC_MS NEW_STATE".into());
    };
    for (left, right) in [
        (state, state_pin),
        (batch, batch_pin),
        (policy, policy_pin),
        (state_head, state),
        (state_head, state_pin),
        (policy_head, policy),
        (policy_head, policy_pin),
        (state_head, policy_head),
        (policy, state),
        (policy, batch),
    ] {
        separate(left, right)?;
    }
    let next = sequence.parse::<u64>().map_err(|_| "invalid sequence")?;
    let as_of = at
        .parse::<i64>()
        .map_err(|_| "invalid as-of UTC milliseconds")?;
    let checkpoint = append_with_policy_witness(
        &regular_bytes(state)?,
        &regular_bytes(state_pin)?,
        &regular_bytes(state_head)?,
        &regular_bytes(batch)?,
        &regular_bytes(batch_pin)?,
        next,
        &regular_bytes(policy)?,
        &regular_bytes(policy_pin)?,
        &regular_bytes(policy_head)?,
        as_of,
    )?;
    write_new(output, &checkpoint)?;
    println!("LEIBNIZ: append accepted with both operator-supplied latest witnesses");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("LEIBNIZ guarded append rejected: {error}");
        std::process::exit(1);
    }
}
