use nexus_leibniz::{
    schema::{Entity, Flow, Restriction, RestrictionType},
    semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity},
    Graph,
};
use std::collections::HashMap;

fn entity(id: &str) -> Entity {
    Entity {
        id: id.into(),
        category: "Business".into(),
        attributes: HashMap::new(),
    }
}
fn rate_dimension(kind: &str) -> Dimension {
    Dimension::new([(kind.into(), 1), ("time".into(), -1)]).unwrap()
}
fn unit(symbol: &str, kind: &str, scale: f64) -> Unit {
    Unit::new(symbol, rate_dimension(kind), scale).unwrap()
}
fn note(unit: Unit, start: i64, end: Option<i64>, source: &str) -> Annotation {
    Annotation::new(unit, Validity::new(start, end).unwrap(), source).unwrap()
}
fn graph() -> Graph {
    let mut g = Graph::new();
    g.add_entity(entity("a")).unwrap();
    g.add_entity(entity("b")).unwrap();
    g.add_flow(Flow {
        from_entity: "a".into(),
        to_entity: "b".into(),
        rate_of_transfer: 86_400.0,
    })
    .unwrap();
    g.add_restriction(Restriction {
        source_id: "a".into(),
        target_id: "b".into(),
        constraint_type: RestrictionType::Conditional,
        boundary_value: 0.5,
    })
    .unwrap();
    g
}

#[test]
fn every_numeric_record_requires_an_annotation() {
    let g = graph();
    assert!(SemanticSnapshot::from_graph(&g, vec![], vec![]).is_err());
    assert!(SemanticSnapshot::from_graph(
        &g,
        vec![note(
            unit("contacts/day", "contacts", 1.0 / 86_400.0),
            0,
            None,
            "source:1"
        )],
        vec![]
    )
    .is_err());
    assert_eq!(g.flows().len(), 1, "the source graph was not modified");
}

#[test]
fn typed_snapshot_preserves_original_values_and_sources() {
    let g = graph();
    let original = g.snapshot();
    let snapshot = SemanticSnapshot::from_graph(
        &g,
        vec![note(
            unit("contacts/day", "contacts", 1.0 / 86_400.0),
            100,
            Some(200),
            "ledger:flow",
        )],
        vec![note(
            Unit::new("ratio", Dimension::dimensionless(), 1.0).unwrap(),
            100,
            None,
            "ledger:rule",
        )],
    )
    .unwrap();
    assert_eq!(snapshot.problem, original);
    assert_eq!(snapshot.flows[0].rate, 86_400.0);
    assert_eq!(snapshot.flows[0].annotation.evidence_id, "ledger:flow");
    assert_eq!(snapshot.restrictions[0].boundary, 0.5);
    assert_eq!(
        snapshot.restrictions[0].constraint_type,
        RestrictionType::Conditional
    );
    assert_eq!(g.flows()[0].rate_of_transfer, 86_400.0);
}

#[test]
fn temporal_selection_is_half_open_and_never_invents_zeroes() {
    let g = graph();
    let snapshot = SemanticSnapshot::from_graph(
        &g,
        vec![note(
            unit("contacts/s", "contacts", 1.0),
            100,
            Some(200),
            "source:flow",
        )],
        vec![note(
            Unit::new("ratio", Dimension::dimensionless(), 1.0).unwrap(),
            150,
            None,
            "source:constraint",
        )],
    )
    .unwrap();
    assert!(snapshot.flows_at(99).is_empty());
    assert_eq!(snapshot.flows_at(100).len(), 1);
    assert_eq!(snapshot.flows_at(199).len(), 1);
    assert!(snapshot.flows_at(200).is_empty());
    assert!(snapshot.restrictions_at(149).is_empty());
    assert_eq!(snapshot.restrictions_at(200).len(), 1);
}

#[test]
fn time_and_unit_require_finite_unambiguous_values() {
    assert!(Validity::new(10, Some(10)).is_err());
    assert!(Validity::new(10, Some(9)).is_err());
    assert!(Unit::new("bad", rate_dimension("contacts"), f64::NAN).is_err());
    assert!(Unit::new("bad", rate_dimension("contacts"), 0.0).is_err());
    assert!(Annotation::new(
        unit("contacts/s", "contacts", 1.0),
        Validity::new(0, None).unwrap(),
        "  "
    )
    .is_err());
    assert!(Dimension::new([("time".into(), -1), ("time".into(), 1)]).is_err());
    assert!(Dimension::new([("  ".into(), -1)]).is_err());
}

#[test]
fn currency_units_do_not_silently_convert_without_fx() {
    let mxn = Unit::new("MXN", Dimension::new([("MXN".into(), 1)]).unwrap(), 1.0).unwrap();
    let usd = Unit::new("USD", Dimension::new([("USD".into(), 1)]).unwrap(), 1.0).unwrap();
    assert!(mxn.convert(500.0, &usd).is_err());
}

