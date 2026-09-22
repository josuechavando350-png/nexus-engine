import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFiniteProgram, verifyFiniteProgram, createVerifiedProgramAgent } from '../src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => JSON.parse(readFileSync(resolve(root, 'examples', name), 'utf8'));
const atom = name => ({ op: 'ATOM', name });
const unary = (op, arg) => ({ op, arg });
const val = name => ({ op: 'VAR', name });
const constant = value => ({ op: 'CONST', value });
const cmp = (op, a, b) => ({ op, left: a, right: b });
const property = (formula, id = 'claim') => ({ id, required: true, formula });
const simple = (domain = [0, 1], initial = 0) => ({ variables: { x: { domain, initial } },
  commands: [{ id: 'tick', guard: cmp('LT', val('x'), constant(domain.at(-1))), updates: { x: cmp('ADD', val('x'), constant(1)) } }],
  predicates: { done: cmp('EQ', val('x'), constant(domain.at(-1))), safe: cmp('GE', val('x'), constant(0)) } });
const run = (program, formula) => verifyFiniteProgram({ program, properties: [property(formula)] });

test('compiles reachable program and verifies AG safety and AF progress exhaustively', () => {
  const output = verifyFiniteProgram(load('finite-program-safe.json'));
  assert.equal(output.status, 'PASS');
  assert.equal(output.reachableStateCount, 3);
  assert.equal(output.reachableTransitionCount, 2);
  assert.deepEqual(output.actionTransitions.map(({ action }) => action), ['submit', 'approve']);
  assert.equal(output.valuations.P000002.phase, 'DONE');
  assert.equal(output.valuations.P000002.balance, 1);
  assert.equal(output.results[1].holds, true);
  assert.equal(output.modelSha256.length, 64);
  assert.equal(output.programSha256.length, 64);
  assert.throws(() => { output.program.variables.bad = {}; }, TypeError);
  assert.throws(() => { output.valuations.P000000.phase = 'ERROR'; }, TypeError);
});

test('unsafe executable transition gives a replayable counterexample with concrete values and action', () => {
  const output = verifyFiniteProgram(load('finite-program-unsafe.json'));
  assert.equal(output.status, 'FAIL');
  assert.deepEqual(output.failedRequired, ['safety']);
  const diagnostic = output.results[0].initialResults[0].diagnostic;
  assert.equal(diagnostic.kind, 'SAFETY_COUNTEREXAMPLE');
  assert.deepEqual(diagnostic.steps.map(step => step.actions), [['bypass']]);
  assert.equal(diagnostic.valuations[1].phase, 'ERROR');
  assert.deepEqual(diagnostic.path, ['P000000', 'P000002']);
});

test('multiple command labels can share one edge without losing nondeterministic semantics', () => {
  const program = simple();
  program.commands.push({ ...structuredClone(program.commands[0]), id: 'alsoTick' });
  const result = run(program, unary('EF', atom('done')));
  assert.equal(result.status, 'PASS');
  assert.equal(result.reachableTransitionCount, 2);
  assert.equal(result.model.transitions.length, 1);
  assert.deepEqual(result.results[0].initialResults[0].diagnostic.steps[0].actions, ['alsoTick', 'tick']);
});

test('parallel assignments use the old valuation, never update in place', () => {
  const program = {
    variables: { x: { domain: [0, 1], initial: 0 }, y: { domain: [0, 1], initial: 1 } },
    commands: [{ id: 'swap', guard: cmp('EQ', val('x'), constant(0)), updates: { x: val('y'), y: val('x') } }],
    predicates: { swapped: { op: 'AND', left: cmp('EQ', val('x'), constant(1)), right: cmp('EQ', val('y'), constant(0)) } },
  };
  const output = run(program, unary('AF', atom('swapped')));
  assert.equal(output.status, 'PASS');
  assert.deepEqual(Object.values(output.valuations), [{ x: 0, y: 1 }, { x: 1, y: 0 }]);
});

test('AF liveness violation includes a valid cycle, including stuttering deadlocks', () => {
  const program = simple();
  program.commands = [];
  const output = run(program, unary('AF', atom('done')));
  assert.equal(output.status, 'FAIL');
  const diagnostic = output.results[0].initialResults[0].diagnostic;
  assert.deepEqual(diagnostic.cycle, ['P000000', 'P000000']);
  assert.equal(diagnostic.cycleSteps[0].deadlockStutter, true);
  assert.deepEqual(diagnostic.cycleValuations, [{ x: 0 }, { x: 0 }]);
});

