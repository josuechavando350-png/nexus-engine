use nexus_leibniz::{
    schema::{AttributeValue, Entity, Flow, Restriction, RestrictionType},
    ArgumentKind, Atom, Decision, Graph, Justification, Limits, Pattern, PatternTerm, Predicate,
    Rule, Term,
};
use std::collections::HashMap;

fn e(id: &str) -> Term {
    Term::Entity(id.into())
}
fn var(name: &str) -> PatternTerm {
    PatternTerm::Variable(name.into())
}
fn pat(name: &str, terms: Vec<PatternTerm>) -> Pattern {
    Pattern {
        predicate: name.into(),
        terms,
    }
}
fn a(name: &str, terms: Vec<Term>) -> Atom {
    Atom {
        predicate: name.into(),
        terms,
    }
}
fn entity(id: &str) -> Entity {
    Entity {
        id: id.into(),
        category: "Actor".into(),
        attributes: HashMap::new(),
    }
}
fn graph() -> Graph {
    let mut g = Graph::new();
    for id in ["a", "b", "c", "d"] {
        g.add_entity(entity(id)).unwrap();
    }
    for name in ["depends_on", "reachable"] {
        g.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![
                ArgumentKind::EntityCategory("Actor".into()),
                ArgumentKind::EntityCategory("Actor".into()),
            ],
        })
        .unwrap();
    }
    g
}

#[test]
fn transitive_inference_has_a_real_reproducible_proof() {
    let mut g = graph();
    g.assert_fact(a("depends_on", vec![e("a"), e("b")]), "ledger:1")
        .unwrap();
    g.assert_fact(a("depends_on", vec![e("b"), e("c")]), "ledger:2")
        .unwrap();
    g.assert_fact(a("depends_on", vec![e("c"), e("d")]), "ledger:3")
        .unwrap();
    g.add_rule(Rule {
        id: "base".into(),
        body: vec![pat("depends_on", vec![var("x"), var("y")])],
        head: pat("reachable", vec![var("x"), var("y")]),
    })
    .unwrap();
    g.add_rule(Rule {
        id: "transitive".into(),
        body: vec![
            pat("reachable", vec![var("x"), var("y")]),
            pat("reachable", vec![var("y"), var("z")]),
        ],
        head: pat("reachable", vec![var("x"), var("z")]),
    })
    .unwrap();
    let query = a("reachable", vec![e("a"), e("d")]);
    let result = g.infer(&query, Limits::default());
    let Decision::Proven { proof } = result else {
        panic!("no proof for transitive path");
    };
    assert_eq!(proof.steps.last().unwrap().atom, query);
    assert!(proof.steps.iter().any(|f| matches!(&f.justification,
        Justification::Derived {rule_id, premises} if rule_id == "transitive" && premises.len() == 2)));
    assert!(proof
        .steps
        .iter()
        .any(|f| f.asserted_sources.contains("ledger:1")));
    assert_eq!(g.fact_count(), 3, "infer must not mutate the input graph");
}

#[test]
fn absent_fact_is_unidentifiable_not_false() {
    let g = graph();
    assert!(matches!(
        g.infer(&a("reachable", vec![e("a"), e("b")]), Limits::default()),
        Decision::Unidentifiable { .. }
    ));
}

#[test]
fn evidence_from_multiple_sources_is_not_lost_on_deduplication() {
    let mut g = graph();
    let atom = a("depends_on", vec![e("a"), e("b")]);
    let id = g.assert_fact(atom.clone(), "source:a").unwrap();
    assert_eq!(g.assert_fact(atom.clone(), "source:b").unwrap(), id);
    assert_eq!(g.fact_count(), 1);
    let Decision::Proven { proof } = g.infer(&atom, Limits::default()) else {
        panic!("expected proof");
    };
    assert_eq!(proof.steps[0].asserted_sources.len(), 2);
}

