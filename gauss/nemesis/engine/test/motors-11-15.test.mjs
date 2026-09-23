import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeSelectionBias, evaluateFiniteTailRisk, synchronizeClockIntervals,
  evaluateFiniteFuzzyLogic, repairFiniteExpression, runMotor, MOTOR_REGISTRY } from '../src/motors/index.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL(`../examples/${name}.json`,import.meta.url),'utf8'));

// Motor 11: elementary conditional probabilities cross-checked against numerical Bayes.
test('11 selection-conditioned posterior differs from naive Bayes when sampling distorts observations',()=>{
  const r=analyzeSelectionBias(fixture('selection-conditioning'));
  assert.equal(r.naivePosteriorAfterPositive,'4/5');
  assert.equal(r.selectionAdjustedPosteriorAfterPositive,'1/2');
  assert.equal(r.naivePosteriorAfterNegative,'1/5');
  assert.equal(r.selectionAdjustedPosteriorAfterNegative,'1/2');
  assert.equal(r.selectedProbabilityIfTrue,'2/5');
});
test('11 constant selection leaves original posterior unchanged',()=>{
  const r=analyzeSelectionBias({...fixture('selection-conditioning'),selectedIfTruePositive:'1/3',selectedIfTrueNegative:'1/3',selectedIfFalsePositive:'1/3',selectedIfFalseNegative:'1/3'});
  assert.equal(r.naivePosteriorAfterPositive,r.selectionAdjustedPosteriorAfterPositive);
  assert.equal(r.naivePosteriorAfterNegative,r.selectionAdjustedPosteriorAfterNegative);
});
test('11 numerical independent Bayes oracle on all nonzero selection combinations',()=>{
  for(const a of [0.2,0.6,1])for(const b of [0.25,0.75,1]) {
    const r=analyzeSelectionBias({priorTrue:'2/5',positiveIfTrue:'3/4',positiveIfFalse:'1/4',
      selectedIfTruePositive:({0.2:'1/5',0.6:'3/5',1:'1/1'})[a],selectedIfTrueNegative:'1/2',
      selectedIfFalsePositive:({0.25:'1/4',0.75:'3/4',1:'1/1'})[b],selectedIfFalseNegative:'1/2'});
    const selTrue=0.75*a+0.25*0.5,selFalse=0.25*b+0.75*0.5;
    const lt=0.75*a/selTrue,lf=0.25*b/selFalse;
    const selectedPrior=0.4*selTrue/(0.4*selTrue+0.6*selFalse);
    const expected=selectedPrior*lt/(selectedPrior*lt+(1-selectedPrior)*lf);
    const [p,q]=r.selectionAdjustedPosteriorAfterPositive.split('/').map(Number);
    assert.ok(Math.abs(p/q-expected)<1e-14);
    const [priorN,priorD]=r.priorTrueAmongSelected.split('/').map(Number);
    assert.ok(Math.abs(priorN/priorD-selectedPrior)<1e-14);
  }
});
test('11 rejects impossible selection and does not fabricate undefined conditional probability',()=>{
  const x=fixture('selection-conditioning');
  assert.throws(()=>analyzeSelectionBias({...x,selectedIfTruePositive:'0/1',selectedIfTrueNegative:'0/1'}),/positive/);
  assert.throws(()=>analyzeSelectionBias({...x,priorTrue:'1/1'}),/strictly/);
  const r=analyzeSelectionBias({...x,selectedIfTruePositive:'0/1',selectedIfFalsePositive:'0/1'});
  assert.equal(r.selectionAdjustedPosteriorAfterPositive,null);
});