test('EG witness carries real cyclic transitions with source valuations', () => {
  const program = simple();
  program.commands = [{ id: 'idle', guard: constant(true), updates: {} }];
  const output = run(program, unary('EG', atom('safe')));
  assert.equal(output.status, 'PASS');
  const diagnostic = output.results[0].initialResults[0].diagnostic;
  assert.deepEqual(diagnostic.cycleSteps.map(x => x.actions), [['idle']]);
  assert.equal(diagnostic.cycleSteps[0].deadlockStutter, false);
});

test('normalization yields deterministic fingerprint under source key and command reorder', () => {
  const input = load('finite-program-safe.json');
  const reorder = structuredClone(input);
  reorder.program.variables = Object.fromEntries(Object.entries(reorder.program.variables).reverse());
  reorder.program.predicates = Object.fromEntries(Object.entries(reorder.program.predicates).reverse());
  reorder.program.commands.reverse();
  assert.equal(verifyFiniteProgram(input).programSha256, verifyFiniteProgram(reorder).programSha256);
  assert.equal(verifyFiniteProgram(input).modelSha256, verifyFiniteProgram(reorder).modelSha256);
});

test('strict input rejects invalid operators, references, missing keys, cross-types and code injection', () => {
  const invalid = mutation => { const program = simple(); mutation(program); assert.throws(() => compileFiniteProgram(program), TypeError); };
  invalid(p => { p.variables.x.domain = [0, true]; });
  invalid(p => { p.variables.x.domain = [0, 0]; });
  invalid(p => { p.variables.x.initial = 2; });
  invalid(p => { p.variables.y = { domain: [0], initial: 0 }; p.commands[0].guard = val('not_declared'); });
  invalid(p => { p.commands[0].guard = val('x'); });
  invalid(p => { p.commands[0].updates.x = constant(false); });
  invalid(p => { p.commands[0].updates.y = constant(1); });
  invalid(p => { p.predicates.done = cmp('LT', val('x'), constant('foo')); });
  invalid(p => { p.commands[0].guard = { op: 'JS', code: 'process.exit(0)' }; });
  invalid(p => { p.commands[0].guard = { op: 'CONST', value: true, evil: true }; });
  invalid(p => { p.commands.push({ ...structuredClone(p.commands[0]) }); });
  invalid(p => { p.predicates = {}; });
  invalid(p => { p.variables.x.domain = [Number.MAX_SAFE_INTEGER + 1]; });
  invalid(p => { p.commands[0].updates.x = { op: 'NOT', arg: constant(1) }; });
});

test('domain escape and integer overflow fail closed instead of returning PASS', () => {
  const program = simple();
  program.commands[0].guard = constant(true);
  assert.throws(() => compileFiniteProgram(program), /leaves declared domain/);
  const huge = simple([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER], Number.MAX_SAFE_INTEGER);
  huge.commands[0].guard = constant(true);
  assert.throws(() => compileFiniteProgram(huge), /unsafe integer/);
});

test('more than 512 reachable valuations rejects the entire proof and never truncates', () => {
  const program = simple(Array.from({ length: 32 }, (_, i) => i));
  program.variables.y = { domain: Array.from({ length: 32 }, (_, i) => i), initial: 0 };
  program.commands = [
    { id: 'incX', guard: cmp('LT', val('x'), constant(31)), updates: { x: cmp('ADD', val('x'), constant(1)) } },
    { id: 'incY', guard: cmp('LT', val('y'), constant(31)), updates: { y: cmp('ADD', val('y'), constant(1)) } },
  ];
  assert.throws(() => run(program, unary('AG', atom('safe'))), /reachable state limit 512 exceeded/);
});

