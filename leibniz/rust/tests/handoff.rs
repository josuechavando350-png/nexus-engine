use nexus_leibniz::{
    handoff::{
        Direction, GaussOutcomeV1, GaussProblemV1, GaussResponseV1, HandoffAssurance,
        HandoffLimits, Objective, CONTRACT_VERSION,
    },
    schema::{Entity, Flow, Restriction, RestrictionType},
    semantic_archive::SemanticArchive,
    semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity},
    ArgumentKind, Atom, Decision, Graph, Limits, Pattern, PatternTerm, Predicate, Rule, Term,
};
use std::collections::HashMap;

fn entity(id: &str) -> Entity {
    Entity {
        id: id.into(),
        category: "Business".into(),
        attributes: HashMap::new(),
    }
}
fn dimension(kind: &str) -> Dimension {
    Dimension::new([(kind.into(), 1), ("time".into(), -1)]).unwrap()
}
fn unit(kind: &str, symbol: &str, scale: f64) -> Unit {
    Unit::new(symbol, dimension(kind), scale).unwrap()
}
fn note(u: Unit, start: i64, end: Option<i64>, evidence: &str) -> Annotation {
    Annotation::new(u, Validity::new(start, end).unwrap(), evidence).unwrap()
}
fn archive() -> SemanticArchive {
    let mut graph = Graph::new();
    for id in ["client", "market", "rival"] {
        graph.add_entity(entity(id)).unwrap();
    }
    for rate in [86_400.0, 1.0] {
        graph
            .add_flow(Flow {
                from_entity: "client".into(),
                to_entity: "market".into(),
                rate_of_transfer: rate,
            })
            .unwrap();
    }
    graph
        .add_flow(Flow {
            from_entity: "rival".into(),
            to_entity: "market".into(),
            rate_of_transfer: 10.0,
        })
        .unwrap();
    graph
        .add_restriction(Restriction {
            source_id: "client".into(),
            target_id: "market".into(),
            constraint_type: RestrictionType::Conditional,
            boundary_value: 200.0,
        })
        .unwrap();
    let signature = vec![ArgumentKind::EntityCategory("Business".into())];
    graph
        .declare_predicate(Predicate {
            name: "observed".into(),
            arguments: signature.clone(),
        })
        .unwrap();
    graph
        .declare_predicate(Predicate {
            name: "eligible".into(),
            arguments: signature,
        })
        .unwrap();
    let atom = Atom {
        predicate: "observed".into(),
        terms: vec![Term::Entity("client".into())],
    };
    graph.assert_fact(atom, "evidence:observation").unwrap();
    graph
        .add_rule(Rule {
            id: "observation_implies_eligibility".into(),
            body: vec![Pattern {
                predicate: "observed".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            }],
            head: Pattern {
                predicate: "eligible".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            },
        })
        .unwrap();
    let annotations = vec![
        note(
            unit("contacts", "contacts/day", 1.0 / 86_400.0),
            100,
            Some(200),
            "evidence:first",
        ),
        note(
            unit("contacts", "contacts/second", 1.0),
            100,
            None,
            "evidence:second",
        ),
        note(
            unit("contacts", "contacts/second", 1.0),
            150,
            None,
            "evidence:rival",
        ),
    ];
    let restriction = note(
        Unit::new("MXN", Dimension::new([("MXN".into(), 1)]).unwrap(), 1.0).unwrap(),
        100,
        None,
        "evidence:budget",
    );
    let snapshot = SemanticSnapshot::from_graph(&graph, annotations, vec![restriction]).unwrap();
    SemanticArchive::new(graph, snapshot).unwrap()
}
fn objective() -> Objective {
    Objective {
        metric: "measured_contacts_rate".into(),
        subject_entity_id: "client".into(),
        unit: unit("contacts", "contacts/second", 1.0),
        direction: Direction::Maximize,
    }
}
fn prepare(a: &SemanticArchive, at: i64) -> GaussProblemV1 {
    GaussProblemV1::prepare(a, "study-001", at, objective(), HandoffLimits::default()).unwrap()
}