#[test]
fn contradictory_assertions_force_abstention() {
    let mut g = graph();
    for name in ["allowed", "forbidden"] {
        g.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![ArgumentKind::AnyEntity],
        })
        .unwrap();
    }
    g.declare_incompatible("allowed", "forbidden").unwrap();
    let allowed = a("allowed", vec![e("a")]);
    g.assert_fact(allowed.clone(), "source:a").unwrap();
    g.assert_fact(a("forbidden", vec![e("a")]), "source:b")
        .unwrap();
    assert!(matches!(
        g.infer(&allowed, Limits::default()),
        Decision::Abstain { .. }
    ));
}

#[test]
fn reified_statement_is_a_first_class_graph_node() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "corroborates".into(),
        arguments: vec![ArgumentKind::Statement, ArgumentKind::Statement],
    })
    .unwrap();
    let first = g
        .assert_fact(a("depends_on", vec![e("a"), e("b")]), "source:1")
        .unwrap();
    let second = g
        .assert_fact(a("depends_on", vec![e("b"), e("c")]), "source:2")
        .unwrap();
    let meta = a(
        "corroborates",
        vec![Term::Statement(first), Term::Statement(second)],
    );
    assert!(matches!(
        g.infer(&meta, Limits::default()),
        Decision::Unidentifiable { .. }
    ));
    g.assert_fact(meta.clone(), "source:analysis").unwrap();
    assert!(matches!(
        g.infer(&meta, Limits::default()),
        Decision::Proven { .. }
    ));
    assert!(g
        .assert_fact(
            a(
                "corroborates",
                vec![Term::Statement(12345), Term::Statement(first)]
            ),
            "x"
        )
        .is_err());
}

#[test]
fn domain_constraints_do_not_silently_turn_into_physical_laws() {
    let mut g = graph();
    g.add_restriction(Restriction {
        source_id: "a".into(),
        target_id: "b".into(),
        constraint_type: RestrictionType::Conditional,
        boundary_value: 0.5,
    })
    .unwrap();
    g.add_flow(Flow {
        from_entity: "a".into(),
        to_entity: "b".into(),
        rate_of_transfer: 4.0,
    })
    .unwrap();
    assert_eq!(g.restrictions().len(), 1);
    assert_eq!(g.flows().len(), 1);
    assert!(matches!(
        g.infer(&a("reachable", vec![e("a"), e("b")]), Limits::default()),
        Decision::Unidentifiable { .. }
    ));
    let snapshot = g.snapshot();
    assert_eq!(snapshot.entities.len(), 4);
    assert_eq!(snapshot.flows.as_slice(), g.flows());
    assert_eq!(snapshot.restrictions.as_slice(), g.restrictions());
    assert_eq!(snapshot.asserted_facts.len(), 0);
}

#[test]
fn snapshot_is_detached_from_mutations_and_contains_real_evidence() {
    let mut g = graph();
    let original = a("depends_on", vec![e("a"), e("b")]);
    g.assert_fact(original.clone(), "source:measured").unwrap();
    let snapshot = g.snapshot();
    assert_eq!(snapshot.asserted_facts[0].atom, original);
    assert!(snapshot.asserted_facts[0]
        .asserted_sources
        .contains("source:measured"));
    g.assert_fact(a("depends_on", vec![e("c"), e("d")]), "source:later")
        .unwrap();
    assert_eq!(snapshot.asserted_facts.len(), 1);
    assert_eq!(g.snapshot().asserted_facts.len(), 2);
}

#[test]
fn rejects_unsafe_rules_and_mismatched_categories() {
    let mut g = graph();
    assert!(g
        .add_rule(Rule {
            id: "bad".into(),
            body: vec![pat("depends_on", vec![var("x"), var("y")])],
            head: pat("reachable", vec![var("x"), var("unbound")])
        })
        .is_err());
    g.add_entity(Entity {
        id: "place".into(),
        category: "Place".into(),
        attributes: HashMap::new(),
    })
    .unwrap();
    assert!(g
        .assert_fact(a("depends_on", vec![e("a"), e("place")]), "source")
        .is_err());
}

