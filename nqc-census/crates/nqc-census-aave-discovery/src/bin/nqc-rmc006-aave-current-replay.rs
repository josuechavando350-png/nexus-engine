use nqc_census_aave_discovery::live::{anchor_from_flags, verify_current_surface};
use std::{collections::BTreeMap, env, error::Error, fs, path::Path};

fn main() -> Result<(), Box<dyn Error>> {
    let mut flags = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        if ![
            "--providers",
            "--current",
            "--store",
            "--out",
            "--anchor-number",
            "--anchor-hash",
        ]
        .contains(&flag.as_str())
        {
            return Err(format!("unknown argument {flag}").into());
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if flags.insert(flag.clone(), value).is_some() {
            return Err(format!("duplicate argument {flag}").into());
        }
    }
    let required = |flag: &str| -> Result<&str, Box<dyn Error>> {
        flags
            .get(flag)
            .map(String::as_str)
            .ok_or_else(|| format!("{flag} is required").into())
    };
    // Replay never inherits the live CLI's historical default anchor.
    let anchor = anchor_from_flags(
        Some(required("--anchor-number")?),
        Some(required("--anchor-hash")?),
    )?;
    let report = verify_current_surface(
        Path::new(required("--providers")?),
        Path::new(required("--current")?),
        Path::new(required("--store")?),
        anchor,
    )?;
    let out = Path::new(required("--out")?);
    if out.exists() {
        return Err("replay output already exists".into());
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(out, report.canonical()?)?;
    println!("RMC006_CURRENT_REPLAY_PASS providers=3 anchor={}", anchor.0);
    Ok(())
}
