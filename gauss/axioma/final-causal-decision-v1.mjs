/* Independent grouped-sum causal and exhaustive payoff-table decision references. */
import assert from 'node:assert/strict';
import {runFinalBank,range} from './final-common-v1.mjs';
const sum=a=>a.reduce((s,x)=>s+x,0);
const mean=a=>sum(a)/a.length;
const verify=(actual,expected)=>{
 assert.deepStrictEqual(Object.keys(actual).sort(),Object.keys(expected).sort());
 for(const [key,value] of Object.entries(expected)){
  if(Array.isArray(value)){assert.equal(actual[key].length,value.length);value.forEach((v,i)=>assert.ok(Math.abs(actual[key][i]-v)<=1e-11*Math.max(1,Math.abs(v)),`${key}[${i}]`));}
  else if(typeof value==='number')assert.ok(typeof actual[key]==='number'&&Number.isFinite(actual[key])&&Math.abs(actual[key]-value)<=1e-11*Math.max(1,Math.abs(value)),`${key}: ${actual[key]} vs ${value}`);
  else assert.deepStrictEqual(actual[key],value);
 }
};
const defs=[
 {id:'GAUSS.CAUSAL.DID.001',make:(i,r)=>({treatedPre:range(2+r(4)).map(()=>r(15)-7),treatedPost:range(2+r(4)).map(()=>r(15)-7),controlPre:range(2+r(4)).map(()=>r(15)-7),controlPost:range(2+r(4)).map(()=>r(15)-7)}),reference:x=>{const treatedChange=mean(x.treatedPost)-mean(x.treatedPre),controlChange=mean(x.controlPost)-mean(x.controlPre);return {treatedChange,controlChange,estimate:treatedChange-controlChange};},invalid:x=>[null,{...x,treatedPre:[]},{...x,controlPost:['not a number']}],verify},
 {id:'GAUSS.CAUSAL.IPW_ATE.002',make:(i,r)=>({rows:range(4+r(5)).map((j)=>({treatment:j%2,outcome:r(21)-10,propensity:[0.25,0.5,0.75][r(3)]})),propensityFloor:0.01}),reference:x=>{const treated=x.rows.filter(row=>row.treatment===1),control=x.rows.filter(row=>row.treatment===0),w1=treated.map(row=>1/row.propensity),w0=control.map(row=>1/(1-row.propensity)),treatedMean=sum(treated.map((row,i)=>row.outcome*w1[i]))/sum(w1),controlMean=sum(control.map((row,i)=>row.outcome*w0[i]))/sum(w0);return {estimate:treatedMean-controlMean,treatedMean,controlMean,sampleCount:x.rows.length};},invalid:x=>[null,{...x,rows:x.rows.map(row=>({...row,treatment:1}))},{...x,rows:[{treatment:1,outcome:2,propensity:0}]}],verify},
 {id:'GAUSS.DECISION.EXPECTED_UTILITY.001',make:(i,r)=>{const n=1+r(5),weights=range(n).map(()=>1+r(8)),total=sum(weights);return {outcomes:weights.map(w=>({probability:w/total,utility:r(25)-12}))};},reference:x=>({expectedUtility:sum(x.outcomes.map(({probability,utility})=>probability*utility)),probabilityMass:sum(x.outcomes.map(row=>row.probability))}),invalid:()=>[null,{outcomes:[]},{outcomes:[{probability:0.7,utility:2}]}],verify},
 {id:'GAUSS.DECISION.MINIMAX_REGRET.002',make:(i,r)=>{const n=1+r(5),m=1+r(5);return {actions:range(n).map(j=>`action-${j}`),payoffMatrix:range(n).map(()=>range(m).map(()=>r(21)-10))};},reference:x=>{const best=x.payoffMatrix[0].map((_,j)=>Math.max(...x.payoffMatrix.map(row=>row[j]))),regrets=x.payoffMatrix.map(row=>Math.max(...row.map((payoff,j)=>best[j]-payoff)));let chosen=0;for(let j=1;j<regrets.length;j++)if(regrets[j]<regrets[chosen])chosen=j;return {selectedAction:x.actions[chosen],maximumRegret:regrets[chosen],regrets};},invalid:x=>[null,{...x,payoffMatrix:[]},{...x,payoffMatrix:x.payoffMatrix.map((row,i)=>i?row:[...row.slice(0,-1),'not a payoff'])}],verify}
];
export const runFinalCausalDecisionBank=options=>runFinalBank({name:'AXIOMA 4 independently calculated causal and decision operators',definitions:defs,...options});
