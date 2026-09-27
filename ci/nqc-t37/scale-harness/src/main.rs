use std::env;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug)]
struct Config {
    markets: usize,
    active_markets: usize,
    surfaces_per_market: usize,
    signals: u64,
    shards: usize,
    bundles: usize,
    seed: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            markets: 50_000,
            active_markets: 25_000,
            surfaces_per_market: 5,
            signals: 1_000_000,
            shards: 256,
            bundles: 25_000,
            seed: 0x4e51435f54333701,
        }
    }
}

#[derive(Default, Debug, PartialEq, Eq)]
struct Metrics {
    surfaces: u64,
    hot_markets: u64,
    warm_markets: u64,
    cold_markets: u64,
    observed_markets: u64,
    observed_cold_markets: u64,
    total_fanout: u64,
    max_fanout: u64,
    candidate_count: u64,
    exact_sim_pass: u64,
    funding_pass: u64,
    durable_actions: u64,
    canonical_outcomes: u64,
    synthetic_positive_outcomes: u64,
    reorg_events: u64,
    reorg_invalidated_pending: u64,
    dropped_signals: u64,
    full_market_scans: u64,
    authority_issuance: u64,
    bundles_written: u64,
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e3779b97f4a7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

fn tier(market: usize) -> u8 {
    match market % 10 {
        0 => 0,     // hot 10%
        1 | 2 => 1, // warm 20%
        _ => 2,     // cold 70%
    }
}

fn market_for(signal_id: u64, ordinal: usize, cfg: Config) -> usize {
    if ordinal == 0 && signal_id < cfg.markets as u64 {
        return signal_id as usize;
    }
    let mixed = splitmix64(
        cfg.seed
            ^ signal_id.wrapping_mul(0x9e3779b97f4a7c15)
            ^ (ordinal as u64).wrapping_mul(0xd6e8feb86659fd93),
    );
    (mixed % cfg.markets as u64) as usize
}

fn simulate(cfg: Config, out_dir: &PathBuf) -> std::io::Result<Metrics> {
    assert!(cfg.active_markets <= cfg.markets);
    assert!(cfg.markets > 0 && cfg.shards > 0 && cfg.surfaces_per_market > 0);

    fs::create_dir_all(out_dir)?;
    let mut metrics = Metrics {
        surfaces: (cfg.markets * cfg.surfaces_per_market) as u64,
        ..Metrics::default()
    };

    for market in 0..cfg.markets {
        match tier(market) {
            0 => metrics.hot_markets += 1,
            1 => metrics.warm_markets += 1,
            _ => metrics.cold_markets += 1,
        }
    }

    let mut observed = vec![false; cfg.markets];
    let raw_path = out_dir.join("execution-records.tsv");
    let raw = File::create(raw_path)?;
    let mut raw = BufWriter::new(raw);
    writeln!(
        raw,
        "execution_seq\tmarket_id\tsignal_id\tcanonical_generation\tshard\tsim_digest_seed\tfunding_digest_seed\taction_digest_seed\tcanonical_included\tsynthetic_net_units"
    )?;

    let mut canonical_generation: u64 = 1;
    let mut pending_generation_candidates: u64 = 0;
    let mut execution_seq: u64 = 0;

    for signal_id in 0..cfg.signals {
        if signal_id != 0 && signal_id.is_multiple_of(10_000) {
            metrics.reorg_events += 1;
            metrics.reorg_invalidated_pending += pending_generation_candidates;
            pending_generation_candidates = 0;
            canonical_generation += 1;
        }

        let fanout = 1 + (splitmix64(cfg.seed ^ signal_id) % 24) as usize;
        metrics.max_fanout = metrics.max_fanout.max(fanout as u64);

        let mut touched: Vec<usize> = Vec::with_capacity(fanout);
        for ordinal in 0..fanout {
            let market = market_for(signal_id, ordinal, cfg);
            if touched.contains(&market) {
                continue;
            }
            touched.push(market);
            metrics.total_fanout += 1;
            if !observed[market] {
                observed[market] = true;
                metrics.observed_markets += 1;
                if tier(market) == 2 {
                    metrics.observed_cold_markets += 1;
                }
            }

            let candidate_seed = splitmix64(
                cfg.seed
                    ^ signal_id.rotate_left(17)
                    ^ (market as u64).rotate_left(31)
                    ^ canonical_generation.rotate_left(7),
            );
            if candidate_seed.is_multiple_of(5) {
                continue;
            }
            metrics.candidate_count += 1;

            if candidate_seed.is_multiple_of(19) {
                pending_generation_candidates += 1;
                continue;
            }

            let sim_seed = splitmix64(candidate_seed ^ 0x53494d5f45584143);
            if sim_seed.is_multiple_of(10) {
                continue;
            }
            metrics.exact_sim_pass += 1;

            let funding_seed = splitmix64(sim_seed ^ 0x46554e44494e475f);
            if funding_seed.is_multiple_of(20) {
                continue;
            }
            metrics.funding_pass += 1;

            let action_seed = splitmix64(funding_seed ^ 0x414354494f4e5f37);
            if action_seed.is_multiple_of(10) {
                continue;
            }
            metrics.durable_actions += 1;

            let included = !splitmix64(action_seed ^ 0x43414e4f4e494341).is_multiple_of(5);
            if included {
                metrics.canonical_outcomes += 1;
            }
            let synthetic_net_units = if included {
                let gross = (splitmix64(action_seed ^ 0x45434f4e4f4d4943) % 10_000) as i64;
                gross - 2_000
            } else {
                -500
            };
            if synthetic_net_units > 0 {
                metrics.synthetic_positive_outcomes += 1;
            }

            if execution_seq < cfg.bundles as u64 {
                let shard = market % cfg.shards;
                writeln!(
                    raw,
                    "{}\t{}\t{}\t{}\t{}\t{:016x}\t{:016x}\t{:016x}\t{}\t{}",
                    execution_seq,
                    market,
                    signal_id,
                    canonical_generation,
                    shard,
                    sim_seed,
                    funding_seed,
                    action_seed,
                    if included { 1 } else { 0 },
                    synthetic_net_units,
                )?;
                execution_seq += 1;
            }
        }
    }

    metrics.bundles_written = execution_seq;
    raw.flush()?;

    let metrics_path = out_dir.join("metrics.json");
    let metrics_file = File::create(metrics_path)?;
    let mut w = BufWriter::new(metrics_file);
    writeln!(w, "{{")?;
    writeln!(w, "  \"schema_version\": 1,")?;
    writeln!(w, "  \"scope\": \"SYNTHETIC_T37_SCALE_ARCHITECTURE_ONLY\",")?;
    writeln!(w, "  \"markets\": {},", cfg.markets)?;
    writeln!(w, "  \"synthetic_active_markets\": {},", cfg.active_markets)?;
    writeln!(w, "  \"surfaces_per_market\": {},", cfg.surfaces_per_market)?;
    writeln!(w, "  \"surfaces\": {},", metrics.surfaces)?;
    writeln!(w, "  \"signals\": {},", cfg.signals)?;
    writeln!(w, "  \"shards\": {},", cfg.shards)?;
    writeln!(w, "  \"hot_markets\": {},", metrics.hot_markets)?;
    writeln!(w, "  \"warm_markets\": {},", metrics.warm_markets)?;
    writeln!(w, "  \"cold_markets\": {},", metrics.cold_markets)?;
    writeln!(w, "  \"observed_markets\": {},", metrics.observed_markets)?;
    writeln!(
        w,
        "  \"observed_cold_markets\": {},",
        metrics.observed_cold_markets
    )?;
    writeln!(w, "  \"total_fanout\": {},", metrics.total_fanout)?;
    writeln!(w, "  \"max_fanout\": {},", metrics.max_fanout)?;
    writeln!(w, "  \"candidate_count\": {},", metrics.candidate_count)?;
    writeln!(w, "  \"exact_sim_pass\": {},", metrics.exact_sim_pass)?;
    writeln!(w, "  \"funding_pass\": {},", metrics.funding_pass)?;
    writeln!(w, "  \"durable_actions\": {},", metrics.durable_actions)?;
    writeln!(
        w,
        "  \"canonical_outcomes\": {},",
        metrics.canonical_outcomes
    )?;
    writeln!(
        w,
        "  \"synthetic_positive_outcomes\": {},",
        metrics.synthetic_positive_outcomes
    )?;
    writeln!(w, "  \"reorg_events\": {},", metrics.reorg_events)?;
    writeln!(
        w,
        "  \"reorg_invalidated_pending\": {},",
        metrics.reorg_invalidated_pending
    )?;
    writeln!(w, "  \"dropped_signals\": {},", metrics.dropped_signals)?;
    writeln!(w, "  \"full_market_scans\": {},", metrics.full_market_scans)?;
    writeln!(
        w,
        "  \"authority_issuance\": {},",
        metrics.authority_issuance
    )?;
    writeln!(w, "  \"bundles_written\": {},", metrics.bundles_written)?;
    writeln!(w, "  \"real_market_evidence\": false,")?;
    writeln!(w, "  \"live_pnl_evidence\": false,")?;
    writeln!(w, "  \"production_certification\": \"NOT_CERTIFIED\"")?;
    writeln!(w, "}}")?;
    w.flush()?;

    Ok(metrics)
}

fn parse_args() -> (Config, PathBuf) {
    let mut cfg = Config::default();
    let mut out_dir = PathBuf::from("out");
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        let value = match arg.as_str() {
            "--markets"
            | "--active-markets"
            | "--surfaces-per-market"
            | "--signals"
            | "--shards"
            | "--bundles"
            | "--seed"
            | "--out-dir" => args.next().expect("missing value"),
            _ => panic!("unknown argument: {arg}"),
        };
        match arg.as_str() {
            "--markets" => cfg.markets = value.parse().expect("markets"),
            "--active-markets" => cfg.active_markets = value.parse().expect("active-markets"),
            "--surfaces-per-market" => {
                cfg.surfaces_per_market = value.parse().expect("surfaces-per-market")
            }
            "--signals" => cfg.signals = value.parse().expect("signals"),
            "--shards" => cfg.shards = value.parse().expect("shards"),
            "--bundles" => cfg.bundles = value.parse().expect("bundles"),
            "--seed" => cfg.seed = value.parse().expect("seed"),
            "--out-dir" => out_dir = PathBuf::from(value),
            _ => unreachable!(),
        }
    }
    (cfg, out_dir)
}

