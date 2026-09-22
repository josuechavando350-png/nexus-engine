use nexus_leibniz::{
    higher_order::{
        compile_higher_order_rules, register_higher_order_rules, HigherOrderPattern,
        HigherOrderRule, PredicateDomain, PredicateReference,
    },
    schema::Entity,
    ArgumentKind, Atom, Decision, Graph, Justification, Limits, PatternTerm, Predicate, Term,
};
use std::collections::HashMap;

fn entity(id: &str, category: &str) -> Entity {
    Entity {
        id: id.into(),
        category: category.into(),
        attributes: HashMap::new(),
    }
}
fn e(id: &str) -> Term {
    Term::Entity(id.into())
}
fn var(name: &str) -> PatternTerm {
    PatternTerm::Variable(name.into())
}
fn named(name: &str, terms: Vec<PatternTerm>) -> HigherOrderPattern {
    HigherOrderPattern {
        predicate: PredicateReference::Named(name.into()),
        terms,
    }
}
fn slot(name: &str, terms: Vec<PatternTerm>) -> HigherOrderPattern {
    HigherOrderPattern {
        predicate: PredicateReference::Slot(name.into()),
        terms,
    }
}
fn domain(slot: &str, names: &[&str]) -> PredicateDomain {
    PredicateDomain {
        slot: slot.into(),
        candidates: names.iter().map(|name| (*name).into()).collect(),
    }
}
fn sample() -> Graph {
    let mut graph = Graph::new();
    for id in ["a", "b", "c"] {
        graph.add_entity(entity(id, "Actor")).unwrap();
    }
    for predicate in ["supplies", "transports", "relevant"] {
        graph
            .declare_predicate(Predicate {
                name: predicate.into(),
                arguments: vec![
                    ArgumentKind::EntityCategory("Actor".into()),
                    ArgumentKind::EntityCategory("Actor".into()),
                ],
            })
            .unwrap();
    }
    graph
}
fn schema() -> HigherOrderRule {
    HigherOrderRule {
        id: "promote".into(),
        domains: vec![domain("p", &["transports", "supplies"])],
        body: vec![slot("p", vec![var("x"), var("y")])],
        head: named("relevant", vec![var("x"), var("y")]),
    }
}

#[test]
fn quantified_predicates_produce_distinct_source_anchored_proofs() {
    let mut graph = sample();
    graph
        .assert_fact(
            Atom {
                predicate: "supplies".into(),
                terms: vec![e("a"), e("b")],
            },
            "ledger:1",
        )
        .unwrap();
    graph
        .assert_fact(
            Atom {
                predicate: "transports".into(),
                terms: vec![e("b"), e("c")],
            },
            "ledger:2",
        )
        .unwrap();
    let ids = register_higher_order_rules(&mut graph, &schema(), 2).unwrap();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    for (from, to) in [("a", "b"), ("b", "c")] {
        let query = Atom {
            predicate: "relevant".into(),
            terms: vec![e(from), e(to)],
        };
        let Decision::Proven { proof } = graph.infer(&query, Limits::default()) else {
            panic!("quantified derivation missing");
        };
        assert!(matches!(&proof.steps.last().unwrap().justification,
            Justification::Derived { rule_id, premises } if ids.contains(rule_id) && premises.len() == 1));
        graph
            .verify_proof(&query, &proof)
            .expect("grounded proof is independently verified");
    }
}

#[test]
fn compilation_is_deterministic_and_cannot_mutate_the_input() {
    let graph = sample();
    let before = graph.export_archive();
    let a = compile_higher_order_rules(&graph, &schema(), 2).unwrap();
    let b = compile_higher_order_rules(&graph, &schema(), 2).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.len(), 2);
    assert_eq!(graph.export_archive(), before);
    let mut reverse = schema();
    reverse.domains[0].candidates.reverse();
    assert_eq!(compile_higher_order_rules(&graph, &reverse, 2).unwrap(), a);
}

#[test]
fn nondeclared_predicates_or_repeated_candidates_cannot_enter_the_catalog() {
    let graph = sample();
    let mut rule = schema();
    rule.domains[0].candidates.push("unregistered".into());
    assert!(compile_higher_order_rules(&graph, &rule, 10).is_err());
    rule.domains[0].candidates = vec!["supplies".into(), "supplies".into()];
    assert!(compile_higher_order_rules(&graph, &rule, 10).is_err());
}

#[test]
fn instance_limit_rejects_expansion_before_generating_rules() {
    let mut graph = sample();
    let mut rule = schema();
    rule.domains.push(domain("q", &["supplies", "transports"]));
    rule.body.push(slot("q", vec![var("y"), var("z")]));
    assert!(compile_higher_order_rules(&graph, &rule, 3).is_err());
    assert!(register_higher_order_rules(&mut graph, &rule, 3).is_err());
    assert!(graph.export_archive().rules.is_empty());
    assert_eq!(
        compile_higher_order_rules(&graph, &rule, 4).unwrap().len(),
        4
    );
}

