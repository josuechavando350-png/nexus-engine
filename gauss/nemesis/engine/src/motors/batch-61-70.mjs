import {randomInt, randomBytes, createHash} from 'node:crypto';
import {array,object,number,integer,unique,id} from './shared.mjs';
import {vector,matrix,dot,solveLinear,leastSquares,seeded,normal} from './numerics.mjs';
import {computePersistentHomology} from './persistent-homology.mjs';
const sum = a => a.reduce((s,x)=>s+x,0);
const finite = (v,n) => number(v,n,-1e12,1e12);
const probability = (x,label) => number(x,label,0,1);
function simplex(row,label,n){const p=vector(row,label,n,n);if(p.some(x=>x<0||x>1)||Math.abs(sum(p)-1)>1e-9)throw new TypeError(`${label} probability row sum`);return p;}
const softmax = v => {const m=Math.max(...v),w=v.map(x=>Math.exp(x-m)),z=sum(w);return w.map(x=>x/z);};
const matvec = (A,x) => A.map(row=>dot(row,x));
const transpose = A=>A[0].map((_,j)=>A.map(r=>r[j]));
const multiply = (A,B)=>A.map(r=>B[0].map((_,j)=>dot(r,B.map(x=>x[j]))));
const mod = (x,q)=>((x%q)+q)%q;

// #61: per-record epsilon-LDP categorical randomized response; no raw categories in output.
export function ingestLocalDifferentialPrivacy(input){
 object(input,'local privacy',['categories','responses','epsilon','maxEpsilon'],['categories','responses','epsilon']);
 const cats=unique(array(input.categories,'categories',2,32).map(x=>id(x,'category')),'categories');
 const responses=array(input.responses,'responses',1,100000);const epsilon=number(input.epsilon,'epsilon',0.001,16);
 if(input.maxEpsilon!==undefined&&epsilon>number(input.maxEpsilon,'maxEpsilon',0.001,16))throw new RangeError('privacy budget exceeded');
 const k=cats.length,e=Math.exp(epsilon),threshold=Math.floor(e/(e+k-1)*2**32),p=threshold/2**32,other=(1-p)/(k-1);
 const privatized=responses.map(v=>{if(!cats.includes(v))throw new TypeError('unknown response category');return randomInt(0,2**32)<threshold?v:cats[(cats.indexOf(v)+1+randomInt(k-1))%k];});
 const counts=Object.fromEntries(cats.map(c=>[c,privatized.filter(v=>v===c).length]));
 const unbiased=Object.fromEntries(cats.map(c=>[c,(counts[c]-other*responses.length)/(p-other)]));
 return {domain:'CATEGORICAL_LOCAL_DIFFERENTIAL_PRIVACY',epsilon,mechanism:'k-ary randomized response',sampleCount:responses.length,report:privatized,reportedCounts:counts,unbiasedEstimatedCounts:unbiased,guarantee:'epsilon-LDP per independently randomized record; no composition budget inferred across calls'};
}

// #62: causal temporal graph attention forward pass; weights are supplied, not trained.
export function temporalGraphAttention(input){
 object(input,'TGAT',['features','events','queries','projection','decay'],['features','events','queries','projection']);
 const f=array(input.features,'features',1,128).map((v,i)=>vector(v,`features[${i}]`,1,16)),d=f[0].length;
 if(f.some(v=>v.length!==d))throw new TypeError('feature dimension mismatch');
 const w=vector(input.projection,'projection',2*d,2*d),decay=number(input.decay??0,'decay',0,100);
 const events=array(input.events,'events',0,4096).map((v,i)=>{object(v,`event${i}`,['source','target','time','weight'],['source','target','time']);return {source:integer(v.source,'source',0,f.length-1),target:integer(v.target,'target',0,f.length-1),time:finite(v.time,'time'),weight:number(v.weight??1,'weight',0,1e6)};});
 const queries=array(input.queries,'queries',1,1024).map((q,i)=>{object(q,`query${i}`,['node','time'],['node','time']);return {node:integer(q.node,'node',0,f.length-1),time:finite(q.time,'time')};});
 const results=queries.map(({node,time})=>{const past=events.filter(e=>e.target===node&&e.time<time).sort((a,b)=>a.time-b.time);if(!past.length)return {node,time,embedding:[...f[node]],attention:[]};const scores=past.map(e=>dot(w,[...f[node],...f[e.source]])-decay*(time-e.time)+Math.log(Math.max(e.weight,1e-300)));const att=softmax(scores);return {node,time,embedding:Array.from({length:d},(_,j)=>sum(past.map((e,i)=>att[i]*f[e.source][j]))),attention:past.map((e,i)=>({source:e.source,eventTime:e.time,weight:att[i]}))};});
 return {domain:'CAUSAL_TEMPORAL_GRAPH_ATTENTION_FORWARD',results,trained:false};
}

