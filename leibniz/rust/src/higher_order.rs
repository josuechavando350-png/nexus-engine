//! Finite, typed predicate quantification on the independent LEIBNIZ graph.
//!
//! A predicate slot ranges over an explicitly enumerated, nonempty set of
//! *declared* predicate symbols. This compiler materializes the finite schema
//! into ordinary range-restricted Horn rules. Each resulting rule is checked
//! by Graph::add_rule; existing source-anchored proof verification applies
//! without a second, weaker proof system. This is not unrestricted higher-
//! order logic, automatic ontology discovery, or a physical prediction.

use crate::{Graph, Pattern, PatternTerm, Rule};
use std::collections::{BTreeMap, BTreeSet};

/// Independent of caller configuration: never attempt unbounded expansion.
pub const MAX_GROUNDED_RULES: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PredicateReference {
    Named(String),
    Slot(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HigherOrderPattern {
    pub predicate: PredicateReference,
    pub terms: Vec<PatternTerm>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PredicateDomain {
    pub slot: String,
    /// This is the *entire* explicit finite domain, not a search request.
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HigherOrderRule {
    pub id: String,
    pub domains: Vec<PredicateDomain>,
    pub body: Vec<HigherOrderPattern>,
    pub head: HigherOrderPattern,
}

fn render_pattern(
    pattern: &HigherOrderPattern,
    choices: &BTreeMap<String, String>,
) -> Result<Pattern, String> {
    let predicate = match &pattern.predicate {
        PredicateReference::Named(name) => name.clone(),
        PredicateReference::Slot(slot) => choices
            .get(slot)
            .ok_or_else(|| format!("undeclared predicate slot: {slot}"))?
            .clone(),
    };
    Ok(Pattern {
        predicate,
        terms: pattern.terms.clone(),
    })
}

/// An injective, deterministic name for a concrete rule and its substitutions.
/// Length prefixes prevent a user-provided colon or equal sign from colliding.
fn grounded_id(id: &str, choices: &BTreeMap<String, String>) -> String {
    let mut output = format!("leibniz:ho:{}:{id}", id.len());
    for (slot, predicate) in choices {
        output.push_str(&format!(
            ":{}:{slot}:{}:{predicate}",
            slot.len(),
            predicate.len()
        ));
    }
    output
}

/// Expands only explicitly permitted predicate symbols. The returned rules
/// remain unregistered. The graph is never mutated, including on failure.
/// `max_instances` is a hard bound checked *before* allocation and cloning.
pub fn compile_higher_order_rules(
    graph: &Graph,
    schema: &HigherOrderRule,
    max_instances: usize,
) -> Result<Vec<Rule>, String> {
    if schema.id.trim().is_empty() || schema.body.is_empty() || schema.domains.is_empty() {
        return Err("higher-order rule needs an ID, a nonempty body and predicate domains".into());
    }
    if max_instances == 0 {
        return Err("higher-order instance limit must be positive".into());
    }
    let catalog: BTreeSet<_> = graph
        .export_archive()
        .predicates
        .into_iter()
        .map(|predicate| predicate.name)
        .collect();
    let mut domains = schema.domains.clone();
    domains.sort_by(|left, right| left.slot.cmp(&right.slot));
    let mut declared_slots = BTreeSet::new();
    let mut count = 1usize;
    for domain in &mut domains {
        if domain.slot.trim().is_empty() || !declared_slots.insert(domain.slot.clone()) {
            return Err("predicate slot is empty or declared twice".into());
        }
        if domain.candidates.is_empty() {
            return Err(format!(
                "predicate slot {} has an empty domain",
                domain.slot
            ));
        }
        domain.candidates.sort();
        for (index, name) in domain.candidates.iter().enumerate() {
            if !catalog.contains(name) {
                return Err(format!(
                    "predicate slot {} refers to undeclared predicate {name}",
                    domain.slot
                ));
            }
            if index > 0 && domain.candidates[index - 1].as_str() == name.as_str() {
                return Err(format!(
                    "predicate slot {} contains duplicate candidate {name}",
                    domain.slot
                ));
            }
        }
        count = count
            .checked_mul(domain.candidates.len())
            .ok_or("higher-order instance count overflow")?;
        if count > max_instances || count > MAX_GROUNDED_RULES {
            return Err("higher-order instance limit exceeded".into());
        }
    }
    let mut used_slots = BTreeSet::new();
    let mut body_slots = BTreeSet::new();
    for pattern in &schema.body {
        if let PredicateReference::Slot(slot) = &pattern.predicate {
            body_slots.insert(slot.clone());
            used_slots.insert(slot.clone());
        }
    }
    if let PredicateReference::Slot(slot) = &schema.head.predicate {
        used_slots.insert(slot.clone());
    }
    if used_slots != declared_slots || !used_slots.is_subset(&body_slots) {
        return Err("every predicate slot must be declared and appear in a premise".into());
    }
    let mut choices = vec![BTreeMap::<String, String>::new()];
    for domain in domains {
        let mut expanded = Vec::with_capacity(choices.len() * domain.candidates.len());
        for choice in &choices {
            for predicate in &domain.candidates {
                let mut next = choice.clone();
                next.insert(domain.slot.clone(), predicate.clone());
                expanded.push(next);
            }
        }
        choices = expanded;
    }
    let mut validated = graph.clone();
    let mut output = Vec::with_capacity(count);
    for choice in choices {
        let mut body = Vec::with_capacity(schema.body.len());
        for pattern in &schema.body {
            body.push(render_pattern(pattern, &choice)?);
        }
        let rule = Rule {
            id: grounded_id(&schema.id, &choice),
            body,
            head: render_pattern(&schema.head, &choice)?,
        };
        // Validates arity, term types, bound variables, named predicates and
        // duplicate concrete rule IDs through the existing trusted checker.
        validated.add_rule(rule.clone())?;
        output.push(rule);
    }
    Ok(output)
}

/// Transactional registration: no partial rule installation on any failure.
/// The installed, fully grounded rules are what the existing archive stores,
/// and what the independent proof verifier subsequently checks.
pub fn register_higher_order_rules(
    graph: &mut Graph,
    schema: &HigherOrderRule,
    max_instances: usize,
) -> Result<Vec<String>, String> {
    let rules = compile_higher_order_rules(graph, schema, max_instances)?;
    let mut candidate = graph.clone();
    let ids = rules.iter().map(|rule| rule.id.clone()).collect();
    for rule in rules {
        candidate.add_rule(rule)?;
    }
    *graph = candidate;
    Ok(ids)
}
