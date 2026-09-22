import { createHash } from 'node:crypto';
import { LIMITS, array, record, token, unique } from './model.mjs';
import { deepFreeze, verifyNormalized } from './verify.mjs';
import { normalizeModel } from './model.mjs';

/** Finite, explicitly defined imperative language. This does NOT parse JavaScript or infer a deployed system. */
const MAX_VARIABLES = 16;
const MAX_COMMANDS = 128;
const MAX_DOMAIN = 32;
const MAX_EXPRESSIONS = 4096;
const MAX_DEPTH = 64;
const VALUE_OPS = new Set(['CONST', 'VAR']);
const UNARY = new Set(['NOT', 'NEG']);
const BINARY = new Set(['EQ', 'NE', 'LT', 'LE', 'GT', 'GE', 'AND', 'OR', 'ADD', 'SUB']);
const INTEGER = 'number';

function ownObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function scalar(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'boolean' ||
      typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) return value;
  throw new TypeError(`${label} must be a safe integer, boolean, or identifier string`);
}
function scalarKey(value) { return JSON.stringify([typeof value, value]); }
function sameType(a, b) { return a === b || a === 'number' && b === 'number'; }
function expectType(actual, expected, label) {
  if (actual !== expected) throw new TypeError(`${label} requires ${expected}, got ${actual}`);
}
function sortedKeys(obj, label, max, min = 0) {
  ownObject(obj, label);
  const names = Object.keys(obj).sort();
  if (names.length < min || names.length > max) throw new TypeError(`${label} must have ${min}..${max} entries`);
  for (const name of names) token(name, `${label} key`);
  return names;
}
function normalizeExpression(expr, types, budget, depth = 0) {
  if (++budget.count > MAX_EXPRESSIONS || depth > MAX_DEPTH) throw new TypeError('program expression exceeds complexity limit');
  record(expr, 'expression', ['op', 'value', 'name', 'arg', 'left', 'right'], ['op']);
  const op = token(expr.op, 'expression operator');
  if (VALUE_OPS.has(op)) {
    if (op === 'CONST') {
      record(expr, op, ['op', 'value']);
      const value = scalar(expr.value, 'CONST.value');
      return Object.freeze({ type: typeof value, node: Object.freeze({ op, value }) });
    }
    record(expr, op, ['op', 'name']);
    const name = token(expr.name, 'VAR.name');
    if (!types.has(name)) throw new TypeError(`unknown variable ${name}`);
    return Object.freeze({ type: types.get(name), node: Object.freeze({ op, name }) });
  }
  if (UNARY.has(op)) {
    record(expr, op, ['op', 'arg']);
    const arg = normalizeExpression(expr.arg, types, budget, depth + 1);
    expectType(arg.type, op === 'NOT' ? 'boolean' : INTEGER, op);
    return Object.freeze({ type: op === 'NOT' ? 'boolean' : INTEGER, node: Object.freeze({ op, arg: arg.node }) });
  }
  if (!BINARY.has(op)) throw new TypeError(`unsupported expression operator ${op}`);
  record(expr, op, ['op', 'left', 'right']);
  const left = normalizeExpression(expr.left, types, budget, depth + 1);
  const right = normalizeExpression(expr.right, types, budget, depth + 1);
  if (!sameType(left.type, right.type)) throw new TypeError(`${op} operands must have the same type`);
  if (['LT', 'LE', 'GT', 'GE', 'ADD', 'SUB'].includes(op)) expectType(left.type, INTEGER, op);
  if (['AND', 'OR'].includes(op)) expectType(left.type, 'boolean', op);
  const result = ['ADD', 'SUB'].includes(op) ? INTEGER : 'boolean';
  return Object.freeze({ type: result, node: Object.freeze({ op, left: left.node, right: right.node }) });
}
function checkedInteger(value, op) {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${op} produced an unsafe integer`);
  return value;
}
function evaluate(expr, valuation) {
  switch (expr.op) {
    case 'CONST': return expr.value;
    case 'VAR': return valuation[expr.name];
    case 'NOT': return !evaluate(expr.arg, valuation);
    case 'NEG': return checkedInteger(-evaluate(expr.arg, valuation), 'NEG');
    case 'AND': return evaluate(expr.left, valuation) && evaluate(expr.right, valuation);
    case 'OR': return evaluate(expr.left, valuation) || evaluate(expr.right, valuation);
    default: {
      const a = evaluate(expr.left, valuation);
      const b = evaluate(expr.right, valuation);
      switch (expr.op) {
        case 'EQ': return a === b;
        case 'NE': return a !== b;
        case 'LT': return a < b;
        case 'LE': return a <= b;
        case 'GT': return a > b;
        case 'GE': return a >= b;
        case 'ADD': return checkedInteger(a + b, 'ADD');
        case 'SUB': return checkedInteger(a - b, 'SUB');
        default: throw new Error(`internal error: unhandled expression ${expr.op}`);
      }
    }
  }
}
function normalizeProgram(raw) {
  record(raw, 'program', ['variables', 'commands', 'predicates']);
  const variableNames = sortedKeys(raw.variables, 'variables', MAX_VARIABLES, 1);
  const types = new Map();
  const variables = Object.create(null);
  for (const name of variableNames) {
    const rawVariable = raw.variables[name];
    record(rawVariable, `variables.${name}`, ['domain', 'initial']);
    const domain = array(rawVariable.domain, `variables.${name}.domain`, 1, MAX_DOMAIN)
      .map(value => scalar(value, `variables.${name}.domain value`));
    unique(domain.map(scalarKey), `variables.${name}.domain`);
    const kind = typeof domain[0];
    if (!domain.every(value => typeof value === kind)) throw new TypeError(`mixed domain types for ${name}`);
    const initial = scalar(rawVariable.initial, `variables.${name}.initial`);
    if (!domain.some(value => value === initial)) throw new TypeError(`initial value outside domain for ${name}`);
    types.set(name, kind);
    variables[name] = Object.freeze({ domain: Object.freeze(domain), initial });
  }
  const budget = { count: 0 };
  const commands = array(raw.commands, 'commands', 0, MAX_COMMANDS).map((command, i) => {
    record(command, `commands[${i}]`, ['id', 'guard', 'updates']);
    const id = token(command.id, `commands[${i}].id`);
    const guard = normalizeExpression(command.guard, types, budget);
    expectType(guard.type, 'boolean', `${id}.guard`);
    const updateNames = sortedKeys(command.updates, `${id}.updates`, MAX_VARIABLES);
    const updates = Object.create(null);
    for (const name of updateNames) {
      if (!types.has(name)) throw new TypeError(`${id} updates unknown variable ${name}`);
      const rhs = normalizeExpression(command.updates[name], types, budget);
      expectType(rhs.type, types.get(name), `${id}.updates.${name}`);
      updates[name] = rhs.node;
    }
    return Object.freeze({ id, guard: guard.node, updates: Object.freeze(updates) });
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  unique(commands.map(command => command.id), 'command ids');
  const predicateNames = sortedKeys(raw.predicates, 'predicates', 256, 1);
  const predicates = Object.create(null);
  for (const name of predicateNames) {
    const expr = normalizeExpression(raw.predicates[name], types, budget);
    expectType(expr.type, 'boolean', `predicates.${name}`);
    predicates[name] = expr.node;
  }
  return Object.freeze({ variableNames: Object.freeze(variableNames), variables: Object.freeze(variables),
    commands: Object.freeze(commands), predicateNames: Object.freeze(predicateNames), predicates: Object.freeze(predicates) });
}

function snapshot(program) {
  return {
    variables: Object.fromEntries(program.variableNames.map(name => [name, program.variables[name]])),
    commands: program.commands,
    predicates: Object.fromEntries(program.predicateNames.map(name => [name, program.predicates[name]])),
  };
}
function canonicalValuation(names, valuation) {
  return Object.freeze(Object.fromEntries(names.map(name => [name, valuation[name]])));
}
function hash(snapshotValue) { return createHash('sha256').update(JSON.stringify(snapshotValue)).digest('hex'); }

/** Enumerates EVERY reachable valuation or throws. No approximate or partial PASS is possible. */
export function compileFiniteProgram(raw) {
  const program = normalizeProgram(raw);
  const variables = program.variableNames;
  const initial = canonicalValuation(variables, Object.fromEntries(variables.map(name => [name, program.variables[name].initial])));
  const key = valuation => JSON.stringify(variables.map(name => valuation[name]));
  const ids = new Map([[key(initial), 'P000000']]);
  const valuations = [initial];
  const transitions = [];
  const relation = [];
  const relationSet = new Set();
  for (let cursor = 0; cursor < valuations.length; cursor++) {
    const from = `P${String(cursor).padStart(6, '0')}`;
    const current = valuations[cursor];
    for (const command of program.commands) {
      if (!evaluate(command.guard, current)) continue;
      const updated = Object.create(null);
      for (const name of variables) {
        const newValue = Object.hasOwn(command.updates, name) ? evaluate(command.updates[name], current) : current[name];
        if (!program.variables[name].domain.some(value => value === newValue)) {
          throw new RangeError(`command ${command.id} leaves declared domain of ${name} from ${from}`);
        }
        updated[name] = newValue;
      }
      const next = canonicalValuation(variables, updated);
      const nextKey = key(next);
      let to = ids.get(nextKey);
      if (to === undefined) {
        if (valuations.length === LIMITS.states) throw new RangeError(`reachable state limit ${LIMITS.states} exceeded; verification incomplete`);
        to = `P${String(valuations.length).padStart(6, '0')}`;
        ids.set(nextKey, to);
        valuations.push(next);
      }
      if (relation.length === LIMITS.transitions) throw new RangeError(`reachable transition limit ${LIMITS.transitions} exceeded; verification incomplete`);
      relation.push(Object.freeze({ from, action: command.id, to }));
      const edgeKey = JSON.stringify([from, to]);
      if (!relationSet.has(edgeKey)) {
        transitions.push({ from, to });
        relationSet.add(edgeKey);
      }
    }
  }
  const states = valuations.map((_, i) => `P${String(i).padStart(6, '0')}`);
  const propositions = Object.fromEntries(states.map((state, i) => [state,
    program.predicateNames.filter(name => evaluate(program.predicates[name], valuations[i]))]));
  const model = normalizeModel({ states, initialStates: [states[0]], transitions,
    atomicPropositions: [...program.predicateNames], propositions });
  const programSnapshot = deepFreeze(snapshot(program));
  return Object.freeze({ model, programSha256: hash(programSnapshot), program: programSnapshot,
    valuations: Object.freeze(Object.fromEntries(states.map((state, i) => [state, valuations[i]]))),
    actionTransitions: Object.freeze(relation) });
}

function explainDiagnostic(diagnostic, compiled) {
  if (!diagnostic || !Array.isArray(diagnostic.path) && !Array.isArray(diagnostic.prefix)) return diagnostic;
  const edges = (path) => path.slice(1).map((to, i) => {
    const from = path[i];
    const actions = compiled.actionTransitions.filter(edge => edge.from === from && edge.to === to).map(edge => edge.action);
    if (!actions.length && from !== to) throw new Error('internal error: invalid path in model');
    const deadlockStutter = !actions.length && from === to;
    return { from, to, actions, deadlockStutter };
  });
  if (diagnostic.path) return { ...diagnostic, valuations: diagnostic.path.map(state => compiled.valuations[state]), steps: edges(diagnostic.path) };
  return { ...diagnostic, prefixValuations: diagnostic.prefix.map(state => compiled.valuations[state]),
    cycleValuations: diagnostic.cycle.map(state => compiled.valuations[state]),
    prefixSteps: edges(diagnostic.prefix), cycleSteps: edges(diagnostic.cycle) };
}

/** Program source is an auditable JSON finite-state DSL, NOT arbitrary JavaScript/TypeScript. */
export function verifyFiniteProgram(spec) {
  record(spec, 'program verification', ['program', 'properties']);
  const compiled = compileFiniteProgram(spec.program);
  const verification = verifyNormalized(compiled.model, spec.properties);
  const results = verification.results.map(property => ({ ...property,
    initialResults: property.initialResults.map(result => ({ ...result, diagnostic: explainDiagnostic(result.diagnostic, compiled) })),
  }));
  return deepFreeze({ ...verification, engine: 'NEMESIS_FINITE_PROGRAM_CTL_V2',
    scope: 'EXHAUSTIVE_REACHABLE_STATES_OF_SUPPLIED_FINITE_PROGRAM_DSL', programSha256: compiled.programSha256,
    program: compiled.program, valuations: compiled.valuations, actionTransitions: compiled.actionTransitions,
    reachableStateCount: compiled.model.states.length, reachableTransitionCount: compiled.actionTransitions.length,
    results, note: 'Every reachable DSL valuation enumerated; no claims about arbitrary JavaScript, external state, or deployments.' });
}
