use nexus_leibniz::{
    axioms::{compile_axioms, register_axioms, OntologyAxiom, MAX_CHAIN_LENGTH},
    schema::Entity,
    ArgumentKind, Atom, Decision, Graph, Justification, Limits, Predicate, Term,
};
use std::collections::HashMap;

fn term(id: &str) -> Term {
    Term::Entity(id.to_owned())
}
fn atom(name: &str, values: &[&str]) -> Atom {
    Atom {
        predicate: name.into(),
        terms: values.iter().map(|id| term(id)).collect(),
    }
}
fn graph() -> Graph {
    let mut g = Graph::new();
    for id in ["a", "b", "c", "d"] {
        g.add_entity(Entity {
            id: id.into(),
            category: "Actor".into(),
            attributes: HashMap::new(),
        })
        .unwrap();
    }
    for name in ["customer", "person", "supplier"] {
        g.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![ArgumentKind::AnyEntity],
        })
        .unwrap();
    }
    for name in [
        "supplies",
        "delivers",
        "provided_by",
        "connected",
        "reaches",
        "transfers",
    ] {
        g.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![ArgumentKind::EntityCategory("Actor".into()); 2],
        })
        .unwrap();
    }
    g
}
fn assert_proven(g: &Graph, query: Atom) {
    let Decision::Proven { proof } = g.infer(&query, Limits::default()) else {
        panic!("axiom must entail {query:?}");
    };
    g.verify_proof(&query, &proof)
        .expect("independent proof verification");
    assert_eq!(proof.steps.last().unwrap().atom, query);
    assert!(proof
        .steps
        .iter()
        .any(|step| matches!(&step.justification, Justification::Derived { .. })));
}

#[test]
fn subclasses_propagate_membership_with_a_reproducible_proof() {
    let mut g = graph();
    g.assert_fact(atom("customer", &["a"]), "crm:entry-1")
        .unwrap();
    let ids = register_axioms(
        &mut g,
        &[OntologyAxiom::SubClass {
            id: "customer-is-person".into(),
            child: "customer".into(),
            parent: "person".into(),
        }],
    )
    .unwrap();
    assert_eq!(ids.len(), 1);
    assert_proven(&g, atom("person", &["a"]));
    assert!(matches!(
        g.infer(&atom("person", &["b"]), Limits::default()),
        Decision::Unidentifiable { .. }
    ));
}

#[test]
fn subproperty_is_not_a_closed_world_equivalence() {
    let mut g = graph();
    g.assert_fact(atom("supplies", &["a", "b"]), "invoice:1")
        .unwrap();
    register_axioms(
        &mut g,
        &[OntologyAxiom::SubProperty {
            id: "supply-is-transfer".into(),
            child: "supplies".into(),
            parent: "transfers".into(),
        }],
    )
    .unwrap();
    assert_proven(&g, atom("transfers", &["a", "b"]));
    assert!(matches!(
        g.infer(&atom("supplies", &["b", "a"]), Limits::default()),
        Decision::Unidentifiable { .. }
    ));
}

#[test]
fn inverse_proves_both_directions_without_conflating_subject_and_object() {
    let mut g = graph();
    g.assert_fact(atom("supplies", &["a", "b"]), "invoice")
        .unwrap();
    g.assert_fact(atom("provided_by", &["c", "d"]), "shipment")
        .unwrap();
    assert_eq!(
        register_axioms(
            &mut g,
            &[OntologyAxiom::Inverse {
                id: "inverse".into(),
                left: "supplies".into(),
                right: "provided_by".into(),
            }]
        )
        .unwrap()
        .len(),
        2
    );
    assert_proven(&g, atom("provided_by", &["b", "a"]));
    assert_proven(&g, atom("supplies", &["d", "c"]));
    assert!(matches!(
        g.infer(&atom("provided_by", &["a", "b"]), Limits::default()),
        Decision::Unidentifiable { .. }
    ));
}

#[test]
fn symmetry_reverses_a_relation_with_a_valid_proof() {
    let mut g = graph();
    g.assert_fact(atom("connected", &["a", "b"]), "topology:1")
        .unwrap();
    register_axioms(
        &mut g,
        &[OntologyAxiom::Symmetric {
            id: "bidirectional".into(),
            property: "connected".into(),
        }],
    )
    .unwrap();
    assert_proven(&g, atom("connected", &["b", "a"]));
}