#[test]
fn explicit_same_dimension_conversion_and_overflow_are_checked() {
    let per_day = unit("contacts/day", "contacts", 1.0 / 86_400.0);
    let per_second = unit("contacts/second", "contacts", 1.0);
    assert!((per_day.convert(86_400.0, &per_second).unwrap() - 1.0).abs() < 1e-12);
    assert!(per_second.convert(f64::INFINITY, &per_day).is_err());
    let massive = unit("massive", "contacts", 1e308);
    assert!(massive.convert(1e308, &per_second).is_err());
}

#[test]
fn dimensionality_mismatch_rejects_a_flow_even_if_the_number_is_valid() {
    let g = graph();
    let plain = Unit::new(
        "contacts",
        Dimension::new([("contacts".into(), 1)]).unwrap(),
        1.0,
    )
    .unwrap();
    assert!(SemanticSnapshot::from_graph(
        &g,
        vec![note(plain, 0, None, "flow")],
        vec![note(
            Unit::new("ratio", Dimension::dimensionless(), 1.0).unwrap(),
            0,
            None,
            "restriction"
        )]
    )
    .is_err());
}

#[test]
fn public_fields_cannot_bypass_semantic_validation() {
    let g = graph();
    let mut forged = note(unit("contacts/s", "contacts", 1.0), 0, None, "measured");
    forged.unit.scale_to_reference = f64::NAN;
    assert!(SemanticSnapshot::from_graph(
        &g,
        vec![forged],
        vec![note(
            Unit::new("ratio", Dimension::dimensionless(), 1.0).unwrap(),
            0,
            None,
            "measured"
        )]
    )
    .is_err());
    let mut forged = note(unit("contacts/s", "contacts", 1.0), 0, None, "measured");
    forged.validity.end_ms = Some(0);
    assert!(SemanticSnapshot::from_graph(
        &g,
        vec![forged],
        vec![note(
            Unit::new("ratio", Dimension::dimensionless(), 1.0).unwrap(),
            0,
            None,
            "measured"
        )]
    )
    .is_err());
}

#[test]
fn conversion_recovers_when_product_underflows_but_answer_is_representable() {
    let source = unit("tiny source", "contacts", 1e-300);
    let target = unit("tiny target", "contacts", 1e-300);
    // The old (amount * source_scale) / target_scale computes 0.0.
    let converted = source.convert(1e-300, &target).unwrap();
    assert_eq!(converted, 1e-300);
    assert_ne!(converted, 0.0);
}

#[test]
fn conversion_recovers_when_product_overflows_but_answer_is_representable() {
    let source = unit("large source", "contacts", 1e308);
    let target = unit("large target", "contacts", 1e308);
    // The old intermediate was +infinity despite a finite final answer.
    assert_eq!(source.convert(1e308, &target).unwrap(), 1e308);
}

#[test]
fn conversion_refuses_real_underflow_and_mutated_invalid_units() {
    let source = unit("tiny", "contacts", 1e-300);
    let target = unit("huge", "contacts", 1e300);
    assert!(source.convert(1e-300, &target).is_err());

    let mut corrupted_source = unit("source", "contacts", 1.0);
    corrupted_source.scale_to_reference = -1.0;
    assert!(corrupted_source.convert(2.0, &target).is_err());
    let mut corrupted_target = unit("target", "contacts", 1.0);
    corrupted_target.scale_to_reference = f64::NAN;
    assert!(source.convert(2.0, &corrupted_target).is_err());
}

#[test]
fn one_unit_symbol_cannot_have_two_scales_in_the_same_snapshot() {
    let mut g = graph();
    g.add_flow(Flow {
        from_entity: "a".into(),
        to_entity: "b".into(),
        rate_of_transfer: 1.0,
    })
    .unwrap();
    let annotations = vec![
        note(unit("contacts/s", "contacts", 1.0), 0, None, "source:one"),
        note(unit("contacts/s", "contacts", 2.0), 0, None, "source:two"),
    ];
    let restrictions = vec![note(
        Unit::new("ratio", Dimension::dimensionless(), 1.0).unwrap(),
        0,
        None,
        "source:rule",
    )];
    assert!(SemanticSnapshot::from_graph(&g, annotations, restrictions).is_err());
}

#[test]
fn unit_symbol_cannot_change_dimension_between_flow_and_restriction() {
    let g = graph();
    let flow = note(
        unit("shared-symbol", "contacts", 1.0),
        0,
        None,
        "source:flow",
    );
    let restriction = note(
        Unit::new("shared-symbol", Dimension::dimensionless(), 1.0).unwrap(),
        0,
        None,
        "source:restriction",
    );
    assert!(SemanticSnapshot::from_graph(&g, vec![flow], vec![restriction]).is_err());
}

#[test]
fn conversion_refuses_a_conflicting_definition_of_its_own_symbol() {
    let original = unit("contacts/s", "contacts", 1.0);
    let forged = unit("contacts/s", "contacts", 2.0);
    assert!(original.convert(10.0, &forged).is_err());
    assert!(
        original.convert(0.0, &forged).is_err(),
        "zero must not bypass the symbol definition check"
    );
}
