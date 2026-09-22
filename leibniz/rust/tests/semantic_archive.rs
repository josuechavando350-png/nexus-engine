use nexus_leibniz::{
    schema::{AttributeValue, Entity, Flow, Restriction, RestrictionType},
    semantic_archive::SemanticArchive,
    semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity},
    ArgumentKind, Atom, Decision, Graph, Limits, Pattern, PatternTerm, Predicate, Rule, Term,
};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEST_FILE: AtomicU64 = AtomicU64::new(0);

fn temp_path() -> PathBuf {
    let n = NEXT_TEST_FILE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("leibniz-semantic-{}-{n}.dat", std::process::id()))
}

fn graph() -> Graph {
    let mut graph = Graph::new();
    for id in ["cliente", "rival"] {
        graph
            .add_entity(Entity {
                id: id.into(),
                category: "Business".into(),
                attributes: HashMap::new(),
            })
            .unwrap();
    }
    graph
        .add_flow(Flow {
            from_entity: "cliente".into(),
            to_entity: "rival".into(),
            rate_of_transfer: 42.0,
        })
        .unwrap();
    graph
        .add_restriction(Restriction {
            source_id: "cliente".into(),
            target_id: "rival".into(),
            constraint_type: RestrictionType::Conditional,
            boundary_value: 150.0,
        })
        .unwrap();
    let arg = ArgumentKind::EntityCategory("Business".into());
    graph
        .declare_predicate(Predicate {
            name: "depends".into(),
            arguments: vec![arg.clone(), arg.clone()],
        })
        .unwrap();
    graph
        .declare_predicate(Predicate {
            name: "affected".into(),
            arguments: vec![arg.clone(), arg],
        })
        .unwrap();
    graph
        .assert_fact(
            Atom {
                predicate: "depends".into(),
                terms: vec![Term::Entity("cliente".into()), Term::Entity("rival".into())],
            },
            "source:contract",
        )
        .unwrap();
    graph
        .add_rule(Rule {
            id: "dependency".into(),
            body: vec![Pattern {
                predicate: "depends".into(),
                terms: vec![
                    PatternTerm::Variable("a".into()),
                    PatternTerm::Variable("b".into()),
                ],
            }],
            head: Pattern {
                predicate: "affected".into(),
                terms: vec![
                    PatternTerm::Variable("a".into()),
                    PatternTerm::Variable("b".into()),
                ],
            },
        })
        .unwrap();
    graph
}

fn annotation(symbol: &str, dimension: Dimension, evidence: &str) -> Annotation {
    Annotation::new(
        Unit::new(symbol, dimension, 1.0).unwrap(),
        Validity::new(100, Some(200)).unwrap(),
        evidence,
    )
    .unwrap()
}

fn archive() -> SemanticArchive {
    let graph = graph();
    let flow = annotation(
        "contacts/s",
        Dimension::new([("contacts".into(), 1), ("time".into(), -1)]).unwrap(),
        "source:flow",
    );
    let restriction = annotation(
        "MXN",
        Dimension::new([("MXN".into(), 1)]).unwrap(),
        "source:limit",
    );
    let snapshot = SemanticSnapshot::from_graph(&graph, vec![flow], vec![restriction]).unwrap();
    SemanticArchive::new(graph, snapshot).unwrap()
}

fn refresh_checksum(bytes: &mut [u8]) {
    let end = bytes.len() - 8;
    let checksum = bytes[..end]
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    bytes[end..].copy_from_slice(&checksum.to_le_bytes());
}

#[test]
fn semantic_roundtrip_is_deterministic_and_preserves_original_v1_graph() {
    let original = archive();
    let original_v1 = original.graph.to_archive_bytes().unwrap();
    let bytes = original.to_bytes().unwrap();
    let restored = SemanticArchive::from_bytes(&bytes).unwrap();
    assert_eq!(restored.to_bytes().unwrap(), bytes);
    assert_eq!(restored.graph.to_archive_bytes().unwrap(), original_v1);
    assert_eq!(restored.snapshot, original.snapshot);
    assert_eq!(restored.snapshot.flows_at(199).len(), 1);
    assert_eq!(restored.snapshot.flows_at(200).len(), 0);
    assert_eq!(
        restored.snapshot.flows[0].annotation.evidence_id,
        "source:flow"
    );
    assert_eq!(
        restored.snapshot.restrictions[0].annotation.unit.symbol,
        "MXN"
    );
}

