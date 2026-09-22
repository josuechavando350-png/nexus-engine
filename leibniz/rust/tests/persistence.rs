use nexus_leibniz::{
    schema::{AttributeValue, Entity, Flow, Restriction, RestrictionType},
    ArgumentKind, Atom, Decision, Graph, Limits, Pattern, PatternTerm, Predicate, Rule, Term,
};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEST_FILE: AtomicU64 = AtomicU64::new(0);
fn temporary_path() -> PathBuf {
    let n = NEXT_TEST_FILE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "leibniz-archive-test-{}-{n}.dat",
        std::process::id()
    ))
}
fn entity(id: &str) -> Entity {
    let mut attributes = HashMap::new();
    attributes.insert("annual_value".into(), AttributeValue::Number(42.5));
    attributes.insert("active".into(), AttributeValue::Boolean(true));
    attributes.insert(
        "caption".into(),
        AttributeValue::Text("niño / café / 東京".into()),
    );
    Entity {
        id: id.into(),
        category: "Business".into(),
        attributes,
    }
}
fn fact(pred: &str, a: &str, b: &str) -> Atom {
    Atom {
        predicate: pred.into(),
        terms: vec![Term::Entity(a.into()), Term::Entity(b.into())],
    }
}
fn pattern(pred: &str, a: &str, b: &str) -> Pattern {
    Pattern {
        predicate: pred.into(),
        terms: vec![
            PatternTerm::Variable(a.into()),
            PatternTerm::Variable(b.into()),
        ],
    }
}
fn build_graph() -> (Graph, Atom) {
    let mut g = Graph::new();
    for id in ["shop-a", "shop-b", "shop-c"] {
        g.add_entity(entity(id)).unwrap();
    }
    g.add_flow(Flow {
        from_entity: "shop-a".into(),
        to_entity: "shop-b".into(),
        rate_of_transfer: 14.5,
    })
    .unwrap();
    g.add_restriction(Restriction {
        source_id: "shop-a".into(),
        target_id: "shop-b".into(),
        constraint_type: RestrictionType::Immutable,
        boundary_value: 150.0,
    })
    .unwrap();
    for pred in ["depends", "reachable", "blocked"] {
        g.declare_predicate(Predicate {
            name: pred.into(),
            arguments: vec![
                ArgumentKind::EntityCategory("Business".into()),
                ArgumentKind::EntityCategory("Business".into()),
            ],
        })
        .unwrap();
    }
    g.declare_predicate(Predicate {
        name: "reviewed".into(),
        arguments: vec![ArgumentKind::Statement],
    })
    .unwrap();
    g.declare_incompatible("blocked", "reachable").unwrap();
    let first = g
        .assert_fact(fact("depends", "shop-a", "shop-b"), "source:a")
        .unwrap();
    g.assert_fact(fact("depends", "shop-a", "shop-b"), "source:b")
        .unwrap();
    g.assert_fact(
        Atom {
            predicate: "reviewed".into(),
            terms: vec![Term::Statement(first)],
        },
        "source:reviewer",
    )
    .unwrap();
    g.assert_fact(fact("depends", "shop-b", "shop-c"), "source:c")
        .unwrap();
    g.add_rule(Rule {
        id: "direct".into(),
        body: vec![pattern("depends", "x", "y")],
        head: pattern("reachable", "x", "y"),
    })
    .unwrap();
    g.add_rule(Rule {
        id: "chain".into(),
        body: vec![
            pattern("reachable", "x", "y"),
            pattern("reachable", "y", "z"),
        ],
        head: pattern("reachable", "x", "z"),
    })
    .unwrap();
    (g, fact("reachable", "shop-a", "shop-c"))
}
fn expect_proof(g: &Graph, query: &Atom) {
    let Decision::Proven { proof } = g.infer(query, Limits::default()) else {
        panic!("inference failed")
    };
    g.verify_proof(query, &proof)
        .expect("proof survives storage");
}
fn rewrite_checksum(bytes: &mut [u8]) {
    let end = bytes.len() - 8;
    let hash = bytes[..end]
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    bytes[end..].copy_from_slice(&hash.to_le_bytes());
}

#[test]
fn full_graph_roundtrip_is_byte_identical_and_preserves_proof() {
    let (original, query) = build_graph();
    let bytes = original.to_archive_bytes().unwrap();
    let restored = Graph::from_archive_bytes(&bytes).unwrap();
    assert_eq!(restored.to_archive_bytes().unwrap(), bytes);
    assert_eq!(restored.export_archive(), original.export_archive());
    assert_eq!(restored.snapshot(), original.snapshot());
    expect_proof(&restored, &query);
}