#[test]
fn invalid_type_in_one_candidate_rolls_back_entire_registration() {
    let mut graph = sample();
    graph
        .declare_predicate(Predicate {
            name: "location".into(),
            arguments: vec![
                ArgumentKind::EntityCategory("Place".into()),
                ArgumentKind::EntityCategory("Place".into()),
            ],
        })
        .unwrap();
    let mut rule = schema();
    rule.domains[0].candidates.push("location".into());
    let before = graph.export_archive();
    assert!(register_higher_order_rules(&mut graph, &rule, 3).is_err());
    assert_eq!(graph.export_archive(), before);
}

#[test]
fn undeclared_unused_or_head_only_slots_fail_closed() {
    let graph = sample();
    let mut rule = schema();
    rule.head = slot("unknown", vec![var("x"), var("y")]);
    assert!(compile_higher_order_rules(&graph, &rule, 4).is_err());
    rule.head = named("relevant", vec![var("x"), var("y")]);
    rule.domains.push(domain("unused", &["supplies"]));
    assert!(compile_higher_order_rules(&graph, &rule, 4).is_err());
    rule.body = vec![named("supplies", vec![var("x"), var("y")])];
    rule.head = slot("p", vec![var("x"), var("y")]);
    rule.domains.pop();
    assert!(compile_higher_order_rules(&graph, &rule, 4).is_err());
}

#[test]
fn variable_safety_and_arity_are_checked_by_original_reasoner() {
    let graph = sample();
    let mut rule = schema();
    rule.head = named("relevant", vec![var("unbound"), var("y")]);
    assert!(compile_higher_order_rules(&graph, &rule, 2).is_err());
    rule.head = named("relevant", vec![var("x"), var("y")]);
    rule.body[0].terms = vec![var("x")];
    assert!(compile_higher_order_rules(&graph, &rule, 2).is_err());
}

#[test]
fn repeated_schema_registration_and_id_collision_are_atomic() {
    let mut graph = sample();
    register_higher_order_rules(&mut graph, &schema(), 2).unwrap();
    let before = graph.export_archive();
    assert!(register_higher_order_rules(&mut graph, &schema(), 2).is_err());
    assert_eq!(graph.export_archive(), before);
}

#[test]
fn graph_archive_preserves_grounded_rule_semantics_and_proof() {
    let mut graph = sample();
    graph
        .assert_fact(
            Atom {
                predicate: "supplies".into(),
                terms: vec![e("a"), e("b")],
            },
            "input:1",
        )
        .unwrap();
    register_higher_order_rules(&mut graph, &schema(), 2).unwrap();
    let archive = graph.to_archive_bytes().unwrap();
    let restored = Graph::from_archive_bytes(&archive).unwrap();
    let query = Atom {
        predicate: "relevant".into(),
        terms: vec![e("a"), e("b")],
    };
    let Decision::Proven { proof } = restored.infer(&query, Limits::default()) else {
        panic!("grounded rule lost on restore");
    };
    restored.verify_proof(&query, &proof).unwrap();
    assert_eq!(
        graph.to_archive_bytes().unwrap(),
        restored.to_archive_bytes().unwrap()
    );
}

#[test]
fn a_forged_grounded_rule_cannot_pass_proof_verification() {
    let mut graph = sample();
    graph
        .assert_fact(
            Atom {
                predicate: "supplies".into(),
                terms: vec![e("a"), e("b")],
            },
            "source",
        )
        .unwrap();
    register_higher_order_rules(&mut graph, &schema(), 2).unwrap();
    let query = Atom {
        predicate: "relevant".into(),
        terms: vec![e("a"), e("b")],
    };
    let Decision::Proven { mut proof } = graph.infer(&query, Limits::default()) else {
        panic!("proof not generated");
    };
    let end = proof.steps.last_mut().unwrap();
    if let Justification::Derived { rule_id, .. } = &mut end.justification {
        *rule_id = "invented:grounding".into();
    } else {
        panic!("last step is not derived");
    }
    assert!(graph.verify_proof(&query, &proof).is_err());
}

