//! Actual offline graph-size benchmark. No simulated numbers or fixed timings.
//! cargo run --release --offline --example graph_scale -- 8 16 24
//!
//! Each size creates N actual entities, N-1 distinct sourced edges, computes
//! bounded recursive reachability and independently checks proof + closure.
//! A resource-limit refusal is reported as ABSTAIN, never as a speed result.
use nexus_leibniz::{
    schema::Entity, ArgumentKind, Atom, Decision, Graph, Limits, Pattern, PatternTerm, Predicate,
    Rule, Term,
};
use std::{collections::HashMap, env, time::Instant};

fn variable(name: &str) -> PatternTerm {
    PatternTerm::Variable(name.to_owned())
}
fn pattern(name: &str, variables: &[&str]) -> Pattern {
    Pattern {
        predicate: name.to_owned(),
        terms: variables.iter().map(|name| variable(name)).collect(),
    }
}
fn node(number: usize) -> Term {
    Term::Entity(format!("node-{number:04}"))
}
fn build(size: usize) -> Result<(Graph, Atom), String> {
    let mut graph = Graph::new();
    for index in 0..size {
        graph.add_entity(Entity {
            id: format!("node-{index:04}"),
            category: "Node".into(),
            attributes: HashMap::new(),
        })?;
    }
    for predicate in ["edge", "reachable"] {
        graph.declare_predicate(Predicate {
            name: predicate.into(),
            arguments: vec![ArgumentKind::EntityCategory("Node".into()); 2],
        })?;
    }
    for index in 0..size - 1 {
        graph.assert_fact(
            Atom {
                predicate: "edge".into(),
                terms: vec![node(index), node(index + 1)],
            },
            &format!("benchmark:edge:{index}"),
        )?;
    }
    graph.add_rule(Rule {
        id: "directed-edge".into(),
        body: vec![pattern("edge", &["x", "y"])],
        head: pattern("reachable", &["x", "y"]),
    })?;
    graph.add_rule(Rule {
        id: "recursive-reachability".into(),
        body: vec![
            pattern("reachable", &["x", "y"]),
            pattern("edge", &["y", "z"]),
        ],
        head: pattern("reachable", &["x", "z"]),
    })?;
    Ok((
        graph,
        Atom {
            predicate: "reachable".into(),
            terms: vec![node(0), node(size - 1)],
        },
    ))
}
fn main() {
    if let Err(reason) = run() {
        eprintln!("LEIBNIZ graph-scale benchmark failed: {reason}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    let sizes = if arguments.is_empty() {
        vec![8, 16, 24]
    } else {
        arguments
            .into_iter()
            .map(|value| {
                let size = value
                    .parse::<usize>()
                    .map_err(|_| "expected an unsigned graph size")?;
                if !(2..=64).contains(&size) {
                    return Err("graph size must be 2..=64".into());
                }
                Ok(size)
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    for size in sizes {
        let (graph, query) = build(size)?;
        let initial_facts = graph.fact_count();
        // This workload is intended to establish a verified reachable path,
        // not to count an ABSTAIN as a successful benchmark. The cap is for
        // the complete closure, across every recursive round.
        let limits = Limits {
            max_rounds: size,
            max_facts: size.saturating_mul(size).saturating_add(size),
            max_matches: 2_000_000,
        };
        let started = Instant::now();
        match graph.infer(&query, limits) {
            Decision::Proven { proof } => {
                graph.verify_consistent_proof(&query, &proof, limits)?;
                println!(
                    "size={size} source_facts={initial_facts} proof_steps={} verified=true elapsed_ms={:.3}",
                    proof.steps.len(), started.elapsed().as_secs_f64() * 1000.0,
                );
            }
            Decision::Abstain { reason } => {
                return Err(format!(
                    "size={size}: benchmark did not verify a proof: ABSTAIN: {reason}"
                ));
            }
            Decision::Unidentifiable { reason } => {
                return Err(format!("a connected chain must be reachable: {reason}"));
            }
            Decision::Estimated { .. } => {
                return Err("deterministic reachability must not produce ESTIMATED".into());
            }
        }
    }
    Ok(())
}
