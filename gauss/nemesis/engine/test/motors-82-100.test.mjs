import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {runMotor,MOTOR_REGISTRY} from '../src/index.mjs';
import {canon} from '../src/motors/finite-tools.mjs';
import {signStateTransition} from '../src/motors/batch-90-100.mjs';
const close=(x,y,eps=1e-6)=>assert.ok(Math.abs(x-y)<eps,`${x} != ${y}`);
const gate={input:[[0]],hidden:[[0]],bias:[0]},weights={input:gate,forget:gate,output:gate,candidate:{input:[[1]],hidden:[[0]],bias:[0]},peepholes:[[0],[0],[0]]};
const kp=generateKeyPairSync('ed25519'),privatePem=kp.privateKey.export({format:'pem',type:'pkcs8'}),publicPem=kp.publicKey.export({format:'pem',type:'spki'});
const replicaKeys=Object.fromEntries(['a','b','c'].map(v=>[v,generateKeyPairSync('ed25519')]));
const vote=(voter,term,leader)=>{const message={kind:'RAFT_VOTE_V1',term,voter,candidate:leader};return {...message,signature:sign(null,Buffer.from(canon(message)),replicaKeys[voter].privateKey).toString('base64')};};
const entryData={kind:'RAFT_LOG_V1',index:1,term:2,payload:{op:'set',key:'a',value:3},previousHash:'GENESIS'};
const entry={index:1,term:2,payload:entryData.payload,previousHash:'GENESIS',signature:sign(null,Buffer.from(canon(entryData)),replicaKeys.a.privateKey).toString('base64')};
const replicas=['a','b','c'].map(id=>({id,publicKey:replicaKeys[id].publicKey.export({format:'pem',type:'spki'})}));
const cert=signStateTransition({before:{safe:true,n:1},after:{safe:true,n:2},invariants:['safe'],context:'session',epoch:4,previousHash:'root'},privatePem);
const cases={
82:{sequence:[[1],[1]],weights},
83:{rows:[[1,0],[0,2],[0,0]],rank:2,iterations:300,seed:7},
84:{transitions:[[[1]]],rewards:[[1]],discount:.5,tolerance:1e-11},
85:{H:[[2]],c:[-2],A:[[1],[-1]],b:[2,2],initial:[0],outerIterations:12},
86:{phases:[0,0],frequencies:[0,0],adjacency:[[0,1],[1,0]],coupling:1,dt:.01,steps:100},
87:{events:[],baseline:2,alpha:.5,beta:1,horizon:3},
88:{transition:[[[1,0],[0,1]],[[0,1],[1,0]]],cost:[[0,1],[0,1]],initial:[.6,.4],horizon:3,congestion:[0,0],boundary:[0,0]},
90:{features:[[1],[2]],parameters:[0],gradient:[1]},
91:{r:2,bins:8,samplesPerBin:32,steps:100},
92:{matrices:[[[.5]],[[.9]]],probabilities:[.5,.5]},
93:{replicas,term:2,leader:'a',votes:[vote('a',2,'a'),vote('b',2,'a')].map(({kind,...v})=>v),entries:[entry],commitIndex:1},
94:{p:[.5,.5],tangent:[.2,-.2],channel:[[.8,.2],[.2,.8]]},
96:{F:1,H:1,Q:0,R:1,initialMean:0,initialSqrtVariance:1,observations:[1,null]},
97:{prior:[.25,.25,.25,.25],features:[[0,0],[1,0],[0,1],[1,1]],targets:[.7,.6]},
98:{mu:1,omega:2,initial:[.1,0],dt:.01,steps:3000},
99:{sequences:[{length:2,labels:[1,1]},{length:3,labels:[1,1,1]}],transition:[[0,0],[0,0]],learningRate:.5,steps:80},
100:{certificate:cert,publicKey:publicPem,before:{safe:true,n:1},after:{safe:true,n:2},context:'session',epoch:4,previousHash:'root'}
};
test('82 peephole-LSTM forward state matches manual gate arithmetic',()=>{const r=runMotor('82',cases[82]);const first=.5*Math.tanh(.5*Math.tanh(1));close(r.states[0].hidden[0],first);assert.equal(r.states.length,2);assert.ok(r.states[1].cell[0]>r.states[0].cell[0]);});
test('83 truncated SVD singular values and rank-2 reconstruction',()=>{const r=runMotor('83',cases[83]);close(r.components[0].singularValue,2,1e-4);close(r.components[1].singularValue,1,1e-4);assert.ok(r.frobeniusResidual<1e-4);});
test('84 infinite-horizon MDP exact fixed point, Bellman bound',()=>{const r=runMotor('84',cases[84]);close(r.values[0],2);assert.ok(r.bellmanErrorBound<1e-8);assert.equal(r.policy[0],0);assert.throws(()=>runMotor('84',{...cases[84],transitions:[[[.7]]]}),/sum/);});
test('85 strict-feasible interior-point quadratic optimizer',()=>{const r=runMotor('85',cases[85]);close(r.solution[0],1,1e-3);assert.ok(r.slacks.every(v=>v>0));assert.throws(()=>runMotor('85',{...cases[85],initial:[3]}),/strictly feasible/);});
test('86 identical oscillators remain fully phase synchronized',()=>{const r=runMotor('86',cases[86]);close(r.order.strength,1);close(r.phases[0],0);});
test('87 exponential Hawkes empty log likelihood and excitation',()=>{const r=runMotor('87',cases[87]);close(r.logLikelihood,-6);const withEvent=runMotor('87',{...cases[87],events:[1,2]});assert.ok(withEvent.eventIntensities[1]>2);assert.throws(()=>runMotor('87',{...cases[87],events:[2,1]}),/ordered/);});
test('88 mean-field boundary fixed policy and conservation',()=>{const r=runMotor('88',cases[88]);assert.equal(r.status,'CONVERGED');assert.deepEqual(r.policy,[[0,0],[0,0],[0,0]]);close(r.distribution.at(-1)[0],.6);});
test('90 logistic Fisher information and natural gradient analytic scalar',()=>{const r=runMotor('90',cases[90]);close(r.fisher[0][0],.625);close(r.naturalGradient[0],1/(.625+1e-8));});
test('91 Ulam Markov rows stochastic and invariant measure normalization',()=>{const r=runMotor('91',cases[91]);for(const row of r.partitionTransition)close(row.reduce((s,v)=>s+v,0),1);close(r.stationaryEstimate.reduce((s,v)=>s+v,0),1);});
test('92 random diagonal mean-square Lyapunov certificate',()=>{const r=runMotor('92',cases[92]);assert.equal(r.meanSquareStable,true);close(r.meanSquareRates[0],.53);close(r.lyapunovDiagonal[0],1/.47);assert.equal(runMotor('92',{matrices:[[[1.1]]],probabilities:[1]}).meanSquareStable,false);});
test('93 authenticated Raft evidence rejects tampering and insufficient votes',()=>{const r=runMotor('93',cases[93]);assert.equal(r.valid,true);assert.equal(r.verifiedVotes,2);assert.equal(runMotor('93',{...cases[93],entries:[{...entry,payload:{bad:true}}]}).valid,false);assert.equal(runMotor('93',{...cases[93],votes:cases[93].votes.slice(0,1)}).valid,false);});
test('94 Chentsov Fisher contraction and identity-channel equality',()=>{const r=runMotor('94',cases[94]);assert.equal(r.contractive,true);assert.ok(r.fisherAfter<r.fisherBefore);const identity=runMotor('94',{...cases[94],channel:[[1,0],[0,1]]});close(identity.fisherAfter,identity.fisherBefore);});
test('96 scalar square-root Kalman exact variance and missing observation',()=>{const r=runMotor('96',cases[96]);close(r.history[0].mean,.5);close(r.history[0].sqrtVariance**2,.5);close(r.history[1].sqrtVariance**2,.5);});
test('97 multi-moment entropy projection with two constraints',()=>{const r=runMotor('97',cases[97]);assert.equal(r.status,'CONVERGED');close(r.moments[0],.7,1e-7);close(r.moments[1],.6,1e-7);close(r.posterior.reduce((s,v)=>s+v,0),1);});
test('98 supercritical Hopf stable limit cycle, subcritical origin',()=>{const r=runMotor('98',cases[98]);close(r.radius,1,.01);const below=runMotor('98',{...cases[98],mu:-1,steps:1500});assert.ok(below.radius<1e-5);});
test('99 supervised CRF learns state bias and predicts labels',()=>{const r=runMotor('99',cases[99]);assert.ok(r.bias[1]>r.bias[0]);assert.deepEqual(r.predictions,[[1,1],[1,1,1]]);});
test('100 signed transition binds context, epoch, previous hash and state',()=>{assert.equal(runMotor('100',cases[100]).verified,true);assert.equal(runMotor('100',{...cases[100],epoch:5}).verified,false);assert.equal(runMotor('100',{...cases[100],after:{safe:true,n:3}}).verified,false);assert.throws(()=>signStateTransition({before:cases[100].before,after:{safe:false,n:2},invariants:['safe'],context:'session',epoch:4,previousHash:'root'},privatePem),/invariant changed/);});
test('99 registry IDs include bounded primitives without rebranding them as full crypto',()=>{const regs=Object.keys(MOTOR_REGISTRY);assert.equal(regs.length,99);for(const v of ['81','89','95'])assert.equal(typeof MOTOR_REGISTRY[v],'function');assert.throws(()=>runMotor('101',{}),/not implemented/);for(const [id,input] of Object.entries(cases))assert.equal(typeof runMotor(id,input),'object');});
export {cases};
