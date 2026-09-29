//! Merges stage stores into one RMC-004 store through the store's own
//! commit path: `--into DIR (--from DIR --record FILE)...`.

use nqc_census_chain::json::Json;
use nqc_census_chain::merge::merge_store;
use nqc_census_store::{ArtifactId, Store, StoreConfig};
use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut into = None;
    let mut sources: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = PathBuf::from(
            args.next()
                .ok_or_else(|| format!("missing value for {flag}"))?,
        );
        match flag.as_str() {
            "--into" => into = Some(value),
            "--from" => sources.push((value, None)),
            "--record" => {
                let last = sources.last_mut().ok_or("--record must follow --from")?;
                last.1 = Some(value);
            }
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    let destination = Store::create(&into.ok_or("--into is required")?, StoreConfig::standard())?;
    let (mut streams, mut checkpoints, mut artifacts) = (0, 0, 0);
    for (path, record) in &sources {
        let source = Store::open_existing(path)?;
        let roots = match record {
            Some(record) => Json::parse(&fs::read(record)?)?
                .get("manifests")
                .and_then(Json::as_array)
                .ok_or("record lists no manifests")?
                .iter()
                .map(|id| {
                    Ok(ArtifactId::parse_hex(
                        id.as_str().ok_or("manifest id is not text")?,
                    )?)
                })
                .collect::<Result<Vec<_>, Box<dyn Error>>>()?,
            None => Vec::new(),
        };
        let report = merge_store(&source, &destination, &roots)?;
        streams += report.streams;
        checkpoints += report.checkpoints;
        artifacts += report.artifacts;
    }
    println!(
        "RMC008_MERGE_PASS sources={} streams={streams} checkpoints={checkpoints} artifacts={artifacts}",
        sources.len()
    );
    Ok(())
}
