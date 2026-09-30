//! One partitioned RMC-007 acquisition stage on one provider.
//!
//! `pair-created --providers F --label L --boundary F --partition K --partitions P --store DIR --out F`
//! `pairs --providers F --label L --current F --partition K --partitions P --store DIR --out F`

use nqc_census_chain::acquire::{partition_plan, Acquisition};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_chain::transport::{CurlTransport, RetryPolicy};
use nqc_census_store::{Store, StoreConfig};
use nqc_census_v2_discovery::stage::{pair_created_stage, pairs_stage, V2Plan};
use std::collections::BTreeMap;
use std::{env, error::Error, fs, path::PathBuf};

fn number(value: &Json, key: &str) -> Result<u64, Box<dyn Error>> {
    Ok(value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| format!("missing integer field {key}"))?)
}

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
    let store = Store::create(&PathBuf::from(flag("--store")?), StoreConfig::standard())?;
    let transport = CurlTransport::new(120, 15);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let plan = V2Plan::from_env_or_mainnet()?;
    let (record, rows) = match command.as_str() {
        "pair-created" => {
            let boundary = Json::parse(&fs::read(flag("--boundary")?)?)?;
            let parts = partition_plan(
                number(&boundary, "first_code_block")?,
                plan.anchor_number,
                flag("--partitions")?.parse()?,
            )?;
            let partition: usize = flag("--partition")?.parse()?;
            let (first, last) = *parts.get(partition).ok_or("partition out of range")?;
            pair_created_stage(&acquisition, &provider, &plan, first, last)?
        }
        "pairs" => {
            let current = Json::parse(&fs::read(flag("--current")?)?)?;
            let facts = current.get("facts").ok_or("current report has no facts")?;
            pairs_stage(
                &acquisition,
                &provider,
                &plan,
                number(facts, "pair_count")?,
                flag("--partition")?.parse()?,
                flag("--partitions")?.parse()?,
            )?
        }
        other => return Err(format!("unknown command {other}").into()),
    };
    fs::write(flag("--out")?, record.canonical()?)?;
    let metrics = format!(
        "RMC007_STAGE_PASS stage={} provider={} rows={} data_sha256={}",
        record.str_field("stage")?,
        provider.label(),
        rows.len(),
        record.str_field("data_sha256")?
    );
    println!("{metrics}");
    Ok(())
}
