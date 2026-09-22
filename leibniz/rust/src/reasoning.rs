use crate::schema::{AttributeValue, Entity, Flow, Restriction};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A fact can describe an entity or a previously asserted statement.
/// Reification permits higher-order relationships without confusing them
/// with logical implication or pretending that arbitrary higher-order logic
/// is decidable.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Term {
    Entity(String),
    Statement(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgumentKind {
    AnyEntity,
    EntityCategory(String),
    Statement,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Predicate {
    pub name: String,
    pub arguments: Vec<ArgumentKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Atom {
    pub predicate: String,
    pub terms: Vec<Term>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternTerm {
    Variable(String),
    Constant(Term),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    pub predicate: String,
    pub terms: Vec<PatternTerm>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub body: Vec<Pattern>,
    pub head: Pattern,
}

/// An asserted source is not the same thing as a derived proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Justification {
    Asserted { source_id: String },
    Derived { rule_id: String, premises: Vec<u64> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fact {
    pub id: u64,
    pub atom: Atom,
    pub justification: Justification,
    /// All independently asserted source IDs, including later corroboration.
    pub asserted_sources: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proof {
    /// Dependencies first, then the queried conclusion. Every derived fact
    /// points at the exact earlier fact IDs used to derive it.
    pub steps: Vec<Fact>,
}

/// Read-only, typed data boundary for a later GAUSS adapter. This is actual
/// graph data, not a mathematical prediction or a fictitious GAUSS response.
/// No network connection or GAUSS process is created by taking a snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct ProblemSnapshot {
    pub entities: Vec<Entity>,
    pub restrictions: Vec<Restriction>,
    pub flows: Vec<Flow>,
    pub asserted_facts: Vec<Fact>,
}

/// Version-independent data needed to recover the *entire asserted* graph.
/// Derived facts are deliberately never persisted: they are recomputed from
/// the recorded assertions and registered rules after restoration.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphArchive {
    pub entities: Vec<Entity>,
    pub restrictions: Vec<Restriction>,
    pub flows: Vec<Flow>,
    pub predicates: Vec<Predicate>,
    pub assertions: Vec<Fact>,
    pub rules: Vec<Rule>,
    pub incompatible: Vec<(String, String)>,
}

/// ESTIMATED is reserved for a separately validated GAUSS probabilistic
/// integration. This deterministic ontology never manufactures a probability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Proven {
        proof: Proof,
    },
    Estimated {
        probability_basis_points: u16,
        evidence: String,
    },
    Unidentifiable {
        reason: String,
    },
    Abstain {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_rounds: usize,
    pub max_facts: usize,
    pub max_matches: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_rounds: 64,
            max_facts: 100_000,
            max_matches: 100_000,
        }
    }
}

type Binding = BTreeMap<String, Term>;

#[derive(Debug, Clone, Default)]
pub struct Graph {
    entities: HashMap<String, Entity>,
    restrictions: Vec<Restriction>,
    flows: Vec<Flow>,
    predicates: BTreeMap<String, Predicate>,
    rules: BTreeMap<String, Rule>,
    facts: BTreeMap<u64, Fact>,
    fact_ids: BTreeMap<Atom, u64>,
    incompatible: BTreeSet<(String, String)>,
    next_fact_id: u64,
}

impl Graph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_entity(&mut self, entity: Entity) -> Result<(), String> {
        nonempty(&entity.id, "entity id")?;
        nonempty(&entity.category, "entity category")?;
        if entity.attributes.iter().any(|(key, val)| {
            key.trim().is_empty() || matches!(val, AttributeValue::Number(num) if !num.is_finite())
        }) {
            return Err("entity attributes require names and finite numeric values".into());
        }
        if self.entities.contains_key(&entity.id) {
            return Err(format!("duplicate entity id: {}", entity.id));
        }
        self.entities.insert(entity.id.clone(), entity);
        Ok(())
    }

    pub fn add_restriction(&mut self, restriction: Restriction) -> Result<(), String> {
        self.require_entity(&restriction.source_id)?;
        self.require_entity(&restriction.target_id)?;
        if !restriction.boundary_value.is_finite() {
            return Err("restriction boundary_value must be finite".into());
        }
        self.restrictions.push(restriction);
        Ok(())
    }

    pub fn add_flow(&mut self, flow: Flow) -> Result<(), String> {
        self.require_entity(&flow.from_entity)?;
        self.require_entity(&flow.to_entity)?;
        if !flow.rate_of_transfer.is_finite() || flow.rate_of_transfer < 0.0 {
            return Err("flow rate must be finite and nonnegative".into());
        }
        self.flows.push(flow);
        Ok(())
    }

    pub fn restrictions(&self) -> &[Restriction] {
        &self.restrictions
    }
    pub fn flows(&self) -> &[Flow] {
        &self.flows
    }
    pub fn fact_count(&self) -> usize {
        self.facts.len()
    }

    pub fn snapshot(&self) -> ProblemSnapshot {
        let mut entities: Vec<_> = self.entities.values().cloned().collect();
        entities.sort_by(|a, b| a.id.cmp(&b.id));
        ProblemSnapshot {
            entities,
            restrictions: self.restrictions.clone(),
            flows: self.flows.clone(),
            asserted_facts: self.facts.values().cloned().collect(),
        }
    }

    /// Deterministic snapshot of the full independent graph, not the
    /// GAUSS-only ProblemSnapshot. Only primary assertions are persisted.
    pub fn export_archive(&self) -> GraphArchive {
        let mut entities: Vec<_> = self.entities.values().cloned().collect();
        entities.sort_by(|a, b| a.id.cmp(&b.id));
        GraphArchive {
            entities,
            restrictions: self.restrictions.clone(),
            flows: self.flows.clone(),
            predicates: self.predicates.values().cloned().collect(),
            assertions: self.facts.values().cloned().collect(),
            rules: self.rules.values().cloned().collect(),
            incompatible: self.incompatible.iter().cloned().collect(),
        }
    }

    /// Rebuild by going through the exact same validation as normal input.
    /// Stored fact IDs are checked, never trusted or silently reassigned.
    pub fn from_archive(archive: GraphArchive) -> Result<Self, String> {
        let mut graph = Self::new();
        for entity in archive.entities {
            graph.add_entity(entity)?;
        }
        for restriction in archive.restrictions {
            graph.add_restriction(restriction)?;
        }
        for flow in archive.flows {
            graph.add_flow(flow)?;
        }
        for predicate in archive.predicates {
            graph.declare_predicate(predicate)?;
        }
        // An archive is an exact assertion ledger, not a set that may silently
        // discard repeated records. assert_fact() deliberately coalesces a
        // second source during *live* ingestion; that behavior must not make
        // duplicate serialized assertions look like a faithful restoration.
        let mut seen_assertion_ids = BTreeSet::new();
        let mut seen_assertion_atoms = BTreeSet::new();
        for assertion in archive.assertions {
            if !seen_assertion_ids.insert(assertion.id)
                || !seen_assertion_atoms.insert(assertion.atom.clone())
            {
                return Err("archive contains a duplicate assertion ID or atom".into());
            }
            let Justification::Asserted { source_id } = &assertion.justification else {
                return Err("durable archive may only contain asserted facts".into());
            };
            if assertion.asserted_sources.is_empty()
                || !assertion.asserted_sources.contains(source_id)
            {
                return Err("archive fact has inconsistent provenance".into());
            }
            let restored = graph.assert_fact(assertion.atom.clone(), source_id)?;
            if restored != assertion.id {
                return Err(format!(
                    "archive fact ID mismatch: expected {}, got {restored}",
                    assertion.id
                ));
            }
            for corroboration in &assertion.asserted_sources {
                graph.assert_fact(assertion.atom.clone(), corroboration)?;
            }
            if graph.facts.get(&restored) != Some(&assertion) {
                return Err("archive assertion did not round-trip exactly".into());
            }
        }
        for rule in archive.rules {
            graph.add_rule(rule)?;
        }
        let mut seen_incompatibilities = BTreeSet::new();
        for (left, right) in archive.incompatible {
            if !seen_incompatibilities.insert(sorted_pair(&left, &right)) {
                return Err("archive contains duplicate incompatible predicates".into());
            }
            graph.declare_incompatible(&left, &right)?;
        }
        Ok(graph)
    }

    /// Read-only signature lookup for bounded predicate quantification.
    /// Avoids cloning the entire graph or its durable archive for a catalog query.
    pub fn predicate_signature(&self, name: &str) -> Option<&[ArgumentKind]> {
        self.predicates
            .get(name)
            .map(|predicate| predicate.arguments.as_slice())
    }

    pub fn declare_predicate(&mut self, predicate: Predicate) -> Result<(), String> {
        nonempty(&predicate.name, "predicate name")?;
        if predicate.arguments.is_empty() {
            return Err("predicates must have at least one argument".into());
        }
        for arg in &predicate.arguments {
            if let ArgumentKind::EntityCategory(category) = arg {
                nonempty(category, "entity category")?;
            }
        }
        if self.predicates.contains_key(&predicate.name) {
            return Err(format!("duplicate predicate: {}", predicate.name));
        }
        self.predicates.insert(predicate.name.clone(), predicate);
        Ok(())
    }

    /// Both predicates must have the exact same argument signature. A clash
    /// causes ABSTAIN rather than choosing an arbitrary side of a conflict.
    pub fn declare_incompatible(&mut self, left: &str, right: &str) -> Result<(), String> {
        let a = self.predicates.get(left).ok_or("unknown left predicate")?;
        let b = self
            .predicates
            .get(right)
            .ok_or("unknown right predicate")?;
        if left == right || a.arguments != b.arguments {
            return Err(
                "incompatible predicates must be distinct and have equal signatures".into(),
            );
        }
        let (first, second) = sorted_pair(left, right);
        self.incompatible.insert((first, second));
        Ok(())
    }

    pub fn assert_fact(&mut self, atom: Atom, source_id: &str) -> Result<u64, String> {
        nonempty(source_id, "source_id")?;
        self.validate_atom(&atom)?;
        if let Some(id) = self.fact_ids.get(&atom).copied() {
            if let Some(fact) = self.facts.get_mut(&id) {
                fact.asserted_sources.insert(source_id.to_owned());
            }
            return Ok(id);
        }
        self.insert_fact(
            atom,
            Justification::Asserted {
                source_id: source_id.into(),
            },
        )
    }

    pub fn add_rule(&mut self, rule: Rule) -> Result<(), String> {
        nonempty(&rule.id, "rule id")?;
        if self.rules.contains_key(&rule.id) {
            return Err("duplicate rule id".into());
        }
        if rule.body.is_empty() {
            return Err("rules require at least one premise".into());
        }
        // Unification alone does not enforce type soundness: a variable could
        // otherwise bind an Entity in a premise and stand for a Statement in
        // the conclusion. Reject such a rule *before* it enters the graph.
        let mut bound = BTreeMap::<String, ArgumentKind>::new();
        for atom in &rule.body {
            self.validate_pattern(atom)?;
            let signature = &self.predicates[&atom.predicate].arguments;
            for (term, expected_kind) in atom.terms.iter().zip(signature) {
                if let PatternTerm::Variable(name) = term {
                    nonempty(name, "variable name")?;
                    match bound.get(name) {
                        Some(previous) => {
                            let merged =
                                intersect_kinds(previous, expected_kind).ok_or_else(|| {
                                    format!(
                                        "rule {}: incompatible types for variable {name}",
                                        rule.id
                                    )
                                })?;
                            bound.insert(name.clone(), merged);
                        }
                        None => {
                            bound.insert(name.clone(), expected_kind.clone());
                        }
                    }
                }
                if let PatternTerm::Constant(term) = term {
                    self.require_term(term)?;
                }
            }
        }
        self.validate_pattern(&rule.head)?;
        let head_signature = &self.predicates[&rule.head.predicate].arguments;
        for (term, expected_kind) in rule.head.terms.iter().zip(head_signature) {
            match term {
                PatternTerm::Variable(name) => match bound.get(name) {
                    None => return Err(format!("unsafe rule: unbound head variable {name}")),
                    Some(actual_kind) if !kind_assignable(actual_kind, expected_kind) => {
                        return Err(format!(
                            "rule {}: head variable {name} has incompatible type",
                            rule.id
                        ))
                    }
                    Some(_) => {}
                },
                PatternTerm::Constant(term) => self.require_term(term)?,
            }
        }
        self.rules.insert(rule.id.clone(), rule);
        Ok(())
    }

    /// Closed computation over an *open-world* graph. No entailed result does
    /// not mean that the negation is true. The caller's graph is not mutated.
    pub fn infer(&self, query: &Atom, limits: Limits) -> Decision {
        if let Err(reason) = self.validate_atom(query) {
            return Decision::Abstain {
                reason: format!("invalid query: {reason}"),
            };
        }
        if limits.max_facts == 0 || limits.max_matches == 0 {
            return Decision::Abstain {
                reason: "resource limits must be positive".into(),
            };
        }
        if self.fact_count() > limits.max_facts {
            return Decision::Abstain {
                reason: "initial graph exceeds max_facts".into(),
            };
        }
        let mut working = self.clone();
        // One budget for the entire closure, not a fresh allowance per round.
        // Otherwise recursive rules can spend max_matches * max_rounds while
        // still appearing to respect the caller's single work bound.
        let mut match_count = 0usize;
        for round in 0..=limits.max_rounds {
            if let Some(reason) = working.contradiction() {
                return Decision::Abstain { reason };
            }
            let mut candidates = BTreeMap::<Atom, (String, Vec<u64>)>::new();
            // Index once per round: rules with no matching predicate do not
            // repeatedly scan the entire graph. Order remains fact-ID sorted.
            let mut by_predicate: BTreeMap<&str, Vec<&Fact>> = BTreeMap::new();
            for fact in working.facts.values() {
                by_predicate
                    .entry(fact.atom.predicate.as_str())
                    .or_default()
                    .push(fact);
            }
            for rule in working.rules.values() {
                let matches = match Self::match_body(
                    &rule.body,
                    &by_predicate,
                    limits.max_matches,
                    &mut match_count,
                ) {
                    Ok(found) => found,
                    Err(reason) => return Decision::Abstain { reason },
                };
                for (bindings, premises) in matches {
                    let atom = match instantiate(&rule.head, &bindings) {
                        Ok(atom) => atom,
                        Err(reason) => return Decision::Abstain { reason },
                    };
                    if let Err(reason) = working.validate_atom(&atom) {
                        return Decision::Abstain {
                            reason: format!("rule {} produced invalid fact: {reason}", rule.id),
                        };
                    }
                    if !working.fact_ids.contains_key(&atom) {
                        candidates
                            .entry(atom)
                            .or_insert_with(|| (rule.id.clone(), premises));
                    }
                }
            }
            // Release borrowed fact references before mutating this round's graph.
            drop(by_predicate);
            if candidates.is_empty() {
                break;
            }
            if round == limits.max_rounds {
                return Decision::Abstain {
                    reason: "max_rounds exhausted before fixed point".into(),
                };
            }
            if candidates.len() > limits.max_facts.saturating_sub(working.fact_count()) {
                return Decision::Abstain {
                    reason: "max_facts would be exceeded".into(),
                };
            }
            for (atom, (rule_id, premises)) in candidates {
                if let Err(reason) =
                    working.insert_fact(atom, Justification::Derived { rule_id, premises })
                {
                    return Decision::Abstain { reason };
                }
            }
        }
        if let Some(reason) = working.contradiction() {
            return Decision::Abstain { reason };
        }
        match working.fact_ids.get(query) {
            Some(id) => Decision::Proven {
                proof: working.proof(*id),
            },
            None => Decision::Unidentifiable {
                reason: "query is not entailed by available facts and rules (open-world semantics)"
                    .into(),
            },
        }
    }

    /// Independently verify a proof against this graph's original assertions
    /// and registered rules. A forged "Asserted" step cannot manufacture a
    /// source: its entire record must match an actual asserted fact. A derived
    /// step is accepted only if every premise appears earlier and the exact
    /// registered rule produces its conclusion with a consistent substitution.
    /// This establishes *relative entailment*, not truth of external sources.
    pub fn verify_proof(&self, query: &Atom, proof: &Proof) -> Result<(), String> {
        self.verify_proof_bounded(query, proof, 100_000, 100_000)
    }

    /// Verify a caller-supplied proof under explicit resource limits. Bounds
    /// apply to *every* submitted step and premise reference, including those
    /// unrelated to the final conclusion; neither is inferred from a trusted
    /// proof length. This verifies relative derivability, not global closure.
    pub fn verify_proof_bounded(
        &self,
        query: &Atom,
        proof: &Proof,
        max_steps: usize,
        max_premise_refs: usize,
    ) -> Result<(), String> {
        if max_steps == 0 || proof.steps.len() > max_steps {
            return Err("proof exceeds max_steps or max_steps is zero".into());
        }
        let mut premise_refs_left = max_premise_refs;
        self.validate_atom(query)?;
        if let Some(reason) = self.contradiction() {
            return Err(format!("inconsistent input graph: {reason}"));
        }
        if proof.steps.last().map(|step| &step.atom) != Some(query) {
            return Err("proof must end in the exact queried conclusion".into());
        }
        let mut verified = BTreeMap::<u64, &Fact>::new();
        let mut seen_atoms = BTreeSet::<Atom>::new();
        for step in &proof.steps {
            if step.id == 0 || verified.contains_key(&step.id) {
                return Err("proof contains a zero or repeated fact ID".into());
            }
            self.validate_atom(&step.atom)?;
            if !seen_atoms.insert(step.atom.clone()) {
                return Err("proof contains repeated conclusions".into());
            }
            match &step.justification {
                Justification::Asserted { .. } => {
                    if self.facts.get(&step.id) != Some(step) {
                        return Err("asserted proof step does not match a source fact".into());
                    }
                }
                Justification::Derived { rule_id, premises } => {
                    if premises.len() > premise_refs_left {
                        return Err("proof exceeds max_premise_refs".into());
                    }
                    premise_refs_left -= premises.len();
                    if self.facts.contains_key(&step.id) || !step.asserted_sources.is_empty() {
                        return Err("derived proof step cannot impersonate an assertion".into());
                    }
                    let rule = self
                        .rules
                        .get(rule_id)
                        .ok_or_else(|| format!("unregistered proof rule: {rule_id}"))?;
                    if rule.body.len() != premises.len() {
                        return Err(format!("rule {rule_id}: wrong number of premises"));
                    }
                    let mut substitution = Binding::new();
                    for (pattern, id) in rule.body.iter().zip(premises) {
                        let premise = verified
                            .get(id)
                            .ok_or_else(|| format!("missing or forward premise: {id}"))?;
                        substitution = unify(pattern, &premise.atom, &substitution)
                            .ok_or_else(|| format!("rule {rule_id}: premise does not unify"))?;
                    }
                    let expected = instantiate(&rule.head, &substitution)?;
                    if expected != step.atom {
                        return Err(format!("rule {rule_id}: conclusion does not follow"));
                    }
                }
            }
            for (left, right) in &self.incompatible {
                let opposite = if &step.atom.predicate == left {
                    Some(right)
                } else if &step.atom.predicate == right {
                    Some(left)
                } else {
                    None
                };
                if let Some(other) = opposite {
                    let counterpart = Atom {
                        predicate: other.clone(),
                        terms: step.atom.terms.clone(),
                    };
                    if seen_atoms.contains(&counterpart) || self.fact_ids.contains_key(&counterpart)
                    {
                        return Err("proof includes mutually incompatible conclusions".into());
                    }
                }
            }
            verified.insert(step.id, step);
        }
        Ok(())
    }

    /// A derivation may be locally valid even when *another* registered rule
    /// derives its incompatible counterpart. Therefore a proof alone is not a
    /// globally consistent PROVEN decision. Recompute bounded closure and
    /// refuse certification if any contradiction or resource limit appears.
    ///
    /// This does not authenticate input sources or prove real-world truth.
    pub fn verify_consistent_proof(
        &self,
        query: &Atom,
        proof: &Proof,
        limits: Limits,
    ) -> Result<(), String> {
        if limits.max_facts == 0
            || self.fact_count() > limits.max_facts
            || proof.steps.len() > limits.max_facts
        {
            return Err("proof or source graph exceeds max_facts".into());
        }
        if limits.max_matches == 0 {
            return Err("proof verification requires a positive match budget".into());
        }
        self.verify_proof_bounded(query, proof, limits.max_facts, limits.max_matches)?;
        match self.infer(query, limits) {
            Decision::Proven { .. } => Ok(()),
            Decision::Abstain { reason } => Err(format!(
                "cannot certify proof: inference abstained: {reason}"
            )),
            Decision::Unidentifiable { reason } => Err(format!(
                "cannot certify proof: query unidentifiable: {reason}"
            )),
            Decision::Estimated { .. } => {
                Err("deterministic inference cannot certify an estimate".into())
            }
        }
    }

    fn validate_pattern(&self, pattern: &Pattern) -> Result<(), String> {
        let signature = self
            .predicates
            .get(&pattern.predicate)
            .ok_or_else(|| format!("undeclared predicate: {}", pattern.predicate))?;
        if pattern.terms.len() != signature.arguments.len() {
            return Err(format!("arity mismatch for {}", pattern.predicate));
        }
        for (term, kind) in pattern.terms.iter().zip(&signature.arguments) {
            if let PatternTerm::Constant(term) = term {
                self.validate_term_kind(term, kind)?;
            }
        }
        Ok(())
    }

    fn validate_atom(&self, atom: &Atom) -> Result<(), String> {
        let signature = self
            .predicates
            .get(&atom.predicate)
            .ok_or_else(|| format!("undeclared predicate: {}", atom.predicate))?;
        if atom.terms.len() != signature.arguments.len() {
            return Err(format!("arity mismatch for {}", atom.predicate));
        }
        for (term, kind) in atom.terms.iter().zip(&signature.arguments) {
            self.validate_term_kind(term, kind)?;
        }
        Ok(())
    }

    fn validate_term_kind(&self, term: &Term, kind: &ArgumentKind) -> Result<(), String> {
        match (term, kind) {
            (Term::Entity(id), ArgumentKind::AnyEntity) => self.require_entity(id).map(|_| ()),
            (Term::Entity(id), ArgumentKind::EntityCategory(category)) => {
                let actual = &self.require_entity(id)?.category;
                if actual != category {
                    return Err(format!(
                        "entity {id}: expected category {category}, got {actual}"
                    ));
                }
                Ok(())
            }
            (Term::Statement(id), ArgumentKind::Statement) => self.require_fact(*id),
            _ => Err("term kind does not match predicate signature".into()),
        }
    }

    fn require_entity(&self, id: &str) -> Result<&Entity, String> {
        self.entities
            .get(id)
            .ok_or_else(|| format!("unknown entity: {id}"))
    }

    fn require_fact(&self, id: u64) -> Result<(), String> {
        if self.facts.contains_key(&id) {
            Ok(())
        } else {
            Err(format!("unknown statement: {id}"))
        }
    }

    fn require_term(&self, term: &Term) -> Result<(), String> {
        match term {
            Term::Entity(id) => self.require_entity(id).map(|_| ()),
            Term::Statement(id) => self.require_fact(*id),
        }
    }

    fn insert_fact(&mut self, atom: Atom, justification: Justification) -> Result<u64, String> {
        let id = self.next_fact_id.checked_add(1).ok_or("fact ID overflow")?;
        self.next_fact_id = id;
        self.fact_ids.insert(atom.clone(), id);
        let mut asserted_sources = BTreeSet::new();
        if let Justification::Asserted { source_id } = &justification {
            asserted_sources.insert(source_id.clone());
        }
        self.facts.insert(
            id,
            Fact {
                id,
                atom,
                justification,
                asserted_sources,
            },
        );
        Ok(id)
    }

    /// `max_matches` caps attempted unifications, not merely successes:
    /// a graph full of nonmatching bindings must not evade the work budget.
    /// Shared accounting covers every rule AND every round in one inference.
    fn match_body(
        body: &[Pattern],
        by_predicate: &BTreeMap<&str, Vec<&Fact>>,
        max_matches: usize,
        count: &mut usize,
    ) -> Result<Vec<(Binding, Vec<u64>)>, String> {
        // Positive conjunction: if any predicate has no facts, the whole
        // body has no match. Check all premises before spending budget on
        // earlier, potentially enormous joins that cannot yield a result.
        if body
            .iter()
            .any(|pattern| !by_predicate.contains_key(pattern.predicate.as_str()))
        {
            return Ok(Vec::new());
        }
        let mut states: Vec<(Binding, Vec<u64>)> = vec![(Binding::new(), Vec::new())];
        for pattern in body {
            let facts = by_predicate
                .get(pattern.predicate.as_str())
                .ok_or("predicate index changed during inference")?;
            let mut next = Vec::new();
            for (bindings, premises) in &states {
                for fact in facts {
                    *count = count.checked_add(1).ok_or("match attempt count overflow")?;
                    if *count > max_matches {
                        return Err("max_matches exhausted during unification".into());
                    }
                    if let Some(new_bindings) = unify(pattern, &fact.atom, bindings) {
                        let mut proof = premises.clone();
                        proof.push(fact.id);
                        next.push((new_bindings, proof));
                    }
                }
            }
            if next.is_empty() {
                return Ok(Vec::new());
            }
            states = next;
        }
        Ok(states)
    }

    fn contradiction(&self) -> Option<String> {
        for (left, right) in &self.incompatible {
            for fact in self
                .facts
                .values()
                .filter(|fact| fact.atom.predicate == *left)
            {
                let counterpart = Atom {
                    predicate: right.clone(),
                    terms: fact.atom.terms.clone(),
                };
                if self.fact_ids.contains_key(&counterpart) {
                    return Some(format!(
                        "incompatible facts: {left} and {right} for {:?}",
                        fact.atom.terms
                    ));
                }
            }
        }
        None
    }

    fn proof(&self, fact_id: u64) -> Proof {
        let mut steps = Vec::new();
        self.collect_proof(fact_id, &mut steps);
        Proof { steps }
    }

    /// Iterative postorder traversal: proof depth is limited by the caller's
    /// graph/work bounds, not by the native call stack. Shared premises appear
    /// once and always precede the claims that depend on them.
    fn collect_proof(&self, root: u64, steps: &mut Vec<Fact>) {
        let mut seen = BTreeSet::new();
        let mut pending = vec![(root, false)];
        while let Some((id, emit)) = pending.pop() {
            if seen.contains(&id) {
                continue;
            }
            let Some(fact) = self.facts.get(&id) else {
                continue;
            };
            if emit {
                seen.insert(id);
                steps.push(fact.clone());
                continue;
            }
            pending.push((id, true));
            if let Justification::Derived { premises, .. } = &fact.justification {
                for premise in premises.iter().rev() {
                    if !seen.contains(premise) {
                        pending.push((*premise, false));
                    }
                }
            }
        }
    }
}

