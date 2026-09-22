import {object,array,integer,number} from './shared.mjs';
/** Simplex projection cross mapping. Predict x(t) from delay vectors of y(t); no automatic causal identification. */
export function estimateConvergentCrossMap(input){
 object(input,'ccm',['x','y','dimension','delay','librarySizes'],['x','y','dimension','delay']);
 const x=array(input.x,'x',20,1024).map((v,i)=>number(v,`x[${i}]`,-1e9,1e9));const y=array(input.y,'y',20,1024).map((v,i)=>number(v,`y[${i}]`,-1e9,1e9));if(x.length!==y.length)throw new TypeError('series length mismatch');
 const dimension=integer(input.dimension,'dimension',2,8),delay=integer(input.delay,'delay',1,50),start=(dimension-1)*delay;
 if(x.length-start<dimension+5)throw new TypeError('too few embedded points');
 const sizes=input.librarySizes??[Math.max(dimension+2,Math.floor((x.length-start)/2)),x.length-start];
 const librarySizes=array(sizes,'librarySizes',1,20).map((n,i)=>integer(n,`librarySizes[${i}]`,dimension+2,x.length-start));
 const points=Array.from({length:x.length-start},(_,k)=>{const t=k+start;return {x:x[t],embed:Array.from({length:dimension},(_,j)=>y[t-j*delay]),t};});
 const skills=librarySizes.map(size=>{
  // evaluate on held-out points only. If full library requested use leave-one-out.
  const library=points.slice(0,size),queries=size<points.length?points.slice(size):points;
  if(queries.length<2)throw new TypeError('too few query points');
  const predicted=[],observed=[];
  for(const q of queries){const near=library.filter(p=>p.t!==q.t).map(p=>({p,d:Math.hypot(...p.embed.map((v,i)=>v-q.embed[i]))})).sort((a,b)=>a.d-b.d||a.p.t-b.p.t).slice(0,dimension+1);
   if(near.length<dimension+1)throw new TypeError('insufficient independent neighbors');
   const d0=near[0].d;const w=near.map(p=>d0<1e-12?(p.d<1e-12?1:0):Math.exp(-p.d/d0));const total=w.reduce((s,v)=>s+v,0);
   predicted.push(near.reduce((s,p,i)=>s+w[i]*p.p.x,0)/total);observed.push(q.x);
  }
  const a=observed.reduce((s,v)=>s+v,0)/observed.length,b=predicted.reduce((s,v)=>s+v,0)/predicted.length;
  const cross=observed.reduce((s,v,i)=>s+(v-a)*(predicted[i]-b),0);
  const sx=Math.sqrt(observed.reduce((s,v)=>s+(v-a)**2,0)),sy=Math.sqrt(predicted.reduce((s,v)=>s+(v-b)**2,0));
  return {librarySize:size,queryCount:queries.length,correlation:sx>0&&sy>0?cross/sx/sy:null,meanSquaredError:observed.reduce((s,v,i)=>s+(v-predicted[i])**2,0)/observed.length};
 });
 return {domain:'FINITE_CONVERGENT_CROSS_MAPPING',direction:'y_manifold_predicts_x',skills,note:'Prediction/cross-map skill alone does not establish causality; autocorrelation, shared forcing and convergence must be evaluated separately.'};
}
