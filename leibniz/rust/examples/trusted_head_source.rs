//! Offline operator-facing anti-rollback CLI. The trusted head MUST be read
//! from a separately protected, monotonic authority. Never treat `propose`
//! output or a second copy in the same mutable directory as authenticated.
//! propose CHECKPOINT PIN OUT_PROPOSED_HEAD
//! append CHECKPOINT PIN TRUSTED_HEAD BATCH BATCH_PIN SEQUENCE OUT_STATE
//! extract CHECKPOINT PIN TRUSTED_HEAD OUT_ARCHIVE
use nexus_leibniz::trusted_head::{
    append_with_trusted_head, extract_with_trusted_head, TrustedHead,
};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const MAX_INPUT_BYTES: u64 = 83 * 1024 * 1024;

fn read_regular(path: &str) -> Result<Vec<u8>, String> {
    let info = fs::symlink_metadata(path).map_err(|e| format!("cannot inspect input: {e}"))?;
    if !info.file_type().is_file() || info.len() > MAX_INPUT_BYTES {
        return Err("input must be bounded regular file, never a symlink".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read input: {e}"))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("input changed or exceeds byte limit".into());
    }
    Ok(bytes)
}

fn distinct(a: &str, b: &str) -> Result<(), String> {
    if fs::canonicalize(a).map_err(|e| e.to_string())?
        == fs::canonicalize(b).map_err(|e| e.to_string())?
    {
        return Err("independent inputs cannot refer to the same file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let left = fs::metadata(a).map_err(|e| e.to_string())?;
        let right = fs::metadata(b).map_err(|e| e.to_string())?;
        if left.dev() == right.dev() && left.ino() == right.ino() {
            return Err("independent inputs cannot be hardlinks".into());
        }
    }
    Ok(())
}

fn write_new(path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options
        .open(path)
        .map_err(|e| format!("cannot create output: {e}"))?;
    if let Err(e) = output.write_all(bytes).and_then(|()| output.sync_all()) {
        drop(output);
        let _ = fs::remove_file(path);
        return Err(format!("cannot persist output: {e}"));
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [mode, state_path, pinned_path, output] if mode == "propose" => {
            distinct(state_path, pinned_path)?;
            let state = read_regular(state_path)?;
            let pin = read_regular(pinned_path)?;
            let proposed = TrustedHead::from_checkpoint(&state, &pin)?.to_bytes()?;
            write_new(output, &proposed)?;
            println!("LEIBNIZ: proposed head; operator must independently authenticate and publish it");
        }
        [mode, state_path, pinned_path, head_path, batch_path, batch_pin_path, sequence, output]
            if mode == "append" =>
        {
            distinct(state_path, pinned_path)?;
            distinct(head_path, state_path)?;
            distinct(head_path, pinned_path)?;
            distinct(batch_path, batch_pin_path)?;
            let state = read_regular(state_path)?;
            let pin = read_regular(pinned_path)?;
            let head = read_regular(head_path)?;
            let batch = read_regular(batch_path)?;
            let batch_pin = read_regular(batch_pin_path)?;
            let next = sequence
                .parse::<u64>()
                .map_err(|_| "invalid next sequence")?;
            let result = append_with_trusted_head(&state, &pin, &head, &batch, &batch_pin, next)?;
            write_new(output, &result)?;
            println!("LEIBNIZ: created sequence {next}; independently publish a new head before the next operation");
        }
        [mode, state_path, pinned_path, head_path, output] if mode == "extract" => {
            distinct(state_path, pinned_path)?;
            distinct(head_path, state_path)?;
            distinct(head_path, pinned_path)?;
            let archive = extract_with_trusted_head(
                &read_regular(state_path)?,
                &read_regular(pinned_path)?,
                &read_regular(head_path)?,
            )?;
            write_new(output, &archive)?;
            println!("LEIBNIZ: exported archive from witnessed latest checkpoint");
        }
        _ => return Err("expected propose CHECKPOINT PIN OUT, append CHECKPOINT PIN TRUSTED_HEAD BATCH BATCH_PIN SEQUENCE OUT, or extract CHECKPOINT PIN TRUSTED_HEAD OUT".into()),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("LEIBNIZ trusted-head gate rejected request: {error}");
        std::process::exit(1);
    }
}
