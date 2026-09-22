//! Offline operator-driven ingestion; NOT a background crawler or source authentication.
//! `init SOURCE_ID NEW_STATE`
//! `append PREVIOUS_STATE INDEPENDENT_PREVIOUS SOURCE INDEPENDENT_SOURCE SEQUENCE NEW_STATE`
//! `extract STATE INDEPENDENT_STATE NEW_ARCHIVE`
//! A trusted operator supplies each independent reference via a separate channel.
use nexus_leibniz::sequential_ingest::{append_authorized_batch, StreamState};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const MAX_INPUT_BYTES: u64 = 82 * 1024 * 1024;

fn read_regular(path: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("inspect input: {e}"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_INPUT_BYTES {
        return Err("input must be a bounded regular file, not a symlink".into());
    }
    let content = fs::read(path).map_err(|e| format!("read input: {e}"))?;
    if content.len() as u64 > MAX_INPUT_BYTES {
        return Err("input changed or exceeds size limit".into());
    }
    Ok(content)
}

fn distinct(first: &str, second: &str) -> Result<(), String> {
    if fs::canonicalize(first).map_err(|e| e.to_string())?
        == fs::canonicalize(second).map_err(|e| e.to_string())?
    {
        return Err("input and independent reference must be separate files".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let left = fs::metadata(first).map_err(|e| e.to_string())?;
        let right = fs::metadata(second).map_err(|e| e.to_string())?;
        if left.dev() == right.dev() && left.ino() == right.ino() {
            return Err("input and independent reference cannot be hard links".into());
        }
    }
    Ok(())
}

fn write_new(path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options.open(path).map_err(|e| format!("create new checkpoint: {e}"))?;
    if let Err(error) = output.write_all(bytes).and_then(|()| output.sync_all()) {
        drop(output);
        let _ = fs::remove_file(path);
        return Err(format!("write checkpoint: {error}"));
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [mode, source, output] if mode == "init" => {
            let state = StreamState::initial(source)?.to_bytes()?;
            write_new(output, &state)?;
            println!("LEIBNIZ: initialized empty source checkpoint");
        }
        [mode, previous, independently_pinned_previous, input, independently_pinned_input, sequence, output]
            if mode == "append" =>
        {
            distinct(previous, independently_pinned_previous)?;
            distinct(input, independently_pinned_input)?;
            let sequence = sequence.parse::<u64>().map_err(|_| "invalid batch sequence")?;
            let previous = read_regular(previous)?;
            let previous_pin = read_regular(independently_pinned_previous)?;
            let batch = read_regular(input)?;
            let batch_pin = read_regular(independently_pinned_input)?;
            let state = append_authorized_batch(
                &previous, &previous_pin, &batch, &batch_pin, sequence,
            )?;
            write_new(output, &state)?;
            println!("LEIBNIZ: committed source sequence {sequence}");
        }
        [mode, checkpoint, independent_checkpoint, output] if mode == "extract" => {
            distinct(checkpoint, independent_checkpoint)?;
            let checkpoint_bytes = read_regular(checkpoint)?;
            let pinned = read_regular(independent_checkpoint)?;
            if checkpoint_bytes != pinned {
                return Err("checkpoint differs from independently trusted state".into());
            }
            let state = StreamState::from_bytes(&checkpoint_bytes)?;
            write_new(output, state.archive_bytes()?)?;
            println!("LEIBNIZ: exported validated semantic archive at sequence {}", state.sequence());
        }
        _ => return Err("expected init SOURCE NEW_STATE, append PREVIOUS TRUSTED_PREVIOUS INPUT TRUSTED_INPUT SEQUENCE NEW_STATE, or extract STATE TRUSTED_STATE NEW_ARCHIVE".into()),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("LEIBNIZ sequential ingestion rejected request: {error}");
        std::process::exit(1);
    }
}
