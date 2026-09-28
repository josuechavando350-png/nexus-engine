//! Standalone offline verifier for an RMC-004 evidence store.
//!
//! Usage:
//!   nqc-census-store-verify --store <dir>
//!       [--require-range <scope-hex>:<first-block>:<last-block>]...
//!       [--expect-tip <scope-hex>:<checkpoint-hex>]...
//!
//! Exit status: 0 verified, 1 verification failed, 2 usage error.
//! Reads only the given directory. No network, RPC, secret, signer or service.

use nqc_census_store::verify::{verify_store, RangeRequirement, TipRequirement, VerifyRequest};
use nqc_census_store::{CheckpointId, HeadStatus, ScopeId, STORE_FORMAT_VERSION};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: nqc-census-store-verify --store <dir> \
[--require-range <scope-hex>:<first>:<last>]... [--expect-tip <scope-hex>:<checkpoint-hex>]...";

fn parse(args: &[String]) -> Result<(PathBuf, VerifyRequest), String> {
    let mut store = None;
    let mut request = VerifyRequest::default();
    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let value = iter
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag.as_str() {
            "--store" if store.is_none() => store = Some(PathBuf::from(value)),
            "--require-range" => {
                let mut parts = value.split(':');
                let (Some(scope), Some(first), Some(last), None) =
                    (parts.next(), parts.next(), parts.next(), parts.next())
                else {
                    return Err(format!("invalid --require-range {value}"));
                };
                request.ranges.push(RangeRequirement {
                    scope_id: ScopeId::parse_hex(scope).map_err(|error| error.to_string())?,
                    first: first
                        .parse()
                        .map_err(|_| format!("invalid first block {first}"))?,
                    last: last
                        .parse()
                        .map_err(|_| format!("invalid last block {last}"))?,
                });
            }
            "--expect-tip" => {
                let (scope, tip) = value
                    .split_once(':')
                    .ok_or_else(|| format!("invalid --expect-tip {value}"))?;
                request.tips.push(TipRequirement {
                    scope_id: ScopeId::parse_hex(scope).map_err(|error| error.to_string())?,
                    tip: CheckpointId::parse_hex(tip).map_err(|error| error.to_string())?,
                });
            }
            other => return Err(format!("unexpected argument {other}")),
        }
    }
    let store = store.ok_or_else(|| "--store is required".to_owned())?;
    Ok((store, request))
}

fn head_code(status: HeadStatus) -> String {
    match status {
        HeadStatus::Absent => "ABSENT".to_owned(),
        HeadStatus::Corrupt => "CORRUPT".to_owned(),
        HeadStatus::Consistent => "CONSISTENT".to_owned(),
        HeadStatus::Stale { head_sequence } => format!("STALE:{head_sequence}"),
    }
}

fn optional(value: Option<u64>) -> String {
    value.map_or_else(|| "NONE".to_owned(), |value| value.to_string())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (store, request) = match parse(&args) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("RMC_004_OFFLINE_VERIFY=USAGE_ERROR reason={message}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match verify_store(&store, &request) {
        Ok(report) => {
            println!("RMC_004_OFFLINE_VERIFY=PASS");
            println!("format_version={STORE_FORMAT_VERSION}");
            println!("config_id={}", report.config_id);
            println!("chunks={}", report.chunks);
            println!("artifacts={}", report.artifacts);
            println!("logical_bytes={}", report.logical_bytes);
            println!("stored_bytes={}", report.stored_bytes);
            println!("orphan_chunks={}", report.orphan_chunks);
            println!("orphan_artifacts={}", report.orphan_artifacts);
            println!("abandoned_registrations={}", report.abandoned_registrations);
            println!("staging_files={}", report.staging_files);
            println!("streams={}", report.streams.len());
            for stream in &report.streams {
                println!(
                    "stream={} checkpoints={} first_block={} last_block={} tip={} head={}",
                    stream.scope_id.to_hex(),
                    stream.checkpoints,
                    optional(stream.first_block),
                    optional(stream.last_block),
                    stream
                        .tip
                        .map_or_else(|| "NONE".to_owned(), |tip| tip.to_hex()),
                    head_code(stream.head),
                );
            }
            println!("ranges_certified={}", request.ranges.len());
            println!("tips_matched={}", request.tips.len());
            println!("evidence_root={}", report.evidence_root);
            ExitCode::SUCCESS
        }
        Err(failure) => {
            eprintln!("RMC_004_OFFLINE_VERIFY=FAIL {failure}");
            ExitCode::from(1)
        }
    }
}
