import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { betaBernoulliBatch, betaBernoulliUpdates } from '../advanced/bayes-stream.mjs';
import { persistentHomologyZero } from '../advanced/persistent-h0.mjs';
import { solveFinitePomdp } from '../advanced/pomdp.mjs';
import { executeGaussAdvancedProblem, GAUSS_ADVANCED_OPERATORS } from '../advanced/index.mjs';
import { sha256Canonical } from '../core/common.mjs';
import { gaussRegistrySummary } from '../core/registry.mjs';

const pomdp = {
  states: ['healthy','ill'], actions: ['guessHealthy','guessIll'], observations: ['seenHealthy','seenIll'],
  belief: ['1/2','1/2'], transition: [
    [['1/1','0/1'],['0/1','1/1']], [['1/1','0/1'],['0/1','1/1']],
  ], observationModel: [
    [['1/1','0/1'],['0/1','1/1']], [['1/1','0/1'],['0/1','1/1']],
  ], reward: [[1,0],[0,1]], horizon: 2, discount: '1/1',
};
const graph = { vertices: [{id:'A',birth:0},{id:'B',birth:1},{id:'C',birth:2}],
  edges: [{u:'A',v:'B',time:2},{u:'B',v:'C',time:3},{u:'A',v:'C',time:4}], queryTimes: [-1,0,1,2,3,4] };

test('Beta-Bernoulli computes all exact online posterior updates', () => {
  const result = betaBernoulliBatch({ priorAlpha:1, priorBeta:1, observations:[1,0,1] });
  assert.equal(result.predictiveTrue, '3/5');
  assert.deepEqual(result.history.map(x => x.predictiveTrue), ['2/3','1/2','3/5']);
  assert.equal(result.alpha, 3);
  assert.equal(result.beta, 2);
  assert.equal(result.observations, 3);
});

test('asynchronous Bayesian ingestion consumes real AsyncIterable and emits intermediate posteriors', async () => {
  async function* source() { yield 1; await Promise.resolve(); yield 0; yield 1; }
  const out = [];
  for await (const receipt of betaBernoulliUpdates({priorAlpha:1,priorBeta:1}, source())) out.push(receipt.predictiveTrue);
  assert.deepEqual(out, ['2/3','1/2','3/5']);
  await assert.rejects(async () => {
    for await (const _ of betaBernoulliUpdates({priorAlpha:1,priorBeta:1}, source(), {maxObservations:2})) { /* consume */ }
  }, /budget exceeded/);
});

test('Bayesian stream refuses fabricated / unbounded evidence and invalid hyperparameters', () => {
  assert.throws(() => betaBernoulliBatch({ priorAlpha:0, priorBeta:1, observations:[] }), /priorAlpha/);
  assert.throws(() => betaBernoulliBatch({ priorAlpha:1, priorBeta:1, observations:[1,2] }), /0 or 1/);
  assert.throws(() => betaBernoulliBatch({ priorAlpha:1, priorBeta:1, observations:[1.1] }), /0 or 1/);
});

test('0-dimensional persistence computes merge deaths, essential bars and Betti numbers', () => {
  const output = persistentHomologyZero(graph);
  assert.equal(output.dimension, 0);
  assert.equal(output.essentialComponentCount, 1);
  assert.deepEqual(output.bars, [
    {component:'A',birth:0,death:null,lifetime:null},
    {component:'B',birth:1,death:2,lifetime:1},
    {component:'C',birth:2,death:3,lifetime:1},
  ]);
  assert.deepEqual(output.bettiZero.map(x=>x.components), [0,1,2,2,1,1]);
});

test('persistent H0 handles ties, zero persistence, cycle edges and no-edge graphs', () => {
  const input = {vertices:[{id:'B',birth:0},{id:'A',birth:0},{id:'C',birth:2}],
    edges:[{u:'A',v:'B',time:0},{u:'B',v:'C',time:2},{u:'A',v:'C',time:2}], queryTimes:[0,2]};
  const out = persistentHomologyZero(input);
  assert.deepEqual(out.bettiZero.map(x=>x.components), [1,1]);
  assert.equal(out.bars.filter(x=>x.lifetime===0).length, 2);
  assert.equal(persistentHomologyZero({...graph,edges:[]}).essentialComponentCount, 3);
});

test('persistent H0 rejects invalid filtration and duplicate edges', () => {
  assert.throws(() => persistentHomologyZero({...graph,edges:[{u:'A',v:'C',time:1}]}), /after both/);
  assert.throws(() => persistentHomologyZero({...graph,edges:[...graph.edges,{u:'B',v:'A',time:3}]}), /duplicate/);
  assert.throws(() => persistentHomologyZero({...graph,edges:[{u:'A',v:'MISSING',time:4}]}), /known vertices/);
});

test('POMDP computes exact finite-horizon Bellman tree and optimal first action', () => {
  const r = solveFinitePomdp(pomdp);
  assert.equal(r.bestAction, 'guessHealthy');
  assert.equal(r.expectedValue, '3/2');
  assert.deepEqual(r.actionValues, {guessHealthy:'3/2',guessIll:'3/2'});
  assert(r.reachableBeliefStates >= 1);
  assert.equal(solveFinitePomdp({...pomdp,belief:['2/5','3/5']}).bestAction, 'guessIll');
  assert.equal(solveFinitePomdp({...pomdp,belief:['2/5','3/5']}).expectedValue, '8/5');
});

