import {object,array,number,integer} from './shared.mjs';
import {matrix,vector,seeded} from './numerics.mjs';
import {createTape} from '../learning/autodiff.mjs';
import {minimizeBox} from '../learning/box-optimizer.mjs';
export function initializeGraphNetwork(input){
 object(input,'GCN initializer',['dimensions','seed']);const dims=array(input.dimensions,'dimensions',2,9).map(v=>integer(v,'dimension',1,32)),rng=seeded(integer(input.seed,'seed',0,2**32-1));
 if(dims.at(-1)<2)throw new TypeError('classification needs >=2 classes');
 return {layers:dims.slice(1).map((out,i)=>({weights:Array.from({length:out},()=>Array.from({length:dims[i]},()=>(rng()*2-1)*Math.sqrt(6/(dims[i]+out)))),bias:Array(out).fill(0),activation:i===dims.length-2?'linear':'tanh'}))};
}
function setup(input,{allowUnlabeled=false}={}){
 object(input.model,'GCN model',['layers']);let din=null;
 const shapes=array(input.model.layers,'layers',1,8).map((l,i)=>{
  object(l,'layer',['weights','bias','activation']);const out=vector(l.bias,'bias',1,32).length,rows=array(l.weights,'weights',out,out),cols=array(rows[0],'weight row',1,32).length;
  if(i&&cols!==din)throw new TypeError('layer dimension mismatch');din=out;
  if(!['tanh','linear'].includes(l.activation))throw new TypeError('activation must be tanh or linear');
  return {weights:matrix(l.weights,'weights',out,cols),bias:[...l.bias],activation:l.activation,out,cols};
 });
 if(shapes.at(-1).activation!=='linear'||din<2)throw new TypeError('last layer must produce >=2 linear class logits');
 const d=shapes[0].cols,classes=din;
 const examples=array(input.examples,'examples',1,64).map(e=>{
  object(e,'GCN example',['features','adjacency','labels']);const features=array(e.features,'features',1,128).map(r=>vector(r,'features row',d,d)),n=features.length;
  const A=matrix(e.adjacency,'adjacency',n,n);for(let i=0;i<n;i++)for(let j=0;j<n;j++){number(A[i][j],'adjacency',0,1e6);if(Math.abs(A[i][j]-A[j][i])>1e-12)throw new TypeError('GCN adjacency must be symmetric');}
  const degree=A.map((r,i)=>r.reduce((s,v)=>s+v,0)+1),normalized=A.map((r,i)=>r.map((v,j)=>(v+ +(i===j))/Math.sqrt(degree[i]*degree[j])));
  const labels=array(e.labels,'labels',n,n).map(v=>v===null?null:integer(v,'class label',0,classes-1));return {features,normalized,labels};
 });
 const labelCount=examples.reduce((s,e)=>s+e.labels.filter(v=>v!==null).length,0);if(!labelCount&&!allowUnlabeled)throw new TypeError('at least one labeled node is required');
 const estimate=examples.reduce((s,e)=>s+shapes.reduce((v,l)=>v+e.features.length*(e.features.length*l.cols+l.out*l.cols),0),0);
 if(estimate>20000)throw new RangeError('GCN training work budget exceeded');
 const l2=number(input.l2??.001,'l2',0,100),initial=shapes.flatMap(l=>[...l.weights.flat(),...l.bias]);
 function unflatten(values){let at=0;return {layers:shapes.map(l=>({weights:Array.from({length:l.out},()=>{const r=values.slice(at,at+l.cols);at+=l.cols;return r;}),bias:(()=>{const r=values.slice(at,at+l.out);at+=l.out;return r;})(),activation:l.activation}))};}
 function objective(values){
  const t=createTape(),params=values.map(t.constant),model=unflatten(params),losses=[],predictions=[],probabilities=[];
  for(const e of examples){let X=e.features.map(r=>r.map(t.constant));
   for(const layer of model.layers){
    const agg=e.normalized.map(r=>Array.from({length:X[0].length},(_,j)=>t.sum(r.map((weight,k)=>t.scale(X[k][j],weight)))));
    X=agg.map(row=>layer.weights.map((w,k)=>{const v=t.add(t.dot(w,row),layer.bias[k]);return layer.activation==='tanh'?t.tanh(v):v;}));
   }
   const probs=X.map(row=>{const max=Math.max(...row.map(v=>v.value)),mass=row.map(v=>Math.exp(v.value-max)),z=mass.reduce((s,v)=>s+v,0);return mass.map(v=>v/z);});
   predictions.push(probs.map(row=>row.indexOf(Math.max(...row))));probabilities.push(probs);
   e.labels.forEach((label,i)=>{if(label!==null)losses.push(t.sub(t.logsumexp(X[i]),X[i][label]));});
  }
  const dataLoss=t.scale(t.sum(losses),1/Math.max(1,labelCount)),loss=t.add(dataLoss,t.scale(t.sum(params.map(v=>t.mul(v,v))),l2/2));t.backward(loss);
  return {value:loss.value,gradient:params.map(v=>v.gradient),dataLoss:dataLoss.value,predictions,probabilities};
 }
 return {initial,objective,unflatten};
}
export function graphNetworkLoss(input){object(input,'GCN loss',['model','examples','l2'],['model','examples']);const s=setup(input);return s.objective(s.initial);}
export function trainGraphNetwork(input){
 object(input,'GCN training',['model','examples','l2','iterations','tolerance'],['model','examples']);const s=setup(input);
 if(s.initial.some(v=>Math.abs(v)>1e4))throw new RangeError('initial GCN weight outside training bounds');
 const fit=minimizeBox(s.objective,s.initial,s.initial.map(()=>-1e4),s.initial.map(()=>1e4),{iterations:integer(input.iterations??300,'iterations',1,10000),tolerance:number(input.tolerance??1e-6,'tolerance',1e-12,.1)});
 const final=s.objective(fit.parameters);
 return {domain:'TRAINED_MULTILAYER_GRAPH_CONVOLUTION_NETWORK',status:fit.status,model:s.unflatten(fit.parameters),optimization:fit,predictions:final.predictions,probabilities:final.probabilities,dataLoss:final.dataLoss,normalization:'D^-1/2 (A+I) D^-1/2; undirected graph',globalOptimumGuaranteed:false};
}

export function inferGraphNetwork(input){
 object(input,'GCN inference',['model','graphs']);
 const examples=array(input.graphs,'graphs',1,64).map(g=>{object(g,'inference graph',['features','adjacency']);return {...g,labels:array(g.features,'features',1,128).map(()=>null)};});
 const s=setup({model:input.model,examples,l2:0},{allowUnlabeled:true}),r=s.objective(s.initial);
 return {domain:'MULTILAYER_GRAPH_CONVOLUTION_INFERENCE',predictions:r.predictions,probabilities:r.probabilities};
}
