import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVerifiedAgent, verifyFiniteSystem } from '../src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = name => JSON.parse(readFileSync(resolve(root, 'examples', name), 'utf8'));
const atom = name => ({ op: 'ATOM', name });
const unary = (op, arg) => ({ op, arg });
const binary = (op, left, right) => ({ op, left, right });
const verify = (model, formula, required = true) => verifyFiniteSystem({ model, properties: [{ id: 'property', required, formula }] });
function graph(states, initialStates, transitions, labels = {}) {
  return { states, initialStates, transitions: transitions.map(([from, to]) => ({ from, to })),
    atomicPropositions: ['p', 'q'], propositions: Object.fromEntries(states.map(s => [s, labels[s] ?? []])) };
}

test('unsafe state is reported with a shortest, genuine AG counterexample', () => {
  const output = verifyFiniteSystem(fixture('safe-workflow.json'));
  assert.equal(output.status, 'FAIL');
  assert.deepEqual(output.failedRequired, ['safety']);
  assert.deepEqual(output.results[0].initialResults[0].diagnostic, {
    kind: 'SAFETY_COUNTEREXAMPLE', path: ['START', 'REVIEW', 'ERROR'],
  });
  assert.equal(output.results[1].holds, true);
  assert.deepEqual(output.results[1].initialResults[0].diagnostic.path, ['START', 'REVIEW', 'DONE']);
  assert.equal(output.model.deadlocks.length, 2);
});

test('unreachable unsafe nodes do not falsify a property of the selected initial state', () => {
  const model = graph(['S', 'GOOD', 'BAD'], ['S'], [['S', 'GOOD']], { S: ['p'], GOOD: ['p'] });
  assert.equal(verify(model, unary('AG', atom('p'))).status, 'PASS');
  assert.equal(verify(model, unary('EF', atom('q'))).status, 'FAIL');
});

test('deadlocks stutter: next, eventual and infinite-path operators are total', () => {
  const model = graph(['S'], ['S'], []);
  for (const op of ['EX', 'AX', 'EF', 'AF', 'EG', 'AG']) {
    assert.equal(verify(model, unary(op, { op: 'TRUE' })).status, 'PASS', op);
    assert.equal(verify(model, unary(op, atom('p'))).status, 'FAIL', op);
  }
  assert.deepEqual(verify(model, unary('AF', atom('p'))).results[0].initialResults[0].diagnostic,
    { kind: 'LIVENESS_COUNTEREXAMPLE', prefix: ['S'], cycle: ['S', 'S'] });
  assert.deepEqual(verify(model, unary('EG', { op: 'TRUE' })).results[0].initialResults[0].diagnostic,
    { kind: 'INFINITE_PATH_WITNESS', prefix: ['S'], cycle: ['S', 'S'] });
});

test('EU/AU distinguish one favorable route from all routes and enforce left condition', () => {
  const model = graph(['S', 'G', 'B'], ['S'], [['S', 'G'], ['S', 'B']], { S: ['p'], G: ['q'] });
  assert.equal(verify(model, binary('EU', atom('p'), atom('q'))).status, 'PASS');
  assert.equal(verify(model, binary('AU', atom('p'), atom('q'))).status, 'FAIL');
  const onlyGood = graph(['S', 'G'], ['S'], [['S', 'G']], { S: ['p'], G: ['q'] });
  assert.equal(verify(onlyGood, binary('AU', atom('p'), atom('q'))).status, 'PASS');
  assert.equal(verify(onlyGood, binary('EU', atom('p'), atom('q'))).status, 'PASS');
  assert.deepEqual(verify(onlyGood, binary('EU', atom('p'), atom('q'))).results[0].initialResults[0].diagnostic.path, ['S', 'G']);
  const premature = graph(['S', 'G'], ['S'], [['S', 'G']], { G: ['q'] });
  assert.equal(verify(premature, binary('EU', atom('p'), atom('q'))).status, 'FAIL');
  assert.equal(verify(premature, binary('AU', atom('p'), atom('q'))).status, 'FAIL');
});

test('AF is not EF: an infinite cycle can avoid the goal', () => {
  const model = graph(['S', 'G'], ['S'], [['S', 'G'], ['S', 'S']], { G: ['q'] });
  assert.equal(verify(model, unary('EF', atom('q'))).status, 'PASS');
  const never = verify(model, unary('AF', atom('q')));
  assert.equal(never.status, 'FAIL');
  assert.deepEqual(never.results[0].initialResults[0].diagnostic, {
    kind: 'LIVENESS_COUNTEREXAMPLE', prefix: ['S'], cycle: ['S', 'S'],
  });
});

test('all initial states must satisfy all required formulas; optional failures are visible', () => {
  const model = graph(['S', 'T'], ['S', 'T'], [], { S: ['p'] });
  const output = verifyFiniteSystem({ model, properties: [
    { id: 'required', required: true, formula: atom('p') },
    { id: 'optional', required: false, formula: atom('q') },
  ] });
  assert.equal(output.status, 'FAIL');
  assert.deepEqual(output.failedRequired, ['required']);
  assert.deepEqual(output.results[0].initialResults.map(x => x.satisfied), [true, false]);
  const optional = verifyFiniteSystem({ model, properties: [
    { id: 'required', required: true, formula: { op: 'TRUE' } },
    { id: 'optional', required: false, formula: atom('q') },
  ] });
  assert.equal(optional.status, 'PASS');
  assert.equal(optional.results[1].holds, false);
});