#[test]
fn semantic_archive_rejects_reordered_dimensions_with_recomputed_checksum() {
    let mut source = archive();
    source.snapshot.flows[0].annotation.unit.dimension =
        Dimension::new([("AA".into(), 1), ("BB".into(), 1), ("time".into(), -1)]).unwrap();
    let bytes = source.to_bytes().unwrap();
    assert!(SemanticArchive::from_bytes(&bytes).is_ok());
    let mut reordered = bytes.clone();
    // Both dimension symbols have equal encoded length. Swapping their names
    // preserves all field boundaries; Dimension::new normalizes their order.
    let aa = reordered.windows(2).position(|x| x == b"AA").unwrap();
    let bb = reordered.windows(2).position(|x| x == b"BB").unwrap();
    reordered[aa..aa + 2].copy_from_slice(b"BB");
    reordered[bb..bb + 2].copy_from_slice(b"AA");
    refresh_checksum(&mut reordered);
    let err = SemanticArchive::from_bytes(&reordered).unwrap_err();
    assert!(err.contains("noncanonical"), "{err}");
}

#[test]
fn restored_rules_and_proofs_retain_exact_source_provenance() {
    let restored = SemanticArchive::from_bytes(&archive().to_bytes().unwrap()).unwrap();
    let query = Atom {
        predicate: "affected".into(),
        terms: vec![Term::Entity("cliente".into()), Term::Entity("rival".into())],
    };
    let Decision::Proven { proof } = restored.graph.infer(&query, Limits::default()) else {
        panic!("the original graph's rule must be preserved")
    };
    restored.graph.verify_proof(&query, &proof).unwrap();
    assert!(proof
        .steps
        .iter()
        .any(|step| step.asserted_sources.contains("source:contract")));
}

#[test]
fn snapshot_from_another_graph_is_refused_even_if_it_has_same_record_counts() {
    let original = archive();
    let mut other_graph = graph();
    other_graph
        .add_entity(Entity {
            id: "otro".into(),
            category: "Business".into(),
            attributes: HashMap::new(),
        })
        .unwrap();
    assert!(SemanticArchive::new(other_graph, original.snapshot).is_err());
}

#[test]
fn altered_public_semantic_fields_are_revalidated_before_write() {
    let mut altered = archive();
    altered.snapshot.flows[0].rate = 999.0;
    assert!(altered.to_bytes().is_err());
    let mut altered = archive();
    altered.snapshot.flows[0].annotation.unit.scale_to_reference = f64::NAN;
    assert!(altered.to_bytes().is_err());
    let mut altered = archive();
    altered.snapshot.restrictions[0]
        .annotation
        .evidence_id
        .clear();
    assert!(altered.to_bytes().is_err());
}

#[test]
fn v1_graph_format_and_semantic_envelope_are_not_confused() {
    let original = archive();
    let old_bytes = original.graph.to_archive_bytes().unwrap();
    let new_bytes = original.to_bytes().unwrap();
    assert!(SemanticArchive::from_bytes(&old_bytes).is_err());
    assert!(Graph::from_archive_bytes(&new_bytes).is_err());
    assert_eq!(
        Graph::from_archive_bytes(&old_bytes)
            .unwrap()
            .to_archive_bytes()
            .unwrap(),
        old_bytes
    );
}

#[test]
fn accidental_corruption_and_truncation_fail_closed() {
    let bytes = archive().to_bytes().unwrap();
    for end in [0, 1, 8, 19, bytes.len() - 1] {
        assert!(
            SemanticArchive::from_bytes(&bytes[..end]).is_err(),
            "truncation {end}"
        );
    }
    let mut changed = bytes.clone();
    changed[30] ^= 1;
    assert!(SemanticArchive::from_bytes(&changed)
        .unwrap_err()
        .contains("checksum"));
    let mut with_trailing_byte = bytes;
    with_trailing_byte.push(0);
    assert!(SemanticArchive::from_bytes(&with_trailing_byte).is_err());
}

#[test]
fn unknown_envelope_version_fails_even_with_a_recomputed_checksum() {
    let mut bytes = archive().to_bytes().unwrap();
    bytes[8] = 99;
    refresh_checksum(&mut bytes);
    assert!(SemanticArchive::from_bytes(&bytes)
        .unwrap_err()
        .contains("version"));
}

#[test]
fn forged_annotation_count_fails_even_with_a_valid_checksum() {
    let mut bytes = archive().to_bytes().unwrap();
    let graph_len = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    let flow_count_offset = 24 + graph_len;
    bytes[flow_count_offset..flow_count_offset + 4].copy_from_slice(&2_u32.to_le_bytes());
    refresh_checksum(&mut bytes);
    assert!(SemanticArchive::from_bytes(&bytes)
        .unwrap_err()
        .contains("count"));
}