// Motor 12: exact finite-distribution tail accounting including VaR ties.
test('12 exact VaR and CVaR with boundary mass and control breach',()=>{
  const r=evaluateFiniteTailRisk(fixture('finite-tail-risk'));
  assert.equal(r.expectedLoss,'11/2');assert.equal(r.valueAtRisk,0);
  assert.equal(r.conditionalValueAtRisk,'55/1');assert.equal(r.probabilityStrictlyAboveVaR,'1/10');
  assert.equal(r.boundaryMassAtVaR,'0/1');assert.equal(r.status,'BREACH');
});
test('12 exact tail at quantile jump and all-tied loss',()=>{
  const x=fixture('finite-tail-risk');const r=evaluateFiniteTailRisk({...x,alpha:'19/20',maxCvar:'100/1'});
  assert.equal(r.valueAtRisk,10);assert.equal(r.conditionalValueAtRisk,'100/1');assert.equal(r.status,'PASS');
  const tied=evaluateFiniteTailRisk({alpha:'1/2',scenarios:[{id:'a',loss:7,probability:'1/3'},{id:'b',loss:7,probability:'2/3'}]});
  assert.equal(tied.conditionalValueAtRisk,'7/1');assert.equal(tied.boundaryMassAtVaR,'1/2');
});
test('12 independent numeric oracle for weighted discrete upper tails',()=>{
  for(let a=1;a<=8;a++)for(let b=1;b<=8;b++){
    const x={alpha:`${a}/10`,scenarios:[{id:'zero',loss:-3,probability:'1/4'}, {id:'mid',loss:2,probability:'1/2'}, {id:'top',loss:b,probability:'1/4'}]};
    const r=evaluateFiniteTailRisk(x);const vals=[[-3,0.25],[2,0.5],[b,0.25]].sort((c,d)=>c[0]-d[0]);
    let tail=1-a/10,sum=0;
    for(let i=vals.length-1;i>=0;i--){const portion=Math.min(tail,vals[i][1]);sum+=portion*vals[i][0];tail-=portion;}
    const [p,q]=r.conditionalValueAtRisk.split('/').map(Number);
    assert.ok(Math.abs(p/q-sum/(1-a/10))<1e-10);
  }
});
test('12 rejects bad probability masses and alpha endpoints',()=>{
  const x=fixture('finite-tail-risk');assert.throws(()=>evaluateFiniteTailRisk({...x,alpha:'1/1'}),/strictly/);
  assert.throws(()=>evaluateFiniteTailRisk({...x,scenarios:x.scenarios.slice(1)}),/sum exactly/);
  assert.throws(()=>evaluateFiniteTailRisk({...x,scenarios:[...x.scenarios,x.scenarios[0]]}),/unique/);
});

// Motor 13: exact difference constraints versus brute-force feasible offsets.
test('13 derives tight static offset intervals and an actual satisfying assignment',()=>{
  const r=synchronizeClockIntervals(fixture('clock-intervals'));
  assert.equal(r.status,'PASS');
  assert.deepEqual(r.offsets.map(x=>[x.minimum,x.maximum]),[[0,0],[5,7],[8,10]]);
  assert.deepEqual(r.offsets.map(x=>x.feasibleAssignment),[0,7,10]);
});
test('13 identifies inconsistent constraints with a negative-cycle witness',()=>{
  const x={clocks:['a','b'],anchor:'a',constraints:[{id:'ab',from:'a',to:'b',min:5,max:7},{id:'ba',from:'b',to:'a',min:0,max:1}]};
  const r=synchronizeClockIntervals(x);assert.equal(r.status,'INCONSISTENT');
  assert.ok(r.negativeCycle.length>0);assert.ok(r.negativeCycle.reduce((s,e)=>s+e.bound,0)<0);
});
test('13 exhaustive integer enumeration agrees on feasibility and tight bounds for 3 clocks',()=>{
  let seed=17; const rand=()=>((seed=(seed*1664525+1013904223)>>>0)%7)-3;
  for(let caseId=0;caseId<96;caseId++){
    const constraints=[{id:'ab',from:'a',to:'b',min:-3,max:3},{id:'ac',from:'a',to:'c',min:-3,max:3}];
    for(let i=0;i<3;i++){const k=rand(),m=rand();constraints.push({id:`r${i}`,from:i%2?'a':'b',to:i%2?'c':'c',min:Math.min(k,m),max:Math.max(k,m)});}
    const feasible=[];
    for(let b=-6;b<=6;b++)for(let c=-6;c<=6;c++) {
      const x={a:0,b,c};if(constraints.every(e=>x[e.to]-x[e.from]>=e.min&&x[e.to]-x[e.from]<=e.max))feasible.push({b,c});
    }
    const r=synchronizeClockIntervals({clocks:['a','b','c'],anchor:'a',constraints});
    assert.equal(r.status==='PASS',feasible.length>0,`case ${caseId}`);
    if(feasible.length){
      for(const [i,name] of [[1,'b'],[2,'c']]){
        assert.equal(r.offsets[i].minimum,Math.min(...feasible.map(f=>f[name])));
        assert.equal(r.offsets[i].maximum,Math.max(...feasible.map(f=>f[name])));
      }
    }
  }
});
test('13 rejects disconnected anchor, unknown clock and invalid interval',()=>{
  const x=fixture('clock-intervals');
  assert.throws(()=>synchronizeClockIntervals({...x,constraints:[]}),/disconnected/);
  assert.throws(()=>synchronizeClockIntervals({...x,anchor:'unknown'}),/anchor unknown/);
  assert.throws(()=>synchronizeClockIntervals({...x,constraints:[{id:'bad',from:'a',to:'b',min:2,max:1}]}),/exceeds/);
});

