use std::fmt::{Debug, Formatter};
use std::sync::Arc;

/// Named points in every durable publication path.
///
/// The store consults an optional [`FaultHook`] at each point. When the hook
/// requests a fault the operation stops immediately with
/// [`crate::StoreError::InjectedFault`] and performs no cleanup, leaving the
/// filesystem exactly as a process killed at that instant would. A hook may
/// also terminate the process itself (for example with
/// `std::process::abort`) to exercise a genuine crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FaultPoint {
    /// Object bytes written and fsynced to a staging file; not yet linked.
    ObjectStaged,
    /// Object linked under its final name; directory entry not yet fsynced.
    ObjectLinked,
    /// Object and its directory entry are durable; staging name not yet removed.
    ObjectDurable,
    /// Checkpoint bytes staged and fsynced; not yet linked.
    CheckpointStaged,
    /// Checkpoint linked (committed); directory entry not yet fsynced.
    CheckpointLinked,
    /// Checkpoint durable; HEAD cache not yet updated.
    CheckpointDurable,
    /// New HEAD bytes staged and fsynced; rename not yet performed.
    HeadStaged,
    /// HEAD renamed into place; directory entry not yet fsynced.
    HeadRenamed,
}

impl FaultPoint {
    pub const ALL: [Self; 8] = [
        Self::ObjectStaged,
        Self::ObjectLinked,
        Self::ObjectDurable,
        Self::CheckpointStaged,
        Self::CheckpointLinked,
        Self::CheckpointDurable,
        Self::HeadStaged,
        Self::HeadRenamed,
    ];
}

/// Returns `true` to inject a fault at the given point.
pub type FaultFn = dyn Fn(FaultPoint) -> bool + Send + Sync;

/// Explicit, off-by-default test seam. A store without a hook never faults.
#[derive(Clone)]
pub struct FaultHook(Arc<FaultFn>);

impl FaultHook {
    pub fn new<F>(hook: F) -> Self
    where
        F: Fn(FaultPoint) -> bool + Send + Sync + 'static,
    {
        Self(Arc::new(hook))
    }

    /// Fault exactly at `point`, every time it is reached.
    pub fn at(point: FaultPoint) -> Self {
        Self::new(move |reached| reached == point)
    }

    pub(crate) fn fires(&self, point: FaultPoint) -> bool {
        (self.0)(point)
    }
}

impl Debug for FaultHook {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str("FaultHook(..)")
    }
}