#[test]
fn transitivity_reaches_a_three_hop_path_without_inventing_absent_edges() {
    let mut g = graph();
    for (a, b) in [("a", "b"), ("b", "c"), ("c", "d")] {
        g.assert_fact(atom("reaches", &[a, b]), &format!("edge:{a}:{b}"))
            .unwrap();
    }
    register_axioms(
        &mut g,
        &[OntologyAxiom::Transitive {
            id: "reachability".into(),
            property: "reaches".into(),
        }],
    )
    .unwrap();
    assert_proven(&g, atom("reaches", &["a", "d"]));
    assert!(matches!(
        g.infer(&atom("reaches", &["d", "a"]), Limits::default()),
        Decision::Unidentifiable { .. }
    ));
}

#[test]
fn typed_property_chain_proves_only_a_valid_join() {
    let mut g = graph();
    g.assert_fact(atom("supplies", &["a", "b"]), "invoice")
        .unwrap();
    g.assert_fact(atom("delivers", &["b", "c"]), "shipment")
        .unwrap();
    register_axioms(
        &mut g,
        &[OntologyAxiom::PropertyChain {
            id: "shipment-path".into(),
            chain: vec!["supplies".into(), "delivers".into()],
            result: "transfers".into(),
        }],
    )
    .unwrap();
    assert_proven(&g, atom("transfers", &["a", "c"]));
    assert!(matches!(
        g.infer(&atom("transfers", &["a", "b"]), Limits::default()),
        Decision::Unidentifiable { .. }
    ));
}

#[test]
fn invalid_axiom_batch_does_not_mutate_the_graph() {
    let mut g = graph();
    let before = g.export_archive();
    let batch = vec![
        OntologyAxiom::SubClass {
            id: "valid".into(),
            child: "customer".into(),
            parent: "person".into(),
        },
        OntologyAxiom::Inverse {
            id: "invalid".into(),
            left: "customer".into(),
            right: "supplies".into(),
        },
    ];
    assert!(register_axioms(&mut g, &batch).is_err());
    assert_eq!(before, g.export_archive());
}

#[test]
fn signatures_must_be_compatible_even_if_no_facts_exist() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "statement".into(),
        arguments: vec![ArgumentKind::Statement],
    })
    .unwrap();
    assert!(compile_axioms(
        &g,
        &[OntologyAxiom::SubClass {
            id: "bad".into(),
            child: "customer".into(),
            parent: "statement".into(),
        }]
    )
    .is_err());
    assert!(compile_axioms(
        &g,
        &[OntologyAxiom::SubProperty {
            id: "bad".into(),
            child: "customer".into(),
            parent: "supplies".into(),
        }]
    )
    .is_err());
    assert!(compile_axioms(
        &g,
        &[OntologyAxiom::Symmetric {
            id: "bad".into(),
            property: "customer".into(),
        }]
    )
    .is_err());
}

#[test]
fn duplicate_ids_are_rejected_without_partial_registration() {
    let mut g = graph();
    let before = g.export_archive();
    let axiom = OntologyAxiom::SubClass {
        id: "duplicate".into(),
        child: "customer".into(),
        parent: "person".into(),
    };
    assert!(register_axioms(&mut g, &[axiom.clone(), axiom]).is_err());
    assert_eq!(before, g.export_archive());
}

#[test]
fn chain_limits_and_missing_predicates_fail_closed() {
    let g = graph();
    for chain in [
        vec!["supplies".into()],
        vec!["supplies".into(); MAX_CHAIN_LENGTH + 1],
    ] {
        assert!(compile_axioms(
            &g,
            &[OntologyAxiom::PropertyChain {
                id: "invalid-length".into(),
                chain,
                result: "transfers".into(),
            }]
        )
        .is_err());
    }
    assert!(compile_axioms(
        &g,
        &[OntologyAxiom::PropertyChain {
            id: "missing".into(),
            chain: vec!["supplies".into(), "ghost".into()],
            result: "transfers".into(),
        }]
    )
    .is_err());
    assert!(compile_axioms(&g, &[]).is_err());
}

#[test]
fn contradictions_from_axioms_require_abstention_not_a_forged_proof() {
    let mut g = graph();
    g.declare_incompatible("customer", "person").unwrap();
    g.assert_fact(atom("customer", &["a"]), "source").unwrap();
    register_axioms(
        &mut g,
        &[OntologyAxiom::SubClass {
            id: "incompatible".into(),
            child: "customer".into(),
            parent: "person".into(),
        }],
    )
    .unwrap();
    assert!(matches!(
        g.infer(&atom("person", &["a"]), Limits::default()),
        Decision::Abstain { .. }
    ));
}

#[test]
fn archived_axioms_preserve_rule_and_source_anchored_proof() {
    let mut g = graph();
    g.assert_fact(atom("supplies", &["a", "b"]), "invoice:source")
        .unwrap();
    register_axioms(
        &mut g,
        &[OntologyAxiom::Inverse {
            id: "archive-check".into(),
            left: "supplies".into(),
            right: "provided_by".into(),
        }],
    )
    .unwrap();
    let encoded = g.to_archive_bytes().unwrap();
    let recovered = Graph::from_archive_bytes(&encoded).unwrap();
    assert_eq!(encoded, recovered.to_archive_bytes().unwrap());
    assert_proven(&recovered, atom("provided_by", &["b", "a"]));
}

