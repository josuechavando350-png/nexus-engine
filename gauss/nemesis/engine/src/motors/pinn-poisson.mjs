import {object,array,integer,number} from './shared.mjs';
import {vector,dot,leastSquares,seeded} from './numerics.mjs';
/** Physics-informed single-hidden-layer tanh neural network; solve -u''(x)=f(x) on [0,1] with fixed hidden layer, ridge-fit output weights. */
export function solvePoissonPINN(input){
 object(input,'PINN',['forcing','boundary','width','collocation','seed','regularization','boundaryWeight','queries'],['forcing','boundary','width','collocation']);
 const forcing=object(input.forcing,'forcing',['kind','value'],['kind']);
 if(forcing.kind!=='constant'&&forcing.kind!=='sine')throw new TypeError('forcing.kind must be constant or sine');
 if(forcing.kind==='constant')number(forcing.value,'forcing.value',-1e4,1e4);
 if(forcing.kind==='sine'&&Object.hasOwn(forcing,'value'))throw new TypeError('sine does not accept value');
 const bd=vector(input.boundary,'boundary',2,2),width=integer(input.width,'width',4,64),count=integer(input.collocation,'collocation',width,1024);
 const reg=number(input.regularization??1e-9,'regularization',1e-12,1),weight=number(input.boundaryWeight??100,'boundaryWeight',1,1e6);
 const seed=integer(input.seed??7,'seed',0,4294967295),rng=seeded(seed);
 // Fixed, deterministic nonlinear hidden features and analytically differentiated second derivatives.
 const hidden=Array.from({length:width},(_,i)=>({slope:(i%2?-1:1)*(1+7*rng()),bias:4*rng()-2}));
 const features=x=>[1,x,...hidden.map(({slope,bias})=>Math.tanh(slope*x+bias))];
 const negativeSecond=x=>[0,0,...hidden.map(({slope,bias})=>{const t=Math.tanh(slope*x+bias);return 2*slope*slope*t*(1-t*t);})];
 const f=x=>forcing.kind==='constant'?forcing.value:Math.sin(Math.PI*x);
 const rows=[],targets=[];
 for(let i=1;i<=count;i++){const x=i/(count+1);rows.push(negativeSecond(x));targets.push(f(x));}
 for(const [x,y] of [[0,bd[0]],[1,bd[1]]]){rows.push(features(x).map(v=>v*weight));targets.push(y*weight);}
 const weights=leastSquares(rows,targets,reg);
 const evaluate=x=>dot(features(x),weights),residual=x=>dot(negativeSecond(x),weights)-f(x);
 const grid=Array.from({length:101},(_,i)=>i/100),rms=Math.sqrt(grid.slice(1,-1).reduce((s,x)=>s+residual(x)**2,0)/99);
 const queries=vector(input.queries??[0,0.25,0.5,0.75,1],'queries',1,256);
 if(queries.some(x=>x<0||x>1))throw new TypeError('queries must be in [0,1]');
 return {domain:'ONE_DIMENSIONAL_POISSON_PINN_FIXED_HIDDEN_LAYER',boundaryResiduals:[evaluate(0)-bd[0],evaluate(1)-bd[1]],rmsPDEResidual:rms,predictions:queries.map(x=>({x,value:evaluate(x),residual:residual(x)})),hidden,outputWeights:weights,note:'Trainable linear readout of a nonlinear tanh network; single ODE BVP with known forcing, not arbitrary PDEs or end-to-end trained deep PINN.'};
}