#[test]
fn forged_nonfinite_unit_fails_even_with_a_valid_checksum() {
    let mut bytes = archive().to_bytes().unwrap();
    let graph_len = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    let first_annotation = 24 + graph_len + 4;
    let name_len = u32::from_le_bytes(
        bytes[first_annotation..first_annotation + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    let scale_at = first_annotation + 4 + name_len;
    bytes[scale_at..scale_at + 8].copy_from_slice(&f64::NAN.to_bits().to_le_bytes());
    refresh_checksum(&mut bytes);
    assert!(SemanticArchive::from_bytes(&bytes).is_err());
}

#[test]
fn complete_snapshot_can_be_saved_replaced_and_loaded_locally() {
    let file = temp_path();
    let source = archive();
    source.save_atomic(&file).unwrap();
    let recovered = SemanticArchive::load(&file).unwrap();
    assert_eq!(recovered.snapshot, source.snapshot);
    let original = fs::read(&file).unwrap();
    let invalid = temp_path().join("missing-folder");
    assert!(source.save_atomic(&invalid).is_err());
    assert_eq!(fs::read(&file).unwrap(), original);
    source.save_atomic(&file).unwrap();
    assert_eq!(fs::read(&file).unwrap(), original);
    fs::remove_file(file).unwrap();
}

#[cfg(unix)]
#[test]
fn disk_snapshot_permissions_are_private_to_owner() {
    use std::os::unix::fs::PermissionsExt;
    let file = temp_path();
    archive().save_atomic(&file).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::remove_file(file).unwrap();
}

#[test]
fn empty_graph_can_be_saved_without_fabricating_measurements() {
    let graph = Graph::new();
    let snapshot = SemanticSnapshot::from_graph(&graph, vec![], vec![]).unwrap();
    let archive = SemanticArchive::new(graph, snapshot).unwrap();
    let restored = SemanticArchive::from_bytes(&archive.to_bytes().unwrap()).unwrap();
    assert!(restored.snapshot.flows.is_empty());
    assert!(restored.snapshot.restrictions.is_empty());
}

/// Regression: the graph and its caller-owned semantic snapshot must agree
/// on the exact IEEE-754 representation, even for a sign-only zero change.
#[test]
fn source_binding_rejects_signed_zero_substitution_in_every_numeric_record() {
    let mut source = Graph::new();
    let mut attrs = HashMap::new();
    attrs.insert("balance".into(), AttributeValue::Number(0.0));
    source
        .add_entity(Entity {
            id: "a".into(),
            category: "Business".into(),
            attributes: attrs,
        })
        .unwrap();
    source
        .add_entity(Entity {
            id: "b".into(),
            category: "Business".into(),
            attributes: HashMap::new(),
        })
        .unwrap();
    source
        .add_flow(Flow {
            from_entity: "a".into(),
            to_entity: "b".into(),
            rate_of_transfer: 0.0,
        })
        .unwrap();
    source
        .add_restriction(Restriction {
            source_id: "a".into(),
            target_id: "b".into(),
            constraint_type: RestrictionType::Immutable,
            boundary_value: 0.0,
        })
        .unwrap();
    let flow = annotation(
        "contacts/s",
        Dimension::new([("contacts".into(), 1), ("time".into(), -1)]).unwrap(),
        "flow:zero",
    );
    let restriction = annotation(
        "MXN",
        Dimension::new([("MXN".into(), 1)]).unwrap(),
        "boundary:zero",
    );
    let snapshot = SemanticSnapshot::from_graph(&source, vec![flow], vec![restriction]).unwrap();
    let bytes = SemanticArchive::new(source.clone(), snapshot.clone())
        .unwrap()
        .to_bytes()
        .unwrap();
    assert_eq!(
        SemanticArchive::from_bytes(&bytes)
            .unwrap()
            .to_bytes()
            .unwrap(),
        bytes
    );

    let mut changed = snapshot.clone();
    changed.flows[0].rate = -0.0;
    assert!(SemanticArchive::new(source.clone(), changed).is_err());
    let mut changed = snapshot.clone();
    changed.problem.flows[0].rate_of_transfer = -0.0;
    assert!(SemanticArchive::new(source.clone(), changed).is_err());
    let mut changed = snapshot.clone();
    changed.restrictions[0].boundary = -0.0;
    assert!(SemanticArchive::new(source.clone(), changed).is_err());
    let mut changed = snapshot.clone();
    changed.problem.restrictions[0].boundary_value = -0.0;
    assert!(SemanticArchive::new(source.clone(), changed).is_err());
    let mut changed = snapshot.clone();
    changed.problem.entities[0]
        .attributes
        .insert("balance".into(), AttributeValue::Number(-0.0));
    assert!(SemanticArchive::new(source.clone(), changed).is_err());

    // The same rejection applies before persistence, after mutation of a
    // previously accepted public snapshot.
    let mut accepted = SemanticArchive::new(source, snapshot).unwrap();
    accepted.snapshot.flows[0].rate = -0.0;
    assert!(accepted.to_bytes().is_err());
}