#[test]
fn explicit_statement_reification_works_with_quantified_predicates() {
    let mut graph = sample();
    graph
        .declare_predicate(Predicate {
            name: "reviewed".into(),
            arguments: vec![ArgumentKind::Statement],
        })
        .unwrap();
    graph
        .declare_predicate(Predicate {
            name: "audited".into(),
            arguments: vec![ArgumentKind::Statement],
        })
        .unwrap();
    graph
        .declare_predicate(Predicate {
            name: "supported".into(),
            arguments: vec![ArgumentKind::Statement],
        })
        .unwrap();
    let id = graph
        .assert_fact(
            Atom {
                predicate: "supplies".into(),
                terms: vec![e("a"), e("b")],
            },
            "source",
        )
        .unwrap();
    graph
        .assert_fact(
            Atom {
                predicate: "reviewed".into(),
                terms: vec![Term::Statement(id)],
            },
            "reviewer",
        )
        .unwrap();
    let rule = HigherOrderRule {
        id: "source-review".into(),
        domains: vec![domain("meta", &["reviewed", "audited"])],
        body: vec![slot("meta", vec![var("statement")])],
        head: named("supported", vec![var("statement")]),
    };
    register_higher_order_rules(&mut graph, &rule, 2).unwrap();
    let query = Atom {
        predicate: "supported".into(),
        terms: vec![Term::Statement(id)],
    };
    let Decision::Proven { proof } = graph.infer(&query, Limits::default()) else {
        panic!("reified inference missing");
    };
    graph.verify_proof(&query, &proof).unwrap();
    assert!(graph
        .assert_fact(
            Atom {
                predicate: "reviewed".into(),
                terms: vec![Term::Statement(u64::MAX)]
            },
            "forged"
        )
        .is_err());
}

#[test]
fn same_user_supplied_separator_characters_cannot_alias_rule_ids() {
    let mut graph = sample();
    let mut first = schema();
    first.id = "a:b".into();
    let mut second = schema();
    second.id = "a".into();
    let ids_a = register_higher_order_rules(&mut graph, &first, 2).unwrap();
    let ids_b = register_higher_order_rules(&mut graph, &second, 2).unwrap();
    assert!(ids_a.iter().all(|id| !ids_b.contains(id)));
}

#[test]
fn exhaustive_boolean_oracle_confirms_finite_predicate_quantification() {
    // Independent truth table: relevant(a,b) iff supplies(a,b) OR transports(a,b).
    // Test all 16 assignments to two predicates on two separate entity pairs.
    for mask in 0..16_u8 {
        let mut graph = sample();
        for (bit, predicate, from, to) in [
            (0, "supplies", "a", "b"),
            (1, "transports", "a", "b"),
            (2, "supplies", "b", "c"),
            (3, "transports", "b", "c"),
        ] {
            if mask & (1 << bit) != 0 {
                graph
                    .assert_fact(
                        Atom {
                            predicate: predicate.into(),
                            terms: vec![e(from), e(to)],
                        },
                        &format!("oracle:{mask}:{bit}"),
                    )
                    .unwrap();
            }
        }
        register_higher_order_rules(&mut graph, &schema(), 2).unwrap();
        for (from, to, first, second) in [("a", "b", 0, 1), ("b", "c", 2, 3)] {
            let query = Atom {
                predicate: "relevant".into(),
                terms: vec![e(from), e(to)],
            };
            let oracle = (mask & (1 << first) != 0) || (mask & (1 << second) != 0);
            match graph.infer(&query, Limits::default()) {
                Decision::Proven { proof } if oracle => graph.verify_proof(&query, &proof).unwrap(),
                Decision::Unidentifiable { .. } if !oracle => {}
                other => panic!("mask {mask} pair {from}->{to} violates truth table: {other:?}"),
            }
        }
    }
}

#[test]
fn derived_incompatibility_requires_abstention_not_false_certainty() {
    let mut graph = sample();
    graph
        .declare_predicate(Predicate {
            name: "blocked".into(),
            arguments: vec![
                ArgumentKind::EntityCategory("Actor".into()),
                ArgumentKind::EntityCategory("Actor".into()),
            ],
        })
        .unwrap();
    graph.declare_incompatible("relevant", "blocked").unwrap();
    graph
        .assert_fact(
            Atom {
                predicate: "supplies".into(),
                terms: vec![e("a"), e("b")],
            },
            "source:1",
        )
        .unwrap();
    graph
        .assert_fact(
            Atom {
                predicate: "blocked".into(),
                terms: vec![e("a"), e("b")],
            },
            "source:2",
        )
        .unwrap();
    register_higher_order_rules(&mut graph, &schema(), 2).unwrap();
    let query = Atom {
        predicate: "relevant".into(),
        terms: vec![e("a"), e("b")],
    };
    assert!(matches!(
        graph.infer(&query, Limits::default()),
        Decision::Abstain { .. }
    ));
}

#[test]
fn finite_predicate_domains_must_have_at_least_one_symbol() {
    let graph = sample();
    let mut rule = schema();
    rule.domains[0].candidates.clear();
    assert!(compile_higher_order_rules(&graph, &rule, 2).is_err());
    rule.domains = vec![];
    assert!(compile_higher_order_rules(&graph, &rule, 2).is_err());
}

#[test]
fn empty_or_duplicate_predicate_slots_are_rejected() {
    let graph = sample();
    let mut rule = schema();
    rule.domains[0].slot = " ".into();
    assert!(compile_higher_order_rules(&graph, &rule, 2).is_err());
    rule.domains[0].slot = "p".into();
    rule.domains.push(domain("p", &["supplies"]));
    assert!(compile_higher_order_rules(&graph, &rule, 2).is_err());
}