test('POMDP correctly handles uninformative and impossible observations', () => {
  const blind = structuredClone(pomdp);
  blind.observationModel = [[['1/2','1/2'],['1/2','1/2']],[['1/2','1/2'],['1/2','1/2']]];
  assert.equal(solveFinitePomdp(blind).expectedValue, '1/1');
  const impossible = structuredClone(pomdp);
  impossible.observationModel = [[['1/1','0/1'],['1/1','0/1']],[['1/1','0/1'],['1/1','0/1']]];
  assert.equal(solveFinitePomdp(impossible).expectedValue, '1/1');
  assert.equal(solveFinitePomdp({...pomdp,horizon:1}).expectedValue, '1/2');
  assert.equal(solveFinitePomdp({...pomdp,discount:'0/1'}).expectedValue, '1/2');
});

test('POMDP rejects invalid transition mass, belief and fake rewards', () => {
  const corrupt = structuredClone(pomdp);
  corrupt.transition[0][0]=['1/2','1/4'];
  assert.throws(() => solveFinitePomdp(corrupt), /sum to one/);
  assert.throws(() => solveFinitePomdp({...pomdp,belief:['1/2','1/4']}), /sum to one/);
  assert.throws(() => solveFinitePomdp({...pomdp,reward:[[1,NaN],[0,1]]}), /reward/);
});

test('GAUSS connects Bayesian outputs into POMDP and carries both existing GAUSS and Quantum receipts', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/advanced-v1.json', import.meta.url)));
  fixture.tasks.push({taskId:'learn-rate',operatorId:'BAYES_BERNOULLI_STREAM_V1',
    input:{priorAlpha:1,priorBeta:1,observations:[1,0,1]}});
  fixture.tasks.push({taskId:'choose-partial-observation-action',operatorId:'POMDP_FINITE_HORIZON_V1',
    input:{...pomdp, belief:[
      {$ref:{taskId:'learn-rate',path:['predictiveFalse']}},
      {$ref:{taskId:'learn-rate',path:['predictiveTrue']}}
    ]}});
  fixture.tasks.push({taskId:'topological-structure',operatorId:'TDA_PERSISTENT_H0_V1',input:graph});
  const report = await executeGaussAdvancedProblem(fixture);
  assert.equal(report.status, 'PASS');
  assert.equal(report.advancedOperatorCount, 12);
  assert.equal(gaussRegistrySummary().implementedLayerCount, 1000);
  assert.equal(report.linkedGaussStatus, 'PASS');
  assert.match(report.linkedQuantumReceiptSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.taskResults.at(-2).output.expectedValue, '8/5');
  assert.deepEqual(report.taskResults.at(-2).dependencies, [{taskId:'learn-rate',outputSha256:report.taskResults.at(-3).outputSha256}]);
  const {reportSha256,...unsigned} = report;
  assert.equal(reportSha256, sha256Canonical(unsigned));
  assert.deepEqual(await executeGaussAdvancedProblem(fixture), report);
});

test('failure of Bayesian input blocks dependent decision rather than fabricating PASS', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/advanced-v1.json', import.meta.url)));
  fixture.tasks.push({taskId:'bad',operatorId:'BAYES_BERNOULLI_STREAM_V1',input:{priorAlpha:1,priorBeta:1,observations:[3]}});
  fixture.tasks.push({taskId:'dependent',operatorId:'POMDP_FINITE_HORIZON_V1',input:{...pomdp,
    belief:[{$ref:{taskId:'bad',path:['predictiveTrue']}},'1/2']}});
  const report = await executeGaussAdvancedProblem(fixture);
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.taskResults.slice(-2).map(x=>x.status), ['FAILED','FAILED']);
  assert.equal(report.taskResults.at(-1).output, null);
});

test('independent unnormalized-belief Bellman oracle agrees across 32 diverse POMDPs', () => {
  const fractions = ['0/1','1/4','1/2','3/4','1/1'];
  const parse = (f) => { const [n,d] = f.split('/').map(Number); return n/d; };
  for (let seed = 0; seed < 32; seed++) {
    const sample = structuredClone(pomdp);
    const p = fractions[seed % fractions.length];
    sample.belief = [p, fractions[4 - seed % fractions.length]];
    sample.discount = fractions[(seed * 3) % fractions.length];
    sample.horizon = 2;
    sample.reward = [[seed % 5 - 2, seed % 7 - 3], [seed % 3 - 1, seed % 11 - 5]];
    for (let a = 0; a < 2; a++) for (let s = 0; s < 2; s++) {
      const x = (seed + 2 * a + 3 * s) % 5;
      const y = (2 * seed + a + 4 * s) % 5;
      sample.transition[a][s] = [fractions[x], fractions[4 - x]];
      sample.observationModel[a][s] = [fractions[y], fractions[4 - y]];
    }
    // Independent oracle: enumerate joint (initial state, next state, observation),
    // and maximize unnormalized second-step expected reward without Bayes division.
    const b = sample.belief.map(parse);
    const reference = sample.actions.map((_, a) => {
      let immediate = b.reduce((sum, bs, s) => sum + bs * sample.reward[a][s], 0);
      let future = 0;
      for (let obs = 0; obs < 2; obs++) {
        const secondActions = sample.actions.map((__, nextA) => {
          let total = 0;
          for (let s = 0; s < 2; s++) for (let ns = 0; ns < 2; ns++) {
            total += b[s] * parse(sample.transition[a][s][ns]) *
              parse(sample.observationModel[a][ns][obs]) * sample.reward[nextA][ns];
          }
          return total;
        });
        future += Math.max(...secondActions);
      }
      return immediate + parse(sample.discount) * future;
    });
    const result = solveFinitePomdp(sample);
    assert(Math.abs(parse(result.expectedValue) - Math.max(...reference)) < 1e-10, `seed ${seed}`);
    sample.actions.forEach((a, i) => assert(Math.abs(parse(result.actionValues[a]) - reference[i]) < 1e-10, `seed ${seed} action ${a}`));
  }
});