#[test]
fn handoff_is_read_only_and_retains_complete_source_graph() {
    let a = archive();
    let original_bytes = a.to_bytes().unwrap();
    let prepared = prepare(&a, 175);
    assert_eq!(prepared.contract_version, CONTRACT_VERSION);
    assert_eq!(prepared.active_flows.len(), 3);
    assert_eq!(prepared.active_restrictions.len(), 1);
    assert_eq!(prepared.source_graph.assertions.len(), 1);
    assert_eq!(prepared.source_graph.rules.len(), 1);
    assert_eq!(a.to_bytes().unwrap(), original_bytes);
}

#[test]
fn time_boundaries_exclude_expired_measurements_without_zero_filling() {
    let a = archive();
    let early = prepare(&a, 100);
    assert_eq!(early.active_flows.len(), 2);
    assert_eq!(early.active_restrictions.len(), 1);
    let later = prepare(&a, 200);
    assert_eq!(later.active_flows.len(), 2);
    assert_eq!(
        later.active_flows[0].annotation.evidence_id,
        "evidence:second"
    );
    assert!(later
        .measured_flow_sum("client", "rival", &objective().unit)
        .is_err());
}

#[test]
fn no_active_evidence_and_unknown_subject_are_rejected() {
    let a = archive();
    assert!(GaussProblemV1::prepare(&a, "x", 99, objective(), HandoffLimits::default()).is_err());
    let mut unknown = objective();
    unknown.subject_entity_id = "ghost".into();
    assert!(GaussProblemV1::prepare(&a, "x", 175, unknown, HandoffLimits::default()).is_err());
}

#[test]
fn no_compatible_dimension_is_not_a_prediction() {
    let a = archive();
    let mut goal = objective();
    goal.unit = Unit::new("USD", Dimension::new([("USD".into(), 1)]).unwrap(), 1.0).unwrap();
    assert!(GaussProblemV1::prepare(&a, "x", 175, goal, HandoffLimits::default()).is_err());
}

#[test]
fn sum_converts_units_and_preserves_each_measurement_source() {
    let p = prepare(&archive(), 175);
    let total = p
        .measured_flow_sum("client", "market", &objective().unit)
        .unwrap();
    assert!((total.value - 2.0).abs() < 1e-12);
    assert_eq!(
        total.evidence_ids,
        vec!["evidence:first", "evidence:second"]
    );
    let daily = p
        .measured_flow_sum(
            "client",
            "market",
            &unit("contacts", "contacts/day", 1.0 / 86_400.0),
        )
        .unwrap();
    assert!((daily.value - 172_800.0).abs() < 1e-7);
}

#[test]
fn cannot_aggregate_mixed_units_or_absent_direction() {
    let p = prepare(&archive(), 175);
    assert!(p
        .measured_flow_sum("client", "market", &unit("visits", "visits/s", 1.0))
        .is_err());
    assert!(p
        .measured_flow_sum("market", "client", &objective().unit)
        .is_err());
}

#[test]
fn mutable_public_fields_are_revalidated_on_preparation() {
    let mut a = archive();
    a.snapshot.flows[0].rate = 123.0;
    assert!(GaussProblemV1::prepare(&a, "x", 175, objective(), HandoffLimits::default()).is_err());
    let mut a = archive();
    a.snapshot.flows[0].annotation.unit.scale_to_reference = f64::NAN;
    assert!(GaussProblemV1::prepare(&a, "x", 175, objective(), HandoffLimits::default()).is_err());
}

