use nexus_leibniz::{
    quantified::{
        infer_quantified, verify_quantified_proof, PredicateQuantifier, QuantifiedDecision,
        QuantifiedQuery, MAX_QUANTIFIED_CANDIDATES,
    },
    schema::Entity,
    ArgumentKind, Atom, Graph, Limits, Predicate, Term,
};
use std::collections::HashMap;

fn setup() -> Graph {
    let mut graph = Graph::new();
    for id in ["a", "b"] {
        graph
            .add_entity(Entity {
                id: id.into(),
                category: "Actor".into(),
                attributes: HashMap::new(),
            })
            .unwrap();
    }
    for name in ["supplies", "transports", "blocks"] {
        graph
            .declare_predicate(Predicate {
                name: name.into(),
                arguments: vec![ArgumentKind::EntityCategory("Actor".into())],
            })
            .unwrap();
    }
    graph
}
fn query(quantifier: PredicateQuantifier) -> QuantifiedQuery {
    QuantifiedQuery {
        quantifier,
        candidates: vec!["transports".into(), "supplies".into()],
        terms: vec![Term::Entity("a".into())],
    }
}
fn evidence(graph: &mut Graph, name: &str) {
    graph
        .assert_fact(
            Atom {
                predicate: name.into(),
                terms: vec![Term::Entity("a".into())],
            },
            &format!("source:{name}"),
        )
        .unwrap();
}

#[test]
fn universal_requires_all_predicates_and_independently_checks_each_proof() {
    let mut graph = setup();
    evidence(&mut graph, "supplies");
    evidence(&mut graph, "transports");
    let question = query(PredicateQuantifier::All);
    let QuantifiedDecision::Proven { witnesses } =
        infer_quantified(&graph, &question, Limits::default(), 2).unwrap()
    else {
        panic!("both facts must be provable");
    };
    assert_eq!(
        witnesses
            .iter()
            .map(|w| w.predicate.as_str())
            .collect::<Vec<_>>(),
        vec!["supplies", "transports"]
    );
    verify_quantified_proof(&graph, &question, &witnesses, Limits::default(), 2).unwrap();
    assert!(
        verify_quantified_proof(&graph, &question, &witnesses[..1], Limits::default(), 2).is_err()
    );
    let mut forged = witnesses;
    forged[0].proof.steps[0].id = 999;
    assert!(verify_quantified_proof(&graph, &question, &forged, Limits::default(), 2).is_err());
}

#[test]
fn missing_universal_premise_is_unknown_not_a_negative_proof() {
    let mut graph = setup();
    evidence(&mut graph, "supplies");
    assert!(matches!(
        infer_quantified(
            &graph,
            &query(PredicateQuantifier::All),
            Limits::default(),
            2
        )
        .unwrap(),
        QuantifiedDecision::Unidentifiable { .. }
    ));
}

#[test]
fn existential_uses_only_a_genuine_witness_and_rejects_forged_membership() {
    let mut graph = setup();
    evidence(&mut graph, "transports");
    let question = query(PredicateQuantifier::Any);
    let QuantifiedDecision::Proven { witnesses } =
        infer_quantified(&graph, &question, Limits::default(), 2).unwrap()
    else {
        panic!("existential witness must be found");
    };
    assert_eq!(witnesses.len(), 1);
    assert_eq!(witnesses[0].predicate, "transports");
    verify_quantified_proof(&graph, &question, &witnesses, Limits::default(), 2).unwrap();
    let mut forged = witnesses;
    forged[0].predicate = "blocks".into();
    assert!(verify_quantified_proof(&graph, &question, &forged, Limits::default(), 2).is_err());
}

#[test]
fn unknown_existence_is_not_false() {
    assert!(matches!(
        infer_quantified(
            &setup(),
            &query(PredicateQuantifier::Any),
            Limits::default(),
            2
        )
        .unwrap(),
        QuantifiedDecision::Unidentifiable { .. }
    ));
}

#[test]
fn domain_budget_duplicates_and_undeclared_predicates_are_rejected() {
    let graph = setup();
    let mut question = query(PredicateQuantifier::All);
    assert!(infer_quantified(&graph, &question, Limits::default(), 1).is_err());
    assert!(infer_quantified(&graph, &question, Limits::default(), 0).is_err());
    question.candidates.push("supplies".into());
    assert!(infer_quantified(&graph, &question, Limits::default(), 3).is_err());
    question.candidates[2] = "invented".into();
    assert!(infer_quantified(&graph, &question, Limits::default(), 3).is_err());
    assert_eq!(MAX_QUANTIFIED_CANDIDATES, 4096);
}

