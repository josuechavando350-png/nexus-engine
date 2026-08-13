//! Metrics registry: counters, gauges and histograms.
//!
//! Histogram buckets are explicit and fixed at construction. Percentiles are
//! computed from bucket boundaries, so a reported p99 is an upper bound of
//! the bucket, never an invented number. `docs/research/V3_PERFORMANCE_TARGETS.md`
//! states this so nobody quotes a bucket edge as a measurement.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Default latency buckets in milliseconds.
pub const DEFAULT_LATENCY_BUCKETS_MS: &[f64] = &[
    0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0,
];

#[derive(Debug, Default)]
pub struct Counter(AtomicU64);

impl Counter {
    pub fn incr(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    pub fn add(&self, amount: u64) {
        self.0.fetch_add(amount, Ordering::Relaxed);
    }
    pub fn value(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Default)]
pub struct Gauge(AtomicI64);

impl Gauge {
    pub fn set(&self, value: i64) {
        self.0.store(value, Ordering::Relaxed);
    }
    pub fn add(&self, delta: i64) {
        self.0.fetch_add(delta, Ordering::Relaxed);
    }
    pub fn value(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Debug)]
pub struct Histogram {
    bounds: Vec<f64>,
    counts: Mutex<Vec<u64>>,
    sum: Mutex<f64>,
    total: AtomicU64,
    max: Mutex<f64>,
}

impl Histogram {
    pub fn new(bounds: &[f64]) -> Self {
        let mut sorted = bounds.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let len = sorted.len() + 1; // +1 for the overflow bucket
        Histogram {
            bounds: sorted,
            counts: Mutex::new(vec![0; len]),
            sum: Mutex::new(0.0),
            total: AtomicU64::new(0),
            max: Mutex::new(f64::MIN),
        }
    }

    pub fn observe(&self, value: f64) {
        if !value.is_finite() {
            return;
        }
        let index = match self.bounds.iter().position(|bound| value <= *bound) {
            Some(index) => index,
            None => self.bounds.len(),
        };
        if let Ok(mut counts) = self.counts.lock() {
            counts[index] += 1;
        }
        if let Ok(mut sum) = self.sum.lock() {
            *sum += value;
        }
        if let Ok(mut max) = self.max.lock() {
            if value > *max {
                *max = value;
            }
        }
        self.total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn count(&self) -> u64 {
        self.total.load(Ordering::Relaxed)
    }

    pub fn mean(&self) -> f64 {
        let count = self.count();
        if count == 0 {
            return 0.0;
        }
        self.sum.lock().map(|sum| *sum).unwrap_or(0.0) / count as f64
    }

    pub fn max(&self) -> f64 {
        let value = self.max.lock().map(|max| *max).unwrap_or(f64::MIN);
        if value == f64::MIN {
            0.0
        } else {
            value
        }
    }

    /// Upper bound of the bucket containing the requested quantile.
    ///
    /// Returns `None` when no observation has been recorded, and `f64::INFINITY`
    /// when the quantile falls in the overflow bucket. Never interpolates:
    /// an interpolated percentile from coarse buckets is a made-up number.
    pub fn quantile_upper_bound(&self, quantile: f64) -> Option<f64> {
        let total = self.count();
        if total == 0 {
            return None;
        }
        let target = (quantile.clamp(0.0, 1.0) * total as f64).ceil().max(1.0) as u64;
        let counts = self.counts.lock().ok()?;
        let mut cumulative = 0u64;
        for (index, count) in counts.iter().enumerate() {
            cumulative += count;
            if cumulative >= target {
                return Some(match self.bounds.get(index) {
                    Some(bound) => *bound,
                    None => f64::INFINITY,
                });
            }
        }
        Some(f64::INFINITY)
    }
}

/// Named metric families for one process.
#[derive(Debug, Default)]
pub struct Metrics {
    counters: Mutex<BTreeMap<String, Arc<Counter>>>,
    gauges: Mutex<BTreeMap<String, Arc<Gauge>>>,
    histograms: Mutex<BTreeMap<String, Arc<Histogram>>>,
}

impl Metrics {
    pub fn new() -> Self {
        Metrics::default()
    }

    pub fn counter(&self, name: &str) -> Arc<Counter> {
        let mut counters = self.counters.lock().expect("metrics mutex poisoned");
        Arc::clone(
            counters
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(Counter::default())),
        )
    }

    pub fn gauge(&self, name: &str) -> Arc<Gauge> {
        let mut gauges = self.gauges.lock().expect("metrics mutex poisoned");
        Arc::clone(
            gauges
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(Gauge::default())),
        )
    }

