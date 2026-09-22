/** Projected gradient with Armijo backtracking and safeguarded BB step sizes. */
export function minimizeBox(evaluate, initial, lower, upper, {iterations=1000,tolerance=1e-7}={}) {
  const project=x=>x.map((v,i)=>Math.max(lower[i],Math.min(upper[i],v)));
  let x=project(initial), out=evaluate(x), rate=1, count=0;
  const check=o=>{if(!Number.isFinite(o.value)||o.gradient.length!==x.length||o.gradient.some(v=>!Number.isFinite(v)))throw new RangeError('nonfinite objective or gradient');};
  check(out);
  const history=[out.value];
  const residual=()=>{const projected=project(x.map((z,j)=>z-out.gradient[j]));return Math.max(...x.map((v,i)=>Math.abs(v-projected[i])));};
  let status='ITERATION_LIMIT';
  for(;count<iterations;count++) {
    if(residual()<=tolerance){status='CONVERGED';break;}
    let accepted=false, next, nextOut, delta;
    for(let backtrack=0;backtrack<60;backtrack++) {
      next=project(x.map((v,i)=>v-rate*out.gradient[i]));delta=next.map((v,i)=>v-x[i]);
      const slope=delta.reduce((s,v,i)=>s+v*out.gradient[i],0);
      nextOut=evaluate(next);check(nextOut);
      if(slope<0 && nextOut.value<=out.value+1e-4*slope){accepted=true;break;}
      rate*=.5;
    }
    if(!accepted){status='LINE_SEARCH_STALLED';break;}
    const y=nextOut.gradient.map((v,i)=>v-out.gradient[i]);
    const sy=delta.reduce((s,v,i)=>s+v*y[i],0),ss=delta.reduce((s,v)=>s+v*v,0);
    rate=sy>0?Math.max(1e-10,Math.min(1e6,ss/sy)):1;
    x=next;out=nextOut;history.push(out.value);
  }
  const projectedGradientInfinityNorm=residual();
  if(projectedGradientInfinityNorm<=tolerance)status='CONVERGED';
  return {parameters:x,objective:out.value,gradient:out.gradient,status,iterations:history.length-1,projectedGradientInfinityNorm,history};
}
