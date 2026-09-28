//! Builds the deterministic SYNTHETIC RMC-004 fixture store used by CI.
//!
//! Usage: cargo run --locked --example rmc004_fixture -- <new-store-dir>
//!
//! The fixture exercises storage semantics only. It is not market, liquidity,
//! capital, execution or profitability evidence.

#[path = "../tests/support/mod.rs"]
mod support;

use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(target) = std::env::args_os().nth(1) else {
        eprintln!("usage: rmc004_fixture <new-store-dir>");
        return ExitCode::from(2);
    };
    let target = std::path::PathBuf::from(target);
    if target.exists() {
        eprintln!("refusing to reuse existing path {}", target.display());
        return ExitCode::from(2);
    }
    match support::build_fixture(&target) {
        Ok((_, scopes)) => {
            println!("RMC_004_FIXTURE=SYNTHETIC_STORAGE_SEMANTICS_ONLY");
            for scope in scopes {
                match scope.id() {
                    Ok(id) => println!("scope={}", id.to_hex()),
                    Err(error) => {
                        eprintln!("RMC_004_FIXTURE_FAIL {error}");
                        return ExitCode::from(1);
                    }
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("RMC_004_FIXTURE_FAIL {error}");
            ExitCode::from(1)
        }
    }
}