test('Boolean expressions and nested temporal expressions are evaluated compositionally', () => {
  const model = graph(['S', 'G'], ['S'], [['S', 'G']], { S: ['p'], G: ['q'] });
  assert.equal(verify(model, binary('AND', atom('p'), unary('EX', atom('q')))).status, 'PASS');
  assert.equal(verify(model, binary('IMPLIES', atom('p'), unary('AF', atom('q')))).status, 'PASS');
  assert.equal(verify(model, unary('AG', unary('AF', binary('OR', atom('p'), atom('q'))))).status, 'PASS');
  assert.equal(verify(model, unary('NOT', binary('OR', atom('p'), atom('q')))).status, 'FAIL');
});

test('invalid or ambiguous models and formulas fail closed', () => {
  const valid = fixture('safe-workflow.json');
  const invalid = mutate => { const copy = structuredClone(valid); mutate(copy); assert.throws(() => verifyFiniteSystem(copy), TypeError); };
  invalid(x => { x.model.states.push('START'); });
  invalid(x => { x.model.transitions.push({ from: 'START', to: 'REVIEW' }); });
  invalid(x => { x.model.transitions.push({ from: 'NOT_HERE', to: 'DONE' }); });
  invalid(x => { x.model.propositions.START = ['undeclared']; });
  invalid(x => { delete x.model.propositions.START; });
  invalid(x => { x.model.initialStates = []; });
  invalid(x => { x.properties[0].formula = { op: 'EVAL', code: 'process.exit(0)' }; });
  invalid(x => { x.properties[0].formula = { op: 'ATOM', name: 'typo' }; });
  invalid(x => { x.properties[0].formula = { op: 'TRUE', extra: 1 }; });
  invalid(x => { x.properties[0].required = 'false'; });
  invalid(x => { x.properties.forEach(p => { p.required = false; }); });
  invalid(x => { x.model.states[0] = '__proto__'; });
  invalid(x => { x.properties[1].id = 'safety'; });
  invalid(x => { x.properties[0].formula = { op: 'NOT', arg: null }; });
});

test('normalized models have a reproducible fingerprint regardless of input ordering', () => {
  const original = fixture('safe-workflow.json');
  const shuffled = structuredClone(original);
  shuffled.model.states.reverse();
  shuffled.model.initialStates.reverse();
  shuffled.model.transitions.reverse();
  shuffled.model.atomicPropositions.reverse();
  Object.values(shuffled.model.propositions).forEach(x => x.reverse());
  assert.equal(verifyFiniteSystem(original).modelSha256, verifyFiniteSystem(shuffled).modelSha256);
});

test('executable agent verifies its actual immutable action table before acting', () => {
  const spec = fixture('verified-agent.json');
  const agent = createVerifiedAgent(spec);
  assert.equal(agent.verification.status, 'PASS');
  assert.deepEqual(agent.availableActions(), ['submit']);
  assert.throws(() => agent.execute('approve'), RangeError);
  assert.equal(agent.state(), 'START');
  assert.equal(agent.execute('submit').to, 'REVIEW');
  assert.equal(agent.execute('approve').to, 'DONE');
  assert.deepEqual(agent.availableActions(), []);
  assert.throws(() => agent.execute('revise'), RangeError);
  assert.throws(() => { agent.verification.status = 'PASS_BUT_MUTATED'; }, TypeError); // wrapper is frozen
});

test('an unsafe action table never yields a runnable agent; ambiguous actions reject', () => {
  const unsafe = fixture('verified-agent.json');
  unsafe.model.states.push('BAD');
  unsafe.model.propositions.BAD = [];
  unsafe.model.transitions.push({ from: 'START', to: 'BAD', action: 'skip' });
  assert.throws(() => createVerifiedAgent(unsafe), /verification failed/);
  const ambiguous = fixture('verified-agent.json');
  ambiguous.model.transitions.push({ from: 'START', to: 'DONE', action: 'submit' });
  assert.throws(() => createVerifiedAgent(ambiguous), /duplicate state\/action/);
});

test('CLI returns 0 for pass, 1 for proven failure, 2 for invalid input and denied action', () => {
  const cmd = (...args) => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(cmd('verify', resolve(root, 'examples/safe-workflow.json')).status, 1);
  assert.equal(cmd('agent', resolve(root, 'examples/verified-agent.json'), 'submit', 'approve').status, 0);
  assert.equal(cmd('agent', resolve(root, 'examples/verified-agent.json'), 'approve').status, 2);
  assert.equal(cmd('verify', resolve(root, 'examples/verified-agent.json')).status, 2); // action labels rejected in plain verification
  assert.equal(cmd('verify', 'missing.json').status, 2);
});

