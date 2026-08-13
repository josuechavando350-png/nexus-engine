//! Resilience primitives shared by the ingest path and the services.
//!
//! Backoff, circuit breaking and bulkheading are implemented here rather than
//! scattered through call sites so their behaviour is testable in isolation
//! and identical everywhere.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

/// Exponential backoff with full jitter and a hard ceiling.
///
/// Jitter is derived deterministically from the attempt number and a seed, so
/// a replay produces the same schedule. Randomised jitter would make failure
/// tests flaky for no operational benefit at this scale.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    pub initial_millis: u64,
    pub max_millis: u64,
    pub jitter_seed: u64,
}

impl Backoff {
    pub fn new(initial_millis: u64, max_millis: u64) -> Self {
        Backoff {
            initial_millis: initial_millis.max(1),
            max_millis: max_millis.max(initial_millis.max(1)),
            jitter_seed: 0x9E3779B97F4A7C15,
        }
    }

    /// Delay before attempt `attempt` (0-based: attempt 0 is the first retry).
    pub fn delay_millis(&self, attempt: u32) -> u64 {
        let exponent = attempt.min(32);
        let raw = self
            .initial_millis
            .saturating_mul(1u64.checked_shl(exponent).unwrap_or(u64::MAX));
        let capped = raw.min(self.max_millis);

        // Full jitter in [capped/2, capped].
        let mixed = self
            .jitter_seed
            .wrapping_mul(attempt as u64 + 1)
            .rotate_left(17);
        let half = capped / 2;
        if half == 0 {
            capped
        } else {
            half + (mixed % (half + 1))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

/// Circuit breaker around a downstream dependency.
///
/// Opens after `failure_threshold` consecutive failures, stays open for
/// `cooldown_millis`, then admits a single probe.
#[derive(Debug)]
pub struct CircuitBreaker {
    failure_threshold: u32,
    cooldown_millis: u64,
    consecutive_failures: AtomicU64,
    opened_at_millis: AtomicU64,
    state: Mutex<CircuitState>,
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, cooldown_millis: u64) -> Self {
        CircuitBreaker {
            failure_threshold: failure_threshold.max(1),
            cooldown_millis,
            consecutive_failures: AtomicU64::new(0),
            opened_at_millis: AtomicU64::new(0),
            state: Mutex::new(CircuitState::Closed),
        }
    }

    pub fn state(&self) -> CircuitState {
        *self.state.lock().expect("circuit mutex poisoned")
    }

    /// Whether a call may proceed. `now_millis` is supplied so the breaker is
    /// testable without sleeping.
    pub fn allows(&self, now_millis: u64) -> bool {
        let mut state = self.state.lock().expect("circuit mutex poisoned");
        match *state {
            CircuitState::Closed | CircuitState::HalfOpen => true,
            CircuitState::Open => {
                let opened_at = self.opened_at_millis.load(Ordering::Relaxed);
                if now_millis.saturating_sub(opened_at) >= self.cooldown_millis {
                    *state = CircuitState::HalfOpen;
                    true
                } else {
                    false
                }
            }
        }
    }

    pub fn record_success(&self) {
        self.consecutive_failures.store(0, Ordering::Relaxed);
        let mut state = self.state.lock().expect("circuit mutex poisoned");
        *state = CircuitState::Closed;
    }

    pub fn record_failure(&self, now_millis: u64) {
        let failures = self.consecutive_failures.fetch_add(1, Ordering::Relaxed) + 1;
        let mut state = self.state.lock().expect("circuit mutex poisoned");
        if *state == CircuitState::HalfOpen || failures >= self.failure_threshold as u64 {
            *state = CircuitState::Open;
            self.opened_at_millis.store(now_millis, Ordering::Relaxed);
        }
    }
}

/// Bounded concurrency permit pool.
///
/// One bulkhead per downstream dependency means a slow graph cannot consume
/// every worker and starve the audit writer.
#[derive(Debug)]
pub struct Bulkhead {
    capacity: usize,
    in_flight: AtomicUsize,
    rejected: AtomicU64,
}

impl Bulkhead {
    pub fn new(capacity: usize) -> Self {
        Bulkhead {
            capacity: capacity.max(1),
            in_flight: AtomicUsize::new(0),
            rejected: AtomicU64::new(0),
        }
    }

    /// Returns `None` when the bulkhead is full.
    pub fn try_acquire(&self) -> Option<BulkheadPermit<'_>> {
        loop {
            let current = self.in_flight.load(Ordering::Acquire);
            if current >= self.capacity {
                self.rejected.fetch_add(1, Ordering::Relaxed);
                return None;
            }
            if self
                .in_flight
                .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Some(BulkheadPermit { bulkhead: self });
            }
        }
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }

    pub fn rejected(&self) -> u64 {
        self.rejected.load(Ordering::Relaxed)
    }
}

#[derive(Debug)]
pub struct BulkheadPermit<'a> {
    bulkhead: &'a Bulkhead,
}

impl Drop for BulkheadPermit<'_> {
    fn drop(&mut self) {
        self.bulkhead.in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_is_capped() {
        let backoff = Backoff::new(100, 5_000);
        let first = backoff.delay_millis(0);
        let later = backoff.delay_millis(10);
        assert!(first <= 100);
        assert!(later <= 5_000);
        assert!(
            later >= 2_500,
            "full jitter keeps at least half the ceiling"
        );
    }

    #[test]
    fn backoff_is_deterministic() {
        let backoff = Backoff::new(50, 1_000);
        for attempt in 0..8 {
            assert_eq!(
                backoff.delay_millis(attempt),
                backoff.delay_millis(attempt),
                "attempt {attempt} must be reproducible"
            );
        }
    }

    #[test]
    fn backoff_does_not_overflow_on_large_attempts() {
        let backoff = Backoff::new(1_000, 60_000);
        assert!(backoff.delay_millis(u32::MAX) <= 60_000);
    }

    #[test]
    fn circuit_opens_after_the_threshold_and_recovers_via_half_open() {
        let breaker = CircuitBreaker::new(3, 1_000);
        assert!(breaker.allows(0));

        breaker.record_failure(0);
        breaker.record_failure(0);
        assert_eq!(breaker.state(), CircuitState::Closed);
        breaker.record_failure(0);
        assert_eq!(breaker.state(), CircuitState::Open);
        assert!(!breaker.allows(500));

        assert!(breaker.allows(1_000));
        assert_eq!(breaker.state(), CircuitState::HalfOpen);

        breaker.record_success();
        assert_eq!(breaker.state(), CircuitState::Closed);
    }

    #[test]
    fn a_failed_probe_reopens_the_circuit_immediately() {
        let breaker = CircuitBreaker::new(2, 100);
        breaker.record_failure(0);
        breaker.record_failure(0);
        assert!(breaker.allows(100));
        breaker.record_failure(100);
        assert_eq!(breaker.state(), CircuitState::Open);
        assert!(!breaker.allows(150));
    }

    #[test]
    fn bulkhead_bounds_concurrency_and_releases_on_drop() {
        let bulkhead = Bulkhead::new(2);
        let first = bulkhead.try_acquire().expect("permit");
        let second = bulkhead.try_acquire().expect("permit");
        assert!(bulkhead.try_acquire().is_none());
        assert_eq!(bulkhead.rejected(), 1);
        drop(first);
        assert_eq!(bulkhead.in_flight(), 1);
        assert!(bulkhead.try_acquire().is_some());
        drop(second);
    }
}