// Motor 14: closed finite-domain truth evaluation; not arbitrary predicate quantification.
test('14 finite second-order Gödel quantification over explicit interpretations',()=>{
  const r=evaluateFiniteFuzzyLogic(fixture('finite-fuzzy'));
  assert.equal(r.grade,'1/2');assert.equal(r.meetsThreshold,true);assert.equal(r.status,'PASS');
  assert.equal(r.predicateInterpretations,2);
});
test('14 forall/exists over predicate interpretations and entity shadowing',()=>{
  const x=fixture('finite-fuzzy');
  const pred={op:'FORALL_PRED',var:'P',arg:{op:'EXISTS',var:'x',arg:{op:'APPLY',pred:'P',term:'x'}}};
  assert.equal(evaluateFiniteFuzzyLogic({...x,formula:pred}).grade,'0/1');
  assert.equal(evaluateFiniteFuzzyLogic({...x,formula:{...pred,op:'EXISTS_PRED',arg:{op:'FORALL',var:'x',arg:{op:'APPLY',pred:'P',term:'x'}}}}).grade,'1/1');
  const shadow={op:'FORALL',var:'x',arg:{op:'EXISTS',var:'x',arg:{op:'PRED',name:'Good',term:'x'}}};
  assert.equal(evaluateFiniteFuzzyLogic({...x,formula:shadow}).grade,'1/1');
});
test('14 Gödel residuum, standard negation, and finite truth arithmetic',()=>{
  const x=fixture('finite-fuzzy');const c=v=>({op:'CONST',value:v});
  assert.equal(evaluateFiniteFuzzyLogic({...x,formula:{op:'IMPLIES',left:c('2/3'),right:c('1/3')}}).grade,'1/3');
  assert.equal(evaluateFiniteFuzzyLogic({...x,formula:{op:'IMPLIES',left:c('1/3'),right:c('2/3')}}).grade,'1/1');
  assert.equal(evaluateFiniteFuzzyLogic({...x,formula:{op:'NOT',arg:c('1/3')}}).grade,'2/3');
  assert.equal(evaluateFiniteFuzzyLogic({...x,formula:c('1/3'),threshold:'1/2'}).status,'THRESHOLD_NOT_MET');
});
test('14 rejects unbound variables, foreign domain members and invalid grades',()=>{
  const x=fixture('finite-fuzzy');
  assert.throws(()=>evaluateFiniteFuzzyLogic({...x,formula:{op:'APPLY',pred:'P',term:'x'}}),/unbound predicate/);
  assert.throws(()=>evaluateFiniteFuzzyLogic({...x,formula:{op:'PRED',name:'Good',term:'x'}}),/unbound entity/);
  assert.throws(()=>evaluateFiniteFuzzyLogic({...x,predicates:{Good:{a:'1/2',b:'1/1',c:'1/1'}}}),/unknown field/);
  assert.throws(()=>evaluateFiniteFuzzyLogic({...x,threshold:'3/2'}),/probability/);
});

