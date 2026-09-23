import test from 'node:test';
import assert from 'node:assert/strict';
import {physicsLSTMLoss,trainPhysicsLSTM,initializeGraphNetwork,graphNetworkLoss,trainGraphNetwork,runMotor} from '../src/index.mjs';
const close=(a,b,t=1e-6)=>assert.ok(Math.abs(a-b)<t,`${a} vs ${b}`);
const gate=(a,b,c)=>({input:[[a]],hidden:[[b]],bias:[c]});
const model={gates:{input:gate(.2,.1,.1),forget:gate(.1,.2,-.1),output:gate(.3,-.1,.2),candidate:gate(.4,.2,.1)},peepholes:[[.1],[.2],[-.1]],readout:{weights:[[.8]],bias:[.1]}};
const residual={op:'add',args:['dy0','y0']};
const example={model,sequences:[{inputs:[[1],[.7],[.4]],times:[0,.4,1],targets:[[1],[null],[.3]]}],residuals:[residual],physicsWeight:.7};
test('82 BPTT differentiates input, hidden, peephole, readout and physics terms',()=>{
 const r=physicsLSTMLoss(example);
 // flatten order: gate input, hidden, bias (3 each), peepholes (3), readout weight+bias.
 const paths=[['gates','input','input',0,0],['gates','forget','hidden',0,0],['gates','candidate','bias',0],['peepholes',0,0],['peepholes',2,0],['readout','weights',0,0],['readout','bias',0]];
 const indices=[0,4,11,12,14,15,16];
 paths.forEach((path,i)=>{const a=structuredClone(example),b=structuredClone(example);let aa=a.model,bb=b.model;for(const key of path.slice(0,-1)){aa=aa[key];bb=bb[key];}const key=path.at(-1);aa[key]+=1e-5;bb[key]-=1e-5;close(r.gradient[indices[i]],(physicsLSTMLoss(a).value-physicsLSTMLoss(b).value)/2e-5,1e-6);});
});
test('82 training optimizes all LSTM parameters and reduces physical residual loss',()=>{
 const before=physicsLSTMLoss(example),r=trainPhysicsLSTM({...example,iterations:150,tolerance:1e-7});
 assert.ok(r.optimization.objective<before.value*.1,`${r.optimization.objective} >= ${before.value*.1}`);
 assert.ok(r.physicsLoss<before.physicsLoss);assert.notDeepEqual(r.model.gates,model.gates);
 const after=physicsLSTMLoss({...example,model:r.model});close(after.value,r.optimization.objective);
 assert.ok(r.optimization.history.every((v,i,a)=>!i||v<=a[i-1]+1e-12));
});
test('82 physics-only training has actual gradient and rejects invalid residual inputs',()=>{
 const spec={model,sequences:[{inputs:[[0],[0],[0]],times:[0,1,2]}],residuals:[{op:'sub',args:['y0',1]}]};
 const r=runMotor('82',{action:'train',payload:{...spec,iterations:100}});assert.ok(r.physicsLoss<1e-8);
 assert.throws(()=>physicsLSTMLoss({...spec,residuals:['unknown']}),/unknown residual/);
 assert.throws(()=>physicsLSTMLoss({...spec,residuals:[]}),/required/);
 assert.throws(()=>physicsLSTMLoss({...spec,sequences:[{inputs:[[0],[0]],times:[1,1]}]}),/increase/);
});
const gcModel=initializeGraphNetwork({dimensions:[2,3,2],seed:49});
const graph={features:[[-1,0],[-.8,.1],[1,0],[.8,-.1]],adjacency:[[0,1,0,0],[1,0,0,0],[0,0,0,1],[0,0,1,0]],labels:[0,null,1,null]};
test('55 multilevel GCN gradients agree with finite differences through graph aggregation',()=>{
 const spec={model:gcModel,examples:[graph],l2:.01},r=graphNetworkLoss(spec),paths=[['weights',0,0,0],['bias',1,0],['weights',1,1,2]];
 // 3*2 weights then 3 biases then 2*3 weights then 2 biases.
 const indices=[0,15,14];
 paths.forEach((path,i)=>{const a=structuredClone(spec),b=structuredClone(spec),[type,layer,j,k]=path;
 if(type==='weights'){a.model.layers[layer][type][j][k]+=1e-5;b.model.layers[layer][type][j][k]-=1e-5;}else{a.model.layers[layer][type][j]+=1e-5;b.model.layers[layer][type][j]-=1e-5;}
 close(r.gradient[indices[i]],(graphNetworkLoss(a).value-graphNetworkLoss(b).value)/2e-5);});
});
test('55 learns graph classification and predicts unlabeled held-out nodes',()=>{
 const r=runMotor('55',{action:'train',payload:{model:gcModel,examples:[graph],iterations:200}});
 assert.deepEqual(r.predictions[0],[0,0,1,1]);assert.ok(r.dataLoss<.02);assert.notDeepEqual(r.model.layers[0].weights,gcModel.layers[0].weights);
 r.probabilities[0].forEach(row=>close(row.reduce((s,v)=>s+v,0),1));
});
test('55 model validation rejects asymmetric graphs and absent training labels',()=>{
 assert.throws(()=>trainGraphNetwork({model:gcModel,examples:[{...graph,labels:[null,null,null,null]}]}),/labeled/);
 const bad=structuredClone(graph);bad.adjacency[0][1]=2;assert.throws(()=>graphNetworkLoss({model:gcModel,examples:[bad]}),/symmetric/);
});

test('55 and 82 trained models run inference on unlabeled inputs',()=>{
 const g=runMotor('55',{action:'infer',payload:{model:gcModel,graphs:[{features:graph.features,adjacency:graph.adjacency}]}});
 assert.deepEqual(g.probabilities,graphNetworkLoss({model:gcModel,examples:[graph],l2:0}).probabilities);
 const sequences=example.sequences.map(({targets,...s})=>s),r=runMotor('82',{action:'infer',payload:{model,sequences}});
 assert.deepEqual(r.predictions,physicsLSTMLoss(example).predictions);
});