#[test]
fn rejects_nonfinite_numbers_and_unknown_entities() {
    let mut g = graph();
    let mut attributes = HashMap::new();
    attributes.insert("cost".into(), AttributeValue::Number(f64::NAN));
    assert!(g
        .add_entity(Entity {
            id: "invalid".into(),
            category: "Actor".into(),
            attributes
        })
        .is_err());
    assert!(g
        .add_flow(Flow {
            from_entity: "a".into(),
            to_entity: "missing".into(),
            rate_of_transfer: 3.0
        })
        .is_err());
    assert!(g
        .add_restriction(Restriction {
            source_id: "a".into(),
            target_id: "b".into(),
            constraint_type: RestrictionType::Immutable,
            boundary_value: f64::INFINITY
        })
        .is_err());
}

#[test]
fn capped_computation_abstains_instead_of_returning_a_false_answer() {
    let mut g = graph();
    g.assert_fact(a("depends_on", vec![e("a"), e("b")]), "source")
        .unwrap();
    g.add_rule(Rule {
        id: "base".into(),
        body: vec![pat("depends_on", vec![var("x"), var("y")])],
        head: pat("reachable", vec![var("x"), var("y")]),
    })
    .unwrap();
    assert!(matches!(
        g.infer(
            &a("reachable", vec![e("a"), e("b")]),
            Limits {
                max_rounds: 0,
                max_facts: 100,
                max_matches: 100
            }
        ),
        Decision::Abstain { .. }
    ));
    assert!(matches!(
        g.infer(
            &a("reachable", vec![e("a"), e("b")]),
            Limits {
                max_rounds: 10,
                max_facts: 1,
                max_matches: 100
            }
        ),
        Decision::Abstain { .. }
    ));
}

#[test]
fn no_probability_is_fabricated_by_the_deterministic_reasoner() {
    let mut g = graph();
    g.assert_fact(a("depends_on", vec![e("a"), e("b")]), "source")
        .unwrap();
    for query in [
        a("depends_on", vec![e("a"), e("b")]),
        a("depends_on", vec![e("a"), e("d")]),
    ] {
        assert!(!matches!(
            g.infer(&query, Limits::default()),
            Decision::Estimated { .. }
        ));
    }
}

#[test]
fn rules_can_reason_about_statements_without_conflating_them_with_entities() {
    let mut g = graph();
    for name in ["reviewed", "supported"] {
        g.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![ArgumentKind::Statement],
        })
        .unwrap();
    }
    let statement_id = g
        .assert_fact(a("depends_on", vec![e("a"), e("b")]), "statement:original")
        .unwrap();
    g.assert_fact(
        a("reviewed", vec![Term::Statement(statement_id)]),
        "reviewer:1",
    )
    .unwrap();
    g.add_rule(Rule {
        id: "review-implies-supported".into(),
        body: vec![pat("reviewed", vec![var("statement")])],
        head: pat("supported", vec![var("statement")]),
    })
    .unwrap();
    let Decision::Proven { proof } = g.infer(
        &a("supported", vec![Term::Statement(statement_id)]),
        Limits::default(),
    ) else {
        panic!("missing derived statement-level proof");
    };
    assert_eq!(proof.steps.len(), 2);
    assert!(proof.steps[0].asserted_sources.contains("reviewer:1"));
}

#[test]
fn invalid_rule_instantiation_does_not_claim_a_proof() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "references".into(),
        arguments: vec![ArgumentKind::Statement],
    })
    .unwrap();
    g.assert_fact(a("depends_on", vec![e("a"), e("b")]), "source")
        .unwrap();
    assert!(g
        .add_rule(Rule {
            id: "type-error".into(),
            body: vec![pat("depends_on", vec![var("x"), var("y")])],
            head: pat("references", vec![var("x")])
        })
        .is_err());
    let query = a("depends_on", vec![e("a"), e("b")]);
    assert!(matches!(
        g.infer(&query, Limits::default()),
        Decision::Proven { .. }
    ));
}