#[test]
fn disk_replace_is_atomic_for_successful_writes_and_readable() {
    let path = temporary_path();
    let (mut graph, query) = build_graph();
    graph.save_atomic(&path).unwrap();
    expect_proof(&Graph::load(&path).unwrap(), &query);
    graph.add_entity(entity("shop-d")).unwrap();
    graph.save_atomic(&path).unwrap();
    assert_eq!(
        Graph::load(&path).unwrap().export_archive(),
        graph.export_archive()
    );
    fs::remove_file(path).unwrap();
}

#[test]
fn old_archive_is_left_untouched_if_new_path_is_invalid() {
    let (graph, _) = build_graph();
    let path = temporary_path();
    graph.save_atomic(&path).unwrap();
    let old = fs::read(&path).unwrap();
    let missing_parent = temporary_path().join("not-a-directory");
    assert!(graph.save_atomic(&missing_parent).is_err());
    assert_eq!(fs::read(&path).unwrap(), old);
    fs::remove_file(path).unwrap();
}

#[test]
fn truncated_or_corrupted_archives_are_rejected() {
    let (g, _) = build_graph();
    let bytes = g.to_archive_bytes().unwrap();
    for size in [0, 1, 8, 15, bytes.len() - 1] {
        assert!(
            Graph::from_archive_bytes(&bytes[..size]).is_err(),
            "size {size}"
        );
    }
    let mut changed = bytes.clone();
    changed[24] ^= 1;
    assert!(Graph::from_archive_bytes(&changed).is_err());
    let mut extra = bytes;
    extra.push(0);
    assert!(Graph::from_archive_bytes(&extra).is_err());
}

#[test]
fn unknown_version_and_incorrect_header_lengths_are_rejected() {
    let (g, _) = build_graph();
    let mut bytes = g.to_archive_bytes().unwrap();
    bytes[8] = 99;
    rewrite_checksum(&mut bytes);
    assert!(Graph::from_archive_bytes(&bytes)
        .unwrap_err()
        .contains("version"));
    let (g, _) = build_graph();
    let mut bytes = g.to_archive_bytes().unwrap();
    bytes[12] = 0;
    assert!(Graph::from_archive_bytes(&bytes).is_err());
}

#[test]
fn valid_checksum_cannot_override_semantic_validation() {
    let (g, _) = build_graph();
    let mut bytes = g.to_archive_bytes().unwrap();
    let index = bytes
        .windows(6)
        .position(|window| window == b"shop-b")
        .unwrap();
    bytes[index..index + 6].copy_from_slice(b"shop-x");
    rewrite_checksum(&mut bytes);
    assert!(Graph::from_archive_bytes(&bytes).is_err());
}

#[test]
fn restoring_does_not_create_new_inference_facts_in_original_graph() {
    let (g, query) = build_graph();
    let restored = Graph::from_archive_bytes(&g.to_archive_bytes().unwrap()).unwrap();
    let count = restored.fact_count();
    expect_proof(&restored, &query);
    assert_eq!(restored.fact_count(), count);
    assert_eq!(g.fact_count(), count);
}

#[test]
fn archive_rejects_forged_assertion_ids_and_sources() {
    let (g, _) = build_graph();
    let mut archive = g.export_archive();
    archive.assertions[0].id = u64::MAX;
    assert!(Graph::from_archive(archive).is_err());
    let mut archive = g.export_archive();
    archive.assertions[0].asserted_sources.clear();
    assert!(Graph::from_archive(archive).is_err());
}

#[test]
fn duplicate_assertion_records_are_not_silently_collapsed_on_restore() {
    let (graph, _) = build_graph();
    let original = graph.export_archive();

    // Both records are individually valid, and live ingestion intentionally
    // deduplicates an identical atom. An archive must instead reject the
    // duplicate so that restoring does not silently change its source ledger.
    let mut repeated_id = original.clone();
    repeated_id.assertions.push(original.assertions[0].clone());
    let err = Graph::from_archive(repeated_id).unwrap_err();
    assert!(err.contains("duplicate assertion"), "{err}");

    // A different ID for the same atom must be rejected as well.
    let mut repeated_atom = original.clone();
    let mut extra = original.assertions[0].clone();
    extra.id = original.assertions.last().unwrap().id + 1;
    repeated_atom.assertions.push(extra);
    let err = Graph::from_archive(repeated_atom).unwrap_err();
    assert!(err.contains("duplicate assertion"), "{err}");

    // Legitimate multi-source corroboration is still a single assertion.
    let restored = Graph::from_archive(original.clone()).unwrap();
    assert_eq!(restored.export_archive(), original);
    assert_eq!(
        restored.export_archive().assertions[0]
            .asserted_sources
            .len(),
        2
    );
}

