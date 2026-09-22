//! Bounded, typed ontology axioms compiled into independently checked Horn rules.
//!
//! No closed-world negation, automatic ontology discovery, unrestricted OWL,
//! numerical prediction or external data ingestion is claimed by this module.
//! The base Graph validates all generated rules and verifies their proofs.
use crate::{ArgumentKind, Graph, Pattern, PatternTerm, Predicate, Rule};
use std::collections::BTreeMap;

/// Explicit finite schema axioms. Each identifier must be unique *within*
/// its kind; generated IDs also include the axiom kind and a length prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OntologyAxiom {
    SubClass {
        id: String,
        child: String,
        parent: String,
    },
    SubProperty {
        id: String,
        child: String,
        parent: String,
    },
    Inverse {
        id: String,
        left: String,
        right: String,
    },
    Symmetric {
        id: String,
        property: String,
    },
    Transitive {
        id: String,
        property: String,
    },
    PropertyChain {
        id: String,
        chain: Vec<String>,
        result: String,
    },
}

/// Hard bound on the number of axioms per installation and chain size.
pub const MAX_AXIOMS: usize = 4_096;
pub const MAX_CHAIN_LENGTH: usize = 32;

fn variable(name: &str) -> PatternTerm {
    PatternTerm::Variable(name.to_owned())
}
fn pattern(predicate: &str, names: &[String]) -> Pattern {
    Pattern {
        predicate: predicate.to_owned(),
        terms: names.iter().map(|s| variable(s)).collect(),
    }
}
fn all_names(n: usize) -> Vec<String> {
    (0..n).map(|index| format!("v{index}")).collect()
}
fn signature<'a>(
    catalog: &'a BTreeMap<String, Predicate>,
    name: &str,
    arity: usize,
) -> Result<&'a [ArgumentKind], String> {
    let predicate = catalog
        .get(name)
        .ok_or_else(|| format!("unknown axiom predicate: {name}"))?;
    if predicate.arguments.len() != arity {
        return Err(format!("predicate {name}: expected arity {arity}"));
    }
    Ok(&predicate.arguments)
}
fn assignable(actual: &ArgumentKind, expected: &ArgumentKind) -> bool {
    actual == expected
        || matches!(
            (actual, expected),
            (ArgumentKind::EntityCategory(_), ArgumentKind::AnyEntity)
        )
}
fn ensure_assignable(actual: &[ArgumentKind], expected: &[ArgumentKind]) -> Result<(), String> {
    if actual.len() != expected.len() || !actual.iter().zip(expected).all(|(a, e)| assignable(a, e))
    {
        return Err("axiom would violate declared argument types".into());
    }
    Ok(())
}
fn id_of(axiom: &OntologyAxiom) -> (&'static str, &str) {
    match axiom {
        OntologyAxiom::SubClass { id, .. } => ("subclass", id),
        OntologyAxiom::SubProperty { id, .. } => ("subproperty", id),
        OntologyAxiom::Inverse { id, .. } => ("inverse", id),
        OntologyAxiom::Symmetric { id, .. } => ("symmetric", id),
        OntologyAxiom::Transitive { id, .. } => ("transitive", id),
        OntologyAxiom::PropertyChain { id, .. } => ("chain", id),
    }
}
fn rule_id(kind: &str, id: &str, direction: usize) -> String {
    format!("leibniz:axiom:{kind}:{}:{id}:{direction}", id.len())
}

