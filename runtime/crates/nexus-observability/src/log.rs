//! Structured logging.
//!
//! Line-delimited JSON on stderr. No log crate, no global subscriber, no
//! macro magic: a logger is a value you pass around, which makes it trivially
//! testable and keeps the dependency count at zero.
//!
//! Every record carries `trace_id` when one is in scope, so a task can be
//! followed from the sensor reading that caused it to the audit entry that
//! closed it.

use nexus_event::json::Value;
use nexus_event::{Timestamp, TraceId};
use std::io::Write;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    /// Parsed from configuration; unknown values fall back to info rather
    /// than failing a service start over a typo in an env var.
    pub fn parse_or_info(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "debug" => Level::Debug,
            "warn" | "warning" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    }
}

/// Where log lines go. Stderr in production, a buffer in tests.
pub trait LogSink: Send + Sync + std::fmt::Debug {
    fn write_line(&self, line: &str);
}

#[derive(Debug, Default)]
pub struct StderrSink;

impl LogSink for StderrSink {
    fn write_line(&self, line: &str) {
        let mut handle = std::io::stderr().lock();
        let _ = writeln!(handle, "{line}");
    }
}

#[derive(Debug, Default)]
pub struct BufferSink {
    lines: Mutex<Vec<String>>,
}

impl BufferSink {
    pub fn new() -> Self {
        BufferSink::default()
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines.lock().map(|guard| guard.clone()).unwrap_or_default()
    }
}

impl LogSink for BufferSink {
    fn write_line(&self, line: &str) {
        if let Ok(mut guard) = self.lines.lock() {
            guard.push(line.to_string());
        }
    }
}

#[derive(Debug, Clone)]
pub struct Logger {
    service: String,
    min_level: Level,
    sink: Arc<dyn LogSink>,
    trace_id: Option<String>,
}

impl Logger {
    pub fn new(service: impl Into<String>, min_level: Level, sink: Arc<dyn LogSink>) -> Self {
        Logger {
            service: service.into(),
            min_level,
            sink,
            trace_id: None,
        }
    }

    pub fn stderr(service: impl Into<String>, min_level: Level) -> Self {
        Logger::new(service, min_level, Arc::new(StderrSink))
    }

    /// Child logger pinned to one causal chain.
    pub fn with_trace(&self, trace_id: &TraceId) -> Logger {
        Logger {
            service: self.service.clone(),
            min_level: self.min_level,
            sink: Arc::clone(&self.sink),
            trace_id: Some(trace_id.as_str().to_string()),
        }
    }

    pub fn log(&self, level: Level, message: &str, fields: Vec<(&str, Value)>) {
        if level < self.min_level {
            return;
        }
        let mut entries = vec![
            ("ts", Value::number(Timestamp::now().as_millis() as f64)),
            ("level", Value::string(level.as_str())),
            ("service", Value::string(&self.service)),
            ("message", Value::string(message)),
        ];
        if let Some(trace_id) = &self.trace_id {
            entries.push(("trace_id", Value::string(trace_id)));
        }
        entries.extend(fields);
        self.sink.write_line(&Value::object(entries).to_canonical_string());
    }

    pub fn debug(&self, message: &str, fields: Vec<(&str, Value)>) {
        self.log(Level::Debug, message, fields);
    }

    pub fn info(&self, message: &str, fields: Vec<(&str, Value)>) {
        self.log(Level::Info, message, fields);
    }

    pub fn warn(&self, message: &str, fields: Vec<(&str, Value)>) {
        self.log(Level::Warn, message, fields);
    }

    pub fn error(&self, message: &str, fields: Vec<(&str, Value)>) {
        self.log(Level::Error, message, fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_line_delimited_json_with_the_expected_fields() {
        let sink = Arc::new(BufferSink::new());
        let logger = Logger::new("ingestd", Level::Info, sink.clone());
        logger.info("accepted", vec![("count", Value::number(3.0))]);

        let lines = sink.lines();
        assert_eq!(lines.len(), 1);
        let parsed = nexus_event::json::parse(&lines[0]).expect("valid json line");
        assert_eq!(parsed.require_str("service").unwrap(), "ingestd");
        assert_eq!(parsed.require_str("level").unwrap(), "info");
        assert_eq!(parsed.require_str("message").unwrap(), "accepted");
        assert_eq!(parsed.require_f64("count").unwrap(), 3.0);
    }

    #[test]
    fn respects_the_minimum_level() {
        let sink = Arc::new(BufferSink::new());
        let logger = Logger::new("graphd", Level::Warn, sink.clone());
        logger.info("ignored", vec![]);
        logger.debug("ignored", vec![]);
        logger.error("kept", vec![]);
        assert_eq!(sink.lines().len(), 1);
    }

    #[test]
    fn trace_id_propagates_to_child_loggers() {
        let sink = Arc::new(BufferSink::new());
        let logger = Logger::new("orchestratord", Level::Debug, sink.clone());
        let trace = TraceId::from_external("trc_abc");
        logger.with_trace(&trace).info("proposed", vec![]);
        let parsed = nexus_event::json::parse(&sink.lines()[0]).unwrap();
        assert_eq!(parsed.require_str("trace_id").unwrap(), "trc_abc");
    }

    #[test]
    fn log_lines_survive_hostile_message_content() {
        let sink = Arc::new(BufferSink::new());
        let logger = Logger::new("gatewayd", Level::Info, sink.clone());
        logger.info("break\"out\n{\"level\":\"error\"}", vec![]);
        // Injected content must stay inside the message string.
        let parsed = nexus_event::json::parse(&sink.lines()[0]).expect("still one json object");
        assert_eq!(parsed.require_str("level").unwrap(), "info");
    }
}
