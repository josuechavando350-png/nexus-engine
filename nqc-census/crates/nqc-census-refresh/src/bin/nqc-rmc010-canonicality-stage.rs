//! Live BASE_CANONICALITY acquisition for RMC-010.
//!
//! --providers F --label L --pins F --pin-root DIR --base DIR
//! --anchor-number N --anchor-hash H --store DIR --out F

use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_chain::transport::{CurlTransport, RetryPolicy};
use nqc_census_refresh::base::read_base;
use nqc_census_refresh::canonical::base_canonicality_stage;
use nqc_census_state::inputs::{verify_pins, verify_upstream};
use nqc_census_store::{Store, StoreConfig};
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
    let providers = ProviderSet::parse(&fs::read(flag("--providers")?)?)?;
    let label = flag("--label")?;
    let provider = providers
        .iter()
        .find(|provider| provider.label() == label)
        .ok_or_else(|| format!("provider {label} is not declared"))?
        .clone();
    let pins_path = PathBuf::from(flag("--pins")?);
    let pins = verify_pins(&pins_path, &PathBuf::from(flag("--pin-root")?))?;
    verify_upstream(&pins_path, &pins)?;
    let anchor = anchor_from_flags(
        flags.get("--anchor-number").map(String::as_str),
        flags.get("--anchor-hash").map(String::as_str),
    )?;
    let plan = plan_at(&pins, anchor)?;
    let base = read_base(&PathBuf::from(flag("--base")?))?;
    let store = Store::create(&PathBuf::from(flag("--store")?), StoreConfig::standard())?;
    let transport = CurlTransport::new(180, 15);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let (record, rows) = base_canonicality_stage(&acquisition, &provider, &plan.anchor, &base)?;
    fs::write(flag("--out")?, record.canonical()?)?;
    println!(
        "RMC010_CANONICALITY_STAGE_PASS provider={} rows={} base={} target={} data_sha256={}",
        provider.label(),
        rows.len(),
        base.anchor_number,
        plan.anchor.number,
        record.str_field("data_sha256")?
    );
    Ok(())
}
