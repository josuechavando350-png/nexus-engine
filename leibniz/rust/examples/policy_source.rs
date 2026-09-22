//! Source consent gate. All identities, byte pins, clock values and revision
//! floors are operator inputs, NOT independently authenticated by this CLI.
//! Usage: policy_source append STATE STATE_PIN TRUSTED_HEAD BATCH BATCH_PIN
//!        NEXT_SEQUENCE POLICY POLICY_PIN MIN_POLICY_REVISION AS_OF_UTC_MS OUT_STATE
use nexus_leibniz::source_policy::append_with_policy;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const MAX_BYTES: u64 = 83 * 1024 * 1024;
fn read_regular(path: &str) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("cannot inspect input: {e}"))?;
    if !meta.file_type().is_file() || meta.len() > MAX_BYTES {
        return Err("input must be bounded regular file, not a symlink".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read input: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("input changed or exceeds limit".into());
    }
    Ok(bytes)
}
fn distinct(a: &str, b: &str) -> Result<(), String> {
    if fs::canonicalize(a).map_err(|e| e.to_string())?
        == fs::canonicalize(b).map_err(|e| e.to_string())?
    {
        return Err("separately supplied inputs refer to the same file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let left = fs::metadata(a).map_err(|e| e.to_string())?;
        let right = fs::metadata(b).map_err(|e| e.to_string())?;
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
    let mut file = options.open(path).map_err(|e| format!("cannot create checkpoint: {e}"))?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!("cannot persist checkpoint: {error}"));
    }
    Ok(())
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [mode, state, state_pin, head, batch, batch_pin, sequence, policy, policy_pin, revision, as_of, output] = args.as_slice() else {
        return Err("expected append STATE STATE_PIN HEAD BATCH BATCH_PIN SEQUENCE POLICY POLICY_PIN MIN_REVISION AS_OF_UTC_MS OUT".into());
    };
    if mode != "append" { return Err("only append is supported".into()); }
    for (left, right) in [
        (state, state_pin), (batch, batch_pin), (policy, policy_pin),
        (head, state), (head, state_pin), (head, policy), (head, policy_pin),
        (policy, state), (policy_pin, state), (policy, batch), (policy_pin, batch_pin),
    ] {
        distinct(left, right)?;
    }
    let next = sequence.parse::<u64>().map_err(|_| "invalid sequence")?;
    let min_revision = revision.parse::<u64>().map_err(|_| "invalid minimum revision")?;
    let now = as_of.parse::<i64>().map_err(|_| "invalid UTC evaluation time")?;
    let result = append_with_policy(
        &read_regular(state)?, &read_regular(state_pin)?, &read_regular(head)?,
        &read_regular(batch)?, &read_regular(batch_pin)?, next,
        &read_regular(policy)?, &read_regular(policy_pin)?, min_revision, now,
    )?;
    write_new(output, &result)?;
    println!("LEIBNIZ: guarded batch accepted under operator-supplied policy; publish new independent head");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("LEIBNIZ policy gate rejected request: {error}");
        std::process::exit(1);
    }
}
