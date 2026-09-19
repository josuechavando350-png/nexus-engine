import { assertArray, assertExactKeys, assertToken } from '../core/common.mjs';
import { add, asString, complement, div, mul, probability, sub, ZERO, ONE } from './rational.mjs';

/** Exact truncated factorization for a fully specified binary causal Bayesian network. */
export function evaluateBinaryIntervention(input) {
  assertExactKeys(input, ['nodes', 'treatment', 'outcome'], 'causal model');
  const nodes = assertArray(input.nodes, 'nodes', { min: 2, max: 8 });
  const known = new Set();
  const compiled = nodes.map((node, i) => {
    assertExactKeys(node, ['id', 'parents', 'table'], `nodes[${i}]`);
    const id = assertToken(node.id, `nodes[${i}].id`);
    if (known.has(id)) throw new TypeError(`duplicate node ${id}`);
    const parents = assertArray(node.parents, `${id}.parents`, { max: 5 });
    if (new Set(parents).size !== parents.length) throw new TypeError('duplicate parent');
    for (const p of parents) if (typeof p !== 'string' || !known.has(p)) throw new TypeError(`parent ${p} must precede ${id} (acyclic topological order)`);
    const rows = assertArray(node.table, `${id}.table`, { min: 1, max: 32 });
    if (rows.length !== 2 ** parents.length) throw new TypeError(`${id} requires a complete conditional probability table`);
    const table = new Map();
    for (const [j, row] of rows.entries()) {
      assertExactKeys(row, ['when', 'probabilityTrue'], `${id}.table[${j}]`);
      assertExactKeys(row.when, parents, `${id}.table[${j}].when`);
      const bits = parents.map((p) => {
        if (row.when[p] !== 0 && row.when[p] !== 1) throw new TypeError('parents must be binary');
        return row.when[p];
      }).join('');
      if (table.has(bits)) throw new TypeError(`${id} duplicate conditional probability row`);
      table.set(bits, probability(row.probabilityTrue, `${id}.table[${j}].probabilityTrue`));
    }
    known.add(id);
    return { id, parents, table };
  });
  if (typeof input.treatment !== 'string' || typeof input.outcome !== 'string'
    || !known.has(input.treatment) || !known.has(input.outcome) || input.treatment === input.outcome) {
    throw new TypeError('treatment and outcome must be distinct model nodes');
  }
  const outcomes = [];
  // Maximum 2^8 = 256 assignments; exact BigInt fractions at every step.
  for (let mask = 0; mask < 2 ** compiled.length; mask++) {
    const assignment = Object.fromEntries(compiled.map((node, i) => [node.id, (mask >> i) & 1]));
    const outcome = assignment[input.outcome];
    const treatment = assignment[input.treatment];
    function likelihood(intervened) {
      let p = ONE;
      for (const node of compiled) {
        if (node.id === input.treatment && intervened !== null) {
          if (treatment !== intervened) return ZERO;
          continue;
        }
        const key = node.parents.map((parent) => assignment[parent]).join('');
        const trueP = node.table.get(key);
        p = mul(p, assignment[node.id] ? trueP : complement(trueP));
      }
      return p;
    }
    outcomes.push({ outcome, treatment, observed: likelihood(null), do0: likelihood(0), do1: likelihood(1) });
  }
  function sum(filter, key) {
    return outcomes.reduce((result, row) => filter(row) ? add(result, row[key]) : result, ZERO);
  }
  function riskAt(observation) {
    const base = sum((r) => r.treatment === observation, 'observed');
    return base.n === 0n ? null : asString(div(sum((r) => r.treatment === observation && r.outcome === 1, 'observed'), base));
  }
  const zeroMass = sum(() => true, 'observed');
  if (zeroMass.n !== zeroMass.d) throw new Error('causal model is not normalized');
  const do0 = sum((r) => r.outcome === 1, 'do0');
  const do1 = sum((r) => r.outcome === 1, 'do1');
  return {
    arithmetic: 'EXACT_RATIONAL',
    evaluatedAssignments: outcomes.length,
    observationalRisk: { treatment0: riskAt(0), treatment1: riskAt(1) },
    interventionalRisk: { do0: asString(do0), do1: asString(do1) },
    averageCausalEffect: asString(sub(do1, do0)),
    assumptions: ['Supplied directed acyclic graph is correct', 'Binary variables and complete conditional probability tables', 'Independent structural noise conditional on declared parents', 'Intervention replaces the treatment mechanism'],
    note: 'Effect is exact within the user-supplied model, not empirically identified from observational data alone.',
  };
}
