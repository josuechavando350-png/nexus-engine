//! Reproducible, small, offline *actual Rust* workload. No invented timings.
//! cargo run --release --offline --example benchmark -- 250 3
//! Arguments are graph count (1..=1000) and repetitions (1..=10).

use nexus_leibniz::{
    schema::Entity, ArgumentKind, Atom, Decision, Graph, Limits, Pattern, PatternTerm, Predicate,
    Rule, Term,
};
use std::{collections::HashMap, env, time::Instant};

fn parse_arg(value: Option<String>, default: usize, maximum: usize) -> Result<usize, String> {
    match value {
        None => Ok(default),
        Some(value) => {
            let number = value
                .parse::<usize>()
                .map_err(|_| "expected unsigned integer")?;
            if number == 0 || number > maximum {
                return Err(format!("expected 1..={maximum}"));
            }
            Ok(number)
        }
    }
}
fn entity(id: &str) -> Entity {
    Entity {
        id: id.into(),
        category: "Actor".into(),
        attributes: HashMap::new(),
    }
}
fn e(id: &str) -> Term {
    Term::Entity(id.into())
}
fn v(id: &str) -> PatternTerm {
    PatternTerm::Variable(id.into())
}
fn pattern(name: &str, terms: Vec<PatternTerm>) -> Pattern {
    Pattern {
        predicate: name.into(),
        terms,
    }
}
fn sample(index: usize) -> Result<(Graph, Atom), String> {
    let mut graph = Graph::new();
    for id in ["a", "b", "c", "d"] {
        graph.add_entity(entity(id))?;
    }
    for name in ["depends", "reachable"] {
        graph.declare_predicate(Predicate {
            name: name.into(),
            arguments: vec![
                ArgumentKind::EntityCategory("Actor".into()),
                ArgumentKind::EntityCategory("Actor".into()),
            ],
        })?;
    }
    for (from, to) in [("a", "b"), ("b", "c"), ("c", "d")] {
        graph.assert_fact(
            Atom {
                predicate: "depends".into(),
                terms: vec![e(from), e(to)],
            },
            &format!("benchmark:{index}:{from}:{to}"),
        )?;
    }
    graph.add_rule(Rule {
        id: "direct".into(),
        body: vec![pattern("depends", vec![v("x"), v("y")])],
        head: pattern("reachable", vec![v("x"), v("y")]),
    })?;
    graph.add_rule(Rule {
        id: "transitive".into(),
        body: vec![
            pattern("reachable", vec![v("x"), v("y")]),
            pattern("reachable", vec![v("y"), v("z")]),
        ],
        head: pattern("reachable", vec![v("x"), v("z")]),
    })?;
    Ok((
        graph,
        Atom {
            predicate: "reachable".into(),
            terms: vec![e("a"), e("d")],
        },
    ))
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let cases = parse_arg(arguments.next(), 250, 1000)?;
    let repetitions = parse_arg(arguments.next(), 3, 10)?;
    if arguments.next().is_some() {
        return Err("expected at most two arguments".into());
    }
    let problems: Vec<_> = (0..cases).map(sample).collect::<Result<_, _>>()?;
    let start = Instant::now();
    let mut verified = 0usize;
    for _ in 0..repetitions {
        for (graph, query) in &problems {
            let Decision::Proven { proof } = graph.infer(query, Limits::default()) else {
                return Err("benchmark workload did not produce a proof".into());
            };
            graph.verify_consistent_proof(query, &proof, Limits::default())?;
            verified += 1;
        }
    }
    let elapsed = start.elapsed();
    println!("LEIBNIZ benchmark; offline; graphs={cases}; repetitions={repetitions}; globally_verified_proofs={verified}; elapsed_ms={:.3}; graph_facts=3; no GPU or forecast", elapsed.as_secs_f64() * 1_000.0);
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("benchmark failed: {error}");
        std::process::exit(1);
    }
}