fn nonempty(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}

fn sorted_pair(a: &str, b: &str) -> (String, String) {
    if a < b {
        (a.into(), b.into())
    } else {
        (b.into(), a.into())
    }
}

fn intersect_kinds(a: &ArgumentKind, b: &ArgumentKind) -> Option<ArgumentKind> {
    match (a, b) {
        (ArgumentKind::AnyEntity, ArgumentKind::AnyEntity) => Some(ArgumentKind::AnyEntity),
        (ArgumentKind::AnyEntity, ArgumentKind::EntityCategory(category))
        | (ArgumentKind::EntityCategory(category), ArgumentKind::AnyEntity) => {
            Some(ArgumentKind::EntityCategory(category.clone()))
        }
        (ArgumentKind::EntityCategory(a), ArgumentKind::EntityCategory(b)) if a == b => {
            Some(ArgumentKind::EntityCategory(a.clone()))
        }
        (ArgumentKind::Statement, ArgumentKind::Statement) => Some(ArgumentKind::Statement),
        _ => None,
    }
}

fn kind_assignable(actual: &ArgumentKind, expected: &ArgumentKind) -> bool {
    matches!(
        (actual, expected),
        (ArgumentKind::AnyEntity, ArgumentKind::AnyEntity)
            | (ArgumentKind::EntityCategory(_), ArgumentKind::AnyEntity)
            | (ArgumentKind::Statement, ArgumentKind::Statement)
    ) || actual == expected
}

fn unify(pattern: &Pattern, atom: &Atom, bindings: &Binding) -> Option<Binding> {
    if pattern.predicate != atom.predicate || pattern.terms.len() != atom.terms.len() {
        return None;
    }
    let mut next = bindings.clone();
    for (pattern_term, actual) in pattern.terms.iter().zip(&atom.terms) {
        match pattern_term {
            PatternTerm::Constant(expected) if expected != actual => return None,
            PatternTerm::Variable(name) => match next.get(name) {
                Some(bound) if bound != actual => return None,
                Some(_) => {}
                None => {
                    next.insert(name.clone(), actual.clone());
                }
            },
            _ => {}
        }
    }
    Some(next)
}

fn instantiate(pattern: &Pattern, bindings: &Binding) -> Result<Atom, String> {
    let mut terms = Vec::with_capacity(pattern.terms.len());
    for term in &pattern.terms {
        match term {
            PatternTerm::Constant(value) => terms.push(value.clone()),
            PatternTerm::Variable(name) => terms.push(
                bindings
                    .get(name)
                    .ok_or_else(|| format!("unbound variable at instantiation: {name}"))?
                    .clone(),
            ),
        }
    }
    Ok(Atom {
        predicate: pattern.predicate.clone(),
        terms,
    })
}