#[test]
fn duplicate_or_reversed_incompatibility_records_are_rejected() {
    let (graph, _) = build_graph();
    let original = graph.export_archive();
    assert_eq!(original.incompatible.len(), 1);

    let mut identical = original.clone();
    identical
        .incompatible
        .push(original.incompatible[0].clone());
    let err = Graph::from_archive(identical).unwrap_err();
    assert!(err.contains("duplicate incompatible"), "{err}");

    let mut reversed = original.clone();
    let (left, right) = &original.incompatible[0];
    reversed.incompatible.push((right.clone(), left.clone()));
    let err = Graph::from_archive(reversed).unwrap_err();
    assert!(err.contains("duplicate incompatible"), "{err}");

    assert_eq!(
        Graph::from_archive(original.clone())
            .unwrap()
            .export_archive(),
        original
    );
}

#[test]
fn incomplete_archive_with_missing_statement_reference_is_rejected() {
    let (g, _) = build_graph();
    let mut archive = g.export_archive();
    archive.assertions.remove(0);
    assert!(Graph::from_archive(archive).is_err());
}

#[test]
fn restored_graph_retains_declared_conflicts_and_abstains() {
    let (mut graph, query) = build_graph();
    graph
        .assert_fact(fact("blocked", "shop-a", "shop-c"), "contradicting:source")
        .unwrap();
    let restored = Graph::from_archive_bytes(&graph.to_archive_bytes().unwrap()).unwrap();
    assert!(matches!(
        restored.infer(&query, Limits::default()),
        Decision::Abstain { .. }
    ));
}

#[test]
fn canonical_bytes_do_not_depend_on_hash_map_iteration_order() {
    let (original, _) = build_graph();
    let (another, _) = build_graph();
    assert_eq!(
        original.to_archive_bytes().unwrap(),
        another.to_archive_bytes().unwrap()
    );
}

#[test]
fn archive_rejects_out_of_order_attributes_despite_repaired_checksum() {
    let mut graph = Graph::new();
    graph
        .add_entity(Entity {
            id: "obj".into(),
            category: "Object".into(),
            attributes: HashMap::from([
                ("alpha".into(), AttributeValue::Text("A".into())),
                ("bravo".into(), AttributeValue::Text("B".into())),
            ]),
        })
        .unwrap();
    let canonical = graph.to_archive_bytes().unwrap();
    assert!(Graph::from_archive_bytes(&canonical).is_ok());

    // Both strings have the same width, so exchanging the key bytes changes
    // ordering but leaves every length field and the entire format valid.
    let mut reordered = canonical.clone();
    let alpha = reordered
        .windows(5)
        .position(|bytes| bytes == b"alpha")
        .unwrap();
    let bravo = reordered
        .windows(5)
        .position(|bytes| bytes == b"bravo")
        .unwrap();
    reordered[alpha..alpha + 5].copy_from_slice(b"bravo");
    reordered[bravo..bravo + 5].copy_from_slice(b"alpha");
    rewrite_checksum(&mut reordered);
    assert_ne!(reordered, canonical);
    let err = Graph::from_archive_bytes(&reordered).unwrap_err();
    assert!(err.contains("noncanonical"), "{err}");
}

#[test]
fn archive_rejects_swapped_corroboration_sources_with_valid_checksum() {
    let mut graph = Graph::new();
    graph.add_entity(entity("shop-a")).unwrap();
    graph
        .declare_predicate(Predicate {
            name: "known".into(),
            arguments: vec![ArgumentKind::AnyEntity],
        })
        .unwrap();
    let atom = Atom {
        predicate: "known".into(),
        terms: vec![Term::Entity("shop-a".into())],
    };
    graph.assert_fact(atom.clone(), "source:a").unwrap();
    graph.assert_fact(atom, "source:b").unwrap();
    let canonical = graph.to_archive_bytes().unwrap();
    let mut reordered = canonical.clone();
    // The primary source appears once in addition to its corroboration entry.
    // Target the final occurrences to change just the BTreeSet wire order.
    let a = reordered
        .windows(8)
        .rposition(|bytes| bytes == b"source:a")
        .unwrap();
    let b = reordered
        .windows(8)
        .rposition(|bytes| bytes == b"source:b")
        .unwrap();
    reordered[a..a + 8].copy_from_slice(b"source:b");
    reordered[b..b + 8].copy_from_slice(b"source:a");
    rewrite_checksum(&mut reordered);
    let err = Graph::from_archive_bytes(&reordered).unwrap_err();
    assert!(err.contains("noncanonical"), "{err}");
    assert!(Graph::from_archive_bytes(&canonical).is_ok());
}

#[test]
fn forged_nonfinite_numeric_value_is_rejected_after_valid_checksum() {
    let (graph, _) = build_graph();
    let mut archive = graph.export_archive();
    archive.entities[0]
        .attributes
        .insert("annual_value".into(), AttributeValue::Number(f64::NAN));
    assert!(Graph::from_archive(archive).is_err());
}

#[cfg(unix)]
#[test]
fn persisted_archive_is_private_to_file_owner() {
    use std::os::unix::fs::PermissionsExt;
    let (graph, _) = build_graph();
    let path = temporary_path();
    graph.save_atomic(&path).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::remove_file(path).unwrap();
}
