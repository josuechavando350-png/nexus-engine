//! One RMC-008 acquisition stage on one provider.
//!
//! `aave --providers F --label L --pins F --pin-root DIR --store DIR --out F`
//! `v2-factory --providers F --label L --pins F --pin-root DIR --store DIR --out F`
//! `v2-state --providers F --label L --pins F --pin-root DIR --partition K --partitions P --store DIR --out F`
//!
//! Inputs are the admitted D06/D07 outputs, refused unless every file matches
//! its pinned sha256.

use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_chain::transport::{CurlTransport, RetryPolicy};
use nqc_census_state::aave_stage::aave_state_stage;
use nqc_census_state::inputs::{pinned, verify_pins, verify_upstream, D06Inputs, D07Inputs};
use nqc_census_state::stage::AnchorPlan;
use nqc_census_state::v2_stage::{factory_samples, v2_factory_stage, v2_state_stage, V2Plan};
use nqc_census_store::{Store, StoreConfig};
use std::collections::BTreeMap;
use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("missing command")?;
    let mut flags = BTreeMap::new();
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
    let label = flag("--label")?;
    let provider = providers
        .iter()
        .find(|provider| provider.label() == label)
        .ok_or_else(|| format!("provider {label} is not declared"))?
        .clone();
    let pins_path = PathBuf::from(flag("--pins")?);
    let pins = verify_pins(&pins_path, &PathBuf::from(flag("--pin-root")?))?;
    verify_upstream(&pins_path, &pins)?;
    let store = Store::create(&PathBuf::from(flag("--store")?), StoreConfig::standard())?;
    let transport = CurlTransport::new(120, 15);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let anchor = AnchorPlan::mainnet()?;
    let v2 = |job_size: usize| -> Result<(D07Inputs, V2Plan), Box<dyn Error>> {
        let d07 = D07Inputs::read(
            pinned(&pins, "d07_current_surface")?,
            pinned(&pins, "d07_deployment_admission")?,
            pinned(&pins, "d07_pair_manifest")?,
            &anchor,
        )?;
        let plan = d07.plan(anchor.clone(), job_size);
        Ok((d07, plan))
    };
    let (record, rows) = match command.as_str() {
        "aave" => {
            let d06 = D06Inputs::read(
                pinned(&pins, "d06_current_surface")?,
                pinned(&pins, "d06_deployment_manifest")?,
                pinned(&pins, "d06_reserve_manifest")?,
                &anchor,
            )?;
            aave_state_stage(&acquisition, &provider, &d06.plan(anchor.clone()))?
        }
        "v2-factory" => {
            let (d07, plan) = v2(V2Plan::mainnet()?.job_size)?;
            let samples = factory_samples(&d07.pairs);
            if samples.is_empty() {
                return Err("no admitted pair".into());
            }
            v2_factory_stage(&acquisition, &provider, &plan, &samples)?
        }
        "v2-state" => {
            let (d07, plan) = v2(V2Plan::mainnet()?.job_size)?;
            v2_state_stage(
                &acquisition,
                &provider,
                &plan,
                &d07.pairs,
                flag("--partition")?.parse()?,
                flag("--partitions")?.parse()?,
            )?
        }
        other => return Err(format!("unknown command {other}").into()),
    };
    fs::write(flag("--out")?, record.canonical()?)?;
    println!(
        "RMC008_STAGE_PASS stage={} provider={} rows={} data_sha256={}",
        record.str_field("stage")?,
        provider.label(),
        rows.len(),
        record.str_field("data_sha256")?
    );
    Ok(())
}
