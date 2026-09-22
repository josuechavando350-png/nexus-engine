//! Operator-approved offline ingestion. The operator must separately verify
//! the source and obtain an independent pin; two matching local files alone
//! do not authenticate the supplier or prove the measurements correct.
//! Usage: ingest_authorized_source INPUT INDEPENDENT_PIN APPROVED_SOURCE_ID NEW_ARCHIVE
use nexus_leibniz::authorized_ingest::{ingest_operator_tsv, MAX_INPUT_BYTES};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

fn read_regular(path: &str) -> Result<Vec<u8>, String> {
    let info = fs::symlink_metadata(path).map_err(|e| format!("inspect source: {e}"))?;
    if !info.file_type().is_file() || info.len() > MAX_INPUT_BYTES as u64 {
        return Err("ingest input must be a bounded regular file, not a symlink".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("read source: {e}"))?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("ingest source exceeds size limit".into());
    }
    Ok(bytes)
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err("expected INPUT INDEPENDENT_PIN APPROVED_SOURCE_ID NEW_ARCHIVE".into());
    }
    let input_path = Path::new(&args[0]);
    let pin_path = Path::new(&args[1]);
    if fs::canonicalize(input_path).map_err(|e| e.to_string())?
        == fs::canonicalize(pin_path).map_err(|e| e.to_string())?
    {
        return Err("source and independent pin cannot be the same file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let input = fs::metadata(input_path).map_err(|e| e.to_string())?;
        let pin = fs::metadata(pin_path).map_err(|e| e.to_string())?;
        if input.dev() == pin.dev() && input.ino() == pin.ino() {
            return Err("source and pin cannot be hardlinks to the same file".into());
        }
    }
    let source = read_regular(&args[0])?;
    let pinned = read_regular(&args[1])?;
    let archive = ingest_operator_tsv(&source, &pinned, &args[2])?;
    // Fail closed: never overwrite an existing archive or follow a final-path
    // symlink. Failed parsing does not create any output file.
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options
        .open(&args[3])
        .map_err(|e| format!("create archive: {e}"))?;
    if let Err(error) = output.write_all(&archive).and_then(|()| output.sync_all()) {
        drop(output);
        let _ = fs::remove_file(&args[3]);
        return Err(format!("write archive: {error}"));
    }
    println!("LEIBNIZ INGESTED: {} bytes of typed archive", archive.len());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("LEIBNIZ ingestion rejected source: {error}");
        std::process::exit(1);
    }
}