fn graph_with_proof() -> (Graph, Atom, nexus_leibniz::Proof) {
    let mut g = graph();
    g.assert_fact(a("depends_on", vec![e("a"), e("b")]), "source:1")
        .unwrap();
    g.assert_fact(a("depends_on", vec![e("b"), e("c")]), "source:2")
        .unwrap();
    g.add_rule(Rule {
        id: "direct".into(),
        body: vec![pat("depends_on", vec![var("x"), var("y")])],
        head: pat("reachable", vec![var("x"), var("y")]),
    })
    .unwrap();
    g.add_rule(Rule {
        id: "chain".into(),
        body: vec![
            pat("reachable", vec![var("x"), var("y")]),
            pat("reachable", vec![var("y"), var("z")]),
        ],
        head: pat("reachable", vec![var("x"), var("z")]),
    })
    .unwrap();
    let query = a("reachable", vec![e("a"), e("c")]);
    let Decision::Proven { proof } = g.infer(&query, Limits::default()) else {
        panic!("not proven")
    };
    (g, query, proof)
}

#[test]
fn independently_verifies_transitive_proof_without_mutating_graph() {
    let (g, query, proof) = graph_with_proof();
    assert_eq!(g.fact_count(), 2);
    g.verify_proof(&query, &proof)
        .expect("valid source-anchored derivation");
    assert_eq!(g.fact_count(), 2);
}

#[test]
fn tampered_assertion_cannot_forge_provenance() {
    let (g, query, mut proof) = graph_with_proof();
    let asserted = proof
        .steps
        .iter_mut()
        .find(|f| matches!(&f.justification, Justification::Asserted { .. }))
        .unwrap();
    asserted.asserted_sources.insert("invented:source".into());
    assert!(g.verify_proof(&query, &proof).is_err());
}

#[test]
fn tampered_rule_or_conclusion_cannot_forge_derivation() {
    let (g, query, proof) = graph_with_proof();
    let mut wrong_rule = proof.clone();
    let derived = wrong_rule
        .steps
        .iter_mut()
        .find(|f| matches!(&f.justification, Justification::Derived { .. }))
        .unwrap();
    if let Justification::Derived { rule_id, .. } = &mut derived.justification {
        *rule_id = "fake".into();
    }
    assert!(g.verify_proof(&query, &wrong_rule).is_err());

    let mut wrong_conclusion = proof.clone();
    let last = wrong_conclusion.steps.last_mut().unwrap();
    last.atom.terms[1] = e("d");
    assert!(g.verify_proof(&query, &wrong_conclusion).is_err());
}

#[test]
fn proof_rejected_if_it_conflicts_with_a_separate_asserted_fact() {
    let (mut g, query, proof) = graph_with_proof();
    g.declare_predicate(Predicate {
        name: "blocked".into(),
        arguments: vec![
            ArgumentKind::EntityCategory("Actor".into()),
            ArgumentKind::EntityCategory("Actor".into()),
        ],
    })
    .unwrap();
    g.declare_incompatible("reachable", "blocked").unwrap();
    g.assert_fact(a("blocked", vec![e("a"), e("c")]), "source:conflict")
        .unwrap();
    assert!(g.verify_proof(&query, &proof).is_err());
    assert!(matches!(
        g.infer(&query, Limits::default()),
        Decision::Abstain { .. }
    ));
}

#[test]
fn missing_or_forward_premise_cannot_pass_verification() {
    let (g, query, proof) = graph_with_proof();
    let mut missing = proof.clone();
    let derived = missing
        .steps
        .iter_mut()
        .find(|f| matches!(&f.justification, Justification::Derived { .. }))
        .unwrap();
    if let Justification::Derived { premises, .. } = &mut derived.justification {
        premises[0] = u64::MAX;
    }
    assert!(g.verify_proof(&query, &missing).is_err());

    let mut reordered = proof.clone();
    let derived_index = reordered
        .steps
        .iter()
        .position(|f| matches!(&f.justification, Justification::Derived { .. }))
        .unwrap();
    reordered.steps.swap(0, derived_index);
    assert!(g.verify_proof(&query, &reordered).is_err());
}

