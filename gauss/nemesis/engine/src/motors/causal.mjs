import { object, array, id, unique, rational, mul, add, div, sub, fmt, ZERO, ONE } from './shared.mjs';

/** Exact truncated-factorization do-calculus for a supplied fully observed binary DAG. */
export function inferBinaryCausal(input) {
  object(input, 'causal input', ['nodes', 'treatment', 'outcome']);
  const rawNodes = array(input.nodes, 'nodes', 2, 10);
  const names = unique(rawNodes.map((node, i) => { object(node, `nodes[${i}]`, ['id', 'parents', 'probabilityTrue']); return id(node.id, 'node.id'); }), 'node ids');
  const lookup = new Map(rawNodes.map((node, i) => [names[i], node]));
  const treatment = id(input.treatment, 'treatment');
  const outcome = id(input.outcome, 'outcome');
  if (!lookup.has(treatment) || !lookup.has(outcome) || treatment === outcome) throw new TypeError('treatment and outcome must be distinct nodes');
  const compiled = new Map();
  for (const node of rawNodes) {
    const parents = unique(array(node.parents, `${node.id}.parents`, 0, 8).map(p => id(p, 'parent')), 'parents');
    if (parents.includes(node.id) || parents.some(p => !lookup.has(p))) throw new TypeError(`${node.id} invalid parent`);
    object(node.probabilityTrue, `${node.id}.probabilityTrue`, Array.from({ length: 2 ** parents.length }, (_, i) => parents.length ? i.toString(2).padStart(parents.length, '0') : ''));
    const probabilities = new Map();
    for (let i = 0; i < 2 ** parents.length; i++) {
      const pattern = parents.length ? i.toString(2).padStart(parents.length, '0') : '';
      if (!Object.hasOwn(node.probabilityTrue, pattern)) throw new TypeError(`${node.id} missing CPT row ${pattern}`);
      probabilities.set(pattern, rational(node.probabilityTrue[pattern], `${node.id}[${pattern}]`, { probability: true }));
    }
    compiled.set(node.id, { parents, probabilities });
  }
  // DFS detects cycles; order is deterministic and independent of JSON node order.
  const sortedNames = [...names].sort();
  const color = new Map();
  const ordered = [];
  function visit(name) {
    if (color.get(name) === 1) throw new TypeError('causal graph contains a directed cycle');
    if (color.get(name) === 2) return;
    color.set(name, 1);
    for (const parent of [...compiled.get(name).parents].sort()) visit(parent);
    color.set(name, 2);
    ordered.push(name);
  }
  for (const name of sortedNames) visit(name);
  const mass = { observational: [ZERO, ZERO], joint: [ZERO, ZERO], interventional: [ZERO, ZERO] };
  function enumerate(assign, offset, probability, forced = null) {
    if (offset === ordered.length) {
      const x = assign[treatment];
      if (assign[outcome] === 1) {
        if (forced === null) mass.joint[x] = add(mass.joint[x], probability);
        else mass.interventional[forced] = add(mass.interventional[forced], probability);
      }
      if (forced === null) mass.observational[x] = add(mass.observational[x], probability);
      return;
    }
    const name = ordered[offset];
    const { parents, probabilities } = compiled.get(name);
    const p = probabilities.get(parents.map(parent => assign[parent]).join(''));
    for (let bit = 0; bit < 2; bit++) {
      if (name === treatment && forced !== null && bit !== forced) continue;
      assign[name] = bit;
      const factor = name === treatment && forced !== null ? ONE : bit ? p : sub(ONE, p);
      enumerate(assign, offset + 1, mul(probability, factor), forced);
    }
    delete assign[name];
  }
  enumerate(Object.create(null), 0, ONE);
  for (let bit = 0; bit < 2; bit++) enumerate(Object.create(null), 0, ONE, bit);
  const observed = mass.observational.map((p, i) => p[0] ? fmt(div(mass.joint[i], p)) : null);
  return {
    engine: 'NEMESIS_CAUSAL_BINARY_DAG_V1', domain: 'SUPPLIED_FULLY_OBSERVED_BINARY_DAG',
    treatment, outcome, topologicalOrder: ordered, assignmentsEvaluated: (2 ** names.length) * 3,
    observational: { treatmentMass: mass.observational.map(fmt), outcomeGivenTreatment: observed },
    interventional: { outcomeGivenDo: mass.interventional.map(fmt), effectDifference: fmt(sub(mass.interventional[1], mass.interventional[0])) },
    assumptions: ['Supplied DAG and complete CPTs are correct', 'All variables binary and fully observed', 'Truncated factorization holds; no unmodeled confounders'],
  };
}
