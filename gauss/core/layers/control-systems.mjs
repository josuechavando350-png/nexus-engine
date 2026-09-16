// First-party, dimension- and horizon-bounded discrete-time control methods.
// Numerical outputs are model calculations, not claims about a physical plant.
const seal=Object.freeze;
const num=(v,name,limit=1e5)=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>limit)throw new TypeError(`${name} must be finite and bounded`);return v;};
const int=(v,name,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw new TypeError(`${name} must be integer in [${min},${max}]`);return v;};
const safe=(v,name)=>{if(!Number.isFinite(v))throw new RangeError(`${name} numerical overflow`);return v;};
function vector(xs,name,n=null,max=8){if(!Array.isArray(xs)||!xs.length||xs.length>max||(n!==null&&xs.length!==n))throw new TypeError(`${name} dimension invalid`);return xs.map((v,i)=>num(v,`${name}[${i}]`));}
function matrix(xs,name,rows=null,cols=null){if(!Array.isArray(xs)||!xs.length||xs.length>8||(rows!==null&&xs.length!==rows))throw new TypeError(`${name} row dimension invalid`);
 const size=cols??xs[0]?.length;if(!Number.isSafeInteger(size)||size<1||size>8)throw new TypeError(`${name} column dimension invalid`);
 return xs.map((row,i)=>vector(row,`${name}[${i}]`,size));}