#[test]
fn mismatched_variable_types_are_rejected_at_rule_registration() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "reviewed".into(),
        arguments: vec![ArgumentKind::Statement],
    })
    .unwrap();
    g.declare_predicate(Predicate {
        name: "generic".into(),
        arguments: vec![ArgumentKind::AnyEntity],
    })
    .unwrap();
    assert!(g
        .add_rule(Rule {
            id: "entity-becomes-statement".into(),
            body: vec![pat("generic", vec![var("x")])],
            head: pat("reviewed", vec![var("x")])
        })
        .is_err());
    assert!(g
        .add_rule(Rule {
            id: "disjoint-join".into(),
            body: vec![
                pat("generic", vec![var("x")]),
                pat("reviewed", vec![var("x")])
            ],
            head: pat("generic", vec![var("x")])
        })
        .is_err());
}

#[test]
fn incompatible_entity_categories_cannot_be_unified_by_a_rule() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "place".into(),
        arguments: vec![ArgumentKind::EntityCategory("Place".into())],
    })
    .unwrap();
    assert!(g
        .add_rule(Rule {
            id: "bad-category".into(),
            body: vec![
                pat("place", vec![var("x")]),
                pat("depends_on", vec![var("x"), var("y")])
            ],
            head: pat("reachable", vec![var("x"), var("y")])
        })
        .is_err());
}

#[test]
fn transitive_closure_matches_independent_graph_oracle_for_32_graphs() {
    // Independent boolean Floyd-Warshall oracle, not a second invocation of
    // the production Horn-rule reasoner. It covers cyclic and disconnected
    // topologies with a reproducible local pseudorandom fixture.
    let nodes = ["a", "b", "c", "d"];
    for seed in 0..32_u64 {
        let mut g = graph();
        let mut oracle = [[false; 4]; 4];
        let mut random = seed.wrapping_add(1);
        for from in 0..4 {
            for to in 0..4 {
                random = random
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                if random >> 61 == 0 {
                    g.assert_fact(
                        a("depends_on", vec![e(nodes[from]), e(nodes[to])]),
                        &format!("fixture:{seed}:{from}:{to}"),
                    )
                    .unwrap();
                    oracle[from][to] = true;
                }
            }
        }
        for via in 0..4 {
            for from in 0..4 {
                for to in 0..4 {
                    oracle[from][to] |= oracle[from][via] && oracle[via][to];
                }
            }
        }
        g.add_rule(Rule {
            id: "direct".into(),
            body: vec![pat("depends_on", vec![var("x"), var("y")])],
            head: pat("reachable", vec![var("x"), var("y")]),
        })
        .unwrap();
        g.add_rule(Rule {
            id: "chain".into(),
            body: vec![
                pat("reachable", vec![var("x"), var("y")]),
                pat("reachable", vec![var("y"), var("z")]),
            ],
            head: pat("reachable", vec![var("x"), var("z")]),
        })
        .unwrap();
        for from in 0..4 {
            for to in 0..4 {
                let query = a("reachable", vec![e(nodes[from]), e(nodes[to])]);
                match g.infer(&query, Limits::default()) {
                    Decision::Proven { proof } if oracle[from][to] => g
                        .verify_consistent_proof(&query, &proof, Limits::default())
                        .expect("oracle-confirmed globally consistent proof"),
                    Decision::Unidentifiable { .. } if !oracle[from][to] => {}
                    unexpected => panic!("seed {seed}, ({from},{to}): {unexpected:?}"),
                }
            }
        }
    }
}

