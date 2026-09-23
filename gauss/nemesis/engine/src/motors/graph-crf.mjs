import {object,array,number,integer,unique} from './shared.mjs';
import {vector,dot} from './numerics.mjs';
import {minimizeBox} from '../learning/box-optimizer.mjs';
const MAX_STATES=65536,MAX_WORK=10000000;
function compile(raw,dimensions){
  object(raw,'CRF graph',['variables','factors']);
  const variables=array(raw.variables,'variables',1,32).map(v=>integer(v,'cardinality',2,32));
  let states=1;for(const k of variables){states*=k;if(states>MAX_STATES)throw new RangeError('exact CRF state budget exceeded');}
  const factors=array(raw.factors,'factors',1,128).map(f=>{
    object(f,'factor',['scope','features']);
    const scope=unique(array(f.scope,'scope',1,variables.length).map(v=>integer(v,'variable index',0,variables.length-1)),'scope');
    const rows=scope.reduce((n,v)=>n*variables[v],1);
    const features=array(f.features,'feature table',rows,rows).map(r=>vector(r,'feature vector',dimensions,dimensions).map(v=>number(v,'feature',-1e6,1e6)));
    return {scope,features};
  });
  if(states*factors.length*dimensions>MAX_WORK)throw new RangeError('exact CRF operation budget exceeded');
  function featuresFor(labels){
    const phi=Array(dimensions).fill(0);
    for(const f of factors){let row=0;for(const v of f.scope)row=row*variables[v]+labels[v];for(let j=0;j<dimensions;j++)phi[j]+=f.features[row][j];}
    return phi;
  }
  return {variables,states,featuresFor,work:states*factors.length*dimensions};
}
function enumerate(graph,weights){
  const labels=Array(graph.variables.length).fill(0),marginals=graph.variables.map(k=>Array(k).fill(0)),expected=Array(weights.length).fill(0);
  let maximum=-Infinity,z=0,best=-Infinity,mapLabels=null;
  for(let state=0;state<graph.states;state++){
    const phi=graph.featuresFor(labels),score=dot(weights,phi);
    if(!Number.isFinite(score))throw new RangeError('CRF score overflow');
    if(score>best){best=score;mapLabels=[...labels];}
    if(score>maximum){const scale=Math.exp(maximum-score);z*=scale;for(let j=0;j<expected.length;j++)expected[j]*=scale;for(const row of marginals)for(let j=0;j<row.length;j++)row[j]*=scale;maximum=score;}
    const mass=Math.exp(score-maximum);z+=mass;
    for(let j=0;j<expected.length;j++)expected[j]+=mass*phi[j];
    for(let j=0;j<labels.length;j++)marginals[j][labels[j]]+=mass;
    for(let j=labels.length-1;j>=0;j--){labels[j]++;if(labels[j]<graph.variables[j])break;labels[j]=0;}
  }
  return {logPartition:maximum+Math.log(z),marginals:marginals.map(r=>r.map(v=>v/z)),expectedFeatures:expected.map(v=>v/z),mapLabels,mapLogScore:best,statesEnumerated:graph.states};
}
function weights(raw){return vector(raw,'weights',1,64).map(v=>number(v,'weight',-1e6,1e6));}
export function inferGraphCRF(input){
  object(input,'graph CRF',['graph','weights']);const w=weights(input.weights),graph=compile(input.graph,w.length);
  return {domain:'EXACT_FINITE_GRAPH_CRF',...enumerate(graph,w),exact:true,limits:{maxStates:MAX_STATES,maxOperations:MAX_WORK}};
}
function data(input){
  const w=weights(input.initialWeights),examples=array(input.examples,'examples',1,256).map(e=>{
    object(e,'example',['graph','labels']);const graph=compile(e.graph,w.length),labels=array(e.labels,'labels',graph.variables.length,graph.variables.length).map((v,i)=>integer(v,'label',0,graph.variables[i]-1));
    return {graph,observed:graph.featuresFor(labels)};
  });
  if(examples.reduce((s,e)=>s+e.graph.work,0)>MAX_WORK)throw new RangeError('CRF training work budget exceeded');
  const l2=number(input.l2??.01,'l2',0,100);
  const objective=w=>{
    let value=0;const gradient=Array(w.length).fill(0);
    for(const e of examples){const r=enumerate(e.graph,w);value+=r.logPartition-dot(w,e.observed);for(let j=0;j<w.length;j++)gradient[j]+=r.expectedFeatures[j]-e.observed[j];}
    value=value/examples.length+l2*dot(w,w)/2;
    return {value,gradient:gradient.map((v,j)=>v/examples.length+l2*w[j])};
  };
  return {w,examples,objective};
}
export function graphCRFLoss(input){
  object(input,'CRF loss',['examples','initialWeights','l2'],['examples','initialWeights']);const d=data(input);return d.objective(d.w);
}
export function trainGraphCRF(input){
  object(input,'CRF training',['examples','initialWeights','l2','iterations','tolerance'],['examples','initialWeights']);
  const {w,examples,objective}=data(input),iterations=integer(input.iterations??300,'iterations',1,10000),tolerance=number(input.tolerance??1e-7,'tolerance',1e-12,.1);
  const result=minimizeBox(objective,w,w.map(()=>-1e6),w.map(()=>1e6),{iterations,tolerance});
  return {domain:'SUPERVISED_FINITE_GRAPH_CRF',status:result.status,weights:result.parameters,optimization:result,predictions:examples.map(e=>enumerate(e.graph,result.parameters).mapLabels),trainedParameters:'all supplied feature weights',exactInference:true};
}
