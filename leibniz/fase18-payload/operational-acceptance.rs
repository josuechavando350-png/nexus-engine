use nexus_leibniz::formal_audit::{AuditLimits, FormalAudit};
use nexus_leibniz::handoff::{
    Direction, GaussOutcomeV1, GaussProblemV1, GaussResponseV1, HandoffAssurance,
    HandoffLimits, Objective, CONTRACT_VERSION,
};
use nexus_leibniz::hol::{Derivation as D, Expr as E, Ty};
use nexus_leibniz::operational_gate::audit_persisted_pinned;
use nexus_leibniz::schema::{Entity, Flow};
use nexus_leibniz::semantic_archive::SemanticArchive;
use nexus_leibniz::semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity};
use nexus_leibniz::{ArgumentKind, Atom, Decision, Graph, Limits, Predicate, Term};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "leibniz-operational-{}-{}-{}.bin",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::thread::current().name().unwrap_or("test").replace('/', "_"),
        )))
    }
    fn path(&self) -> &Path { &self.0 }
}
impl Drop for Scratch {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}
fn rate_unit() -> Unit {
    Unit::new("contacts/s", Dimension::new([
        ("contacts".into(), 1), ("time".into(), -1),
    ]).unwrap(), 1.0).unwrap()
}
fn atom() -> Atom {
    Atom { predicate: "reported".into(), terms: vec![Term::Entity("client".into())] }
}
fn fixture(rate: f64) -> SemanticArchive {
    let mut graph = Graph::new();
    for id in ["client", "market"] {
        graph.add_entity(Entity { id: id.into(), category: "Business".into(),
            attributes: HashMap::new() }).unwrap();
    }
    graph.add_flow(Flow {
        from_entity: "client".into(), to_entity: "market".into(), rate_of_transfer: rate,
    }).unwrap();
    graph.declare_predicate(Predicate { name: "reported".into(),
        arguments: vec![ArgumentKind::EntityCategory("Business".into())] }).unwrap();
    graph.assert_fact(atom(), "ledger:original-record").unwrap();
    let annotation = Annotation::new(rate_unit(),
        Validity::new(100, Some(200)).unwrap(), "ledger:rate").unwrap();
    let snapshot = SemanticSnapshot::from_graph(&graph, vec![annotation], vec![]).unwrap();
    SemanticArchive::new(graph, snapshot).unwrap()
}
fn problem(source: &SemanticArchive) -> GaussProblemV1 {
    GaussProblemV1::prepare(source, "question-original", 150, Objective {
        metric: "reported_contacts_rate".into(), subject_entity_id: "client".into(),
        unit: rate_unit(), direction: Direction::Maximize,
    }, HandoffLimits::default()).unwrap()
}
fn proven(source: &SemanticArchive) -> GaussResponseV1 {
    let query = atom();
    let Decision::Proven { proof } = source.graph.infer(&query, Limits::default())
        else { panic!("asserted source must yield a checked derivation") };
    GaussResponseV1 { contract_version: CONTRACT_VERSION,
        problem_id: "question-original".into(), outcome: GaussOutcomeV1::Proven { query, proof } }
}
fn theorem() -> (E, D) {
    let x = E::Var("x".into(), Ty::Individual);
    (E::Forall("x".into(), Ty::Individual,
        Box::new(E::Equal(Box::new(x.clone()), Box::new(x.clone())))),
     D::ForallIntro { variable: "x".into(), ty: Ty::Individual,
        body: Box::new(D::EqualRefl(x)) })
}
fn check(path: &Path, expected: &[u8], request: &GaussProblemV1,
         response: &GaussResponseV1, formal_limit: AuditLimits) -> Result<nexus_leibniz::formal_audit::ReadOnlyAudit, String> {
    let (claim, derivation) = theorem();
    audit_persisted_pinned(path, expected, request, response,
        HandoffLimits::default(), &claim, Some(&derivation), formal_limit)
}
fn baseline() -> (Scratch, Vec<u8>, GaussProblemV1, GaussResponseV1) {
    let source = fixture(2.0);
    let expected = source.to_bytes().unwrap();
    let request = problem(&source);
    let response = proven(&source);
    let path = Scratch::new();
    source.save_atomic(path.path()).unwrap();
    (path, expected, request, response)
}