#[test]
fn standalone_proof_is_not_a_global_consistency_certificate() {
    let mut g = graph();
    for name in ["safe", "unsafe"] {
        g.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![ArgumentKind::AnyEntity],
        })
        .unwrap();
    }
    let original = a("depends_on", vec![e("a"), e("b")]);
    g.assert_fact(original, "source:observed").unwrap();
    g.add_rule(Rule {
        id: "proof-safe".into(),
        body: vec![pat("depends_on", vec![var("x"), var("y")])],
        head: pat("safe", vec![var("x")]),
    })
    .unwrap();
    let query = a("safe", vec![e("a")]);
    let Decision::Proven { proof } = g.infer(&query, Limits::default()) else {
        panic!("first rule should entail the safe claim");
    };
    g.verify_proof(&query, &proof).unwrap();
    g.declare_incompatible("safe", "unsafe").unwrap();
    g.add_rule(Rule {
        id: "proof-unsafe".into(),
        body: vec![pat("depends_on", vec![var("x"), var("y")])],
        head: pat("unsafe", vec![var("x")]),
    })
    .unwrap();
    // Local derivation is still valid. Global certification must reject it.
    g.verify_proof(&query, &proof).unwrap();
    assert!(matches!(
        g.infer(&query, Limits::default()),
        Decision::Abstain { .. }
    ));
    assert!(g
        .verify_consistent_proof(&query, &proof, Limits::default())
        .is_err());
}

#[test]
fn consistent_proof_gate_rejects_exhaustion_and_accepts_complete_closure() {
    let (g, query, proof) = graph_with_proof();
    g.verify_consistent_proof(&query, &proof, Limits::default())
        .unwrap();
    assert!(g
        .verify_consistent_proof(
            &query,
            &proof,
            Limits {
                max_rounds: 0,
                max_facts: 100,
                max_matches: 100,
            }
        )
        .is_err());
    assert_eq!(g.fact_count(), 2, "verification must not mutate input");
}

#[test]
fn unification_work_budget_counts_failed_attempts_not_only_matches() {
    let mut g = graph();
    for (from, to) in [("a", "b"), ("b", "c"), ("c", "d")] {
        g.assert_fact(a("depends_on", vec![e(from), e(to)]), "ledger")
            .unwrap();
    }
    g.add_rule(Rule {
        id: "two-hop".into(),
        body: vec![
            pat("depends_on", vec![var("x"), var("y")]),
            pat("depends_on", vec![var("y"), var("z")]),
        ],
        head: pat("reachable", vec![var("x"), var("z")]),
    })
    .unwrap();
    let query = a("reachable", vec![e("a"), e("c")]);
    // 3 first-premise matches + 9 second-premise *attempts*, but just two
    // second-premise successes. Budget 5 used to permit much more work.
    assert!(matches!(
        g.infer(
            &query,
            Limits {
                max_rounds: 10,
                max_facts: 100,
                max_matches: 5,
            }
        ),
        Decision::Abstain { .. }
    ));
    let Decision::Proven { proof } = g.infer(
        &query,
        Limits {
            max_rounds: 10,
            max_facts: 100,
            max_matches: 100,
        },
    ) else {
        panic!("a sufficiently funded graph must complete");
    };
    g.verify_consistent_proof(
        &query,
        &proof,
        Limits {
            max_rounds: 10,
            max_facts: 100,
            max_matches: 100,
        },
    )
    .unwrap();
}

#[test]
fn unification_budget_is_cumulative_across_all_closure_rounds() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "completed".into(),
        arguments: vec![ArgumentKind::AnyEntity],
    })
    .unwrap();
    g.assert_fact(a("depends_on", vec![e("a"), e("b")]), "source:edge")
        .unwrap();
    g.add_rule(Rule {
        id: "first".into(),
        body: vec![pat("depends_on", vec![var("x"), var("y")])],
        head: pat("reachable", vec![var("x"), var("y")]),
    })
    .unwrap();
    g.add_rule(Rule {
        id: "second".into(),
        body: vec![pat("reachable", vec![var("x"), var("y")])],
        head: pat("completed", vec![var("x")]),
    })
    .unwrap();
    let query = a("completed", vec![e("a")]);
    // Round 0: one attempt; round 1: two; fixed-point round 2: two.
    // An old per-round reset incorrectly accepted this three-attempt budget.
    let insufficient = Limits {
        max_rounds: 10,
        max_facts: 100,
        max_matches: 3,
    };
    assert!(matches!(
        g.infer(&query, insufficient),
        Decision::Abstain { .. }
    ));
    let complete = Limits {
        max_matches: 5,
        ..insufficient
    };
    let Decision::Proven { proof } = g.infer(&query, complete) else {
        panic!("a five-attempt global budget must reach fixed point")
    };
    g.verify_consistent_proof(&query, &proof, complete).unwrap();
    assert_eq!(g.fact_count(), 1, "the source graph must remain unchanged");
}