#[test]
fn wrong_terms_and_nonuniform_signatures_are_rejected() {
    let mut graph = setup();
    let mut question = query(PredicateQuantifier::All);
    question.terms = vec![Term::Entity("missing".into())];
    assert!(infer_quantified(&graph, &question, Limits::default(), 2).is_err());
    graph
        .declare_predicate(Predicate {
            name: "binary".into(),
            arguments: vec![ArgumentKind::AnyEntity, ArgumentKind::AnyEntity],
        })
        .unwrap();
    question = query(PredicateQuantifier::All);
    question.candidates[0] = "binary".into();
    assert!(infer_quantified(&graph, &question, Limits::default(), 2).is_err());
}

#[test]
fn contradiction_and_exhaustion_never_generate_a_universal_proof() {
    let mut graph = setup();
    graph
        .declare_incompatible("supplies", "transports")
        .unwrap();
    evidence(&mut graph, "supplies");
    evidence(&mut graph, "transports");
    assert!(matches!(
        infer_quantified(
            &graph,
            &query(PredicateQuantifier::All),
            Limits::default(),
            2
        )
        .unwrap(),
        QuantifiedDecision::Abstain { .. }
    ));
    assert!(matches!(
        infer_quantified(
            &setup(),
            &query(PredicateQuantifier::Any),
            Limits {
                max_rounds: 0,
                max_facts: 0,
                max_matches: 0
            },
            2
        )
        .unwrap(),
        QuantifiedDecision::Abstain { .. }
    ));
}

#[test]
fn truth_table_for_finite_quantifiers_matches_independent_boolean_oracle() {
    for mask in 0..4_u8 {
        let mut graph = setup();
        if mask & 1 != 0 {
            evidence(&mut graph, "supplies");
        }
        if mask & 2 != 0 {
            evidence(&mut graph, "transports");
        }
        for quantifier in [PredicateQuantifier::All, PredicateQuantifier::Any] {
            let question = query(quantifier);
            let expected = match quantifier {
                PredicateQuantifier::All => mask == 3,
                PredicateQuantifier::Any => mask != 0,
            };
            match infer_quantified(&graph, &question, Limits::default(), 2).unwrap() {
                QuantifiedDecision::Proven { witnesses } if expected => {
                    verify_quantified_proof(&graph, &question, &witnesses, Limits::default(), 2)
                        .unwrap()
                }
                QuantifiedDecision::Unidentifiable { .. } if !expected => {}
                other => panic!("mask {mask}, quantifier {quantifier:?}: {other:?}"),
            }
        }
    }
}

#[test]
fn quantified_proofs_accept_derived_horn_conclusions_after_independent_check() {
    use nexus_leibniz::{Pattern, PatternTerm, Rule};
    let mut graph = setup();
    evidence(&mut graph, "supplies");
    graph
        .add_rule(Rule {
            id: "derived-transport".into(),
            body: vec![Pattern {
                predicate: "supplies".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            }],
            head: Pattern {
                predicate: "transports".into(),
                terms: vec![PatternTerm::Variable("x".into())],
            },
        })
        .unwrap();
    let question = query(PredicateQuantifier::All);
    let QuantifiedDecision::Proven { witnesses } =
        infer_quantified(&graph, &question, Limits::default(), 2).unwrap()
    else {
        panic!("the registered Horn rule should derive the second predicate");
    };
    verify_quantified_proof(&graph, &question, &witnesses, Limits::default(), 2).unwrap();
    assert!(witnesses.iter().any(|w| w.proof.steps.len() > 1));
}

#[test]
fn quantified_proof_checker_rejects_extraneous_and_reordered_witnesses() {
    let mut graph = setup();
    evidence(&mut graph, "supplies");
    evidence(&mut graph, "transports");
    let question = query(PredicateQuantifier::All);
    let QuantifiedDecision::Proven { mut witnesses } =
        infer_quantified(&graph, &question, Limits::default(), 2).unwrap()
    else {
        panic!("expected universal proof");
    };
    witnesses.reverse();
    assert!(verify_quantified_proof(&graph, &question, &witnesses, Limits::default(), 2).is_err());
    witnesses.reverse();
    let mut existential = query(PredicateQuantifier::Any);
    assert!(
        verify_quantified_proof(&graph, &existential, &witnesses, Limits::default(), 2).is_err()
    );
    existential.candidates.clear();
    assert!(infer_quantified(&graph, &existential, Limits::default(), 2).is_err());
}
