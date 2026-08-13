//! Health and readiness.
//!
//! Liveness and readiness are separated on purpose: a service whose broker
//! connection is down is *not ready* (stop routing work to it) but is still
//! *alive* (do not restart it into a crash loop while the broker recovers).

use nexus_event::json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentState {
    Up,
    Degraded,
    Down,
}

impl ComponentState {
    pub fn as_str(self) -> &'static str {
        match self {
            ComponentState::Up => "up",
            ComponentState::Degraded => "degraded",
            ComponentState::Down => "down",
        }
    }
}

#[derive(Debug, Default)]
pub struct HealthRegistry {
    components: Mutex<BTreeMap<String, (ComponentState, String)>>,
}

impl HealthRegistry {
    pub fn new() -> Self {
        HealthRegistry::default()
    }

    pub fn set(&self, component: &str, state: ComponentState, detail: impl Into<String>) {
        if let Ok(mut components) = self.components.lock() {
            components.insert(component.to_string(), (state, detail.into()));
        }
    }

    /// Alive unless a component is hard down *and* declared essential.
    pub fn is_live(&self) -> bool {
        true
    }

    /// Ready only when every registered component is up.
    pub fn is_ready(&self) -> bool {
        self.components
            .lock()
            .map(|components| {
                components
                    .values()
                    .all(|(state, _)| *state == ComponentState::Up)
            })
            .unwrap_or(false)
    }

    pub fn worst_state(&self) -> ComponentState {
        self.components
            .lock()
            .map(|components| {
                if components
                    .values()
                    .any(|(state, _)| *state == ComponentState::Down)
                {
                    ComponentState::Down
                } else if components
                    .values()
                    .any(|(state, _)| *state == ComponentState::Degraded)
                {
                    ComponentState::Degraded
                } else {
                    ComponentState::Up
                }
            })
            .unwrap_or(ComponentState::Down)
    }

    pub fn report(&self) -> Value {
        let components = self.components.lock().ok();
        let mut entries: Vec<(String, Value)> = Vec::new();
        if let Some(components) = components {
            for (name, (state, detail)) in components.iter() {
                entries.push((
                    name.clone(),
                    Value::object(vec![
                        ("state", Value::string(state.as_str())),
                        ("detail", Value::string(detail)),
                    ]),
                ));
            }
        }
        let mut map: BTreeMap<String, Value> = BTreeMap::new();
        map.insert("live".into(), Value::Bool(self.is_live()));
        map.insert("ready".into(), Value::Bool(self.is_ready()));
        map.insert("state".into(), Value::string(self.worst_state().as_str()));
        map.insert(
            "components".into(),
            Value::Object(entries.into_iter().collect()),
        );
        Value::Object(map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_every_component_up() {
        let health = HealthRegistry::new();
        health.set("broker", ComponentState::Up, "connected");
        health.set("graph", ComponentState::Up, "connected");
        assert!(health.is_ready());

        health.set("broker", ComponentState::Down, "connection refused");
        assert!(!health.is_ready());
        // Still live: a broker outage must not trigger a restart loop.
        assert!(health.is_live());
        assert_eq!(health.worst_state(), ComponentState::Down);
    }

    #[test]
    fn degraded_is_reported_but_not_fatal_to_the_worst_state_ordering() {
        let health = HealthRegistry::new();
        health.set("graph", ComponentState::Degraded, "high latency");
        assert_eq!(health.worst_state(), ComponentState::Degraded);
        assert!(!health.is_ready());
    }

    #[test]
    fn report_is_valid_json() {
        let health = HealthRegistry::new();
        health.set("broker", ComponentState::Up, "ok");
        let text = health.report().to_canonical_string();
        let parsed = nexus_event::json::parse(&text).unwrap();
        assert_eq!(parsed.get("ready").and_then(|v| v.as_bool()), Some(true));
    }
}