#[test]
fn missing_later_premise_skips_unsatisfiable_join_without_spending_budget() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "no_evidence".into(),
        arguments: vec![ArgumentKind::AnyEntity],
    })
    .unwrap();
    for (from, to) in [("a", "b"), ("b", "c"), ("c", "d")] {
        g.assert_fact(a("depends_on", vec![e(from), e(to)]), "source:edge")
            .unwrap();
    }
    g.add_rule(Rule {
        id: "unreachable_join".into(),
        body: vec![
            pat("depends_on", vec![var("x"), var("y")]),
            pat("no_evidence", vec![var("x")]),
        ],
        head: pat("reachable", vec![var("x"), var("y")]),
    })
    .unwrap();
    let query = a("depends_on", vec![e("a"), e("b")]);
    let limits = Limits {
        max_rounds: 5,
        max_facts: 10,
        max_matches: 1,
    };
    let Decision::Proven { proof } = g.infer(&query, limits) else {
        panic!("a rule with an absent premise cannot entail new facts")
    };
    g.verify_consistent_proof(&query, &proof, limits).unwrap();
}

#[test]
fn consistent_proof_gate_limits_untrusted_proof_size_before_verification() {
    let (g, query, proof) = graph_with_proof();
    let tight = Limits {
        max_rounds: 10,
        max_facts: 2,
        max_matches: 100,
    };
    // The original two assertions fit, but the submitted proof also carries
    // two derived steps: refuse a larger untrusted certificate up front.
    assert!(proof.steps.len() > 2);
    assert!(g.verify_consistent_proof(&query, &proof, tight).is_err());
}

#[test]
fn exhaustive_three_source_truth_table_matches_consistency_decisions() {
    // Independent finite oracle: safe(a) iff support(a) and no contradictory
    // counterclaim. An unrelated assertion must not affect the result.
    for mask in 0_u8..8 {
        let mut g = graph();
        for predicate in ["support", "counterclaim", "safe", "unsafe", "unrelated"] {
            g.declare_predicate(Predicate {
                name: predicate.into(),
                arguments: vec![ArgumentKind::AnyEntity],
            })
            .unwrap();
        }
        g.declare_incompatible("safe", "unsafe").unwrap();
        for (input, output) in [("support", "safe"), ("counterclaim", "unsafe")] {
            g.add_rule(Rule {
                id: format!("derive-{output}"),
                body: vec![pat(input, vec![var("x")])],
                head: pat(output, vec![var("x")]),
            })
            .unwrap();
        }
        for (bit, predicate) in [(0, "support"), (1, "counterclaim"), (2, "unrelated")] {
            if mask & (1 << bit) != 0 {
                g.assert_fact(a(predicate, vec![e("a")]), &format!("oracle:{mask}:{bit}"))
                    .unwrap();
            }
        }
        let query = a("safe", vec![e("a")]);
        let supported = mask & 1 != 0;
        let contradicted = mask & 2 != 0;
        match g.infer(&query, Limits::default()) {
            Decision::Proven { proof } if supported && !contradicted => {
                g.verify_consistent_proof(&query, &proof, Limits::default())
                    .unwrap();
            }
            Decision::Abstain { .. } if supported && contradicted => {}
            Decision::Unidentifiable { .. } if !supported => {}
            other => panic!("oracle mismatch for mask {mask}: {other:?}"),
        }
    }
}