test('512 reachable valuations verify without partial enumeration', () => {
  const program = simple(Array.from({ length: 32 }, (_, i) => i));
  program.variables.y = { domain: Array.from({ length: 16 }, (_, i) => i), initial: 0 };
  program.commands = [
    { id: 'incX', guard: cmp('LT', val('x'), constant(31)), updates: { x: cmp('ADD', val('x'), constant(1)) } },
    { id: 'incY', guard: cmp('LT', val('y'), constant(15)), updates: { y: cmp('ADD', val('y'), constant(1)) } },
  ];
  const result = run(program, unary('AG', atom('safe')));
  assert.equal(result.status, 'PASS');
  assert.equal(result.reachableStateCount, 512);
  assert.equal(result.reachableTransitionCount, 976);
});

test('program CLI uses exit 0/1/2 and rejects extra actions', () => {
  const cmd = (...args) => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(cmd('program', resolve(root, 'examples/finite-program-safe.json')).status, 0);
  assert.equal(cmd('program', resolve(root, 'examples/finite-program-unsafe.json')).status, 1);
  assert.equal(cmd('program', resolve(root, 'examples/finite-program-unsafe.json'), 'bypass').status, 2);
  assert.equal(cmd('program', 'nonexistent.json').status, 2);
});

/** Independent small-domain oracle, not sharing the compiler's transition enumerator. */
test('model checker verdict agrees with independent enumerated-valuation oracle on 256 programs', () => {
  let checked = 0;
  for (let mask = 0; mask < 256; mask++) {
    const program = simple([0, 1, 2]);
    // Eight independent edges; the third state is the goal and needs no outgoing commands.
    const candidateEdges = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1]];
    program.commands = candidateEdges.filter((_, i) => mask & (1 << i)).map(([from, to], i) => ({
      id: `go${i}`, guard: cmp('EQ', val('x'), constant(from)), updates: { x: constant(to) },
    }));
    const out = run(program, unary('AF', atom('done')));
    // Independent valuation-graph oracle: any reachable cycle entirely outside goal x=2 refutes AF(done).
    const edges = [0, 1, 2].map(from => {
      const destinations = candidateEdges.filter(([src], i) => src === from && mask & (1 << i)).map(([, to]) => to);
      return destinations.length ? destinations : [from];
    });
    const reachable = new Set([0]);
    for (const i of reachable) for (const next of edges[i]) reachable.add(next);
    const noDone = [...reachable].filter(i => i !== 2);
    const onStack = new Set(), finished = new Set();
    function cycle(i) {
      if (onStack.has(i)) return true;
      if (finished.has(i) || !noDone.includes(i)) return false;
      onStack.add(i);
      for (const next of edges[i]) if (cycle(next)) return true;
      onStack.delete(i); finished.add(i); return false;
    }
    assert.equal(out.status === 'PASS', !cycle(0), `mask=${mask}`);
    checked++;
  }
  assert.equal(checked, 256);
});


test('verified program agent executes precisely checked commands and yields immutable provenance receipts', () => {
  const agent = createVerifiedProgramAgent(load('finite-program-safe.json'));
  assert.deepEqual(agent.valuation(), { balance: 0, phase: 'READY' });
  assert.deepEqual(agent.availableActions(), ['submit']);
  assert.throws(() => agent.execute('approve'), /not permitted/);
  assert.deepEqual(agent.valuation(), { balance: 0, phase: 'READY' });
  const receipt = agent.execute('submit');
  assert.equal(receipt.before.phase, 'READY');
  assert.equal(receipt.after.phase, 'REVIEW');
  assert.equal(receipt.modelSha256, agent.verification.modelSha256);
  assert.equal(receipt.programSha256, agent.verification.programSha256);
  assert.equal(agent.execute('approve').after.phase, 'DONE');
  assert.deepEqual(agent.availableActions(), []);
  assert.throws(() => agent.execute('approve'), /not permitted/);
  assert.throws(() => { receipt.after.phase = 'CORRUPT'; }, TypeError);
});

test('an unsafe program cannot be executed by the verified program agent', () => {
  assert.throws(() => createVerifiedProgramAgent(load('finite-program-unsafe.json')), /program verification failed: safety/);
  const runCli = (...args) => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(runCli('program-agent', resolve(root, 'examples/finite-program-safe.json'), 'submit', 'approve').status, 0);
  assert.equal(runCli('program-agent', resolve(root, 'examples/finite-program-safe.json'), 'approve').status, 2);
  assert.equal(runCli('program-agent', resolve(root, 'examples/finite-program-unsafe.json'), 'bypass').status, 2);
});