fn expand(
    axiom: &OntologyAxiom,
    catalog: &BTreeMap<String, Predicate>,
) -> Result<Vec<Rule>, String> {
    let (kind, identifier) = id_of(axiom);
    if identifier.trim().is_empty() || identifier.len() > 256 {
        return Err("axiom ID must be 1..=256 non-whitespace characters".into());
    }
    let make = |direction, body: Vec<Pattern>, head: Pattern| Rule {
        id: rule_id(kind, identifier, direction),
        body,
        head,
    };
    match axiom {
        OntologyAxiom::SubClass { child, parent, .. } => {
            ensure_assignable(
                signature(catalog, child, 1)?,
                signature(catalog, parent, 1)?,
            )?;
            let xs = all_names(1);
            Ok(vec![make(
                0,
                vec![pattern(child, &xs)],
                pattern(parent, &xs),
            )])
        }
        OntologyAxiom::SubProperty { child, parent, .. } => {
            let child_types = catalog
                .get(child)
                .ok_or_else(|| format!("unknown axiom predicate: {child}"))?;
            let parent_types = catalog
                .get(parent)
                .ok_or_else(|| format!("unknown axiom predicate: {parent}"))?;
            ensure_assignable(&child_types.arguments, &parent_types.arguments)?;
            let xs = all_names(child_types.arguments.len());
            Ok(vec![make(
                0,
                vec![pattern(child, &xs)],
                pattern(parent, &xs),
            )])
        }
        OntologyAxiom::Inverse { left, right, .. } => {
            let l = signature(catalog, left, 2)?;
            let r = signature(catalog, right, 2)?;
            ensure_assignable(l, &[r[1].clone(), r[0].clone()])?;
            ensure_assignable(r, &[l[1].clone(), l[0].clone()])?;
            let xy = all_names(2);
            let yx = vec![xy[1].clone(), xy[0].clone()];
            Ok(vec![
                make(0, vec![pattern(left, &xy)], pattern(right, &yx)),
                make(1, vec![pattern(right, &xy)], pattern(left, &yx)),
            ])
        }
        OntologyAxiom::Symmetric { property, .. } => {
            let types = signature(catalog, property, 2)?;
            ensure_assignable(types, &[types[1].clone(), types[0].clone()])?;
            let xy = all_names(2);
            let yx = vec![xy[1].clone(), xy[0].clone()];
            Ok(vec![make(
                0,
                vec![pattern(property, &xy)],
                pattern(property, &yx),
            )])
        }
        OntologyAxiom::Transitive { property, .. } => {
            let types = signature(catalog, property, 2)?;
            // Equality is a sufficient, explicit type-safe condition for a
            // transitive homogeneous relation, without inventing coercions.
            if types[0] != types[1] {
                return Err("transitivity requires identical endpoint argument types".into());
            }
            let xy = vec!["v0".into(), "v1".into()];
            let yz = vec!["v1".into(), "v2".into()];
            let xz = vec!["v0".into(), "v2".into()];
            Ok(vec![make(
                0,
                vec![pattern(property, &xy), pattern(property, &yz)],
                pattern(property, &xz),
            )])
        }
        OntologyAxiom::PropertyChain { chain, result, .. } => {
            if chain.len() < 2 || chain.len() > MAX_CHAIN_LENGTH {
                return Err("property chain length must be between 2 and 32".into());
            }
            let mut premises = Vec::with_capacity(chain.len());
            let mut left_type = None;
            let mut previous_right: Option<ArgumentKind> = None;
            for (i, property) in chain.iter().enumerate() {
                let types = signature(catalog, property, 2)?;
                if let Some(previous) = &previous_right {
                    // The premise types must have a nonempty possible
                    // intersection; Graph::add_rule performs full checking.
                    if !assignable(previous, &types[0]) && !assignable(&types[0], previous) {
                        return Err(
                            "property chain has incompatible adjacent endpoint types".into()
                        );
                    }
                } else {
                    left_type = Some(types[0].clone());
                }
                previous_right = Some(types[1].clone());
                premises.push(pattern(property, &[format!("v{i}"), format!("v{}", i + 1)]));
            }
            let output = signature(catalog, result, 2)?;
            let start = left_type.ok_or("property chain has no first endpoint")?;
            let end = previous_right.ok_or("property chain has no last endpoint")?;
            ensure_assignable(&[start, end], output)?;
            let head = pattern(result, &["v0".into(), format!("v{}", chain.len())]);
            Ok(vec![make(0, premises, head)])
        }
    }
}

/// Compile AND validate every rule against a cloned graph, never mutating
/// the original. The returned rules have ordinary source-checkable proofs.
pub fn compile_axioms(graph: &Graph, axioms: &[OntologyAxiom]) -> Result<Vec<Rule>, String> {
    if axioms.is_empty() || axioms.len() > MAX_AXIOMS {
        return Err("axiom batch must contain 1..=4096 axioms".into());
    }
    let catalog: BTreeMap<_, _> = graph
        .export_archive()
        .predicates
        .into_iter()
        .map(|p| (p.name.clone(), p))
        .collect();
    let mut candidate = graph.clone();
    let mut rules = Vec::new();
    for axiom in axioms {
        let expanded = expand(axiom, &catalog)?;
        if rules
            .len()
            .checked_add(expanded.len())
            .is_none_or(|total| total > MAX_AXIOMS)
        {
            return Err("expanded ontology rule limit exceeded".into());
        }
        for rule in expanded {
            candidate.add_rule(rule.clone())?;
            rules.push(rule);
        }
    }
    Ok(rules)
}

/// All-or-nothing installation. Persisted output consists solely of standard
/// Graph rules, so the existing archive and independent verifier remain valid.
pub fn register_axioms(graph: &mut Graph, axioms: &[OntologyAxiom]) -> Result<Vec<String>, String> {
    let rules = compile_axioms(graph, axioms)?;
    let mut candidate = graph.clone();
    let ids = rules.iter().map(|rule| rule.id.clone()).collect();
    for rule in rules {
        candidate.add_rule(rule)?;
    }
    *graph = candidate;
    Ok(ids)
}