#[test]
fn invalid_objectives_and_resource_budgets_are_rejected() {
    let a = archive();
    assert!(GaussProblemV1::prepare(&a, " ", 175, objective(), HandoffLimits::default()).is_err());
    let mut goal = objective();
    goal.metric.clear();
    assert!(GaussProblemV1::prepare(&a, "x", 175, goal, HandoffLimits::default()).is_err());
    let mut goal = objective();
    goal.unit.scale_to_reference = 0.0;
    assert!(GaussProblemV1::prepare(&a, "x", 175, goal, HandoffLimits::default()).is_err());
    let limits = HandoffLimits {
        max_entities: 2,
        ..HandoffLimits::default()
    };
    assert!(GaussProblemV1::prepare(&a, "x", 175, objective(), limits).is_err());
    let limits = HandoffLimits {
        max_rules: 0,
        ..HandoffLimits::default()
    };
    assert!(GaussProblemV1::prepare(&a, "x", 175, objective(), limits).is_err());
}

#[test]
fn forged_proven_result_fails_independent_source_proof_check() {
    let a = archive();
    let problem = prepare(&a, 175);
    let query = Atom {
        predicate: "eligible".into(),
        terms: vec![Term::Entity("client".into())],
    };
    let Decision::Proven { proof } = a.graph.infer(&query, Limits::default()) else {
        panic!("test premises must entail eligibility")
    };
    let response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Proven {
            query: query.clone(),
            proof: proof.clone(),
        },
    };
    response.validate_against(&problem).unwrap();
    let mut altered = response.clone();
    if let GaussOutcomeV1::Proven { proof, .. } = &mut altered.outcome {
        proof.steps.last_mut().unwrap().atom.predicate = "observed".into();
    }
    assert!(altered.validate_against(&problem).is_err());
    let mut altered = response;
    altered.problem_id = "different".into();
    assert!(altered.validate_against(&problem).is_err());
}

#[test]
fn trusted_source_gate_rejects_mutated_numeric_problem_with_valid_logical_proof() {
    let trusted = archive();
    let mut problem = prepare(&trusted, 175);
    let query = Atom {
        predicate: "eligible".into(),
        terms: vec![Term::Entity("client".into())],
    };
    let Decision::Proven { proof } = trusted.graph.infer(&query, Limits::default()) else {
        panic!("trusted source must derive the query")
    };
    let response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Proven { query, proof },
    };
    assert_eq!(
        response
            .assess_against_trusted_source(&problem, &trusted, HandoffLimits::default(),)
            .unwrap(),
        HandoffAssurance::LogicalProofVerified
    );
    // The local logical proof does not cover a forged numeric measurement.
    // A caller can mutate public problem fields after preparation.
    problem.active_flows[0].rate = 999_999.0;
    assert!(
        response.assess_against(&problem).is_ok(),
        "the older API checks a proof, not mutable measurements"
    );
    assert!(response
        .assess_against_trusted_source(&problem, &trusted, HandoffLimits::default(),)
        .is_err());
}

#[test]
fn trusted_source_gate_rejects_forged_estimate_input_and_accepts_original() {
    let trusted = archive();
    let mut problem = prepare(&trusted, 175);
    let response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Estimated {
            probability_basis_points: 5500,
            claim: "claimed rate".into(),
            model_id: "external-model".into(),
            estimation_evidence_id: "external-run".into(),
            calibration_evidence_id: "external-calibration".into(),
        },
    };
    assert_eq!(
        response
            .assess_against_trusted_source(&problem, &trusted, HandoffLimits::default(),)
            .unwrap(),
        HandoffAssurance::EstimateStructureOnly
    );
    problem.source_graph.assertions[0]
        .asserted_sources
        .insert("forged:new-source".into());
    assert!(
        response.assess_against(&problem).is_ok(),
        "structural ESTIMATED validation cannot authenticate a source graph"
    );
    assert!(response
        .assess_against_trusted_source(&problem, &trusted, HandoffLimits::default(),)
        .is_err());
}

