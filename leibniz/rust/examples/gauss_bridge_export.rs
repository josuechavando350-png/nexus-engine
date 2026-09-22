//! Offline CLI: export one selected, trusted-source-bound measurement.
//! Usage: gauss_bridge_export ARCHIVE INDEPENDENT_PIN PROBLEM_ID UTC_MS FROM TO UNIT MAXIMIZE|MINIMIZE
//! The operator must obtain the independent pin from an authorized source.
use nexus_leibniz::gauss_bridge::{export_measured_rate, RateSelection};
use nexus_leibniz::handoff::{Direction, HandoffLimits};
use std::fs;
use std::path::Path;

const MAX_SOURCE_BYTES: u64 = 81 * 1024 * 1024;

fn read_source(path: &str) -> Result<Vec<u8>, String> {
    let path = Path::new(path);
    let info = fs::symlink_metadata(path).map_err(|e| format!("cannot inspect source: {e}"))?;
    if !info.file_type().is_file() || info.len() > MAX_SOURCE_BYTES {
        return Err("source must be a bounded regular file, not a symlink".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read source: {e}"))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err("source changed or exceeds byte limit".into());
    }
    Ok(bytes)
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 8 {
        return Err("expected ARCHIVE INDEPENDENT_PIN PROBLEM_ID UTC_MS FROM TO UNIT DIRECTION".into());
    }
    let source = Path::new(&args[0]);
    let pin = Path::new(&args[1]);
    if fs::canonicalize(source).map_err(|e| e.to_string())?
        == fs::canonicalize(pin).map_err(|e| e.to_string())?
    {
        return Err("archive and independent pin cannot be the same file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let left = fs::metadata(source).map_err(|e| e.to_string())?;
        let right = fs::metadata(pin).map_err(|e| e.to_string())?;
        if left.dev() == right.dev() && left.ino() == right.ino() {
            return Err("archive and pin cannot be hard links to the same file".into());
        }
    }
    let direction = match args[7].as_str() {
        "MAXIMIZE" => Direction::Maximize,
        "MINIMIZE" => Direction::Minimize,
        _ => return Err("direction must be MAXIMIZE or MINIMIZE".into()),
    };
    let selected = RateSelection {
        problem_id: args[2].clone(),
        as_of_utc_ms: args[3].parse().map_err(|_| "invalid UTC millisecond timestamp")?,
        from_entity: args[4].clone(),
        to_entity: args[5].clone(),
        target_unit_symbol: args[6].clone(),
        direction,
    };
    let archive = read_source(&args[0])?;
    let pinned = read_source(&args[1])?;
    let line = export_measured_rate(&archive, &pinned, &selected, HandoffLimits::default())?;
    println!("{line}");
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("LEIBNIZ rate bridge rejected input: {e}");
        std::process::exit(1);
    }
}