#[test]
fn saved_and_restored_real_archive_replays_both_independent_proofs_without_writes() {
    let (path, expected, request, response) = baseline();
    let before = std::fs::read(path.path()).unwrap();
    let result = check(path.path(), &expected, &request, &response, AuditLimits::default()).unwrap();
    assert_eq!(result.handoff, HandoffAssurance::LogicalProofVerified);
    assert_eq!(result.formal, FormalAudit::ClosedTheoremChecked { models_checked: 2 });
    assert_eq!(before, std::fs::read(path.path()).unwrap());
}

#[test]
fn changed_and_rechecksummed_but_valid_archive_cannot_replace_pinned_source() {
    let (path, expected, request, response) = baseline();
    fixture(99.0).save_atomic(path.path()).unwrap();
    assert!(SemanticArchive::load(path.path()).is_ok());
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[test]
fn accidental_on_disk_corruption_is_an_error_not_a_counterexample() {
    let (path, expected, request, response) = baseline();
    let mut bytes = std::fs::read(path.path()).unwrap();
    let position = bytes.len() / 2;
    bytes[position] ^= 1;
    std::fs::write(path.path(), &bytes).unwrap();
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[test]
fn truncated_persisted_source_is_rejected_before_audit() {
    let (path, expected, request, response) = baseline();
    std::fs::write(path.path(), &expected[..expected.len() / 2]).unwrap();
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[test]
fn independently_pinned_bytes_must_match_exactly_even_if_archive_itself_is_valid() {
    let (path, mut expected, request, response) = baseline();
    let position = expected.len() / 2;
    expected[position] ^= 1;
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[test]
fn edited_measurement_in_submitted_problem_fails_against_unmodified_pinned_archive() {
    let (path, expected, mut request, response) = baseline();
    request.active_flows[0].rate = 9.0;
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[test]
fn forged_proof_from_a_real_saved_archive_fails() {
    let (path, expected, request, mut response) = baseline();
    if let GaussOutcomeV1::Proven { proof, .. } = &mut response.outcome {
        proof.steps[0].asserted_sources.clear();
    }
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[test]
fn cross_problem_replay_is_refused() {
    let (path, expected, request, mut response) = baseline();
    response.problem_id = "other-question".into();
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[test]
fn structurally_accepted_estimate_is_never_promoted_to_proven() {
    let (path, expected, request, _) = baseline();
    let response = GaussResponseV1 { contract_version: CONTRACT_VERSION,
        problem_id: "question-original".into(), outcome: GaussOutcomeV1::Estimated {
            probability_basis_points: 8_000, claim: "unverified future outcome".into(),
            model_id: "unverified-estimator".into(),
            estimation_evidence_id: "unverified-input".into(),
            calibration_evidence_id: "unverified-calibration".into(),
        } };
    let result = check(path.path(), &expected, &request, &response, AuditLimits::default()).unwrap();
    assert_eq!(result.handoff, HandoffAssurance::EstimateStructureOnly);
    assert_eq!(result.formal, FormalAudit::ClosedTheoremChecked { models_checked: 2 });
}

#[test]
fn exhausted_independent_model_budget_blocks_operational_audit() {
    let (path, expected, request, response) = baseline();
    assert!(check(path.path(), &expected, &request, &response,
        AuditLimits { max_steps_per_model: 1, ..AuditLimits::default() }).is_err());
}

#[test]
fn missing_source_and_missing_independent_pin_fail_closed() {
    let (path, expected, request, response) = baseline();
    assert!(check(path.path(), &[], &request, &response, AuditLimits::default()).is_err());
    std::fs::remove_file(path.path()).unwrap();
    assert!(check(path.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}

#[cfg(unix)]
#[test]
fn symlink_cannot_redirect_the_pinned_source() {
    let (path, expected, request, response) = baseline();
    let link = Scratch::new();
    std::os::unix::fs::symlink(path.path(), link.path()).unwrap();
    assert!(check(link.path(), &expected, &request, &response, AuditLimits::default()).is_err());
}
