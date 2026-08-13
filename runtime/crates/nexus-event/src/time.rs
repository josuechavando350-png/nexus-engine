//! Wall-clock and monotonic time helpers.
//!
//! Timestamps are milliseconds since the Unix epoch, stored as `i64` so that
//! clock skew between an edge device and the analytics zone can be expressed
//! as a negative delta instead of silently wrapping.

use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(i64);

impl Timestamp {
    pub const fn from_millis(millis: i64) -> Self {
        Timestamp(millis)
    }

    pub fn now() -> Self {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(delta) => Timestamp(delta.as_millis() as i64),
            // Pre-epoch system clock. Clamped rather than panicking: an edge
            // device with a dead RTC must still be able to emit telemetry,
            // and the ingest side detects the implausible timestamp.
            Err(_) => Timestamp(0),
        }
    }

    pub const fn as_millis(self) -> i64 {
        self.0
    }

    pub const fn saturating_add_millis(self, millis: i64) -> Self {
        Timestamp(self.0.saturating_add(millis))
    }

    /// Signed difference `self - other` in milliseconds.
    pub const fn delta_millis(self, other: Timestamp) -> i64 {
        self.0.saturating_sub(other.0)
    }

    pub const fn is_before(self, other: Timestamp) -> bool {
        self.0 < other.0
    }
}

/// A deterministic clock, so the whole pipeline can be replayed in tests and
/// in `nexus-sim` without depending on wall-clock time.
pub trait Clock: Send + Sync {
    fn now(&self) -> Timestamp;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }
}

/// Manually advanced clock for deterministic tests and replay.
#[derive(Debug)]
pub struct FixedClock {
    millis: std::sync::atomic::AtomicI64,
}

impl FixedClock {
    pub fn new(start: Timestamp) -> Self {
        FixedClock {
            millis: std::sync::atomic::AtomicI64::new(start.as_millis()),
        }
    }

    pub fn advance(&self, millis: i64) {
        self.millis
            .fetch_add(millis, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        Timestamp::from_millis(self.millis.load(std::sync::atomic::Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_clock_is_deterministic() {
        let clock = FixedClock::new(Timestamp::from_millis(1_000));
        assert_eq!(clock.now().as_millis(), 1_000);
        clock.advance(250);
        assert_eq!(clock.now().as_millis(), 1_250);
    }

    #[test]
    fn delta_can_be_negative_for_clock_skew() {
        let earlier = Timestamp::from_millis(100);
        let later = Timestamp::from_millis(400);
        assert_eq!(earlier.delta_millis(later), -300);
        assert_eq!(later.delta_millis(earlier), 300);
    }

    #[test]
    fn system_clock_is_after_2020() {
        assert!(SystemClock.now().as_millis() > 1_577_836_800_000);
    }
}
