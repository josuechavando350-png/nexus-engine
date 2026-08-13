//! # nexus-bench — load generator and measurement harness
//!
//! ## What this is for
//!
//! To replace guesses with numbers. NEXUS V3 makes **no** throughput claim
//! anywhere in its documentation; the only figures that may be quoted are the
//! ones this harness prints, on hardware it also prints.
//!
//! ## What it measures
//!
//! - envelope construction + integrity hashing
//! - canonical encode/decode round trip
//! - deduplication at a realistic window size
//! - entity resolution against a candidate set
//! - graph mutation apply
//!
//! ## What it does NOT measure
//!
//! Anything involving a network: broker throughput, Neo4j write latency,
//! WASM cold start under contention. Those need infrastructure and belong in
//! a separate load test against a real deployment. Reporting an in-process
//! number as if it were a system number would be exactly the kind of claim
//! this file exists to prevent.
//!
//! Run: `cargo run -p nexus-bench --release -- --events 100000`

use std::time::Instant;

use nexus_event::json::Value;
use nexus_event::{
    DedupIndex, EventEnvelope, SourceId, SourceType, Timestamp,
};
use nexus_graph::InMemoryGraph;
use nexus_observability::Histogram;
use nexus_ontology::store::{GraphMutation, GraphWriter};
use nexus_ontology::{normalize_telemetry, resolve, EntityKind};

/// Finer buckets than the service default: these operations are sub-millisecond.
const BENCH_BUCKETS_MS: &[f64] = &[
    0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 50.0,
];

struct Measurement {
    name: &'static str,
    operations: usize,
    elapsed_seconds: f64,
    histogram: Histogram,
}

impl Measurement {
    fn per_second(&self) -> f64 {
        if self.elapsed_seconds <= 0.0 {
            0.0
        } else {
            self.operations as f64 / self.elapsed_seconds
        }
    }

    fn print(&self) {
        let p = |q: f64| {
            self.histogram
                .quantile_upper_bound(q)
                .map(|value| {
                    if value.is_finite() {
                        format!("<={value} ms")
                    } else {
                        "overflow".to_string()
                    }
                })
                .unwrap_or_else(|| "n/a".into())
        };
        println!(
            "{:<28} {:>10} ops  {:>10.3} s  {:>12.0} ops/s   p50 {:<12} p95 {:<12} p99 {:<12} max {:.4} ms",
            self.name,
            self.operations,
            self.elapsed_seconds,
            self.per_second(),
            p(0.50),
            p(0.95),
            p(0.99),
            self.histogram.max(),
        );
    }
}

fn measure<F>(name: &'static str, operations: usize, mut body: F) -> Measurement
where
    F: FnMut(usize),
{
    let histogram = Histogram::new(BENCH_BUCKETS_MS);
    let started = Instant::now();
    for index in 0..operations {
        let iteration = Instant::now();
        body(index);
        histogram.observe(iteration.elapsed().as_secs_f64() * 1_000.0);
    }
    Measurement {
        name,
        operations,
        elapsed_seconds: started.elapsed().as_secs_f64(),
        histogram,
    }
}

fn envelope(index: usize) -> EventEnvelope {
    EventEnvelope::builder(
        SourceId::from_external(format!("temp-sensor-{}", index % 64)),
        SourceType::Sensor,
        "telemetry.temperature",
        Value::object(vec![
            ("asset", Value::string(format!("press-{}", index % 512))),
            ("zone", Value::string("press-hall")),
            ("celsius", Value::number(60.0 + (index % 40) as f64)),
        ]),
    )
    .occurred_at(Timestamp::from_millis(1_700_000_000_000 + index as i64))
    .sequence(index as u64)
    .build()
}

fn parse_events_argument() -> usize {
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--events" {
            if let Some(value) = arguments.next() {
                if let Ok(parsed) = value.parse::<usize>() {
                    return parsed.clamp(1_000, 5_000_000);
                }
            }
        }
    }
    50_000
}

fn hardware_note() -> String {
    // Reported, never assumed. If the platform does not expose it, the
    // report says so rather than printing a plausible-looking guess.
    let cores = std::thread::available_parallelism()
        .map(|value| value.get().to_string())
        .unwrap_or_else(|_| "unknown".into());
    format!(
        "os={} arch={} logical_cpus={} profile={}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        cores,
        if cfg!(debug_assertions) {
            "debug (numbers are NOT representative; use --release)"
        } else {
            "release"
        }
    )
}

fn main() {
    let count = parse_events_argument();

    println!("NEXUS V3 — in-process benchmark");
    println!("hardware: {}", hardware_note());
    println!("events  : {count}");
    println!(
        "scope   : in-process only. No broker, no graph database, no WASM engine.\n\
         \x20         These numbers do not describe system throughput.\n"
    );

    if cfg!(debug_assertions) {
        println!("WARNING: built without --release. Reported figures are not usable.\n");
    }

    let mut results = Vec::new();

    // 1. Envelope construction, including the integrity hash.
    results.push(measure("envelope_build+hash", count, |index| {
        let built = envelope(index);
        std::hint::black_box(&built);
    }));

    // 2. Canonical encode.
    let sample = envelope(1);
    results.push(measure("canonical_encode", count, |_| {
        std::hint::black_box(sample.to_canonical_string());
    }));

    // 3. Decode + validate.
    let encoded = sample.to_canonical_string();
    results.push(measure("decode+validate", count, |_| {
        let decoded = EventEnvelope::decode(&encoded);
        std::hint::black_box(decoded.is_ok());
    }));

    // 4. Deduplication at a 100k window.
    let mut dedup = DedupIndex::new(100_000);
    let keys: Vec<String> = (0..count).map(|index| envelope(index).idempotency_key()).collect();
    results.push(measure("dedup_check_insert", count, |index| {
        std::hint::black_box(dedup.check_and_insert(&keys[index]));
    }));

    // 5. Entity resolution against a realistic candidate set.
    let graph = InMemoryGraph::new();
    for index in 0..256 {
        let record = normalize_telemetry(&envelope(index)).expect("normalizes");
        let (_, _, mutations) =
            nexus_ontology::pipeline_for_telemetry(&envelope(index), &[], None).expect("pipeline");
        let _ = record;
        graph.apply(&mutations).expect("seed");
    }
    let candidates = graph.entities_of_kind(EntityKind::Asset);
    println!("resolution candidate set: {} entities\n", candidates.len());

    let records: Vec<_> = (0..count)
        .map(|index| normalize_telemetry(&envelope(index)).expect("normalizes"))
        .collect();
    results.push(measure("entity_resolution", count, |index| {
        std::hint::black_box(resolve(&records[index], &candidates));
    }));

    // 6. Graph mutation apply.
    let apply_graph = InMemoryGraph::new();
    let mutations: Vec<GraphMutation> = (0..count)
        .map(|index| {
            let (_, _, mutations) =
                nexus_ontology::pipeline_for_telemetry(&envelope(index), &[], None)
                    .expect("pipeline");
            mutations.into_iter().next().expect("one mutation")
        })
        .collect();
    results.push(measure("graph_apply_single", count, |index| {
        std::hint::black_box(apply_graph.apply(&mutations[index..index + 1]).is_ok());
    }));

    println!();
    for result in &results {
        result.print();
    }

    println!(
        "\nAll figures above are measured on this machine, in this process, in this run.\n\
         Percentiles are bucket upper bounds, not interpolated values.\n\
         Copy them into docs/research/V3_PERFORMANCE_TARGETS.md with the hardware line."
    );
}
