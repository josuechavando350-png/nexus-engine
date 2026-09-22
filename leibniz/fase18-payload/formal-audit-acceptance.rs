use nexus_leibniz::formal_audit::{audit_closed, audit_trusted_handoff, AuditLimits, FormalAudit};
use nexus_leibniz::handoff::{Direction, GaussOutcomeV1, GaussProblemV1, GaussResponseV1,
    HandoffAssurance, HandoffLimits, Objective, CONTRACT_VERSION};
use nexus_leibniz::hol::{Derivation as D, Expr as E, Ty};
use nexus_leibniz::schema::{Entity, Flow};
use nexus_leibniz::semantic_archive::SemanticArchive;
use nexus_leibniz::semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity};
use nexus_leibniz::{ArgumentKind, Atom, Decision, Graph, Limits, Pattern, PatternTerm,
    Predicate, Rule, Term};
use std::collections::HashMap;

fn atom(name: &str) -> Atom {
    Atom { predicate: name.into(), terms: vec![Term::Entity("client".into())] }
}
fn unit() -> Unit {
    Unit::new("contacts/second", Dimension::new([
        ("contacts".into(), 1), ("time".into(), -1),
    ]).unwrap(), 1.0).unwrap()
}
fn trusted() -> SemanticArchive {
    let mut graph = Graph::new();
    for name in ["client", "market"] {
        graph.add_entity(Entity { id: name.into(), category: "Business".into(),
            attributes: HashMap::new() }).unwrap();
    }
    graph.add_flow(Flow { from_entity: "client".into(),
        to_entity: "market".into(), rate_of_transfer: 2.0 }).unwrap();
    for name in ["reported", "eligible"] {
        graph.declare_predicate(Predicate { name: name.into(),
            arguments: vec![ArgumentKind::EntityCategory("Business".into())] }).unwrap();
    }
    graph.assert_fact(atom("reported"), "ledger:real-record").unwrap();
    graph.add_rule(Rule { id: "reported_implies_eligible".into(),
        body: vec![Pattern { predicate: "reported".into(),
            terms: vec![PatternTerm::Variable("x".into())] }],
        head: Pattern { predicate: "eligible".into(),
            terms: vec![PatternTerm::Variable("x".into())] },
    }).unwrap();
    let annotation = Annotation::new(unit(), Validity::new(100, Some(200)).unwrap(),
        "ledger:measured-rate").unwrap();
    let snapshot = SemanticSnapshot::from_graph(&graph, vec![annotation], vec![]).unwrap();
    SemanticArchive::new(graph, snapshot).unwrap()
}
fn problem(archive: &SemanticArchive) -> GaussProblemV1 {
    GaussProblemV1::prepare(archive, "question-1", 150, Objective {
        metric: "contacts_rate".into(), subject_entity_id: "client".into(),
        unit: unit(), direction: Direction::Maximize,
    }, HandoffLimits::default()).unwrap()
}
fn proven(archive: &SemanticArchive) -> GaussResponseV1 {
    let query = atom("eligible");
    let Decision::Proven { proof } = archive.graph.infer(&query, Limits::default())
        else { panic!("real asserted source and Horn rule must produce a proof") };
    GaussResponseV1 { contract_version: CONTRACT_VERSION,
        problem_id: "question-1".into(), outcome: GaussOutcomeV1::Proven { query, proof } }
}
fn estimate() -> GaussResponseV1 {
    GaussResponseV1 { contract_version: CONTRACT_VERSION,
        problem_id: "question-1".into(), outcome: GaussOutcomeV1::Estimated {
            probability_basis_points: 8_500,
            claim: "unverified future event".into(), model_id: "external-model".into(),
            estimation_evidence_id: "unverified-estimate".into(),
            calibration_evidence_id: "unverified-calibration".into(),
        } }
}
fn theorem() -> (E, D) {
    let x = E::Var("x".into(), Ty::Individual);
    (E::Forall("x".into(), Ty::Individual,
        Box::new(E::Equal(Box::new(x.clone()), Box::new(x.clone())))),
     D::ForallIntro { variable: "x".into(), ty: Ty::Individual,
        body: Box::new(D::EqualRefl(x)) })
}
fn audit(archive: &SemanticArchive, problem: &GaussProblemV1,
         response: &GaussResponseV1) -> Result<nexus_leibniz::formal_audit::ReadOnlyAudit, String> {
    let (claim, proof) = theorem();
    audit_trusted_handoff(response, problem, archive, HandoffLimits::default(),
        &claim, Some(&proof), AuditLimits::default())
}

#[test]
fn closed_theorem_needs_real_proof_and_independent_model_replay() {
    let (claim, proof) = theorem();
    assert_eq!(audit_closed(&claim, Some(&proof), AuditLimits::default()).unwrap(),
        FormalAudit::ClosedTheoremChecked { models_checked: 2 });
}

