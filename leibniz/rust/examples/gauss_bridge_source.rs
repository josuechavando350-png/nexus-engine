//! SYNTHETIC TEST-ONLY generator; never ingest or label as real-world evidence.
//! Usage: gauss_bridge_source ARCHIVE PIN RATE_LEFT RATE_RIGHT
use nexus_leibniz::schema::{Entity, Flow};
use nexus_leibniz::semantic_archive::SemanticArchive;
use nexus_leibniz::semantics::{Annotation, Dimension, SemanticSnapshot, Unit, Validity};
use nexus_leibniz::Graph;
use std::collections::HashMap;
use std::fs;

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 || args[0] == args[1] {
        return Err("expected distinct ARCHIVE PIN paths and RATE_LEFT RATE_RIGHT".into());
    }
    let rates = [
        args[2].parse::<f64>().map_err(|_| "invalid left rate")?,
        args[3].parse::<f64>().map_err(|_| "invalid right rate")?,
    ];
    if rates
        .iter()
        .any(|rate| !rate.is_finite() || *rate < 0.0 || *rate > 1e9)
    {
        return Err("fixture rates must be bounded and nonnegative".into());
    }
    let mut graph = Graph::new();
    for id in ["source", "left", "right"] {
        graph.add_entity(Entity {
            id: id.into(),
            category: "SYNTHETIC_TEST_ONLY".into(),
            attributes: HashMap::new(),
        })?;
    }
    for (to, rate) in [("left", rates[0]), ("right", rates[1])] {
        graph.add_flow(Flow {
            from_entity: "source".into(),
            to_entity: to.into(),
            rate_of_transfer: rate,
        })?;
    }
    let unit = Unit::new(
        "contacts/s",
        Dimension::new([("contacts".into(), 1), ("time".into(), -1)])?,
        1.0,
    )?;
    let annotations = ["synthetic:left", "synthetic:right"]
        .into_iter()
        .map(|id| Annotation::new(unit.clone(), Validity::new(100, Some(200))?, id))
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot = SemanticSnapshot::from_graph(&graph, annotations, vec![])?;
    let bytes = SemanticArchive::new(graph, snapshot)?.to_bytes()?;
    // Two distinct test files, populated from the same SYNTHETIC generator.
    // In production the caller MUST obtain the pinned bytes independently.
    fs::write(&args[0], &bytes).map_err(|e| format!("fixture source write failed: {e}"))?;
    fs::write(&args[1], &bytes).map_err(|e| format!("fixture pin write failed: {e}"))?;
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("LEIBNIZ synthetic source generation failed: {e}");
        std::process::exit(1);
    }
}
