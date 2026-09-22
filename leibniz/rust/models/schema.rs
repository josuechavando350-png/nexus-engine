//! Core Ontology Engine: domain-independent entity, restriction, and flow models.
//! This file implements the three source models from the sovereign manifesto.
//! Numeric values must be finite; the domain supplies their meaning and units.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum AttributeValue {
    Text(String),
    Number(f64),
    Boolean(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestrictionType {
    Immutable,
    Conditional,
    Elastic,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entity {
    pub id: String,
    pub category: String,
    pub attributes: HashMap<String, AttributeValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Restriction {
    pub source_id: String,
    pub target_id: String,
    pub constraint_type: RestrictionType,
    pub boundary_value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Flow {
    pub from_entity: String,
    pub to_entity: String,
    pub rate_of_transfer: f64,
}
