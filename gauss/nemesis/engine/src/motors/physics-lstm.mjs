import {object,array,number,integer} from './shared.mjs';
import {matrix,vector} from './numerics.mjs';
import {createTape} from '../learning/autodiff.mjs';
import {minimizeBox} from '../learning/box-optimizer.mjs';
const gates=['input','forget','output','candidate'];
function validateModel(model){
 object(model,'physics LSTM model',['gates','peepholes','readout']);object(model.gates,'gates',gates);
 const h=vector(model.gates.input.bias,'input bias',1,8).length,d=array(model.gates.input.input,'input matrix',h,h)[0].length;
 integer(d,'input dimension',1,8);
 const checked={gates:{},peepholes:matrix(model.peepholes,'peepholes',3,h),readout:{}};
 for(const name of gates){const g=object(model.gates[name],name,['input','hidden','bias']);checked.gates[name]={input:matrix(g.input,`${name}.input`,h,d),hidden:matrix(g.hidden,`${name}.hidden`,h,h),bias:vector(g.bias,`${name}.bias`,h,h)};}
 object(model.readout,'readout',['weights','bias']);const o=vector(model.readout.bias,'readout bias',1,8).length;
 checked.readout={weights:matrix(model.readout.weights,'readout weights',o,h),bias:[...model.readout.bias]};
 return {model:checked,h,d,o};
}
function flatten(model){return [...gates.flatMap(name=>[...model.gates[name].input.flat(),...model.gates[name].hidden.flat(),...model.gates[name].bias]),...model.peepholes.flat(),...model.readout.weights.flat(),...model.readout.bias];}
function unflatten(values,{h,d,o}){let at=0;const take=n=>values.slice(at,at+=n),rows=(r,c)=>Array.from({length:r},()=>take(c)),model={gates:{}};for(const name of gates)model.gates[name]={input:rows(h,d),hidden:rows(h,h),bias:take(h)};model.peepholes=rows(3,h);model.readout={weights:rows(o,h),bias:take(o)};return model;}
function expression(raw,allowed,depth=0,counter={n:0}){
 if(++counter.n>128||depth>16)throw new RangeError('physics residual expression budget exceeded');
 if(typeof raw==='number'){number(raw,'residual constant',-1e6,1e6);return (t,env)=>t.constant(raw);}
 if(typeof raw==='string'){if(!allowed.has(raw))throw new TypeError(`unknown residual variable ${raw}`);return (t,env)=>env[raw];}
 object(raw,'residual expression',['op','args']);
 const arity={add:2,sub:2,mul:2,square:1,sin:1,cos:1,exp:1};
 if(!Object.hasOwn(arity,raw.op))throw new TypeError('unsupported residual operation');
 const args=array(raw.args,'residual args',arity[raw.op],arity[raw.op]).map(v=>expression(v,allowed,depth+1,counter));
 return (t,env)=>{const v=args.map(f=>f(t,env));return raw.op==='square'?t.mul(v[0],v[0]):t[raw.op](...v);};
}
function setup(input,{allowUnsupervised=false}={}){
 const shape=validateModel(input.model),{d,o}=shape;
 const sequences=array(input.sequences,'sequences',1,64).map(s=>{
  object(s,'sequence',['inputs','times','targets'],['inputs','times']);
  const inputs=array(s.inputs,'inputs',2,256).map(r=>vector(r,'input',d,d)),times=vector(s.times,'times',inputs.length,inputs.length);
  if(times.some((v,i)=>i&&v-times[i-1]<1e-8))throw new TypeError('times must strictly increase with separation >=1e-8');
  const targets=s.targets===undefined?inputs.map(()=>Array(o).fill(null)):array(s.targets,'targets',inputs.length,inputs.length).map(r=>array(r,'target',o,o).map(v=>v===null?null:number(v,'target')));
  return {inputs,times,targets};
 });
 if(sequences.reduce((sum,s)=>sum+s.inputs.length,0)*shape.h*(shape.h+d+o)>10000)throw new RangeError('LSTM sequence work budget exceeded');
 const allowed=new Set(['t',...Array.from({length:d},(_,j)=>`x${j}`),...Array.from({length:o},(_,j)=>`y${j}`),...Array.from({length:o},(_,j)=>`dy${j}`)]);
 const residuals=array(input.residuals??[],'residuals',0,16).map(r=>expression(r,allowed));
 const physicsWeight=number(input.physicsWeight??1,'physicsWeight',0,1e6),l2=number(input.l2??0,'l2',0,100);
 if(!allowUnsupervised&&!sequences.some(s=>s.targets.some(r=>r.some(v=>v!==null)))&&(!residuals.length||physicsWeight===0))throw new TypeError('at least one supervised target or active physics residual is required');
 const objective=values=>{
  const t=createTape(),params=values.map(t.constant),model=unflatten(params,shape),predictions=[],supervised=[],physics=[];
  for(const seq of sequences){
   let h=Array.from({length:shape.h},()=>t.constant(0)),c=Array.from({length:shape.h},()=>t.constant(0));const output=[];
   for(let step=0;step<seq.inputs.length;step++){
    const x=seq.inputs[step].map(t.constant),linear=(name,j)=>t.sum([model.gates[name].bias[j],t.dot(model.gates[name].input[j],x),t.dot(model.gates[name].hidden[j],h)]);
    const gate=(name,ph)=>Array.from({length:shape.h},(_,j)=>t.sigmoid(t.add(linear(name,j),t.mul(model.peepholes[ph][j],c[j]))));
    const i=gate('input',0),f=gate('forget',1),g=Array.from({length:shape.h},(_,j)=>t.tanh(linear('candidate',j)));
    c=c.map((v,j)=>t.add(t.mul(f[j],v),t.mul(i[j],g[j])));const out=gate('output',2);
    h=c.map((v,j)=>t.mul(out[j],t.tanh(v)));
    const y=model.readout.bias.map((b,j)=>t.add(b,t.dot(model.readout.weights[j],h)));output.push(y);
    seq.targets[step].forEach((target,j)=>{if(target!==null){const e=t.sub(y[j],t.constant(target));supervised.push(t.mul(e,e));}});
    if(step>0){const env={t:t.constant(seq.times[step])};x.forEach((v,j)=>env[`x${j}`]=v);y.forEach((v,j)=>{env[`y${j}`]=v;env[`dy${j}`]=t.scale(t.sub(v,output[step-1][j]),1/(seq.times[step]-seq.times[step-1]));});for(const residual of residuals){const r=residual(t,env);physics.push(t.mul(r,r));}}
   }
   predictions.push(output.map(row=>row.map(v=>v.value)));
  }
  const supervisedLoss=t.scale(t.sum(supervised),1/Math.max(1,supervised.length)),physicsLoss=t.scale(t.sum(physics),1/Math.max(1,physics.length));
  const loss=t.sum([supervisedLoss,t.scale(physicsLoss,physicsWeight),t.scale(t.sum(params.map(v=>t.mul(v,v))),l2/2)]);t.backward(loss);
  return {value:loss.value,gradient:params.map(v=>v.gradient),supervisedLoss:supervisedLoss.value,physicsLoss:physicsLoss.value,predictions,tapeNodes:t.size()};
 };
 return {shape,initial:flatten(shape.model),objective};
}
const fields=['model','sequences','residuals','physicsWeight','l2'];
export function physicsLSTMLoss(input){object(input,'physics LSTM loss',fields,['model','sequences']);const s=setup(input);return s.objective(s.initial);}
export function trainPhysicsLSTM(input){
 object(input,'physics LSTM training',[...fields,'iterations','tolerance'],['model','sequences']);const s=setup(input);
 const bound=1e4;if(s.initial.some(v=>Math.abs(v)>bound))throw new RangeError('initial LSTM weight outside training bounds');
 const fit=minimizeBox(s.objective,s.initial,s.initial.map(()=>-bound),s.initial.map(()=>bound),{iterations:integer(input.iterations??300,'iterations',1,10000),tolerance:number(input.tolerance??1e-6,'tolerance',1e-12,.1)});
 const final=s.objective(fit.parameters);
 return {domain:'PHYSICS_RESIDUAL_TRAINED_PEEPHOLE_LSTM',status:fit.status,model:unflatten(fit.parameters,s.shape),optimization:fit,supervisedLoss:final.supervisedLoss,physicsLoss:final.physicsLoss,predictions:final.predictions,physicsDiscretization:'backward time differences at supplied timestamps; residuals omit first timestep',globalOptimumGuaranteed:false};
}

export function inferPhysicsLSTM(input){
 object(input,'physics LSTM inference',['model','sequences']);
 const s=setup({...input,residuals:[],physicsWeight:0,l2:0},{allowUnsupervised:true}),r=s.objective(s.initial);
 return {domain:'TRAINED_PHYSICS_LSTM_INFERENCE',predictions:r.predictions};
}