// #63: least-squares dynamic-mode operator fitted to paired time snapshots.
export function dynamicModeDecomposition(input){
 object(input,'DMD',['snapshots','ridge','forecastSteps'],['snapshots']);
 const snapshots=array(input.snapshots,'snapshots',3,2000).map((r,i)=>vector(r,`snapshot${i}`,1,12)),n=snapshots[0].length;
 if(snapshots.some(x=>x.length!==n))throw new TypeError('ragged snapshots');
 const ridge=number(input.ridge??1e-10,'ridge',0,1e4),steps=integer(input.forecastSteps??1,'forecastSteps',0,128);
 const X=snapshots.slice(0,-1),Y=snapshots.slice(1);const A=Array.from({length:n},(_,j)=>leastSquares(X,Y.map(row=>row[j]),ridge));
 const residual=Math.sqrt(sum(X.map((x,i)=>sum(matvec(A,x).map((v,j)=>(v-Y[i][j])**2))))/X.length);
 const forecast=[];let value=snapshots.at(-1);for(let t=0;t<steps;t++){value=matvec(A,value);if(value.some(v=>!Number.isFinite(v)||Math.abs(v)>1e100))throw new RangeError('unstable DMD forecast');forecast.push(value);}
 return {domain:'LEAST_SQUARES_DYNAMIC_MODE_DECOMPOSITION',operator:A,rootMeanSquaredResidual:residual,forecast,assumption:'fixed linear snapshot operator; eigenmode extraction not included'};
}

// #64: exact finite-horizon belief-tree Bellman recursion for small known tabular POMDP.
export function solveFinitePOMDP(input){
 object(input,'POMDP',['transition','observation','rewards','belief','horizon','discount'],['transition','observation','rewards','belief','horizon']);
 const transitions=array(input.transition,'transition',1,6),n=transitions.length,m=array(transitions[0],'state actions',1,3).length;
 const T=transitions.map((byA,s)=>array(byA,`T${s}`,m,m).map((row,a)=>simplex(row,`T${s}:${a}`,n)));
 const obs=array(input.observation,'observation',m,m).map((byS,a)=>array(byS,`O${a}`,n,n).map((r,s)=>simplex(r,`O${a}:${s}`,r.length)));
 const o=obs[0][0].length;if(o>3||obs.some(a=>a.some(s=>s.length!==o)))throw new TypeError('observation alphabet invalid');
 const R=array(input.rewards,'rewards',n,n).map((r,s)=>vector(r,`reward${s}`,m,m));const b=simplex(input.belief,'belief',n);const horizon=integer(input.horizon,'horizon',1,5);const discount=number(input.discount??1,'discount',0,1);
 let nodes=0;function value(belief,h){if(!h)return {value:0,action:null,actionValues:[]};if(++nodes>300000)throw new RangeError('POMDP search limit');const vs=Array.from({length:m},(_,a)=>{let total=sum(belief.map((p,s)=>p*R[s][a]));for(let z=0;z<o;z++){const unnorm=Array.from({length:n},(_,j)=>obs[a][j][z]*sum(belief.map((p,s)=>p*T[s][a][j])));const pz=sum(unnorm);if(pz>1e-15)total+=discount*pz*value(unnorm.map(x=>x/pz),h-1).value;}return total;});const best=Math.max(...vs);return {value:best,action:vs.indexOf(best),actionValues:vs};}
 return {domain:'EXACT_FINITE_BELIEF_TREE_POMDP',...value(b,horizon),expandedNodes:nodes,discount,horizon};
}

// #65: a quantum-*inspired* complex-rotating momentum optimizer; ordinary deterministic code.
export function optimizeRotatingMomentum(input){
 object(input,'rotating momentum',['initial','target','quadratic','learningRate','momentum','phase','steps'],['initial','target','quadratic','learningRate','momentum','phase','steps']);
 let x=vector(input.initial,'initial',1,32),target=vector(input.target,'target',x.length,x.length);const H=matrix(input.quadratic,'quadratic',x.length,x.length);for(let i=0;i<x.length;i++)for(let j=0;j<x.length;j++)if(Math.abs(H[i][j]-H[j][i])>1e-10)throw new TypeError('quadratic must be symmetric');
 const lr=number(input.learningRate,'learningRate',0.000001,1),beta=number(input.momentum,'momentum',0,.999),phase=number(input.phase,'phase',-Math.PI,Math.PI),steps=integer(input.steps,'steps',1,5000);
 let re=Array(x.length).fill(0),im=Array(x.length).fill(0);const history=[];
 for(let k=0;k<steps;k++){const g=matvec(H,x.map((v,j)=>v-target[j]));for(let j=0;j<x.length;j++){const nr=beta*(Math.cos(phase)*re[j]-Math.sin(phase)*im[j])+g[j],ni=beta*(Math.sin(phase)*re[j]+Math.cos(phase)*im[j]);re[j]=nr;im[j]=ni;x[j]-=lr*nr;}if(x.some(v=>!Number.isFinite(v)||Math.abs(v)>1e100))throw new RangeError('optimizer diverged');if(k===0||k===steps-1)history.push({step:k+1,objective:dot(x.map((v,i)=>v-target[i]),matvec(H,x.map((v,i)=>v-target[i])))/2});}
 return {domain:'QUANTUM_INSPIRED_ROTATING_MOMENTUM',parameters:x,history,quantumHardware:false,guarantee:'no quantum speedup claimed'};
}

