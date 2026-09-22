//! The operator MUST independently authenticate and retain a monotonic
//! policy witness outside the checkpoint/policy store. `propose` only creates
//! candidate bytes; it never publishes, signs or authenticates them.
//! Usage: policy_witness_source propose POLICY POLICY_PIN OUT_WITNESS
//!        policy_witness_source append STATE STATE_PIN STATE_HEAD BATCH
//!        BATCH_PIN NEXT_SEQUENCE POLICY POLICY_PIN POLICY_HEAD AS_OF_MS OUT
use nexus_leibniz::policy_witness::{append_with_policy_witness, PolicyWitness};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

const MAX_BYTES: u64 = 83 * 1024 * 1024;

fn read_regular(path: &str) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("cannot inspect input: {e}"))?;
    if !meta.file_type().is_file() || meta.len() > MAX_BYTES {
        return Err("input must be a bounded regular file, not a symlink".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read input: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("input changed or exceeds byte limit".into());
    }
    Ok(bytes)
}

fn distinct(a: &str, b: &str) -> Result<(), String> {
    if fs::canonicalize(a).map_err(|e| e.to_string())?
        == fs::canonicalize(b).map_err(|e| e.to_string())?
    {
        return Err("separately supplied inputs are the same file".into());
    }
    #[cfg(unix)]
    {
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
    let mut file = options
        .open(path)
        .map_err(|e| format!("cannot create output: {e}"))?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!("cannot persist output: {error}"));
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [mode, policy, pin, output] if mode == "propose" => {
            distinct(policy, pin)?;
            let proposal = PolicyWitness::from_policy(&read_regular(policy)?, &read_regular(pin)?)?;
            write_new(output, &proposal.to_bytes()?)?;
            println!("LEIBNIZ: policy witness PROPOSED, not externally authorized or published");
        }
        [mode, state, state_pin, state_head, batch, batch_pin, sequence,
         policy, policy_pin, policy_head, at, output] if mode == "append" => {
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
                distinct(left, right)?;
            }
            let next = sequence.parse::<u64>().map_err(|_| "invalid sequence")?;
            let now = at.parse::<i64>().map_err(|_| "invalid as-of UTC milliseconds")?;
            let result = append_with_policy_witness(
                &read_regular(state)?,
                &read_regular(state_pin)?,
                &read_regular(state_head)?,
                &read_regular(batch)?,
                &read_regular(batch_pin)?,
                next,
                &read_regular(policy)?,
                &read_regular(policy_pin)?,
                &read_regular(policy_head)?,
                now,
            )?;
            write_new(output, &result)?;
            println!("LEIBNIZ: checkpoint accepted under operator-supplied witnesses");
        }
        _ => {
            return Err(
                "expected propose POLICY POLICY_PIN OUT or append STATE STATE_PIN STATE_HEAD BATCH BATCH_PIN NEXT_SEQUENCE POLICY POLICY_PIN POLICY_HEAD AS_OF_MS OUT"
                    .into(),
            );
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("LEIBNIZ witnessed policy operation rejected: {error}");
        std::process::exit(1);
    }
}
