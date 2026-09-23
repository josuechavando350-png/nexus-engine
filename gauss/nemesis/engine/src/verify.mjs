import { createHash } from 'node:crypto';
import { LIMITS, array, normalizeModel, publicModel, record, token, unique } from './model.mjs';
import { diagnostic, evaluateCTL, normalizeFormula } from './ctl.mjs';

function digest(data) { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Throws on malformed input: an exception is never translated into PASS. */
export function verifyFiniteSystem(spec) {
  record(spec, 'verification', ['model', 'properties']);
  const graph = normalizeModel(spec.model);
  return verifyNormalized(graph, spec.properties);
}

export function verifyNormalized(graph, rawProperties) {
  const budget = { count: 0 };
  const properties = array(rawProperties, 'properties', 1, LIMITS.properties).map((raw, i) => {
    record(raw, `properties[${i}]`, ['id', 'formula', 'required']);
    if (typeof raw.required !== 'boolean') throw new TypeError(`properties[${i}].required must be boolean`);
    return Object.freeze({ id: token(raw.id, `properties[${i}].id`), required: raw.required, formula: normalizeFormula(raw.formula, budget) });
  });
  unique(properties.map(p => p.id), 'property ids');
  if (!properties.some(p => p.required)) throw new TypeError('at least one required property is needed for a passing verification');
  const vocabulary = new Set(graph.atomicPropositions);
  function validateAtoms(formula) {
    if (formula.op === 'ATOM' && !vocabulary.has(formula.name)) throw new TypeError(`undeclared atomic proposition ${formula.name}`);
    if (formula.arg) validateAtoms(formula.arg);
    if (formula.left) validateAtoms(formula.left);
    if (formula.right) validateAtoms(formula.right);
  }
  for (const property of properties) validateAtoms(property.formula);
  const modelSnapshot = publicModel(graph);
  const modelSha256 = digest(modelSnapshot);
  const results = properties.map(property => {
    const { satisfying, subformulaEvidence, satisfyingByNode } = evaluateCTL(property.formula, graph);
    const initialResults = graph.initialStates.map(state => {
      const index = graph.index.get(state);
      const satisfied = Boolean(satisfying[index]);
      return { state, satisfied, diagnostic: diagnostic(property.formula, graph, index, satisfied, satisfyingByNode) };
    });
    return {
      id: property.id, required: property.required, holds: initialResults.every(result => result.satisfied),
      formula: property.formula, satisfyingStates: graph.states.filter((_, i) => satisfying[i]),
      initialResults, subformulaEvidence,
    };
  });
  const failedRequired = results.filter(result => result.required && !result.holds).map(result => result.id);
  return deepFreeze({
    engine: 'NEMESIS_FORMAL_FINITE_CTL_V1', status: failedRequired.length ? 'FAIL' : 'PASS',
    scope: 'ONLY_THE_SUPPLIED_FINITE_KRIPKE_STRUCTURE',
    modelSha256, model: modelSnapshot,
    failedRequired, results,
    note: 'Exhaustive over this validated finite model, not a proof of arbitrary source code or a running deployment.',
  });
}