#[test]
fn true_in_all_tested_models_without_proof_is_undetermined() {
    let (claim, _) = theorem();
    assert_eq!(audit_closed(&claim, None, AuditLimits::default()).unwrap(),
        FormalAudit::Undetermined { models_checked: 2 });
}

#[test]
fn quantified_arbitrary_predicate_has_real_countermodel() {
    let pt = Ty::Arrow(Box::new(Ty::Individual), Box::new(Ty::Prop));
    let p = E::Var("P".into(), pt.clone());
    let x = E::Var("x".into(), Ty::Individual);
    let claim = E::Forall("P".into(), pt,
        Box::new(E::Forall("x".into(), Ty::Individual,
            Box::new(E::App(Box::new(p), Box::new(x))))));
    assert_eq!(audit_closed(&claim, None, AuditLimits::default()).unwrap(),
        FormalAudit::FiniteCounterexample { individuals: 1 });
}

#[test]
fn counterexample_identifies_first_distinguishing_model() {
    let x = E::Var("x".into(), Ty::Individual);
    let y = E::Var("y".into(), Ty::Individual);
    let claim = E::Forall("x".into(), Ty::Individual,
        Box::new(E::Forall("y".into(), Ty::Individual,
            Box::new(E::Equal(Box::new(x), Box::new(y))))));
    assert_eq!(audit_closed(&claim, None, AuditLimits::default()).unwrap(),
        FormalAudit::FiniteCounterexample { individuals: 2 });
}

#[test]
fn forged_closed_certificate_is_an_error_not_a_finite_model_verdict() {
    let claim = E::False;
    assert!(audit_closed(&claim, Some(&D::Hypothesis(0)), AuditLimits::default()).is_err());
}

#[test]
fn missing_constant_and_open_variable_are_refused_not_assumed_false() {
    assert!(audit_closed(&E::Const("market_will_rise".into(), Ty::Prop),
        None, AuditLimits::default()).is_err());
    assert!(audit_closed(&E::Var("free".into(), Ty::Prop),
        None, AuditLimits::default()).is_err());
}

#[test]
fn finite_model_and_proof_work_limits_fail_closed() {
    let (claim, proof) = theorem();
    assert!(audit_closed(&claim, Some(&proof), AuditLimits {
        max_steps_per_model: 1, ..AuditLimits::default()
    }).is_err());
    assert!(audit_closed(&claim, Some(&proof), AuditLimits {
        proof: nexus_leibniz::hol::Budget { max_nodes: 1, max_reductions: 1 },
        ..AuditLimits::default()
    }).is_err());
}

#[test]
fn invalid_zero_and_excessive_model_limits_do_not_claim_success() {
    let (claim, proof) = theorem();
    for max_individuals in [0, 5] {
        assert!(audit_closed(&claim, Some(&proof), AuditLimits {
            max_individuals, ..AuditLimits::default()
        }).is_err());
    }
}

#[test]
fn trusted_handoff_keeps_two_independent_proofs_separately_typed() {
    let archive = trusted();
    let result = audit(&archive, &problem(&archive), &proven(&archive)).unwrap();
    assert_eq!(result.handoff, HandoffAssurance::LogicalProofVerified);
    assert_eq!(result.formal, FormalAudit::ClosedTheoremChecked { models_checked: 2 });
}

#[test]
fn restored_archive_keeps_a_reproducible_end_to_end_audit() {
    let archive = trusted();
    let restored = SemanticArchive::from_bytes(&archive.to_bytes().unwrap()).unwrap();
    let result = audit(&restored, &problem(&restored), &proven(&restored)).unwrap();
    assert_eq!(result.handoff, HandoffAssurance::LogicalProofVerified);
}

#[test]
fn forged_numeric_rate_is_rejected_even_with_a_valid_graph_and_hol_proofs() {
    let archive = trusted();
    let mut request = problem(&archive);
    request.active_flows[0].rate = 999_999.0;
    assert!(audit(&archive, &request, &proven(&archive)).is_err());
}

#[test]
fn altered_logical_proof_is_rejected_before_any_formal_assurance() {
    let archive = trusted();
    let mut response = proven(&archive);
    if let GaussOutcomeV1::Proven { proof, .. } = &mut response.outcome {
        proof.steps.last_mut().unwrap().asserted_sources.insert("forged".into());
    }
    assert!(audit(&archive, &problem(&archive), &response).is_err());
}

#[test]
fn unverifiable_estimate_remains_structure_only_even_with_closed_theorem() {
    let archive = trusted();
    let result = audit(&archive, &problem(&archive), &estimate()).unwrap();
    assert_eq!(result.handoff, HandoffAssurance::EstimateStructureOnly);
    assert_eq!(result.formal, FormalAudit::ClosedTheoremChecked { models_checked: 2 });
}