#[test]
fn estimated_is_never_automatically_proven_or_calibrated() {
    let problem = prepare(&archive(), 175);
    let mut response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Estimated {
            probability_basis_points: 8_500,
            claim: "specified event".into(),
            model_id: "gauss-model-id".into(),
            estimation_evidence_id: "measurement-id".into(),
            calibration_evidence_id: "independent-calibration-id".into(),
        },
    };
    // A well-formed claim is *not* evidence that this or any model achieved 85%.
    response.validate_against(&problem).unwrap();
    if let GaussOutcomeV1::Estimated {
        probability_basis_points,
        ..
    } = &mut response.outcome
    {
        *probability_basis_points = 10_000;
    }
    assert!(response.validate_against(&problem).is_err());
    if let GaussOutcomeV1::Estimated {
        probability_basis_points,
        calibration_evidence_id,
        ..
    } = &mut response.outcome
    {
        *probability_basis_points = 8_500;
        calibration_evidence_id.clear();
    }
    assert!(response.validate_against(&problem).is_err());
}

#[test]
fn abstention_and_unidentifiable_need_an_actual_reason() {
    let problem = prepare(&archive(), 175);
    for outcome in [
        GaussOutcomeV1::Abstain { reason: " ".into() },
        GaussOutcomeV1::Unidentifiable { reason: "".into() },
    ] {
        let result = GaussResponseV1 {
            contract_version: CONTRACT_VERSION,
            problem_id: problem.problem_id.clone(),
            outcome,
        };
        assert!(result.validate_against(&problem).is_err());
    }
    let result = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Abstain {
            reason: "model cannot be identified".into(),
        },
    };
    result.validate_against(&problem).unwrap();
}

#[test]
fn repeated_evidence_on_an_edge_is_not_double_counted() {
    let mut a = archive();
    a.snapshot.flows[1].annotation.evidence_id = "evidence:first".into();
    let a = SemanticArchive::new(a.graph, a.snapshot).unwrap();
    let p = prepare(&a, 175);
    let err = p
        .measured_flow_sum("client", "market", &objective().unit)
        .unwrap_err();
    assert!(err.contains("double counting"));
}

#[test]
fn tampering_with_proof_source_or_contract_version_is_rejected() {
    let a = archive();
    let mut problem = prepare(&a, 175);
    let query = Atom {
        predicate: "eligible".into(),
        terms: vec![Term::Entity("client".into())],
    };
    let Decision::Proven { proof } = a.graph.infer(&query, Limits::default()) else {
        panic!("expected source-anchored conclusion")
    };
    let response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Proven { query, proof },
    };
    problem.source_graph.assertions.clear();
    assert!(response.validate_against(&problem).is_err());
    let mut problem = prepare(&a, 175);
    problem.contract_version = CONTRACT_VERSION + 1;
    assert!(response.validate_against(&problem).is_err());
}

#[test]
fn dimension_mismatch_in_an_active_stream_fails_closed() {
    let mut a = archive();
    a.snapshot.flows[1].annotation.unit = unit("visits", "visits/second", 1.0);
    let a = SemanticArchive::new(a.graph, a.snapshot).unwrap();
    let problem = prepare(&a, 175);
    let result = problem.measured_flow_sum("client", "market", &objective().unit);
    assert!(result.unwrap_err().contains("mixed dimensions"));
}

#[test]
fn numeric_overflow_is_not_returned_as_a_valid_flow() {
    let problem = prepare(&archive(), 175);
    let tiny = unit("contacts", "tiny", 1e-308);
    assert!(problem
        .measured_flow_sum("client", "market", &tiny)
        .is_err());
}

#[test]
fn gauss_proven_handoff_cannot_launder_a_derived_contradiction() {
    let mut archive = archive();
    let query = Atom {
        predicate: "eligible".into(),
        terms: vec![Term::Entity("client".into())],
    };
    let Decision::Proven { proof } = archive.graph.infer(&query, Limits::default()) else {
        panic!("the original inference fixture must be provable");
    };
    archive
        .graph
        .declare_predicate(Predicate {
            name: "ineligible".into(),
            arguments: vec![ArgumentKind::EntityCategory("Business".into())],
        })
        .unwrap();
    archive
        .graph
        .declare_incompatible("eligible", "ineligible")
        .unwrap();
    archive
        .graph
        .add_rule(Rule {
            id: "derive-ineligible".into(),
            body: vec![Pattern {
                predicate: "observed".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            }],
            head: Pattern {
                predicate: "ineligible".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            },
        })
        .unwrap();
    let snapshot = SemanticSnapshot::from_graph(
        &archive.graph,
        archive
            .snapshot
            .flows
            .iter()
            .map(|flow| flow.annotation.clone())
            .collect(),
        archive
            .snapshot
            .restrictions
            .iter()
            .map(|restriction| restriction.annotation.clone())
            .collect(),
    )
    .unwrap();
    let archive = SemanticArchive::new(archive.graph, snapshot).unwrap();
    let problem = prepare(&archive, 175);
    let response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Proven { query, proof },
    };
    assert!(
        response.validate_against(&problem).is_err(),
        "a locally correct proof must not override the contradictory closure"
    );
}

