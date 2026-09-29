//! Offline RMC-008 reconciliation and closeout.
//!
//! `--providers F --pins F --pin-root DIR (--records DIR --store DIR |
//!  --extracts DIR) --out-dir DIR --code-commit SHA --code-tree SHA`
//!
//! `--records` replays every record from one store holding all their
//! evidence; `--extracts` takes stages already replayed one store at a time
//! by `nqc-rmc008-state-replay`. Performs no network access.

use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_state::closeout::{
    reconcile_extracts, reconcile_offline, write_closeout, CloseoutContext,
};
use nqc_census_state::inputs::{pinned, verify_pins, D06Inputs, D07Inputs};
use nqc_census_state::replay::manifests;
use nqc_census_state::stage::AnchorPlan;
use nqc_census_state::v2_stage::V2Plan;
use nqc_census_store::{Store, StoreConfig};
use std::collections::BTreeMap;
use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut flags = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        flags.insert(
            flag.clone(),
            args.next()
                .ok_or_else(|| format!("missing value for {flag}"))?,
        );
    }
    let flag = |name: &str| -> Result<String, Box<dyn Error>> {
        Ok(flags
            .get(name)
            .cloned()
            .ok_or_else(|| format!("{name} is required"))?)
    };
    let providers = ProviderSet::parse(&fs::read(flag("--providers")?)?)?;
    let providers: Vec<_> = providers.iter().cloned().collect();
    let pins = verify_pins(
        &PathBuf::from(flag("--pins")?),
        &PathBuf::from(flag("--pin-root")?),
    )?;
    let anchor = AnchorPlan::mainnet()?;
    let d06 = D06Inputs::read(
        pinned(&pins, "d06_current_surface")?,
        pinned(&pins, "d06_deployment_manifest")?,
        pinned(&pins, "d06_reserve_manifest")?,
        &anchor,
    )?;
    let d07 = D07Inputs::read(
        pinned(&pins, "d07_current_surface")?,
        pinned(&pins, "d07_deployment_admission")?,
        pinned(&pins, "d07_pair_manifest")?,
        &anchor,
    )?;
    let json_files = |dir: String| -> Result<Vec<Json>, Box<dyn Error>> {
        let mut paths: Vec<PathBuf> = fs::read_dir(dir)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<_, _>>()?;
        paths.sort();
        paths
            .iter()
            .map(|path| Ok(Json::parse(&fs::read(path)?)?))
            .collect()
    };
    let job_size = V2Plan::mainnet()?.job_size;
    let (verified, records, store_evidence_root, stage_stores) = match (
        flags.contains_key("--records"),
        flags.contains_key("--extracts"),
    ) {
        (true, false) => {
            let records = json_files(flag("--records")?)?;
            let store_path = PathBuf::from(flag("--store")?);
            let store = Store::open(&store_path, &StoreConfig::standard())?;
            let verified =
                reconcile_offline(&store, &providers, &anchor, &d06, &d07, job_size, &records)?;
            let report = nqc_census_store::verify::verify_store(
                &store_path,
                &nqc_census_store::verify::VerifyRequest {
                    ranges: Vec::new(),
                    tips: Vec::new(),
                },
            )
            .map_err(|failure| format!("store verification failed: {failure:?}"))?;
            (verified, records, report.evidence_root, Vec::new())
        }
        (false, true) => {
            let extracts = json_files(flag("--extracts")?)?;
            let stage_stores = extracts
                .iter()
                .map(|extract| {
                    Ok(Json::object([
                        (
                            "record_sha256",
                            Json::string(extract.str_field("record_sha256")?),
                        ),
                        (
                            "store",
                            extract
                                .get("store")
                                .cloned()
                                .ok_or("extract without store")?,
                        ),
                    ]))
                })
                .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
            let (verified, records) =
                reconcile_extracts(&providers, &anchor, &d06, &d07, job_size, extracts)?;
            (
                verified,
                records,
                "NOT_MERGED_EACH_STAGE_STORE_IN_STAGE_STORES".to_owned(),
                stage_stores,
            )
        }
        _ => return Err("exactly one of --records and --extracts is required".into()),
    };
    let mut record_manifests = Vec::new();
    for record in &records {
        record_manifests.extend(manifests(record)?);
    }
    record_manifests.sort();
    record_manifests.dedup();
    let summary = write_closeout(
        &PathBuf::from(flag("--out-dir")?),
        &CloseoutContext {
            code_commit: &flag("--code-commit")?,
            code_tree: &flag("--code-tree")?,
            pins: &pins,
            store_evidence_root: &store_evidence_root,
            stage_stores,
            record_manifests,
        },
        &verified,
    )?;
    println!(
        "RMC008_CLOSEOUT_PASS aave_markets={} v2_markets={} unexplained={} unknown={} records={}",
        verified.aave.state_rows.len(),
        verified.v2.state_rows.len(),
        summary
            .get("unexplained_mismatches")
            .and_then(Json::as_i64)
            .unwrap_or(-1),
        summary
            .get("unknown_rejections")
            .and_then(Json::as_i64)
            .unwrap_or(-1),
        verified.records
    );
    Ok(())
}
