// Bounded, self-owned statistical operators. Outputs describe supplied data;
// inferential guarantees still depend on sampling and modeling assumptions.
const freeze = Object.freeze;
const integer = (v, name, min, max) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new TypeError(`${name} must be a safe integer in [${min},${max}]`);
  return v;
};
const finite = (v, name, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new TypeError(`${name} must be a finite number in [${min},${max}]`);
  return v;
};
const rowsOf = (xs, name, min, max) => {
  if (!Array.isArray(xs) || xs.length < min || xs.length > max) throw new TypeError(`${name} must have ${min}..${max} entries`);
  return xs;
};
const median = sorted => (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;

export function weightedLeastSquaresLine({ x, y, weights }) {
  const xs = rowsOf(x, 'x', 2, 10000).map((v,i) => integer(v, `x[${i}]`, -1000000, 1000000));
  const ys = rowsOf(y, 'y', xs.length, xs.length).map((v,i) => integer(v, `y[${i}]`, -1000000, 1000000));
  const ws = rowsOf(weights, 'weights', xs.length, xs.length).map((v,i) => integer(v, `weights[${i}]`, 1, 10000));
  const sumWeight = ws.reduce((s,w) => s+w,0);
  const xMean = xs.reduce((s,x,i) => s+x*ws[i],0)/sumWeight;
  const yMean = ys.reduce((s,y,i) => s+y*ws[i],0)/sumWeight;
  let xx=0,xy=0;
  for (let i=0;i<xs.length;i++) {
    const dx=xs[i]-xMean;
    xx+=ws[i]*dx*dx;
    xy+=ws[i]*dx*(ys[i]-yMean);
  }
  if (!(xx>0) || !Number.isFinite(xx)) throw new TypeError('weighted regression requires distinct x values');
  const slope=xy/xx;
  const intercept=yMean-slope*xMean;
  let squaredError=0;
  for(let i=0;i<xs.length;i++) squaredError+=ws[i]*(ys[i]-intercept-slope*xs[i])**2;
  if (![slope,intercept,squaredError].every(Number.isFinite)) throw new Error('regression numerical overflow');
  return freeze({ slope, intercept, weightedSquaredError: squaredError, sumWeight, sampleCount: xs.length });
}

export function weightedIsotonicRegression({ observations, weights }) {
  const y=rowsOf(observations, 'observations',1,2048).map((v,i)=>integer(v,`observations[${i}]`,-1000000,1000000));
  const w=rowsOf(weights,'weights',y.length,y.length).map((v,i)=>integer(v,`weights[${i}]`,1,10000));
  const blocks=[];
  for(let i=0;i<y.length;i++) {
    blocks.push({ start:i, end:i, weight:w[i], sum:y[i]*w[i] });
    while(blocks.length>1) {
      const b=blocks.at(-1), a=blocks.at(-2);
      if(a.sum/a.weight<=b.sum/b.weight) break;
      blocks.pop();blocks.pop();
      blocks.push({start:a.start,end:b.end,weight:a.weight+b.weight,sum:a.sum+b.sum});
    }
  }
  const fitted=Array(y.length);
  for(const b of blocks) for(let i=b.start;i<=b.end;i++) fitted[i]=b.sum/b.weight;
  const weightedSquaredError=y.reduce((s,v,i)=>s+w[i]*(v-fitted[i])**2,0);
  if(!Number.isFinite(weightedSquaredError)||fitted.some((v,i)=>!Number.isFinite(v)||(i>0&&fitted[i]<fitted[i-1]))) throw new Error('isotonic regression numerical invariant failed');
  return freeze({ fitted:freeze(fitted), weightedSquaredError,
    blocks:freeze(blocks.map(b=>freeze({start:b.start,end:b.end,mean:b.sum/b.weight,weight:b.weight}))) });
}

export function benjaminiHochbergFdr({ pValues, alpha }) {
  const p=rowsOf(pValues,'pValues',1,10000).map((v,i)=>finite(v,`pValues[${i}]`,0,1));
  const a=finite(alpha,'alpha',Number.EPSILON,1);
  const ordered=p.map((v,i)=>({p:v,index:i})).sort((x,y)=>x.p-y.p||x.index-y.index);
  let largestAccepted=-1;
  for(let i=0;i<ordered.length;i++) if(ordered[i].p<=a*(i+1)/ordered.length) largestAccepted=i;
  const adjusted=Array(p.length);
  let smallest=1;
  for(let i=ordered.length-1;i>=0;i--) {
    smallest=Math.min(smallest,ordered[i].p*ordered.length/(i+1));
    adjusted[ordered[i].index]=smallest;
  }
  const rejectedIndices=ordered.slice(0,largestAccepted+1).map(row=>row.index).sort((x,y)=>x-y);
  return freeze({ adjustedPValues:freeze(adjusted), rejectedIndices:freeze(rejectedIndices), rejectedCount:rejectedIndices.length, alpha:a });
}

export function exactPairedSignPermutation({ differences }) {
  const d=rowsOf(differences,'differences',1,16).map((v,i)=>integer(v,`differences[${i}]`,-10000,10000));
  const observed=d.reduce((s,v)=>s+v,0);
  const total=2**d.length;
  let extreme=0;
  for(let mask=0;mask<total;mask++) {
    let sum=0;
    for(let i=0;i<d.length;i++) sum+=((mask>>i)&1)?d[i]:-d[i];
    if(Math.abs(sum)>=Math.abs(observed)) extreme++;
  }
  return freeze({ observedMean:observed/d.length, twoSidedPValue:extreme/total, extremeAssignments:extreme, totalAssignments:total });
}

function choose(n,k) {
  if(k<0||k>n) return 0n;
  const r=Math.min(k,n-k);
  let result=1n;
  for(let i=1;i<=r;i++) result=result*BigInt(n-r+i)/BigInt(i);
  return result;
}
export function fisherExactTwoSided({ table }) {
  const matrix=rowsOf(table,'table',2,2);
  const a=integer(rowsOf(matrix[0],'table[0]',2,2)[0],'a',0,200);
  const b=integer(matrix[0][1],'b',0,200);
  const c=integer(rowsOf(matrix[1],'table[1]',2,2)[0],'c',0,200);
  const d=integer(matrix[1][1],'d',0,200);
  const n=a+b+c+d;
  if(n===0||n>200) throw new TypeError('Fisher exact test requires 1..200 observations');
  const r1=a+b,r2=c+d,col1=a+c;
  const min=Math.max(0,col1-r2),max=Math.min(r1,col1);
  const weight=x=>choose(r1,x)*choose(r2,col1-x);
  const observedWeight=weight(a);
  let tail=0n;
  for(let x=min;x<=max;x++) {
    const w=weight(x);
    if(w<=observedWeight) tail+=w;
  }
  const denominator=choose(n,col1);
  const value=Number(tail)/Number(denominator);
  return freeze({ twoSidedPValue:value, observedTableProbability:Number(observedWeight)/Number(denominator),
    enumeratedTables:max-min+1, rowTotals:freeze([r1,r2]), columnTotals:freeze([col1,b+d]) });
}

export function kaplanMeierSurvival({ observations }) {
  const data=rowsOf(observations,'observations',1,10000).map((row,i)=>{
    if(!row||typeof row!=='object'||Array.isArray(row)) throw new TypeError(`observations[${i}] must be object`);
    const time=integer(row.time,`observations[${i}].time`,0,1000000000);
    if(row.event!==0&&row.event!==1) throw new TypeError(`observations[${i}].event must be 0 or 1`);
    return {time,event:row.event};
  }).sort((a,b)=>a.time-b.time||b.event-a.event);
  const steps=[];
  let atRisk=data.length,survival=1;
  for(let i=0;i<data.length;) {
    const t=data[i].time;
    let events=0,censored=0;
    while(i<data.length&&data[i].time===t){if(data[i].event)events++;else censored++;i++;}
    if(events) survival*=1-events/atRisk;
    steps.push(freeze({time:t,atRisk,events,censored,survival}));
    atRisk-=events+censored;
  }
  if(atRisk!==0||!Number.isFinite(survival)||survival<0||survival>1) throw new Error('survival risk-set invariant failed');
  return freeze({survivalAtLastTime:survival,observations:data.length,curve:freeze(steps)});
}

export function theilSenLine({ x, y }) {
  const xs=rowsOf(x,'x',2,128).map((v,i)=>integer(v,`x[${i}]`,-1000000,1000000));
  const ys=rowsOf(y,'y',xs.length,xs.length).map((v,i)=>integer(v,`y[${i}]`,-1000000,1000000));
  const slopes=[];
  for(let i=0;i<xs.length;i++)for(let j=i+1;j<xs.length;j++)if(xs[i]!==xs[j])slopes.push((ys[j]-ys[i])/(xs[j]-xs[i]));
  if(!slopes.length)throw new TypeError('Theil-Sen requires distinct x values');
  slopes.sort((a,b)=>a-b);
  const slope=median(slopes);
  const intercepts=ys.map((v,i)=>v-slope*xs[i]).sort((a,b)=>a-b);
  const intercept=median(intercepts);
  if(!Number.isFinite(slope)||!Number.isFinite(intercept))throw new Error('Theil-Sen numerical overflow');
  return freeze({slope,intercept,pairCount:slopes.length,sampleCount:xs.length});
}

export function splitConformalInterval({ calibrationResiduals, prediction, alpha }) {
  const residuals=rowsOf(calibrationResiduals,'calibrationResiduals',2,10000)
    .map((v,i)=>integer(v,`calibrationResiduals[${i}]`,0,1000000)).sort((a,b)=>a-b);
  const estimate=integer(prediction,'prediction',-1000000000,1000000000);
  const a=finite(alpha,'alpha',Number.EPSILON,1-Number.EPSILON);
  const rank=Math.ceil((residuals.length+1)*(1-a));
  if(rank>residuals.length) throw new TypeError('insufficient calibration data for a finite split-conformal interval');
  const halfWidth=residuals[rank-1];
  return freeze({lower:estimate-halfWidth,upper:estimate+halfWidth,halfWidth,calibrationCount:residuals.length,quantileRank:rank,alpha:a});
}

export function bernoulliSequentialLikelihood({ observations, nullRate, alternativeRate, alpha, beta }) {
  const xs=rowsOf(observations,'observations',1,100000).map((v,i)=>{if(v!==0&&v!==1)throw new TypeError(`observations[${i}] must be 0 or 1`);return v;});
  const p0=finite(nullRate,'nullRate',Number.EPSILON,1-Number.EPSILON);
  const p1=finite(alternativeRate,'alternativeRate',Number.EPSILON,1-Number.EPSILON);
  const a=finite(alpha,'alpha',Number.EPSILON,1-Number.EPSILON);
  const b=finite(beta,'beta',Number.EPSILON,1-Number.EPSILON);
  if(p0===p1||a+b>=1)throw new TypeError('SPRT requires distinct hypotheses and alpha+beta<1');
  const upper=Math.log((1-b)/a),lower=Math.log(b/(1-a));
  let logLikelihoodRatio=0;
  for(let i=0;i<xs.length;i++) {
    logLikelihoodRatio+=xs[i]?Math.log(p1/p0):Math.log((1-p1)/(1-p0));
    if(logLikelihoodRatio>=upper) return freeze({decision:'ALTERNATIVE',observationsUsed:i+1,logLikelihoodRatio,lowerBoundary:lower,upperBoundary:upper});
    if(logLikelihoodRatio<=lower) return freeze({decision:'NULL',observationsUsed:i+1,logLikelihoodRatio,lowerBoundary:lower,upperBoundary:upper});
  }
  return freeze({decision:'INCONCLUSIVE',observationsUsed:xs.length,logLikelihoodRatio,lowerBoundary:lower,upperBoundary:upper});
}