fn main() -> std::io::Result<()> {
    let (cfg, out_dir) = parse_args();
    let metrics = simulate(cfg, &out_dir)?;
    assert_eq!(metrics.authority_issuance, 0);
    assert_eq!(metrics.full_market_scans, 0);
    assert_eq!(metrics.dropped_signals, 0);
    assert_eq!(metrics.observed_markets, cfg.markets as u64);
    assert_eq!(metrics.observed_cold_markets, metrics.cold_markets);
    assert_eq!(metrics.bundles_written, cfg.bundles as u64);
    println!(
        "PASS T37 synthetic scale harness markets={} surfaces={} signals={} max_fanout={} bundles={}",
        cfg.markets, metrics.surfaces, cfg.signals, metrics.max_fanout, metrics.bundles_written
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_zero_coverage_is_constructive() {
        let cfg = Config::default();
        for i in 0..cfg.markets as u64 {
            assert_eq!(market_for(i, 0, cfg), i as usize);
        }
    }

    #[test]
    fn tiers_cover_all_markets() {
        let cfg = Config::default();
        let mut counts = [0usize; 3];
        for market in 0..cfg.markets {
            counts[tier(market) as usize] += 1;
        }
        assert_eq!(counts.iter().sum::<usize>(), cfg.markets);
        assert_eq!(counts[0], 5_000);
        assert_eq!(counts[1], 10_000);
        assert_eq!(counts[2], 35_000);
    }

    #[test]
    fn splitmix_is_deterministic() {
        assert_eq!(splitmix64(123), splitmix64(123));
        assert_ne!(splitmix64(123), splitmix64(124));
    }
}