// #66: Clayton Archimedean copula, exact analytic CDF and bivariate joint upper tail.
export function claytonCopulaRisk(input){
 object(input,'Clayton copula',['u','theta'],['u','theta']);const u=vector(input.u,'u',2,16);if(u.some(v=>v<=0||v>1))throw new TypeError('u must lie in (0,1]');const theta=number(input.theta,'theta',0.000001,100);const inner=Math.max(1,sum(u.map(v=>v**(-theta)))-u.length+1);const c=inner**(-1/theta);let upperTail=null;if(u.length===2)upperTail=Math.max(0,1-u[0]-u[1]+c);return {domain:'CLAYTON_ARCHIMEDEAN_COPULA',jointCdf:c,kendallTau:theta/(theta+2),bivariateUpperTail:upperTail,dimension:u.length};
}

// #67: polynomial nonlinear cointegration regression + residual AR(1) statistic, no p-value claim.
export function analyzeNonlinearCointegration(input){
 object(input,'nonlinear cointegration',['x','y','degree'],['x','y']);const x=vector(input.x,'x',12,4096),y=vector(input.y,'y',x.length,x.length),degree=integer(input.degree??2,'degree',1,3);
 const mu=sum(x)/x.length,sigma=Math.sqrt(sum(x.map(v=>(v-mu)**2))/x.length);if(sigma<1e-10)throw new TypeError('predictor has zero variance');const design=x.map(v=>Array.from({length:degree+1},(_,j)=>((v-mu)/sigma)**j));const coeff=leastSquares(design,y,1e-9);const residual=y.map((v,i)=>v-dot(design[i],coeff));const e0=residual.slice(0,-1),de=residual.slice(1).map((v,i)=>v-e0[i]);const den=dot(e0,e0);if(den<1e-15) return {domain:'POLYNOMIAL_COINTEGRATION_DIAGNOSTIC',coefficients:coeff,centering:mu,scale:sigma,residual,adfSlope:null,adfTStatistic:null,perfectFit:true};const rho=dot(e0,de)/den,errors=de.map((v,i)=>v-rho*e0[i]),s2=sum(errors.map(v=>v*v))/(de.length-1),t=s2===0?null:rho/Math.sqrt(s2/den);return {domain:'POLYNOMIAL_COINTEGRATION_DIAGNOSTIC',coefficients:coeff,centering:mu,scale:sigma,residual,adfSlope:rho,adfTStatistic:t,perfectFit:false,note:'ADF-like statistic without critical values or stationarity decision'};
}

// #68: deterministic expectation dynamics of a stochastic replicator–mutator game.
export function simulateEvolutionaryGame(input){
 object(input,'evolutionary game',['payoffs','initial','mutation','selection','steps'],['payoffs','initial','mutation','steps']);const initial=vector(input.initial,'initial',2,16),n=initial.length;if(initial.some(v=>v<0)||Math.abs(sum(initial)-1)>1e-10)throw new TypeError('initial simplex');const payoff=matrix(input.payoffs,'payoffs',n,n);const Q=array(input.mutation,'mutation',n,n).map((r,i)=>simplex(r,`mutation${i}`,n));const selection=number(input.selection??1,'selection',0,100),steps=integer(input.steps,'steps',1,5000);let p=[...initial];const history=[p];for(let i=0;i<steps;i++){const pay=matvec(payoff,p),base=Math.min(...pay),fit=pay.map(v=>1+selection*(v-base)),z=dot(p,fit),parents=p.map((v,j)=>v*fit[j]/z);p=Array.from({length:n},(_,j)=>sum(parents.map((v,k)=>v*Q[k][j])));history.push(p);}return {domain:'REPLICATOR_MUTATOR_EXPECTED_DYNAMICS',distribution:p,history,assumption:'mean field expected frequencies; no finite population sampling'};
}

