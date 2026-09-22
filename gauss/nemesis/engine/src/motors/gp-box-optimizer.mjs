import {object,array,vector,number,integer,cholesky,solveLinear,dot,assertFinite} from './finite-tools.mjs';
const phi=z=>Math.exp(-z*z/2)/Math.sqrt(2*Math.PI);
function cdf(z){const x=Math.abs(z),t=1/(1+.2316419*x),poly=t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));const p=1-phi(x)*poly;return z>=0?p:1-p;}
/** Gaussian process RBF regression + expected improvement over explicit in-box candidates. */
export function optimizeFiniteGaussianProcess(input){object(input,'gp',['bounds','observations','candidates','lengthScale','amplitude','noise','exploration'],['bounds','observations','candidates']);
 const bounds=array(input.bounds,'bounds',1,8).map((b,i)=>{const [lo,hi]=vector(b,`bounds[${i}]`,2,2);if(!(lo<hi))throw new TypeError('invalid bounds');return [lo,hi];}),d=bounds.length;
 function point(p,label){const v=vector(p,label,d,d);v.forEach((x,i)=>{if(x<bounds[i][0]||x>bounds[i][1])throw new TypeError(`${label} outside bounds`);});return v;}
 const obs=array(input.observations,'observations',1,128).map((v,i)=>{object(v,`observations[${i}]`,['x','y']);return {x:point(v.x,`x${i}`),y:number(v.y,`y${i}`)};}),cand=array(input.candidates,'candidates',1,8192).map((p,i)=>point(p,`candidate[${i}]`));
 const ell=number(input.lengthScale??1,'lengthScale',1e-6,1e6),amp=number(input.amplitude??1,'amplitude',1e-6,1e6),noise=number(input.noise??1e-5,'noise',1e-10,1e2),xi=number(input.exploration??0,'exploration',0,100),n=obs.length;
 const kernel=(a,b)=>amp*amp*Math.exp(-a.reduce((s,v,j)=>s+((v-b[j])/ell)**2,0)/2);
 const K=obs.map((o,i)=>obs.map((v,j)=>kernel(o.x,v.x)+(i===j?noise*noise:0)));const L=cholesky(K); // SPD validated even with duplicate inputs.
 const y=obs.map(o=>o.y),alpha=solveLinear(K,y),bestObserved=Math.min(...y);
 const predictions=cand.map(x=>{const k=obs.map(o=>kernel(o.x,x)),mean=dot(k,alpha),w=solveLinear(K,k),variance=Math.max(0,kernel(x,x)-dot(k,w)),std=Math.sqrt(variance),improvement=bestObserved-mean-xi,ei=std>1e-14?improvement*cdf(improvement/std)+std*phi(improvement/std):Math.max(0,improvement);return {x,mean:assertFinite(mean),std,expectedImprovement:Math.max(0,ei)};});
 let winner=0;for(let i=1;i<predictions.length;i++)if(predictions[i].expectedImprovement>predictions[winner].expectedImprovement)winner=i;
 return {domain:'FINITE_CANDIDATE_GP_EXPECTED_IMPROVEMENT',recommended:predictions[winner],predictions,observedBest:bestObserved,choleskyDiagonal:L.map((r,i)=>r[i]),note:'RBF Gaussian-process regression with fixed hyperparameters and EI on provided candidate set; neither continuous global optimum nor calibrated uncertainty guaranteed.'};
}