#[test]
fn shared_proof_dependencies_appear_once_and_before_both_conclusions() {
    let mut g = graph();
    for name in ["left", "right", "combined"] {
        g.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![ArgumentKind::AnyEntity],
        })
        .unwrap();
    }
    g.assert_fact(a("depends_on", vec![e("a"), e("b")]), "source:shared")
        .unwrap();
    for (id, head) in [("derive-left", "left"), ("derive-right", "right")] {
        g.add_rule(Rule {
            id: id.into(),
            body: vec![pat("depends_on", vec![var("x"), var("y")])],
            head: pat(head, vec![var("x")]),
        })
        .unwrap();
    }
    g.add_rule(Rule {
        id: "combine".into(),
        body: vec![pat("left", vec![var("x")]), pat("right", vec![var("x")])],
        head: pat("combined", vec![var("x")]),
    })
    .unwrap();
    let query = a("combined", vec![e("a")]);
    let Decision::Proven { proof } = g.infer(&query, Limits::default()) else {
        panic!("expected shared-premise proof")
    };
    assert_eq!(proof.steps.len(), 4);
    assert_eq!(proof.steps[0].atom.predicate, "depends_on");
    assert_eq!(proof.steps[3].atom, query);
    assert!(proof.steps[1..3]
        .iter()
        .any(|step| step.atom.predicate == "left"));
    assert!(proof.steps[1..3]
        .iter()
        .any(|step| step.atom.predicate == "right"));
    g.verify_consistent_proof(&query, &proof, Limits::default())
        .unwrap();
}

#[test]
fn long_proof_chain_uses_postorder_without_recursive_collection() {
    const DEPTH: usize = 96;
    let mut g = graph();
    for index in 0..=DEPTH {
        g.declare_predicate(Predicate {
            name: format!("level-{index}"),
            arguments: vec![ArgumentKind::AnyEntity],
        })
        .unwrap();
    }
    g.assert_fact(a("level-0", vec![e("a")]), "source:start")
        .unwrap();
    for index in 0..DEPTH {
        g.add_rule(Rule {
            id: format!("advance-{index}"),
            body: vec![pat(&format!("level-{index}"), vec![var("x")])],
            head: pat(&format!("level-{}", index + 1), vec![var("x")]),
        })
        .unwrap();
    }
    let query = a(&format!("level-{DEPTH}"), vec![e("a")]);
    let limits = Limits {
        max_rounds: DEPTH + 1,
        max_facts: DEPTH + 2,
        max_matches: 20_000,
    };
    let Decision::Proven { proof } = g.infer(&query, limits) else {
        panic!("long chain did not produce a proof")
    };
    assert_eq!(proof.steps.len(), DEPTH + 1);
    for (index, step) in proof.steps.iter().enumerate() {
        assert_eq!(step.atom.predicate, format!("level-{index}"));
    }
    g.verify_consistent_proof(&query, &proof, limits).unwrap();
}

#[test]
fn independent_proof_verifier_rejects_oversized_certificates_before_validating_steps() {
    let (graph, query, proof) = graph_with_proof();
    assert!(proof.steps.len() > 1);
    let err = graph
        .verify_proof_bounded(&query, &proof, 1, usize::MAX)
        .unwrap_err();
    assert!(err.contains("max_steps"), "{err}");
    // The valid proof also has derived dependencies; zero allowed premise
    // references is insufficient even though all source assertions are real.
    let err = graph
        .verify_proof_bounded(&query, &proof, proof.steps.len(), 0)
        .unwrap_err();
    assert!(err.contains("max_premise_refs"), "{err}");
    graph
        .verify_proof_bounded(&query, &proof, proof.steps.len(), 32)
        .unwrap();
    assert!(graph.verify_proof_bounded(&query, &proof, 0, 32).is_err());
}

#[test]
fn bounded_proof_verification_counts_all_derived_premise_references() {
    let (graph, query, proof) = graph_with_proof();
    let total: usize = proof
        .steps
        .iter()
        .map(|step| match &step.justification {
            nexus_leibniz::Justification::Derived { premises, .. } => premises.len(),
            nexus_leibniz::Justification::Asserted { .. } => 0,
        })
        .sum();
    assert!(total > 1);
    assert!(graph
        .verify_proof_bounded(&query, &proof, proof.steps.len(), total - 1)
        .is_err());
    graph
        .verify_proof_bounded(&query, &proof, proof.steps.len(), total)
        .unwrap();
}