#[test]
fn assurance_distinguishes_proof_from_uncalibrated_estimate_and_reported_states() {
    let a = archive();
    let problem = prepare(&a, 175);
    let query = Atom {
        predicate: "eligible".into(),
        terms: vec![Term::Entity("client".into())],
    };
    let Decision::Proven { proof } = a.graph.infer(&query, Limits::default()) else {
        panic!("fixture must entail eligibility");
    };
    let mut response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: problem.problem_id.clone(),
        outcome: GaussOutcomeV1::Proven { query, proof },
    };
    assert_eq!(
        response.assess_against(&problem).unwrap(),
        HandoffAssurance::LogicalProofVerified
    );
    response.outcome = GaussOutcomeV1::Estimated {
        probability_basis_points: 7500,
        claim: "unverified numerical forecast".into(),
        model_id: "model:unverified".into(),
        estimation_evidence_id: "estimate:source".into(),
        calibration_evidence_id: "calibration:claimed".into(),
    };
    assert_eq!(
        response.assess_against(&problem).unwrap(),
        HandoffAssurance::EstimateStructureOnly
    );
    response.outcome = GaussOutcomeV1::Unidentifiable {
        reason: "missing data".into(),
    };
    assert_eq!(
        response.assess_against(&problem).unwrap(),
        HandoffAssurance::UnidentifiableReported
    );
    response.outcome = GaussOutcomeV1::Abstain {
        reason: "budget exceeded".into(),
    };
    assert_eq!(
        response.assess_against(&problem).unwrap(),
        HandoffAssurance::AbstentionReported
    );
}

#[test]
fn trusted_source_rejects_signed_zero_mutation_in_numeric_measurements() {
    let previous = archive();
    let mut graph = previous.graph;
    graph
        .add_flow(Flow {
            from_entity: "client".into(),
            to_entity: "market".into(),
            rate_of_transfer: 0.0,
        })
        .unwrap();
    let mut annotations: Vec<_> = previous
        .snapshot
        .flows
        .iter()
        .map(|record| record.annotation.clone())
        .collect();
    annotations.push(note(
        unit("contacts", "contacts/second", 1.0),
        100,
        None,
        "evidence:zero-rate",
    ));
    let restrictions = previous
        .snapshot
        .restrictions
        .iter()
        .map(|record| record.annotation.clone())
        .collect();
    let snapshot = SemanticSnapshot::from_graph(&graph, annotations, restrictions).unwrap();
    let trusted = SemanticArchive::new(graph, snapshot).unwrap();
    let original = prepare(&trusted, 175);
    let response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: original.problem_id.clone(),
        outcome: GaussOutcomeV1::Abstain {
            reason: "test response".into(),
        },
    };
    response
        .assess_against_trusted_source(&original, &trusted, HandoffLimits::default())
        .unwrap();

    let mut mutated = original.clone();
    mutated.active_flows.last_mut().unwrap().rate = -0.0;
    assert_eq!(
        mutated, original,
        "ordinary f64 equality does not compare sign bits"
    );
    assert!(response
        .assess_against_trusted_source(&mutated, &trusted, HandoffLimits::default(),)
        .is_err());

    let mut mutated = original.clone();
    mutated
        .source_graph
        .flows
        .last_mut()
        .unwrap()
        .rate_of_transfer = -0.0;
    assert_eq!(
        mutated, original,
        "archive equality must not hide sign-bit changes"
    );
    assert!(response
        .assess_against_trusted_source(&mutated, &trusted, HandoffLimits::default(),)
        .is_err());
}

