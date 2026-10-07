//! Live negative control of RMC-010 base canonicality.
//!
//! --providers F --labels L1,L2 --pins F --pin-root DIR --base DIR
//! --anchor-number N --anchor-hash H --store DIR --out F
//!
//! Declares the certified base height with the real hash of the block before
//! it and requires the unchanged canonicality check, on live providers at the
//! target anchor, to refuse the refresh and name a full census. Exits nonzero
//! unless it refuses for exactly that reason.

use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_chain::transport::{CurlTransport, RetryPolicy};
use nqc_census_refresh::base::read_base;
use nqc_census_refresh::canonical::reorg_control;
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
    let declared = ProviderSet::parse(&fs::read(flag("--providers")?)?)?;
    let providers = flag("--labels")?
        .split(',')
        .map(|label| {
            declared
                .iter()
                .find(|provider| provider.label() == label)
                .cloned()
                .ok_or_else(|| format!("provider {label} is not declared"))
        })
        .collect::<Result<Vec<_>, _>>()?;
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
    let report = reorg_control(&acquisition, &providers, &plan.anchor, &base)?;
    fs::write(flag("--out")?, report.canonical()?)?;
    println!(
        "RMC010_REORG_CONTROL_REFUSED base={} declared={} certified={} providers={}",
        base.anchor_number,
        report.str_field("declared_control_hash")?,
        report.str_field("certified_base_hash")?,
        providers.len()
    );
    Ok(())
}