// #69: textbook Regev LWE encryption, NOT a production KEM or storage-security solution.
const LWE_Q=12289,LWE_N=16,LWE_M=128;
function secureMod(){return randomInt(LWE_Q);}function secNoise(){return randomInt(3)-1;}
export function createEducationalLWEKeypair(){const secret=Array.from({length:LWE_N},()=>randomInt(2)),A=Array.from({length:LWE_M},()=>Array.from({length:LWE_N},secureMod)),b=A.map(row=>mod(dot(row,secret)+secNoise(),LWE_Q));return {publicKey:{algorithm:'EDUCATIONAL_LWE_REGEV',q:LWE_Q,n:LWE_N,A,b},privateKey:{algorithm:'EDUCATIONAL_LWE_REGEV',s:secret}};}
export function encryptEducationalLWE(publicKey,plain){object(publicKey,'LWE key',['algorithm','q','n','A','b']);if(publicKey.algorithm!=='EDUCATIONAL_LWE_REGEV'||publicKey.q!==LWE_Q||publicKey.n!==LWE_N)throw new TypeError('unsupported LWE public key');const A=array(publicKey.A,'A',LWE_M,LWE_M).map((row,i)=>row.map(v=>integer(v,`A${i}`,0,LWE_Q-1))),b=array(publicKey.b,'b',LWE_M,LWE_M).map(v=>integer(v,'b',0,LWE_Q-1));if(A.some(r=>r.length!==LWE_N))throw new TypeError('invalid LWE matrix');const bytes=Buffer.from(plain,'utf8');if(typeof plain!=='string'||bytes.length>128)throw new TypeError('short string required');const bits=[...bytes].flatMap(byte=>Array.from({length:8},(_,i)=>(byte>>i)&1));return {algorithm:'EDUCATIONAL_LWE_REGEV',byteLength:bytes.length,ciphertexts:bits.map(bit=>{const indices=Array.from({length:LWE_M},(_,i)=>i).filter(()=>randomInt(2));const u=Array.from({length:LWE_N},(_,j)=>mod(sum(indices.map(i=>A[i][j])),LWE_Q));const v=mod(sum(indices.map(i=>b[i]))+bit*Math.floor(LWE_Q/2),LWE_Q);return {u,v};})};}
export function decryptEducationalLWE(privateKey,cipher){object(privateKey,'LWE secret',['algorithm','s']);object(cipher,'cipher',['algorithm','byteLength','ciphertexts']);if(privateKey.algorithm!=='EDUCATIONAL_LWE_REGEV'||cipher.algorithm!=='EDUCATIONAL_LWE_REGEV')throw new TypeError('unsupported LWE format');const s=array(privateKey.s,'secret',LWE_N,LWE_N).map(x=>integer(x,'secret bit',0,1));const length=integer(cipher.byteLength,'byteLength',0,128),cts=array(cipher.ciphertexts,'ciphertexts',length*8,length*8);const bits=cts.map(c=>{object(c,'cipher bit',['u','v']);const u=array(c.u,'u',LWE_N,LWE_N).map(x=>integer(x,'u',0,LWE_Q-1)),v=integer(c.v,'v',0,LWE_Q-1),d=mod(v-dot(u,s),LWE_Q);return d>LWE_Q/4&&d<3*LWE_Q/4?1:0;});const data=Buffer.alloc(length);for(let i=0;i<bits.length;i++)data[i>>3]|=bits[i]<<(i&7);return new TextDecoder('utf-8',{fatal:true}).decode(data);}
export function runEducationalLWEStorage(input){object(input,'LWE storage',['text'],['text']);const {publicKey,privateKey}=createEducationalLWEKeypair();const ciphertext=encryptEducationalLWE(publicKey,input.text),restored=decryptEducationalLWE(privateKey,ciphertext);return {domain:'EDUCATIONAL_LWE_ENCRYPTION_ROUNDTRIP',verified:restored===input.text,byteLength:ciphertext.byteLength,plaintextSha256:createHash('sha256').update(input.text).digest('hex'),security:'INSECURE_DEMONSTRATION_ONLY; 16-dimensional LWE is breakable; do not store real secrets'};}

// #70: exact H0/H1 Rips persistence recomputed over explicit append-only point stream.
export function streamPersistentHomology(input){object(input,'homology stream',['points','maxScale','startAt'],['points']);const points=array(input.points,'points',2,16),start=integer(input.startAt??2,'startAt',2,points.length),maxScale=number(input.maxScale??1e6,'maxScale',0,1e12);const snapshots=[];for(let count=start;count<=points.length;count++){const v=computePersistentHomology({points:points.slice(0,count),maxScale});snapshots.push({count,h0Alive:v.h0.filter(x=>x.death===null).length,h1Alive:v.h1.filter(x=>x.death===null).length,intervals:v.intervals});}return {domain:'APPEND_ONLY_STREAM_RIPS_PERSISTENCE',snapshots,note:'bounded exact recomputation, not a distributed streaming approximation'};}