#[test]
fn trusted_source_rejects_signed_zero_mutation_in_entity_attributes() {
    let previous = archive();
    let mut graph = previous.graph;
    let mut attributes = HashMap::new();
    attributes.insert(
        "reading".into(),
        nexus_leibniz::schema::AttributeValue::Number(0.0),
    );
    graph
        .add_entity(Entity {
            id: "meter".into(),
            category: "Business".into(),
            attributes,
        })
        .unwrap();
    let snapshot = SemanticSnapshot::from_graph(
        &graph,
        previous
            .snapshot
            .flows
            .iter()
            .map(|record| record.annotation.clone())
            .collect(),
        previous
            .snapshot
            .restrictions
            .iter()
            .map(|record| record.annotation.clone())
            .collect(),
    )
    .unwrap();
    let trusted = SemanticArchive::new(graph, snapshot).unwrap();
    let original = prepare(&trusted, 175);
    let response = GaussResponseV1 {
        contract_version: CONTRACT_VERSION,
        problem_id: original.problem_id.clone(),
        outcome: GaussOutcomeV1::Unidentifiable {
            reason: "test response".into(),
        },
    };
    let mut mutated = original.clone();
    let meter = mutated
        .entities
        .iter_mut()
        .find(|item| item.id == "meter")
        .unwrap();
    meter.attributes.insert(
        "reading".into(),
        nexus_leibniz::schema::AttributeValue::Number(-0.0),
    );
    assert_eq!(
        mutated, original,
        "standard equality hides signed zero in attributes"
    );
    assert!(response
        .assess_against_trusted_source(&mutated, &trusted, HandoffLimits::default(),)
        .is_err());
}

#[test]
fn objective_cannot_redefine_an_existing_unit_symbol() {
    let a = archive();
    let mut forged = objective();
    forged.unit.scale_to_reference = 2.0;
    assert!(GaussProblemV1::prepare(
        &a,
        "objective-unit-conflict",
        175,
        forged,
        HandoffLimits::default(),
    )
    .is_err());
}

#[test]
fn measured_sum_rejects_an_ambiguous_target_unit_symbol() {
    let p = prepare(&archive(), 175);
    let mut target = objective().unit;
    target.scale_to_reference = 2.0;
    assert!(p.measured_flow_sum("client", "market", &target).is_err());
}

#[test]
fn measured_sum_can_be_bound_to_trusted_graph_and_rejects_tampering() {
    let trusted = archive();
    let mut p = prepare(&trusted, 175);
    let expected = p
        .measured_flow_sum_against_trusted_source(
            "client",
            "market",
            &objective().unit,
            &trusted,
            HandoffLimits::default(),
        )
        .unwrap();
    assert!((expected.value - 2.0).abs() < 1e-12);
    assert_eq!(
        expected.evidence_ids,
        vec!["evidence:first", "evidence:second"]
    );
    p.active_flows[0].rate = 9_999_999.0;
    assert!(
        p.measured_flow_sum("client", "market", &objective().unit)
            .is_ok(),
        "the legacy API cannot authenticate publicly mutable fields"
    );
    assert!(p
        .measured_flow_sum_against_trusted_source(
            "client",
            "market",
            &objective().unit,
            &trusted,
            HandoffLimits::default(),
        )
        .is_err());
}

#[test]
fn trusted_sum_detects_edited_graph_even_if_live_measurements_look_unchanged() {
    let trusted = archive();
    let mut p = prepare(&trusted, 175);
    p.source_graph.flows[0].rate_of_transfer = 300.0;
    assert!(p
        .measured_flow_sum_against_trusted_source(
            "client",
            "market",
            &objective().unit,
            &trusted,
            HandoffLimits::default(),
        )
        .is_err());
}
