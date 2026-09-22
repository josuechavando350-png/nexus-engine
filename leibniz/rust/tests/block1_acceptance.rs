use nexus_leibniz::{
    hol::{verify, Budget, Derivation, Expr, Ty},
    schema::Entity,
    ArgumentKind, Atom, Decision, Graph, Limits, Pattern, PatternTerm, Predicate, Rule, Term,
};
use std::collections::HashMap;

fn atom(predicate: &str, subject: &str) -> Atom {
    Atom {
        predicate: predicate.into(),
        terms: vec![Term::Entity(subject.into())],
    }
}
fn prepared_graph() -> Graph {
    let mut graph = Graph::new();
    graph
        .add_entity(Entity {
            id: "a".into(),
            category: "Actor".into(),
            attributes: HashMap::new(),
        })
        .unwrap();
    for name in ["reported", "supported", "excluded"] {
        graph
            .declare_predicate(Predicate {
                name: name.into(),
                arguments: vec![ArgumentKind::AnyEntity],
            })
            .unwrap();
    }
    graph.declare_incompatible("supported", "excluded").unwrap();
    graph
        .add_rule(Rule {
            id: "derivation".into(),
            body: vec![Pattern {
                predicate: "reported".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            }],
            head: Pattern {
                predicate: "supported".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            },
        })
        .unwrap();
    graph
}

#[test]
fn block1_assertion_to_archive_to_independent_global_proof() {
    let mut graph = prepared_graph();
    graph
        .assert_fact(atom("reported", "a"), "ledger:actual-source")
        .unwrap();
    let bytes = graph.to_archive_bytes().unwrap();
    let restored = Graph::from_archive_bytes(&bytes).unwrap();
    assert_eq!(restored.to_archive_bytes().unwrap(), bytes);
    let query = atom("supported", "a");
    let Decision::Proven { proof } = restored.infer(&query, Limits::default()) else {
        panic!("expected derivation");
    };
    assert!(proof
        .steps
        .iter()
        .any(|step| step.asserted_sources.contains("ledger:actual-source")));
    restored
        .verify_consistent_proof(&query, &proof, Limits::default())
        .unwrap();
    let mut counterfeit = proof;
    counterfeit.steps[0].asserted_sources.clear();
    assert!(restored
        .verify_consistent_proof(&query, &counterfeit, Limits::default())
        .is_err());
}

#[test]
fn block1_conflicting_evidence_invalidates_previous_certificate() {
    let mut graph = prepared_graph();
    graph
        .assert_fact(atom("reported", "a"), "ledger:source-one")
        .unwrap();
    let query = atom("supported", "a");
    let Decision::Proven { proof } = graph.infer(&query, Limits::default()) else {
        panic!("expected proof");
    };
    graph
        .assert_fact(atom("excluded", "a"), "ledger:source-two")
        .unwrap();
    assert!(graph
        .verify_consistent_proof(&query, &proof, Limits::default())
        .is_err());
    assert!(matches!(
        graph.infer(&query, Limits::default()),
        Decision::Abstain { .. }
    ));
}

#[test]
fn block1_hol_closed_theorem_does_not_certify_an_external_market_claim() {
    let individual = Ty::Individual;
    let x = Expr::Var("x".into(), individual.clone());
    let reflexive = Expr::Equal(Box::new(x.clone()), Box::new(x));
    let theorem = Expr::Forall("x".into(), individual.clone(), Box::new(reflexive));
    let derivation = Derivation::ForallIntro {
        variable: "x".into(),
        ty: individual,
        body: Box::new(Derivation::EqualRefl(Expr::Var("x".into(), Ty::Individual))),
    };
    verify(&theorem, &[], &derivation, Budget::default()).unwrap();
    assert!(verify(
        &Expr::Const("market_rise".into(), Ty::Prop),
        &[],
        &derivation,
        Budget::default()
    )
    .is_err());
}

#[test]
fn block1_invalid_archive_does_not_recover_a_valid_proof() {
    let mut graph = prepared_graph();
    graph
        .assert_fact(atom("reported", "a"), "ledger:real")
        .unwrap();
    let mut bytes = graph.to_archive_bytes().unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    assert!(Graph::from_archive_bytes(&bytes).is_err());
}