    pub fn histogram(&self, name: &str) -> Arc<Histogram> {
        let mut histograms = self.histograms.lock().expect("metrics mutex poisoned");
        Arc::clone(
            histograms
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(Histogram::new(DEFAULT_LATENCY_BUCKETS_MS))),
        )
    }

    /// Prometheus-style text exposition.
    pub fn render_text(&self) -> String {
        let mut out = String::new();
        if let Ok(counters) = self.counters.lock() {
            for (name, counter) in counters.iter() {
                out.push_str(&format!("{name} {}\n", counter.value()));
            }
        }
        if let Ok(gauges) = self.gauges.lock() {
            for (name, gauge) in gauges.iter() {
                out.push_str(&format!("{name} {}\n", gauge.value()));
            }
        }
        if let Ok(histograms) = self.histograms.lock() {
            for (name, histogram) in histograms.iter() {
                out.push_str(&format!("{name}_count {}\n", histogram.count()));
                out.push_str(&format!("{name}_mean {:.3}\n", histogram.mean()));
                for quantile in [0.5, 0.95, 0.99] {
                    if let Some(value) = histogram.quantile_upper_bound(quantile) {
                        let label = (quantile * 100.0) as u32;
                        out.push_str(&format!("{name}_p{label}_upper_bound {value}\n"));
                    }
                }
            }
        }
        out
    }
}

/// Metric names used across the runtime. Centralised so dashboards do not
/// depend on a string literal buried in a service.
pub mod names {
    pub const INGEST_ACCEPTED: &str = "nexus_ingest_accepted_total";
    pub const INGEST_REJECTED: &str = "nexus_ingest_rejected_total";
    pub const INGEST_DUPLICATE: &str = "nexus_ingest_duplicate_total";
    pub const INGEST_DEADLETTERED: &str = "nexus_ingest_deadlettered_total";
    pub const INGEST_LAG_MS: &str = "nexus_ingest_lag_ms";
    pub const DLQ_SIZE: &str = "nexus_deadletter_size";
    pub const QUEUE_DEPTH: &str = "nexus_queue_depth";
    pub const GRAPH_MUTATION_LATENCY_MS: &str = "nexus_graph_mutation_latency_ms";
    pub const TASK_PROPOSAL_LATENCY_MS: &str = "nexus_task_proposal_latency_ms";
    pub const TASK_APPROVAL_LATENCY_MS: &str = "nexus_task_approval_latency_ms";
    pub const EDGE_EXECUTION_LATENCY_MS: &str = "nexus_edge_execution_latency_ms";
    pub const POLICY_DENIED: &str = "nexus_policy_denied_total";
    pub const POLICY_APPROVAL_REQUIRED: &str = "nexus_policy_approval_required_total";
    pub const CIRCUIT_OPEN: &str = "nexus_circuit_open";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_and_gauges_accumulate() {
        let metrics = Metrics::new();
        metrics.counter("a").incr();
        metrics.counter("a").add(4);
        metrics.gauge("b").set(10);
        metrics.gauge("b").add(-3);
        assert_eq!(metrics.counter("a").value(), 5);
        assert_eq!(metrics.gauge("b").value(), 7);
    }

    #[test]
    fn histogram_reports_bucket_upper_bounds_not_interpolations() {
        let histogram = Histogram::new(&[1.0, 10.0, 100.0]);
        for _ in 0..99 {
            histogram.observe(5.0);
        }
        histogram.observe(90.0);
        assert_eq!(histogram.count(), 100);
        assert_eq!(histogram.quantile_upper_bound(0.5), Some(10.0));
        assert_eq!(histogram.quantile_upper_bound(0.99), Some(10.0));
        assert_eq!(histogram.quantile_upper_bound(1.0), Some(100.0));
    }

    #[test]
    fn empty_histogram_has_no_quantile() {
        let histogram = Histogram::new(&[1.0]);
        assert_eq!(histogram.quantile_upper_bound(0.5), None);
        assert_eq!(histogram.mean(), 0.0);
        assert_eq!(histogram.max(), 0.0);
    }

    #[test]
    fn overflow_bucket_reports_infinity_rather_than_a_guess() {
        let histogram = Histogram::new(&[1.0]);
        histogram.observe(9_000.0);
        assert_eq!(histogram.quantile_upper_bound(0.99), Some(f64::INFINITY));
    }

    #[test]
    fn render_text_lists_every_family() {
        let metrics = Metrics::new();
        metrics.counter(names::INGEST_ACCEPTED).incr();
        metrics.histogram(names::INGEST_LAG_MS).observe(3.0);
        let text = metrics.render_text();
        assert!(text.contains(names::INGEST_ACCEPTED));
        assert!(text.contains("nexus_ingest_lag_ms_count 1"));
    }
}
