//! Source-pinned, measured-rate export for a bounded GAUSS linear-system bridge.
//! A rate from an archive is an observation, not a forecast, causal estimate,
//! externally authenticated fact, or a proof that a numerical answer is true.
use crate::handoff::{Direction, GaussProblemV1, HandoffLimits, Objective};
use crate::semantic_archive::SemanticArchive;
use crate::semantics::Unit;

pub const BRIDGE_PROTOCOL: &str = "LEIBNIZ_MEASURED_RATE_V1";

#[derive(Clone, Debug)]
pub struct RateSelection {
    pub problem_id: String,
    pub as_of_utc_ms: i64,
    pub from_entity: String,
    pub to_entity: String,
    pub target_unit_symbol: String,
    pub direction: Direction,
}

fn hex(value: &str) -> String {
    let mut output = String::with_capacity(value.len().saturating_mul(2));
    for byte in value.as_bytes() {
        use std::fmt::Write;
        write!(&mut output, "{byte:02x}").expect("hex encoding cannot fail");
    }
    output
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.len() > 256
        || !token
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        return Err("bridge problem_id must be a bounded GAUSS token".into());
    }
    Ok(())
}

/// The caller obtains `pinned_bytes` through an independent, trusted channel.
/// Equality protects against substitution relative to that pin; it does NOT
/// authenticate who created the pin or whether the reported measurement is real.
/// The caller must authorize objective, selection, source and executable.
/// Returns one ASCII line, with UTF-8 labels encoded as unambiguous hex bytes.
#[allow(clippy::too_many_arguments)]
pub fn export_measured_rate(
    archive_bytes: &[u8],
    pinned_bytes: &[u8],
    selection: &RateSelection,
    limits: HandoffLimits,
) -> Result<String, String> {
    validate_token(&selection.problem_id)?;
    if archive_bytes.is_empty() || archive_bytes != pinned_bytes {
        return Err("bridge archive does not match independently pinned bytes".into());
    }
    if selection.from_entity == selection.to_entity
        || selection.from_entity.trim().is_empty()
        || selection.to_entity.trim().is_empty()
        || selection.target_unit_symbol.trim().is_empty()
    {
        return Err("bridge requires distinct, nonempty endpoints and a unit".into());
    }
    let archive = SemanticArchive::from_bytes(archive_bytes)?;
    let target: Unit = archive
        .snapshot
        .flows
        .iter()
        .find(|f| {
            f.from_entity == selection.from_entity
                && f.to_entity == selection.to_entity
                && f.annotation.unit.symbol == selection.target_unit_symbol
        })
        .ok_or("bridge target unit is not declared for the selected edge")?
        .annotation
        .unit
        .clone();
    let prepared = GaussProblemV1::prepare(
        &archive,
        selection.problem_id.clone(),
        selection.as_of_utc_ms,
        Objective {
            metric: "measured_flow_sum".into(),
            subject_entity_id: selection.from_entity.clone(),
            unit: target.clone(),
            direction: selection.direction,
        },
        limits,
    )?;
    let measured = prepared.measured_flow_sum_against_trusted_source(
        &selection.from_entity,
        &selection.to_entity,
        &target,
        &archive,
        limits,
    )?;
    if !measured.value.is_finite() || measured.value == 0.0 && measured.value.is_sign_negative() {
        return Err("bridge refuses nonfinite or negative-zero measurements".into());
    }
    if measured.evidence_ids.is_empty() || measured.evidence_ids.len() > limits.max_numeric_records
    {
        return Err("bridge measurement has no bounded evidence".into());
    }
    // Dimension names are hex-encoded before joining: no user string can
    // impersonate a separator, and a symbol cannot silently change dimension.
    let dimension = target
        .dimension
        .powers()
        .iter()
        .map(|(name, power)| format!("{}={power}", hex(name)))
        .collect::<Vec<_>>()
        .join(",");
    let mut fields = vec![
        BRIDGE_PROTOCOL.to_owned(),
        hex(&selection.problem_id),
        selection.as_of_utc_ms.to_string(),
        hex(&selection.from_entity),
        hex(&selection.to_entity),
        format!("{:016x}", measured.value.to_bits()),
        hex(&measured.unit.symbol),
        dimension,
        measured.evidence_ids.len().to_string(),
    ];
    fields.extend(measured.evidence_ids.iter().map(|id| hex(id)));
    Ok(fields.join("\t"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Entity, Flow};
    use crate::semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity};
    use crate::Graph;
    use std::collections::HashMap;

    fn sample(first: f64, second: f64) -> Vec<u8> {
        let mut graph = Graph::new();
        for id in ["source", "left", "right"] {
            graph
                .add_entity(Entity {
                    id: id.into(),
                    category: "Test".into(),
                    attributes: HashMap::new(),
                })
                .unwrap();
        }
        for (to, rate) in [("left", first), ("right", second)] {
            graph
                .add_flow(Flow {
                    from_entity: "source".into(),
                    to_entity: to.into(),
                    rate_of_transfer: rate,
                })
                .unwrap();
        }
        let unit = Unit::new(
            "contacts/s",
            Dimension::new([("contacts".into(), 1), ("time".into(), -1)]).unwrap(),
            1.0,
        )
        .unwrap();
        let annotations = ["observation:left", "observation:right"]
            .into_iter()
            .map(|id| {
                Annotation::new(unit.clone(), Validity::new(100, Some(200)).unwrap(), id).unwrap()
            })
            .collect();
        let snapshot = SemanticSnapshot::from_graph(&graph, annotations, vec![]).unwrap();
        SemanticArchive::new(graph, snapshot)
            .unwrap()
            .to_bytes()
            .unwrap()
    }
    fn selection(to: &str) -> RateSelection {
        RateSelection {
            problem_id: "measurement-42".into(),
            as_of_utc_ms: 150,
            from_entity: "source".into(),
            to_entity: to.into(),
            target_unit_symbol: "contacts/s".into(),
            direction: Direction::Maximize,
        }
    }
    fn run(bytes: &[u8], selected: &RateSelection) -> Result<String, String> {
        export_measured_rate(bytes, bytes, selected, HandoffLimits::default())
    }

    #[test]
    fn distinct_real_archive_values_generate_distinct_ieee754_bits_and_evidence() {
        let bytes = sample(2.5, 7.25);
        let left = run(&bytes, &selection("left")).unwrap();
        let right = run(&bytes, &selection("right")).unwrap();
        assert!(left.starts_with(BRIDGE_PROTOCOL));
        assert!(left.contains("4004000000000000"));
        assert!(right.contains("401d000000000000"));
        assert!(left.ends_with("6f62736572766174696f6e3a6c656674"));
        assert!(right.ends_with("6f62736572766174696f6e3a7269676874"));
    }
    #[test]
    fn modified_measurement_cannot_reuse_previous_source_pin() {
        let original = sample(2.5, 7.25);
        let changed = sample(99.0, 7.25);
        assert!(export_measured_rate(
            &changed,
            &original,
            &selection("left"),
            HandoffLimits::default()
        )
        .is_err());
    }
    #[test]
    fn missing_expired_and_cross_edge_measurements_are_refused() {
        let original = sample(2.5, 7.25);
        let mut expired = selection("left");
        expired.as_of_utc_ms = 200;
        assert!(run(&original, &expired).is_err());
        assert!(run(&original, &selection("unknown")).is_err());
        let mut wrong_unit = selection("left");
        wrong_unit.target_unit_symbol = "USD/s".into();
        assert!(run(&original, &wrong_unit).is_err());
    }
    #[test]
    fn forged_problem_ids_and_invalid_sources_fail_closed() {
        let original = sample(2.5, 7.25);
        let mut bad = selection("left");
        bad.problem_id = "a\tforged".into();
        assert!(run(&original, &bad).is_err());
        assert!(export_measured_rate(
            b"garbage",
            b"garbage",
            &selection("left"),
            HandoffLimits::default()
        )
        .is_err());
        assert!(
            export_measured_rate(&original, b"", &selection("left"), HandoffLimits::default())
                .is_err()
        );
    }
    #[test]
    fn measurement_budget_is_not_bypassed_by_bridge_export() {
        let original = sample(2.5, 7.25);
        let mut limits = HandoffLimits::default();
        limits.max_numeric_records = 1;
        assert!(export_measured_rate(&original, &original, &selection("left"), limits).is_err());
    }
}
