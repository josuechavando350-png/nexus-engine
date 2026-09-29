//! One RMC-009 acquisition stage on one provider.
//!
//! `index --partition K --partitions P --providers F --label L --pins F --pin-root DIR --store DIR --out F`
//! `tokens --providers F --label L --pins F --pin-root DIR --store DIR --out F`
//! `state --candidates F --partition K --partitions P --providers F --label L --pins F --pin-root DIR --store DIR --out F`
//!
//! Inputs are the admitted D06 outputs, refused unless every file matches
//! its pinned sha256; `--candidates` must be the output of
//! `nqc-rmc009-account-candidates`.

use nqc_census_accounts::candidates::Candidates;
use nqc_census_accounts::index::account_index_stage;
use nqc_census_accounts::inputs::mainnet_plan;
use nqc_census_accounts::state::account_state_stage;
use nqc_census_accounts::tokens::account_tokens_stage;
use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_chain::transport::{CurlTransport, RetryPolicy};
use nqc_census_state::inputs::verify_pins;
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
    let number = |name: &str| -> Result<u64, Box<dyn Error>> { Ok(flag(name)?.parse()?) };
    let providers = ProviderSet::parse(&fs::read(flag("--providers")?)?)?;
    let label = flag("--label")?;
    let provider = providers
        .iter()
        .find(|provider| provider.label() == label)
        .ok_or_else(|| format!("provider {label} is not declared"))?
        .clone();
    let pins = verify_pins(
        &PathBuf::from(flag("--pins")?),
        &PathBuf::from(flag("--pin-root")?),
    )?;
    let plan = mainnet_plan(&pins)?;
    let store = Store::create(&PathBuf::from(flag("--store")?), StoreConfig::standard())?;
    let transport = CurlTransport::new(180, 15);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let (record, rows) = match command.as_str() {
        "index" => account_index_stage(
            &acquisition,
            &provider,
            &plan,
            number("--partition")?,
            number("--partitions")?,
        )?,
        "tokens" => account_tokens_stage(&acquisition, &provider, &plan)?,
        "state" => {
            let candidates = Candidates::from_jsonl(&fs::read(flag("--candidates")?)?)?;
            account_state_stage(
                &acquisition,
                &provider,
                &plan,
                &candidates,
                number("--partition")?,
                number("--partitions")?,
            )?
        }
        other => return Err(format!("unknown command {other}").into()),
    };
    fs::write(PathBuf::from(flag("--out")?), record.canonical()?)?;
    println!(
        "RMC009_STAGE_PASS stage={} provider={} rows={} data_sha256={}",
        record.str_field("stage")?,
        provider.label(),
        rows.len(),
        record.str_field("data_sha256")?
    );
    Ok(())
}