#[test]
fn installing_axioms_is_deterministic_and_read_only_compilation_is_pure() {
    let mut g = graph();
    let batch = vec![OntologyAxiom::SubClass {
        id: "stable".into(),
        child: "customer".into(),
        parent: "person".into(),
    }];
    let before = g.export_archive();
    let first = compile_axioms(&g, &batch).unwrap();
    assert_eq!(first, compile_axioms(&g, &batch).unwrap());
    assert_eq!(before, g.export_archive());
    let ids = register_axioms(&mut g, &batch).unwrap();
    assert_eq!(ids, first.iter().map(|r| r.id.clone()).collect::<Vec<_>>());
}

#[test]
fn resource_limits_prevent_unbounded_recursive_axiom_execution() {
    let mut g = graph();
    for (a, b) in [("a", "b"), ("b", "c"), ("c", "d")] {
        g.assert_fact(atom("reaches", &[a, b]), "edge").unwrap();
    }
    register_axioms(
        &mut g,
        &[OntologyAxiom::Transitive {
            id: "recursive".into(),
            property: "reaches".into(),
        }],
    )
    .unwrap();
    let limits = Limits {
        max_rounds: 0,
        max_facts: 100,
        max_matches: 100,
    };
    assert!(matches!(
        g.infer(&atom("reaches", &["a", "d"]), limits),
        Decision::Abstain { .. }
    ));
}

#[test]
fn exhaustive_two_edge_oracle_confirms_transitive_axiom() {
    // Independent truth table: with exactly two possible edges a->b and
    // b->c, a->c is derived if and only if both have been asserted.
    for mask in 0..4_u8 {
        let mut g = graph();
        if mask & 1 != 0 {
            g.assert_fact(atom("reaches", &["a", "b"]), "edge:first")
                .unwrap();
        }
        if mask & 2 != 0 {
            g.assert_fact(atom("reaches", &["b", "c"]), "edge:second")
                .unwrap();
        }
        register_axioms(
            &mut g,
            &[OntologyAxiom::Transitive {
                id: "oracle".into(),
                property: "reaches".into(),
            }],
        )
        .unwrap();
        let query = atom("reaches", &["a", "c"]);
        match g.infer(&query, Limits::default()) {
            Decision::Proven { proof } => {
                assert_eq!(mask, 3, "no unasserted path is permitted");
                g.verify_proof(&query, &proof).unwrap();
            }
            Decision::Unidentifiable { .. } => {
                assert_ne!(mask, 3, "complete path must be entailed")
            }
            other => panic!("unexpected oracle decision: {other:?}"),
        }
    }
}

#[test]
fn source_premise_tampering_is_rejected_after_axiom_inference() {
    let mut g = graph();
    g.assert_fact(atom("customer", &["a"]), "verified:source")
        .unwrap();
    register_axioms(
        &mut g,
        &[OntologyAxiom::SubClass {
            id: "source-check".into(),
            child: "customer".into(),
            parent: "person".into(),
        }],
    )
    .unwrap();
    let query = atom("person", &["a"]);
    let Decision::Proven { mut proof } = g.infer(&query, Limits::default()) else {
        panic!("expected proof");
    };
    proof.steps[0]
        .asserted_sources
        .insert("invented-source".into());
    assert!(g.verify_proof(&query, &proof).is_err());
}

#[test]
fn mismatched_endpoint_categories_reject_inverse_without_registration() {
    let mut g = graph();
    g.declare_predicate(Predicate {
        name: "located_at".into(),
        arguments: vec![
            ArgumentKind::EntityCategory("Actor".into()),
            ArgumentKind::EntityCategory("Place".into()),
        ],
    })
    .unwrap();
    let before = g.export_archive();
    assert!(register_axioms(
        &mut g,
        &[OntologyAxiom::Inverse {
            id: "type-mismatch".into(),
            left: "located_at".into(),
            right: "supplies".into(),
        }]
    )
    .is_err());
    assert_eq!(before, g.export_archive());
}

#[test]
fn inverse_expansion_has_a_global_upper_bound() {
    let mut g = graph();
    let before = g.export_archive();
    let axioms: Vec<_> = (0..=2048)
        .map(|i| OntologyAxiom::Inverse {
            id: format!("inverse-{i}"),
            left: "supplies".into(),
            right: "provided_by".into(),
        })
        .collect();
    assert!(register_axioms(&mut g, &axioms).is_err());
    assert_eq!(before, g.export_archive());
}