// Motor 15: deterministic search of bounded AST edits, never arbitrary source code execution.
test('15 finds verified one-constant repair and does not change original input',()=>{
  const x=fixture('grammar-repair'),original=JSON.stringify(x);
  const r=repairFiniteExpression(x);
  assert.equal(r.status,'REPAIRED');assert.equal(r.editCount,1);assert.equal(r.expression.right.value,2);
  assert.equal(r.passedExamples,3);assert.equal(JSON.stringify(x),original);
});
test('15 repairs operator typo and variable name with one edit each',()=>{
  const x=fixture('grammar-repair');
  const op=repairFiniteExpression({...x,expression:{op:'SUB',left:{op:'VAR',name:'x'},right:{op:'CONST',value:2}},candidateConstants:[2]});
  assert.equal(op.status,'REPAIRED');assert.equal(op.expression.op,'ADD');
  const vars=repairFiniteExpression({variables:['x','y'],expression:{op:'VAR',name:'y'},examples:[{inputs:{x:2,y:5},expected:2},{inputs:{x:8,y:9},expected:8}],candidateConstants:[0]});
  assert.equal(vars.status,'REPAIRED');assert.equal(vars.expression.name,'x');
});
test('15 two edits are required and found for a changed operator and constant',()=>{
  const x=fixture('grammar-repair');
  const expr={op:'SUB',left:{op:'VAR',name:'x'},right:{op:'CONST',value:1}};
  assert.equal(repairFiniteExpression({...x,expression:expr,maxEdits:1}).status,'NO_REPAIR_IN_BUDGET');
  const r=repairFiniteExpression({...x,expression:expr,maxEdits:2});
  assert.equal(r.status,'REPAIRED');assert.equal(r.editCount,2);
  assert.equal(r.expression.op,'ADD');assert.equal(r.expression.right.value,2);
});
test('15 already passing, impossible fixtures, and bounded search cannot claim success',()=>{
  const x=fixture('grammar-repair');
  assert.equal(repairFiniteExpression({...x,expression:{op:'ADD',left:{op:'VAR',name:'x'},right:{op:'CONST',value:2}}}).status,'ALREADY_PASSING');
  assert.equal(repairFiniteExpression({...x,maxCandidates:1}).status,'NO_REPAIR_IN_BUDGET');
  assert.equal(repairFiniteExpression({...x,maxEdits:0}).status,'NO_REPAIR_IN_BUDGET');
  const impossible={...x,examples:[{inputs:{x:0},expected:1},{inputs:{x:0},expected:2}]};
  assert.equal(repairFiniteExpression(impossible).status,'NO_REPAIR_IN_BUDGET');
});
test('15 rejects malformed programs, foreign variables, unsafe arithmetic',()=>{
  const x=fixture('grammar-repair');
  assert.throws(()=>repairFiniteExpression({...x,expression:{op:'VAR',name:'unknown'}}),/unknown variable/);
  assert.throws(()=>repairFiniteExpression({...x,expression:{op:'CALL',name:'eval'}}),/unknown arithmetic operator/);
  assert.throws(()=>repairFiniteExpression({...x,variables:['x','x']}),/duplicates/);
  assert.throws(()=>repairFiniteExpression({...x,expression:{op:'CONST',value:1.5}}),/safe integer/);
});
test('11..15 registry and isolated CLI return nonzero for infeasible and unrepairable cases',()=>{
  const ids=['11','12','13','14','15'];
  for(const id of ids)assert.equal(typeof MOTOR_REGISTRY[id],'function');
  assert.throws(()=>runMotor('101',{}),/not implemented/);
  const root=new URL('../',import.meta.url).pathname;
  for(const [id,name] of [['11','selection-conditioning'],['13','clock-intervals'],['14','finite-fuzzy'],['15','grammar-repair']]){
    const run=spawnSync(process.execPath,['cli.mjs','motor',join(root,'examples',`${name}.json`),id],{cwd:root,encoding:'utf8'});
    assert.equal(run.status,0,`${id}: ${run.stderr}`);assert.ok(JSON.parse(run.stdout).engine);
  }
  const breach=spawnSync(process.execPath,['cli.mjs','motor',join(root,'examples','finite-tail-risk.json'),'12'],{cwd:root,encoding:'utf8'});
  assert.equal(breach.status,1);assert.equal(JSON.parse(breach.stdout).status,'BREACH');
  const temp=mkdtempSync(join(tmpdir(),'nemesis-11-15-'));
  try {
    const bad=fixture('clock-intervals');bad.constraints.push({id:'contradiction',from:'c',to:'a',min:1,max:2});
    const path=join(temp,'bad.json');writeFileSync(path,JSON.stringify(bad));
    const run=spawnSync(process.execPath,['cli.mjs','motor',path,'13'],{cwd:root,encoding:'utf8'});
    assert.equal(run.status,1);assert.equal(JSON.parse(run.stdout).status,'INCONSISTENT');
  }finally{rmSync(temp,{recursive:true,force:true});}
});
