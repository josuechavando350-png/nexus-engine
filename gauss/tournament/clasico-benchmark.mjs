#!/usr/bin/env node
// Reproducible, leakage-free scoreline benchmark. Node built-ins + NEXUS engines only.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {executeGaussProblem} from '../core/problem.mjs';
import {contributeNexusQuantum} from '../core/quantum-contributor.mjs';

const HISTORICAL_SOURCE = 'https://github.com/CarlosYoung0/ligamx-data/blob/cec10701ac2f9673132fb48c3ea861ae58ae4f4d/data/historical.csv';
const CHIVAS_SOURCE = 'https://www.chivasdecorazon.com.mx/es/partidos/calendario/Apertura-2026';
const AMERICA_SOURCE = 'https://www.goal.com/es-mx/equipo/cf-america/partidos-resultados/eu8c408f59yx7egaqossbv25e';
const SOURCE_COMMIT = 'cec10701ac2f9673132fb48c3ea861ae58ae4f4d';
const FROZEN_AT = '2026-09-18';
const HOME = 'CF América', AWAY = 'Deportivo Guadalajara';
const MAX_GOALS = 32;
const MODELS = ['leagueBaseline','gaussClassic','gaussContext','quantumSelectedEnsemble'];
const MIXES = Object.freeze([
  {id:'classic-heavy', baseline:.25, classic:.75, context:0},
  {id:'balanced', baseline:.10, classic:.45, context:.45},
  {id:'recent-heavy', baseline:.10, classic:.20, context:.70},
]);

