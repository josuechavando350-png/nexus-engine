//! Append-only operator entrypoint: no legacy append, witness proposal or
//! policy override. The two witnesses and source pins MUST originate from
//! independently authenticated authorities; this executable cannot provide
//! that external trust or a trusted clock.
//! On Linux, O_NOFOLLOW prevents a final-component symlink swap during open.
//! Ancestor-directory substitution, concurrent writers and compromised
//! witnesses remain outside this process's trust boundary.
//! Usage: guarded_append STATE STATE_PIN STATE_HEAD BATCH BATCH_PIN SEQUENCE
//!        POLICY POLICY_PIN POLICY_HEAD AS_OF_UTC_MS NEW_STATE
use nexus_leibniz::policy_witness::append_with_policy_witness;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

const MAX_BYTES: u64 = 83 * 1024 * 1024;
#[cfg(target_os = "linux")]
const O_NOFOLLOW: i32 = 0o400000;

/// Open once, validate the opened descriptor, then read from that same handle.
/// Checking a pathname and reopening it would allow a last-component symlink
/// to be substituted between inspection and use.
fn open_input(path: &str) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    options.custom_flags(O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(|e| format!("cannot open input without following a final symlink: {e}"))?;
    let metadata = file.metadata().map_err(|e| format!("cannot inspect opened input: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("input must be a bounded regular file".into());
    }
    Ok(file)
}

fn read_open_input(file: &mut File) -> Result<Vec<u8>, String> {
    let before = file.metadata().map_err(|e| format!("cannot inspect opened input: {e}"))?;
    if !before.is_file() || before.len() > MAX_BYTES {
        return Err("input changed or exceeds maximum size".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read opened input: {e}"))?;
    let after = file.metadata().map_err(|e| format!("cannot recheck opened input: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES
        || bytes.len() as u64 != before.len()
        || bytes.len() as u64 != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("input changed while being read or exceeded maximum size".into());
    }
    Ok(bytes)
}

fn check_distinct_open_inputs(inputs: &[File]) -> Result<(), String> {
    #[cfg(unix)]
    for (index, left) in inputs.iter().enumerate() {
        let first = left.metadata().map_err(|e| format!("cannot inspect input identity: {e}"))?;
        for right in &inputs[index + 1..] {
            let second = right.metadata().map_err(|e| format!("cannot inspect input identity: {e}"))?;
            if first.dev() == second.dev() && first.ino() == second.ino() {
                return Err("separately supplied inputs share a file descriptor identity".into());
            }
        }
    }
    Ok(())
}

/// Persist the newly created file and its directory entry on Unix filesystems
/// that honor fsync. This does NOT atomically publish the external witness.
fn write_new(path: &str, bytes: &[u8]) -> Result<(), String> {
    let parent = Path::new(path)
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|e| format!("cannot create new checkpoint: {e}"))?;
    let persisted = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| File::open(parent)?.sync_all());
    if let Err(error) = persisted {
        drop(file);
        let _ = fs::remove_file(path);
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        return Err(format!("cannot persist checkpoint and directory entry: {error}"));
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
    let paths = [
        state, state_pin, state_head, batch, batch_pin, policy, policy_pin, policy_head,
    ];
    let mut opened = paths
        .iter()
        .map(|path| open_input(path))
        .collect::<Result<Vec<_>, _>>()?;
    check_distinct_open_inputs(&opened)?;
    let blobs = opened
        .iter_mut()
        .map(read_open_input)
        .collect::<Result<Vec<_>, _>>()?;
    let next = sequence.parse::<u64>().map_err(|_| "invalid sequence")?;
    let as_of = at
        .parse::<i64>()
        .map_err(|_| "invalid as-of UTC milliseconds")?;
    let checkpoint = append_with_policy_witness(
        &blobs[0],
        &blobs[1],
        &blobs[2],
        &blobs[3],
        &blobs[4],
        next,
        &blobs[5],
        &blobs[6],
        &blobs[7],
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