const identity=n=>Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>Number(i===j)));
const transpose=m=>m[0].map((_,j)=>m.map(row=>row[j]));
const mm=(a,b)=>{const bt=transpose(b);return a.map(row=>bt.map(col=>safe(row.reduce((s,v,i)=>s+v*col[i],0),'matrix product')));};
const add=(a,b)=>a.map((row,i)=>row.map((v,j)=>safe(v+b[i][j],'matrix sum')));
const mv=(a,v)=>a.map(row=>safe(row.reduce((s,x,i)=>s+x*v[i],0),'state'));
const freezeMat=m=>seal(m.map(row=>seal(row)));
function dynamics(A,B){const a=matrix(A,'A'),n=a.length;if(a[0].length!==n)throw new TypeError('A must be square');const b=matrix(B,'B',n);return {a,b,n,m:b[0].length};}
function integerRank(m){const a=m.map(row=>row.map(v=>BigInt(int(v,'rank matrix element',-1e12,1e12)))),n=a.length,cols=a[0].length;
 let r=0;for(let j=0;j<cols&&r<n;j++){
  let pivot=r;while(pivot<n&&a[pivot][j]===0n)pivot++;if(pivot===n)continue;
  [a[r],a[pivot]]=[a[pivot],a[r]];for(let i=r+1;i<n;i++){
   const factor=a[i][j],den=a[r][j];if(factor===0n)continue;
   for(let k=j;k<cols;k++)a[i][k]=a[i][k]*den-a[r][k]*factor;
   const common=a[i].reduce((g,v)=>{if(v<0n)v=-v;while(v){[g,v]=[v,g%v];}return g;},0n);
   if(common>1n)for(let k=j;k<cols;k++)a[i][k]/=common;
  }r++;
 }return r;
}
function integerSystem(A,B){const {a,b,n,m}=dynamics(A,B);
 for(const v of [...a.flat(),...b.flat()])int(v,'integer system',-5,5);
 if(n>5||m>3)throw new RangeError('exact-rank dimension exceeds bounded budget');
 return {a,b,n,m};
}
export function linearStateSpaceTrajectory({A,B,initial,controls}){
 const {a,b,n,m}=dynamics(A,B),start=vector(initial,'initial',n);
 if(!Array.isArray(controls)||controls.length>1000)throw new TypeError('controls horizon must be <=1000');
 const u=controls.map((row,i)=>vector(row,`controls[${i}]`,m));let state=start;
 const states=[seal(state)];for(const action of u){const ax=mv(a,state),bu=mv(b,action);state=ax.map((x,i)=>safe(x+bu[i],'linear state'));states.push(seal(state));}
 return seal({states:seal(states),steps:u.length});
}
export function finiteControllabilityGramian({A,B,horizon}){
 const {a,b,n}=dynamics(A,B),h=int(horizon,'horizon',0,60);
 let power=identity(n),sum=Array.from({length:n},()=>Array(n).fill(0));
 for(let t=0;t<h;t++){const x=mm(power,b);sum=add(sum,mm(x,transpose(x)));power=mm(power,a);}
 return seal({gramian:freezeMat(sum),horizon:h});
}
export function finiteObservabilityGramian({A,C,horizon}){
 const a=matrix(A,'A'),n=a.length;if(a[0].length!==n)throw new TypeError('A must be square');const c=matrix(C,'C');if(c[0].length!==n)throw new TypeError('C column count must match states');
 const h=int(horizon,'horizon',0,60);let power=identity(n),sum=Array.from({length:n},()=>Array(n).fill(0));
 for(let t=0;t<h;t++){const x=mm(c,power);sum=add(sum,mm(transpose(x),x));power=mm(power,a);}
 return seal({gramian:freezeMat(sum),horizon:h});
}
export function exactControllabilityRank({A,B}){
 const {a,b,n}=integerSystem(A,B);let p=identity(n),block=Array.from({length:n},()=>[]);
 for(let t=0;t<n;t++){const cols=mm(p,b);block=block.map((row,i)=>[...row,...cols[i]]);p=mm(p,a);}
 const rank=integerRank(block);return seal({rank,fullyControllable:rank===n,columns:block[0].length});
}
export function exactObservabilityRank({A,C}){
 const a=matrix(A,'A'),n=a.length;if(a[0].length!==n||n>5)throw new TypeError('A shape exceeds rank bounds');const c=matrix(C,'C');
 if(c[0].length!==n||c.length>3)throw new TypeError('C shape exceeds rank bounds');for(const v of [...a.flat(),...c.flat()])int(v,'integer system',-5,5);
 let p=identity(n),rows=[];for(let t=0;t<n;t++){rows.push(...mm(c,p));p=mm(p,a);}
 const rank=integerRank(transpose(rows));return seal({rank,fullyObservable:rank===n,rows:rows.length});
}
function kalmanInputs(v){const a=num(v.a,'a',10),q=num(v.processVariance,'processVariance'),r=num(v.measurementVariance,'measurementVariance');
 if(q<0||r<=0)throw new TypeError('processVariance must be nonnegative and measurementVariance positive');
 const mean=num(v.initialMean,'initialMean'),variance=num(v.initialVariance,'initialVariance');if(variance<0)throw new TypeError('initialVariance must be nonnegative');
 if(!Array.isArray(v.observations)||v.observations.length>1000)throw new TypeError('observations length must be <=1000');
 return {a,q,r,mean,variance,observations:v.observations.map((o,i)=>num(o,`observations[${i}]`))};
}
function filter(parameters){const {a,q,r,mean,variance,observations}=kalmanInputs(parameters),states=[];
 let x=mean,p=variance,logLikelihood=0;
 for(const y of observations){const predictedMean=safe(a*x,'Kalman predicted mean'),predictedVariance=safe(a*a*p+q,'Kalman predicted variance');
  const innovationVariance=safe(predictedVariance+r,'Kalman innovation variance');if(!(innovationVariance>0))throw new RangeError('Kalman innovation covariance invalid');
  const gain=predictedVariance/innovationVariance,innovation=y-predictedMean;
  x=safe(predictedMean+gain*innovation,'Kalman mean');p=safe((1-gain)*predictedVariance,'Kalman variance');
  logLikelihood=safe(logLikelihood-.5*(Math.log(2*Math.PI*innovationVariance)+innovation*innovation/innovationVariance),'Kalman log likelihood');
  states.push({predictedMean,predictedVariance,filteredMean:x,filteredVariance:p,gain});
 }return {a,q,mean,variance,states,logLikelihood};
}
export function scalarKalmanFilter(v){const f=filter(v);return seal({estimates:seal(f.states.map(s=>seal({mean:s.filteredMean,variance:s.filteredVariance,gain:s.gain}))),logLikelihood:f.logLikelihood});}
export function scalarRauchTungStriebelSmoother(v){const f=filter(v),n=f.states.length;
 const smoothed=f.states.map(s=>({mean:s.filteredMean,variance:s.filteredVariance}));
 for(let t=n-2;t>=0;t--){const current=f.states[t],next=f.states[t+1];
  const coefficient=next.predictedVariance===0?0:current.filteredVariance*f.a/next.predictedVariance;
  smoothed[t].mean=safe(current.filteredMean+coefficient*(smoothed[t+1].mean-next.predictedMean),'RTS smoothed mean');
  smoothed[t].variance=safe(current.filteredVariance+coefficient*coefficient*(smoothed[t+1].variance-next.predictedVariance),'RTS smoothed variance');
  if(smoothed[t].variance < -1e-9)throw new RangeError('RTS negative covariance');
  smoothed[t].variance=Math.max(0,smoothed[t].variance);
 }
 return seal({smoothed:seal(smoothed.map(x=>seal(x))),logLikelihood:f.logLikelihood});
}
export function boundedPidController({targets,measurements,kp,ki,kd,dt,integralLimit}){
 const p=num(kp,'kp'),i=num(ki,'ki'),d=num(kd,'kd'),step=num(dt,'dt'),limit=num(integralLimit,'integralLimit');
 if(step<=0||limit<0)throw new TypeError('dt must be positive and integralLimit nonnegative');
 if(!Array.isArray(targets)||!Array.isArray(measurements)||targets.length!==measurements.length||targets.length>1000)throw new TypeError('targets and measurements must have the same bounded length');
 let accumulated=0,previous=0;const actions=[];
 for(let k=0;k<targets.length;k++){
  const error=num(targets[k],`targets[${k}]`)-num(measurements[k],`measurements[${k}]`);
  accumulated=Math.max(-limit,Math.min(limit,safe(accumulated+error*step,'PID integral')));
  const derivative=k===0?0:(error-previous)/step;
  actions.push(safe(p*error+i*accumulated+d*derivative,'PID command'));previous=error;
 }
 return seal({commands:seal(actions),terminalIntegral:accumulated});
}
function solve(a,b){const n=a.length,m=a.map((row,i)=>[...row,b[i]]);
 for(let k=0;k<n;k++){let pivot=k;for(let j=k+1;j<n;j++)if(Math.abs(m[j][k])>Math.abs(m[pivot][k]))pivot=j;
  if(Math.abs(m[pivot][k])<1e-12)throw new RangeError('LQR gain system not invertible');[m[k],m[pivot]]=[m[pivot],m[k]];
  for(let j=k+1;j<n;j++){const f=m[j][k]/m[k][k];for(let x=k;x<=n;x++)m[j][x]-=f*m[k][x];}
 }const result=Array(n).fill(0);for(let i=n-1;i>=0;i--){let rhs=m[i][n];for(let j=i+1;j<n;j++)rhs-=m[i][j]*result[j];result[i]=safe(rhs/m[i][i],'LQR gain');}return result;
}
export function finiteHorizonDiagonalCostLqr({A,B,statePenalties,controlPenalties,terminalPenalties,horizon,initialState}){
 const {a,b,n,m}=dynamics(A,B),h=int(horizon,'horizon',0,64),x0=vector(initialState,'initialState',n);
 const q=vector(statePenalties,'statePenalties',n),r=vector(controlPenalties,'controlPenalties',m),end=vector(terminalPenalties,'terminalPenalties',n);
 if([...q,...end].some(x=>x<0)||r.some(x=>x<=0))throw new TypeError('LQR penalties must be nonnegative with positive controls');
 const diag=xs=>xs.map((x,i)=>xs.map((_,j)=>i===j?x:0));let p=diag(end),gains=[];
 for(let t=h-1;t>=0;t--){const bt=transpose(b),bTp=mm(bt,p),s=add(mm(bTp,b),diag(r)),f=mm(bTp,a);
  const k=Array.from({length:m},()=>Array(n).fill(0));for(let j=0;j<n;j++){
   const column=solve(s,f.map(row=>row[j]));for(let i=0;i<m;i++)k[i][j]=column[i];}
  const aTp=mm(transpose(a),p),correction=mm(mm(aTp,b),k);
  const next=add(diag(q),mm(aTp,a).map((row,i)=>row.map((v,j)=>safe(v-correction[i][j],'LQR Riccati'))));
  p=next;gains.unshift(freezeMat(k));
 }
 let state=x0,cost=0;const controls=[];for(const k of gains){const command=mv(k,state).map(v=>-v);controls.push(seal(command));
  cost=safe(cost+state.reduce((sum,v,j)=>sum+q[j]*v*v,0)+command.reduce((sum,v,j)=>sum+r[j]*v*v,0),'LQR cost');
  const ax=mv(a,state),bu=mv(b,command);state=ax.map((v,j)=>safe(v+bu[j],'LQR state'));
 }
 cost=safe(cost+state.reduce((sum,v,j)=>sum+end[j]*v*v,0),'LQR terminal cost');
 const optimalCost=x0.reduce((sum,v,i)=>sum+v*mv(p,x0)[i],0);
 return seal({optimalCost:safe(optimalCost,'LQR optimal cost'),realizedCost:cost,gains:seal(gains),controls:seal(controls),terminalState:seal(state)});
}
export function stableScalarLyapunovCertificate({a,forcing}){
 const scalar=num(a,'a',100),q=num(forcing,'forcing');if(Math.abs(scalar)>=1||q<=0)throw new TypeError('stable scalar Lyapunov requires |a| < 1 and positive forcing');
 const variance=safe(q/(1-scalar*scalar),'Lyapunov variance');return seal({variance,residual:safe(variance-scalar*scalar*variance-q,'Lyapunov residual')});
}
export function scalarMinimumEnergyReachability({a,b,initial,target,horizon}){
 const aa=num(a,'a',10),bb=num(b,'b',10),x0=num(initial,'initial'),goal=num(target,'target'),h=int(horizon,'horizon',0,128);
 const free=safe(aa**h*x0,'uncontrolled final state'),delta=goal-free;
 if(h===0){if(delta!==0)throw new RangeError('horizon zero cannot reach distinct target');return seal({controls:seal([]),minimumEnergy:0,terminalState:x0});}
 const weights=Array.from({length:h},(_,k)=>safe(bb*aa**(h-1-k),'reachability weight'));
 const gram=weights.reduce((sum,v)=>safe(sum+v*v,'reachability Gramian'),0);
 if(!(gram>0)){if(delta!==0)throw new RangeError('target is unreachable');return seal({controls:seal(Array(h).fill(0)),minimumEnergy:0,terminalState:free});}
 const controls=weights.map(w=>safe(w*delta/gram,'minimum-energy command'));
 let state=x0;for(const command of controls)state=safe(aa*state+bb*command,'controlled state');
 if(Math.abs(state-goal)>1e-8*Math.max(1,Math.abs(goal)))throw new RangeError('minimum-energy terminal residual exceeded tolerance');
 return seal({controls:seal(controls),minimumEnergy:safe(controls.reduce((s,u)=>s+u*u,0),'minimum energy'),terminalState:state});
}
export function scalarIntervalReachability({a,b,initial,controlLower,controlUpper,horizon}){
 const aa=num(a,'a',10),bb=num(b,'b',10),x0=num(initial,'initial'),u0=num(controlLower,'controlLower'),u1=num(controlUpper,'controlUpper'),h=int(horizon,'horizon',0,1000);
 if(u0>u1)throw new TypeError('controlLower must not exceed controlUpper');
 let low=x0,high=x0;const bounds=[seal({lower:low,upper:high})];
 for(let t=0;t<h;t++){
  const ends=[aa*low+bb*u0,aa*low+bb*u1,aa*high+bb*u0,aa*high+bb*u1];
  low=safe(Math.min(...ends),'reachable lower bound');high=safe(Math.max(...ends),'reachable upper bound');bounds.push(seal({lower:low,upper:high}));
 }
 return seal({bounds:seal(bounds),steps:h});
}