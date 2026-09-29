//! Offline RMC-007 closeout. Needs no network.
//!
//! Stages come either as records (`--records DIR`) replayed here from one
//! store holding all their evidence, or as extracts (`--extracts DIR`) each
//! replayed beforehand from its own store by `nqc-rmc007-v2-replay`; then
//! `--store` holds the surface evidence only and receives the closeout.

use nqc_census_chain::json::Json;
use nqc_census_chain::provider::{ProviderSet, ProviderSpec};
use nqc_census_store::Store;
use nqc_census_v2_discovery::closeout::{
    reconcile_extracts, reconcile_offline, write_closeout, Inputs,
};
use nqc_census_v2_discovery::stage::V2Plan;
use std::collections::BTreeMap;
use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut flags: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        flags.entry(flag).or_default().push(value);
    }
    let one = |name: &str| -> Result<String, Box<dyn Error>> {
        Ok(flags
            .get(name)
            .and_then(|values| values.first())
            .cloned()
            .ok_or_else(|| format!("{name} is required"))?)
    };
    let surface_providers = ProviderSet::parse(&fs::read(one("--surface-providers")?)?)?;
    let mut stage_providers: Vec<ProviderSpec> = Vec::new();
    for path in flags
        .get("--stage-providers")
        .ok_or("--stage-providers is required")?
    {
        stage_providers.extend(ProviderSet::parse(&fs::read(path)?)?.iter().cloned());
    }
    let current = Json::parse(&fs::read(one("--current")?)?)?;
    let boundary = Json::parse(&fs::read(one("--boundary")?)?)?;
    let json_files = |dir: String| -> Result<Vec<Json>, Box<dyn Error>> {
        let mut paths: Vec<PathBuf> = fs::read_dir(dir)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<_, _>>()?;
        paths.sort();
        paths
            .iter()
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .map(|path| Ok(Json::parse(&fs::read(path)?)?))
            .collect()
    };
    let (records, extracts) = match (
        flags.contains_key("--records"),
        flags.contains_key("--extracts"),
    ) {
        (true, false) => (json_files(one("--records")?)?, None),
        (false, true) => {
            let extracts = json_files(one("--extracts")?)?;
            let records = extracts
                .iter()
                .map(|extract| {
                    extract
                        .get("record")
                        .cloned()
                        .ok_or("extract without record")
                })
                .collect::<Result<Vec<_>, _>>()?;
            (records, Some(extracts))
        }
        _ => return Err("exactly one of --records and --extracts is required".into()),
    };
    let stage_stores = match &extracts {
        Some(extracts) => extracts
            .iter()
            .map(|extract| extract.get("store").cloned().ok_or("extract without store"))
            .collect::<Result<Vec<_>, _>>()?,
        None => Vec::new(),
    };
    let store = Store::open_existing(&PathBuf::from(one("--store")?))?;
    let plan = V2Plan::mainnet()?;
    let inputs = Inputs {
        store: &store,
        plan: &plan,
        surface_providers: &surface_providers,
        stage_providers: &stage_providers,
        current: &current,
        boundary: &boundary,
        records: &records,
        stage_stores: &stage_stores,
    };
    let (reconciliation, admission, agreement) = match extracts {
        Some(extracts) => reconcile_extracts(&inputs, extracts)?,
        None => reconcile_offline(&inputs)?,
    };
    let report = write_closeout(
        &inputs,
        &reconciliation,
        &admission,
        &agreement,
        &PathBuf::from(one("--out-dir")?),
        &one("--code-commit")?,
        &one("--code-tree")?,
    )?;
    fs::write(
        PathBuf::from(one("--out-dir")?).join("closeout-report.json"),
        report.canonical()?,
    )?;
    println!(
        "RMC007_CLOSEOUT_PASS pairs={} unexplained={} mismatches={} records={} agreement={}",
        report
            .get("pair_count")
            .and_then(Json::as_i64)
            .ok_or("pair_count")?,
        report
            .get("unexplained_delta_count")
            .and_then(Json::as_i64)
            .ok_or("unexplained")?,
        report
            .get("provider_mismatch_count")
            .and_then(Json::as_i64)
            .ok_or("mismatches")?,
        records.len(),
        agreement.canonical_string()?
    );
    Ok(())
}