const official2026 = Object.freeze([
  // 2026 regular-season scores only. Source for each row belongs to the named team.
  ['2026-07-18','Deportivo Guadalajara','Deportivo Toluca',0,2,CHIVAS_SOURCE],
  ['2026-07-25','Deportivo Guadalajara','FC Juárez',1,0,CHIVAS_SOURCE],
  ['2026-07-31','Puebla FC','Deportivo Guadalajara',1,1,CHIVAS_SOURCE],
  ['2026-08-16','Santos Laguna','Deportivo Guadalajara',0,1,CHIVAS_SOURCE],
  ['2026-08-22','Deportivo Guadalajara','Club Tijuana',5,2,CHIVAS_SOURCE],
  ['2026-08-29','CF Pachuca','Deportivo Guadalajara',1,1,CHIVAS_SOURCE],
  ['2026-09-05','Atlético San Luis','Deportivo Guadalajara',0,3,CHIVAS_SOURCE],
  ['2026-09-13','Deportivo Guadalajara','Pumas UNAM',3,0,CHIVAS_SOURCE],
  ['2026-07-18','Gallos Blancos','CF América',0,1,AMERICA_SOURCE],
  ['2026-07-24','Atlante','CF América',1,1,AMERICA_SOURCE],
  ['2026-08-02','CF América','Santos Laguna',3,0,AMERICA_SOURCE],
  ['2026-08-16','CF América','Atlético San Luis',3,0,AMERICA_SOURCE],
  ['2026-08-21','FC Juárez','CF América',1,2,AMERICA_SOURCE],
  ['2026-08-29','CF América','Puebla FC',2,0,AMERICA_SOURCE],
  ['2026-09-12','Cruz Azul','CF América',4,3,AMERICA_SOURCE],
]);
const datePattern = /^\d{4}-\d\d-\d\d$/u;
const numeric = x => Number.isInteger(x) && x >= 0 && x <= 30;
function normalize(row) {
  assert(datePattern.test(row.date), `invalid date ${row.date}`);
  assert(row.home !== row.away && row.home && row.away, 'invalid teams');
  assert(numeric(row.homeScore) && numeric(row.awayScore), 'invalid goals');
  return Object.freeze(row);
}
function parseHistorical(text) {
  const lines = text.trim().split(/\r?\n/u);
  assert.equal(lines.shift(), 'date,season,stage,round,home_team,away_team,home_score,away_score');
  const seen = new Set();
  const all = lines.map((line, i) => {
    const parts=line.split(',');
    assert.equal(parts.length, 8, `CSV line ${i+2}`);
    const [date,season,stage,round,home,away,hs,as] = parts;
    const row=normalize({date,season,stage,round,home,away,homeScore:Number(hs),awayScore:Number(as)});
    const key=[date,home,away,stage].join('|');
    assert(!seen.has(key), `duplicate fixture ${key}`);
    seen.add(key);
    assert(date <= '2026-05-31', 'historical source contains future information');
    return row;
  });
  assert(all.length >= 2000, 'historical sample unexpectedly small');
  const regular = all.filter(r => r.stage === 'Apertura' || r.stage === 'Clausura').sort(sortMatches);
  assert(regular.some(r=>r.season==='2023-24') && regular.some(r=>r.season==='2024-25') && regular.some(r=>r.season==='2025-26'));
  return {all,regular};
}
function sortMatches(a,b) {return a.date.localeCompare(b.date)||a.home.localeCompare(b.home)||a.away.localeCompare(b.away);}
function rate(arr, field, prior, priorGames, recent=15, decay=1) {
  let total=prior*priorGames,denom=priorGames, w=1;
  for(let i=arr.length-1,j=0;i>=0 && j<recent;i--,j++) {
    total += arr[i][field]*w; denom+=w;w*=decay;
  }
  return total/denom;
}
function trainingPrior(past) {
  const last=past.slice(-360);
  const n=last.length;
  const home=(last.reduce((s,m)=>s+m.homeScore,0)+1.4*12)/(n+12);
  const away=(last.reduce((s,m)=>s+m.awayScore,0)+1.15*12)/(n+12);
  const out=[1,1,1];
  for(const m of last)out[m.homeScore>m.awayScore?0:m.homeScore===m.awayScore?1:2]++;
  const total=out.reduce((a,b)=>a+b,0);
  return {home,away,baseline:out.map(v=>v/total)};
}
function expectedGoals(past,home,away,context=false) {
  const prior=trainingPrior(past);
  const h=past.filter(m=>m.home===home||m.away===home);
  const a=past.filter(m=>m.home===away||m.away===away);
  const hFor=h.map(m=>({goal:m.home===home?m.homeScore:m.awayScore,conceded:m.home===home?m.awayScore:m.homeScore}));
  const aFor=a.map(m=>({goal:m.home===away?m.homeScore:m.awayScore,conceded:m.home===away?m.awayScore:m.homeScore}));
  const subsetH=context?h.filter(m=>m.home===home):h;
  const subsetA=context?a.filter(m=>m.away===away):a;
  const hr=context?subsetH.map(m=>({goal:m.homeScore,conceded:m.awayScore})):hFor;
  const ar=context?subsetA.map(m=>({goal:m.awayScore,conceded:m.homeScore})):aFor;
  const length=context?6:15, decay=context?.85:1, shrink=context?6:10;
  const hAttack=rate(hr,'goal',prior.home,shrink,length,decay);
  const hDefence=rate(hr,'conceded',prior.away,shrink,length,decay);
  const aAttack=rate(ar,'goal',prior.away,shrink,length,decay);
  const aDefence=rate(ar,'conceded',prior.home,shrink,length,decay);
  const clamp=x=>Math.max(.2,Math.min(4.5,x));
  return [clamp(hAttack*aDefence/prior.home),clamp(aAttack*hDefence/prior.away)];
}
async function gaussForecast(goals,problemId) {
  const tasks=goals.map((mean,i)=>({taskId:`team-${i}`,layerId:'GAUSS.STATS.POISSON_BINOMIAL.021',input:{probabilities:Array(MAX_GOALS).fill(mean/MAX_GOALS)}}));
  const result=await executeGaussProblem({schemaVersion:1,problemId,objective:'Illustrative binomial goals under explicit independence assumption; not a calibrated xG model',tasks},{quantumContributor:contributeNexusQuantum});
  assert.equal(result.status,'PASS',result.errors.join(';'));
  assert.equal(result.quantumContribution.status,'NOT_APPLICABLE');
  const [home,away]=result.taskResults.map(t=>t.output.probabilities);
  for(const dist of [home,away])assert(Math.abs(dist.reduce((s,v)=>s+v,0)-1)<1e-9);
  const probs=[0,0,0];let modal=null,largest=-1;
  for(let h=0;h<home.length;h++)for(let a=0;a<away.length;a++) {
    const p=home[h]*away[a];probs[h>a?0:h===a?1:2]+=p;
    if(p>largest){largest=p;modal=`${h}-${a}`;}
  }
  assert(Math.abs(probs.reduce((x,y)=>x+y,0)-1)<1e-9);
  return {probs,modal,modalProbability:largest,reportSha256:result.reportSha256};
}
const mixForecast=(baseline,classic,context,mix)=>baseline.map((v,i)=>v*mix.baseline+classic[i]*mix.classic+context[i]*mix.context);
function brier(p,index){return p.reduce((s,v,i)=>s+(v-(i===index?1:0))**2,0);}
function logLoss(p,index){return -Math.log(Math.max(p[index],1e-15));}
function truth(m){return m.homeScore>m.awayScore?0:m.homeScore===m.awayScore?1:2;}
function encodeIsing(energies) {
  const [a,b,c]=energies,d=Math.max(...energies)+10;
  return {fields:[(a-b+c-d)/4,(a+b-c-d)/4],couplings:[{i:0,j:1,value:(a-b-c+d)/4}],offset:(a+b+c+d)/4};
}
async function quantumSelect(scores) {
  const result=await executeGaussProblem({schemaVersion:1,problemId:'clasico-2026-quantum-validation-selection',objective:'Minimize pre-holdout validation Brier loss over three precommitted ensemble recipes',tasks:[{taskId:'validation-mixes',layerId:'GAUSS.PHYSICS.ISING_EXACT_GROUND.003',input:encodeIsing(scores)}]},{quantumContributor:contributeNexusQuantum});
  assert.equal(result.status,'PASS',result.errors.join(';'));
  assert.equal(result.quantumContribution.status,'EXECUTED');
  assert.equal(result.quantumContribution.simulation.hardwareExecution,false);
  assert.equal(result.quantumContribution.simulation.quantumAdvantageClaimAllowed,false);
  const spins=result.taskResults[0].output.spins;
  const index=(spins[0]===-1?1:0)+(spins[1]===-1?2:0);
  assert(index<3 && Math.abs(scores[index]-Math.min(...scores))<1e-8);
  return {mix:MIXES[index],index,reportSha256:result.reportSha256,quantumReceiptSha256:result.quantumContribution.simulation.receiptSha256};
}
async function predict(past,home,away,id) {
  const prior=trainingPrior(past);
  const classic=await gaussForecast(expectedGoals(past,home,away),`${id}-classic`);
  const context=await gaussForecast(expectedGoals(past,home,away,true),`${id}-context`);
  return {baseline:prior.baseline,classic,context};
}
async function evaluate(matches,history,label,selected=null) {
  const scores=Object.fromEntries(MODELS.map(name=>[name,{brier:0,logLoss:0,correct:0}]));
  const recipeScores=[0,0,0];let count=0;
  // All matches played on the same local date use the identical pre-date information.
  const days=Map.groupBy(matches,m=>m.date);
  let past=[...history].sort(sortMatches);
  for(const [date,group] of days){
    assert(past.every(m=>m.date<date),`temporal leakage at ${date}`);
    for(const match of group){
      const prediction=await predict(past,match.home,match.away,`${label}-${date}-${count}`);
      const t=truth(match);
      const candidates={leagueBaseline:prediction.baseline,gaussClassic:prediction.classic.probs,gaussContext:prediction.context.probs};
      for(let i=0;i<MIXES.length;i++)recipeScores[i]+=brier(mixForecast(prediction.baseline,prediction.classic.probs,prediction.context.probs,MIXES[i]),t);
      if(selected)candidates.quantumSelectedEnsemble=mixForecast(prediction.baseline,prediction.classic.probs,prediction.context.probs,selected.mix);
      for(const [name,p] of Object.entries(candidates)){
        const score=scores[name]; score.brier+=brier(p,t);score.logLoss+=logLoss(p,t);
        if(p.indexOf(Math.max(...p))===t)score.correct++;
      }
      count++;
    }
    past.push(...group);past.sort(sortMatches);
  }
  for(const score of Object.values(scores)) if(count && (score.correct!==0||score.brier!==0)){
    score.meanBrier=score.brier/count;score.meanLogLoss=score.logLoss/count;score.accuracy=score.correct/count;
  }
  return {label,matches:count,scores,recipeScores:recipeScores.map(n=>n/count),lastDate:matches.at(-1)?.date??null};
}
function snapshot(){
  const rows=official2026.map(([date,home,away,homeScore,awayScore,source])=>normalize({date,home,away,homeScore,awayScore,source}));
  const seen=new Set();for(const row of rows){assert(row.date<=FROZEN_AT);const key=`${row.date}:${row.home}:${row.away}`;assert(!seen.has(key));seen.add(key);}
  for(const [team,played,scored,conceded] of [[HOME,7,15,6],[AWAY,8,15,6]]){
    const sample=rows.filter(m=>m.home===team||m.away===team);
    assert.equal(sample.length,played);
    assert.equal(sample.reduce((s,m)=>s+(m.home===team?m.homeScore:m.awayScore),0),scored);
    assert.equal(sample.reduce((s,m)=>s+(m.home===team?m.awayScore:m.homeScore),0),conceded);
  }
  return rows.sort(sortMatches);
}
const [,,historicalPath,outPath]=process.argv;
assert(historicalPath&&outPath,'usage: node gauss/tournament/clasico-benchmark.mjs <historical.csv> <report.json>');
const bytes=await readFile(historicalPath);
const parsed=parseHistorical(bytes.toString('utf8'));
const regular=parsed.regular;
const training=regular.filter(m=>m.season<'2023-24');
const validation=regular.filter(m=>m.season==='2023-24');
const holdout=regular.filter(m=>m.season==='2024-25');
const postHoldout=regular.filter(m=>m.season==='2025-26');
assert(training.length>1200 && validation.length>=150 && holdout.length>=150 && postHoldout.length>=150,'insufficient chronological sample');
assert(training.at(-1).date<validation[0].date && validation.at(-1).date<holdout[0].date);
const validationResults=await evaluate(validation,training,'validation');
const quantum=await quantumSelect(validationResults.recipeScores);
const holdoutResults=await evaluate(holdout,[...training,...validation],'holdout',quantum);
const postHoldoutResults=await evaluate(postHoldout,[...training,...validation,...holdout],'2025-26-holdout',quantum);
const current=snapshot();
const recentResults=await evaluate(current,regular,'2026-primary-snapshot',quantum);
assert.equal(recentResults.matches,15);
const preMatch=[...regular,...current].sort(sortMatches);
assert(preMatch.every(m=>m.date<=FROZEN_AT));
const predicted=await predict(preMatch,HOME,AWAY,'clasico-2026-final');
const probabilities={
  leagueBaseline:predicted.baseline,
  gaussClassic:predicted.classic.probs,
  gaussContext:predicted.context.probs,
  quantumSelectedEnsemble:mixForecast(predicted.baseline,predicted.classic.probs,predicted.context.probs,quantum.mix),
};
const sha256=createHash('sha256').update(bytes).digest('hex');
const report={schemaVersion:1,experiment:'clasico-2026-independent-historical-holdout-v1',source:{historical:HISTORICAL_SOURCE,sourceCommit:SOURCE_COMMIT,historicalSha256:`sha256:${sha256}`,historicalRows:parsed.all.length,regularRows:regular.length,america2026:AMERICA_SOURCE,chivas2026:CHIVAS_SOURCE,current2026Rows:current.length,asOf:FROZEN_AT,historicalThrough:'2026-05-24',missing2025_26:false},method:{trainingSeasonEnd:'2022-23',validationSeason:'2023-24',holdoutSeason:'2024-25',sameDateNoLeakage:true,noTrainingOnHoldout:true,models:MODELS,quantumMixCandidates:MIXES,assumptions:['32 independent Bernoulli opportunities per team, not a learned xG model','historical source includes 2025-26 but the 2026-27 seasonal JSON includes only rounds 1 and 2','only 15 primary-sourced 2026 matches for current form; no complete 2026 league feed','xG and injuries omitted because consistent timestamped historical coverage unavailable','Quantum simulation optimizes a pre-holdout ensemble; it is not a separate football forecast']},validation:validationResults,quantum:{...quantum,hardwareExecution:false},holdout:holdoutResults,postHoldout2025_26:postHoldoutResults,recent2026:recentResults,prematch:{date:'2026-09-19',home:HOME,away:AWAY,probabilities,modalScores:{gaussClassic:predicted.classic.modal,gaussContext:predicted.context.modal},meanGoals:{gaussClassic:expectedGoals(preMatch,HOME,AWAY),gaussContext:expectedGoals(preMatch,HOME,AWAY,true)},gaussReceipts:{classic:predicted.classic.reportSha256,context:predicted.context.reportSha256},resultKnown:false}};
const serialized=JSON.stringify(report,null,2)+'\n';
await writeFile(outPath,serialized,{flag:'wx',mode:0o600});
console.log(`CLASICO_FULL_TOURNAMENT=${JSON.stringify({historicalRows:parsed.all.length,regularRows:regular.length,validation:validationResults.matches,holdout:holdoutResults.matches,postHoldout2025_26:postHoldoutResults.matches,postHoldoutMetrics:postHoldoutResults.scores,recent2026:recentResults.matches,recentMetrics:recentResults.scores,quantumSelectedMix:quantum.mix.id,holdoutMetrics:holdoutResults.scores,prematch:report.prematch.probabilities,modalScores:report.prematch.modalScores,historicalSha256:report.source.historicalSha256})}`);
