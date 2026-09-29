//! Offline replay of one RMC-010 BASE_CANONICALITY stage.
//!
//! --providers F --pins F --pin-root DIR --base DIR --anchor-number N
//! --anchor-hash H --record F --store DIR --stage-artifact NAME --out F

use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_refresh::base::read_base;
use nqc_census_refresh::canonical_extract::stage_extract;
use nqc_census_state::inputs::verify_pins;
use nqc_census_store::verify::{verify_store, VerifyRequest};
use nqc_census_store::Store;
use std::collections::BTreeMap;
use std::{env, error::Error, fs, path::PathBuf};

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
    let pins = verify_pins(
        &PathBuf::from(flag("--pins")?),
        &PathBuf::from(flag("--pin-root")?),
    )?;
    let anchor = anchor_from_flags(
        flags.get("--anchor-number").map(String::as_str),
        flags.get("--anchor-hash").map(String::as_str),
    )?;
    let plan = plan_at(&pins, anchor)?;
    let base = read_base(&PathBuf::from(flag("--base")?))?;
    let record = Json::parse(&fs::read(flag("--record")?)?)?;
    let root = PathBuf::from(flag("--store")?);
    let before =
        verify_store(&root, &VerifyRequest::default()).map_err(|failure| failure.to_string())?;
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
        stage_extract(&store, &providers, &plan.anchor, &base, &record, summary)?
    };
    let after =
        verify_store(&root, &VerifyRequest::default()).map_err(|failure| failure.to_string())?;
    if after.evidence_root != before.evidence_root || after.streams != before.streams {
        return Err("canonicality replay changed the stage store".into());
    }
    fs::write(flag("--out")?, extract.canonical()?)?;
    println!(
        "RMC010_CANONICALITY_REPLAY_PASS provider={} record_sha256={} data_sha256={} evidence_root={}",
        record
            .get("provider")
            .ok_or("record names no provider")?
            .str_field("label")?,
        extract.str_field("record_sha256")?,
        extract.str_field("data_sha256")?,
        before.evidence_root
    );
    Ok(())
}
