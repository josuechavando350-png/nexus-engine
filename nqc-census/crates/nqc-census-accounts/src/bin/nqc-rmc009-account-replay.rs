//! Offline replay of one RMC-009 stage from its own store. Needs no network.
//!
//! `--providers F --pins F --pin-root DIR [--candidates F] --record F
//!  --store DIR --stage-artifact NAME --out F`
//!
//! `--anchor-number N --anchor-hash H` and `--index-start S` select the plan
//! as for the stage run. `--candidates` is required for `ACCOUNT_STATE`.
//! The store is verified before and after, and the replay must not move its
//! evidence root.

use nqc_census_accounts::candidates::Candidates;
use nqc_census_accounts::extract::stage_extract;
use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_state::inputs::{verify_pins, verify_upstream};
use nqc_census_store::verify::{verify_store, VerifyReport, VerifyRequest};
use nqc_census_store::Store;
use std::collections::BTreeMap;
use std::path::Path;
use std::{env, error::Error, fs, path::PathBuf};

fn verified(store: &Path) -> Result<VerifyReport, Box<dyn Error>> {
    Ok(verify_store(store, &VerifyRequest::default()).map_err(|failure| failure.to_string())?)
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut flags = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if flags.insert(flag.clone(), value).is_some() {
            return Err(format!("{flag} given twice").into());
        }
    }
    let flag = |name: &str| -> Result<String, Box<dyn Error>> {
        Ok(flags
            .get(name)
            .cloned()
            .ok_or_else(|| format!("{name} is required"))?)
    };
    let providers: Vec<_> = ProviderSet::parse(&fs::read(flag("--providers")?)?)?
        .iter()
        .cloned()
        .collect();
    let pins_path = PathBuf::from(flag("--pins")?);
    let pins = verify_pins(&pins_path, &PathBuf::from(flag("--pin-root")?))?;
    verify_upstream(&pins_path, &pins)?;
    let mut plan = plan_at(
        &pins,
        anchor_from_flags(
            flags.get("--anchor-number").map(String::as_str),
            flags.get("--anchor-hash").map(String::as_str),
        )?,
    )?;
    if let Some(start) = flags.get("--index-start") {
        plan = plan.with_index_start(start.parse()?)?;
    }
    let candidates = match flags.get("--candidates") {
        Some(path) => Some(Candidates::from_jsonl(&fs::read(path)?)?),
        None => None,
    };
    let record = Json::parse(&fs::read(flag("--record")?)?)?;
    let root = PathBuf::from(flag("--store")?);
    let before = verified(&root)?;
    let summary = Json::object([
        ("stage_artifact", Json::string(flag("--stage-artifact")?)),
        ("evidence_root", Json::string(before.evidence_root.clone())),
        ("config_id", Json::string(before.config_id.clone())),
        ("streams", Json::uint(before.streams.len() as u64)),
        ("artifacts", Json::uint(before.artifacts)),
        ("chunks", Json::uint(before.chunks)),
        ("logical_bytes", Json::uint(before.logical_bytes)),
    ]);
    let extract = {
        let store = Store::open_existing(&root)?;
        stage_extract(
            &store,
            &providers,
            &plan,
            candidates.as_ref(),
            &record,
            summary,
        )?
    };
    let after = verified(&root)?;
    if after.evidence_root != before.evidence_root || after.streams != before.streams {
        return Err("replay changed the stage store's evidence root".into());
    }
    fs::write(flag("--out")?, extract.canonical()?)?;
    println!(
        "RMC009_REPLAY_PASS stage={} provider={} rows={} record_sha256={} data_sha256={} evidence_root={} streams={}",
        record.str_field("stage")?,
        record
            .get("provider")
            .ok_or("record names no provider")?
            .str_field("label")?,
        extract.get("row_count").and_then(Json::as_i64).ok_or("row_count")?,
        extract.str_field("record_sha256")?,
        extract.str_field("data_sha256")?,
        before.evidence_root,
        before.streams.len()
    );
    Ok(())
}