/** Independent finite-path oracle: a repeated state creates an infinite lasso. */
function oracle(model, op, p, q, initial) {
  const out = Object.fromEntries(model.states.map(s => [s, []]));
  for (const { from, to } of model.transitions) out[from].push(to);
  for (const s of model.states) if (!out[s].length) out[s].push(s);
  const has = (s, label) => model.propositions[s].includes(label);
  function pathExists(start, allowed, target) {
    const stack = [[start]];
    while (stack.length) {
      const path = stack.pop(); const s = path.at(-1);
      if (target(s)) return true;
      for (const next of out[s]) if (allowed(s) && !path.includes(next)) stack.push([...path, next]);
    }
    return false;
  }
  function forever(start, allowed) {
    const stack = [[start]];
    while (stack.length) {
      const path = stack.pop(); const s = path.at(-1);
      if (!allowed(s)) continue;
      for (const next of out[s]) {
        if (!allowed(next)) continue;
        if (path.includes(next)) return true;
        stack.push([...path, next]);
      }
    }
    return false;
  }
  switch (op) {
    case 'EX': return out[initial].some(s => has(s, p));
    case 'AX': return out[initial].every(s => has(s, p));
    case 'EF': return pathExists(initial, () => true, s => has(s, p));
    case 'AF': return !forever(initial, s => !has(s, p));
    case 'EG': return forever(initial, s => has(s, p));
    case 'AG': return !pathExists(initial, () => true, s => !has(s, p));
    case 'EU': return pathExists(initial, s => has(s, p), s => has(s, q));
    case 'AU': return !pathExists(initial, s => !has(s, q), s => !has(s, p) && !has(s, q)) &&
      !forever(initial, s => has(s, p) && !has(s, q));
    default: throw Error(op);
  }
}

test('all eight CTL temporal operators agree with an independent path/cycle oracle on 256 small models', () => {
  let cases = 0;
  for (let edges = 0; edges < 16; edges++) for (let labels = 0; labels < 16; labels++) {
    const states = ['A', 'B'];
    const transitions = [['A', 'A'], ['A', 'B'], ['B', 'A'], ['B', 'B']]
      .filter((_, index) => edges & (1 << index));
    const model = graph(states, states, transitions, {
      A: ['p', 'q'].filter((_, i) => labels & (1 << i)),
      B: ['p', 'q'].filter((_, i) => labels & (1 << (i + 2))),
    });
    const formulas = ['EX', 'AX', 'EF', 'AF', 'EG', 'AG', 'EU', 'AU'].map(op => ({
      op, formula: op.endsWith('U') ? binary(op, atom('p'), atom('q')) : unary(op, atom('p')),
    }));
    const result = verifyFiniteSystem({ model, properties: formulas.map(({ op, formula }) => ({ id: op, required: true, formula })) });
    for (const property of result.results) for (const initial of property.initialResults) {
      assert.equal(initial.satisfied, oracle(model, property.id, 'p', 'q', initial.state),
        `model edges=${edges}, labels=${labels}, op=${property.id}, initial=${initial.state}`);
      cases++;
    }
  }
  assert.equal(cases, 4096);
});

test('temporal operators agree with path oracle on 128 deterministic three-state models', () => {
  let cases = 0;
  let seed = 0x5eed1234;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let iteration = 0; iteration < 128; iteration++) {
    const states = ['A', 'B', 'C'];
    const transitions = states.flatMap(from => states.filter(() => (random() & 1) === 1).map(to => [from, to]));
    const labels = Object.fromEntries(states.map(state => [state, ['p', 'q'].filter(() => (random() & 1) === 1)]));
    const model = graph(states, states, transitions, labels);
    const properties = ['EX', 'AX', 'EF', 'AF', 'EG', 'AG', 'EU', 'AU'].map(op => ({
      id: op, required: true, formula: op.endsWith('U') ? binary(op, atom('p'), atom('q')) : unary(op, atom('p')),
    }));
    const result = verifyFiniteSystem({ model, properties });
    for (const property of result.results) for (const initial of property.initialResults) {
      assert.equal(initial.satisfied, oracle(model, property.id, 'p', 'q', initial.state),
        `case ${iteration}, ${property.id}, ${initial.state}`);
      cases++;
    }
  }
  assert.equal(cases, 3072);
});

test('a 512-state chain reaches a goal with a 512-state shortest path, without truncation', () => {
  const states = Array.from({ length: 512 }, (_, i) => `S${String(i).padStart(3, '0')}`);
  const model = graph(states, [states[0]], states.slice(0, -1).map((s, i) => [s, states[i + 1]]), { [states.at(-1)]: ['p'] });
  const output = verify(model, unary('EF', atom('p')));
  assert.equal(output.status, 'PASS');
  assert.equal(output.results[0].initialResults[0].diagnostic.path.length, 512);
  assert.equal(output.results[0].initialResults[0].diagnostic.path.at(-1), 'S511');
  assert.equal(output.results[0].subformulaEvidence.at(-1).satisfyingStateIndices.length, 512);
});
