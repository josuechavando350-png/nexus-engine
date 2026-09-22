//! Executable, synthetic cross-runtime fixture. It does NOT assert a real
//! customer measurement, forecast, or the existence of a live GAUSS service.
use nexus_leibniz::handoff::{Direction, GaussProblemV1, HandoffLimits, Objective};
use nexus_leibniz::schema::{Entity, Flow};
use nexus_leibniz::semantic_archive::SemanticArchive;
use nexus_leibniz::semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity};
use nexus_leibniz::Graph;
use std::collections::HashMap;

fn fixture() -> Result<SemanticArchive, String> {
    let mut graph = Graph::new();
    for id in ["fixture-client", "fixture-market"] {
        graph.add_entity(Entity {
            id: id.into(),
            category: "Synthetic".into(),
            attributes: HashMap::new(),
        })?;
    }
    graph.add_flow(Flow {
        from_entity: "fixture-client".into(),
        to_entity: "fixture-market".into(),
        rate_of_transfer: 2.5,
    })?;
    let unit = Unit::new(
        "contacts/s",
        Dimension::new([("contacts".into(), 1), ("time".into(), -1)])?,
        1.0,
    )?;
    let annotation = Annotation::new(unit, Validity::new(100, Some(200))?, "fixture:rate")?;
    let snapshot = SemanticSnapshot::from_graph(&graph, vec![annotation], vec![])?;
    SemanticArchive::new(graph, snapshot)
}
fn run() -> Result<(), String> {
    let original = fixture()?;
    let canonical = original.to_bytes()?;
    // The file is a local synthetic artifact, not an external trusted record.
    let mut path = std::env::temp_dir();
    path.push(format!("leibniz-gauss-fixture-{}.bin", std::process::id()));
    let outcome = (|| -> Result<(), String> {
        original.save_atomic(&path)?;
        let restored = SemanticArchive::load(&path)?;
        if restored.to_bytes()? != canonical {
            return Err("fixture changed on disk".into());
        }
        let objective = Objective {
            metric: "synthetic_rate".into(),
            subject_entity_id: "fixture-client".into(),
            unit: restored.snapshot.flows[0].annotation.unit.clone(),
            direction: Direction::Maximize,
        };
        let request = GaussProblemV1::prepare(
            &restored,
            "leibniz-gauss-fixture",
            150,
            objective.clone(),
            HandoffLimits::default(),
        )?;
        let rate = request.measured_flow_sum_against_trusted_source(
            "fixture-client",
            "fixture-market",
            &objective.unit,
            &restored,
            HandoffLimits::default(),
        )?;
        if rate.evidence_ids.len() != 1
            || rate.evidence_ids[0] != "fixture:rate"
            || !rate.value.is_finite()
        {
            return Err("fixture provenance or result changed".into());
        }
        // The wire format is deliberately a fixed token protocol, not a
        // general JSON serializer. All labels are literals; no user strings
        // can escape a field. The JS consumer independently validates it.
        println!(
            "LEIBNIZ_SYNTHETIC_RATE_V1\t{}\t{}\t{}\t{}\t{}",
            request.problem_id,
            request.as_of_utc_ms,
            rate.value,
            rate.unit.symbol,
            rate.evidence_ids[0]
        );
        Ok(())
    })();
    let _ = std::fs::remove_file(path);
    outcome
}
fn main() {
    if let Err(error) = run() {
        eprintln!("LEIBNIZ synthetic fixture failed: {error}");
        std::process::exit(1);
    }
}
