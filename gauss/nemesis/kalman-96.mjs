/** Némesis #96 inside GAUSS: bounded factor-only Gaussian conditioning.
 * Redundant exact measurements use a rank-revealing orthogonal projection.
 * This is a numerical filter, not a proof of stability for arbitrary inputs.
 */
import {object,array,number} from './engine/src/motors/shared.mjs';
import {matrix,vector} from './engine/src/motors/numerics.mjs';

const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const transpose=A=>A[0].map((_,j)=>A.map(r=>r[j]));
const mm=(A,B)=>{const BT=transpose(B);return A.map(r=>BT.map(c=>dot(r,c)));};
const mv=(A,x)=>A.map(row=>dot(row,x));
const finite=(A,label)=>{if(A.flat().some(v=>!Number.isFinite(v)))throw new RangeError(`${label} numerical overflow`);return A;};

/** Givens-QR of A^T: square L with L L^T = A A^T, including rank-deficient A. */
function lowerFactor(A){
  const B=transpose(A),n=A.length;
  for(let j=0;j<n;j++)for(let i=B.length-1;i>j;i--){
    const a=B[i-1][j],b=B[i][j];if(b===0)continue;
    const r=Math.hypot(a,b),c=a/r,s=b/r;
    for(let k=j;k<n;k++){
      const x=B[i-1][k],y=B[i][k];B[i-1][k]=c*x+s*y;B[i][k]=-s*x+c*y;
    }
  }
  const L=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>j<=i?B[j][i]:0));
  for(let j=0;j<n;j++)if(L[j][j]<0)for(let i=j;i<n;i++)L[i][j]*=-1;
  return finite(L,'Kalman factor');
}
function factor(raw,label,n){
  const S=matrix(raw,label,n,n);
  for(let i=0;i<n;i++){
    if(S[i][i]<0)throw new TypeError(`${label} negative diagonal`);
    for(let j=i+1;j<n;j++)if(S[i][j]!==0)throw new TypeError(`${label} must be lower triangular`);
  }
  return S;
}

/**
 * Independent-row Gaussian conditioning on G=[H*S, R_factor]. The posterior
 * projection B(I-Q^TQ) avoids covariance subtraction when innovation is singular.
 * A null-space contradiction throws rather than inventing a pseudoinverse answer.
 */
export function filterGaussNemesis96(input){
  object(input,'factor Kalman',['initialMean','initialFactor','steps']);
  let mean=vector(input.initialMean,'initialMean',1,32),n=mean.length,S=factor(input.initialFactor,'initialFactor',n);
  const steps=array(input.steps,'steps',1,10000),history=[];
  let work=0;
  for(const step of steps){
    object(step,'step',['transition','processFactor','observationMatrix','observationFactor','observation','offset'],['transition','processFactor','observationMatrix','observationFactor','observation']);
    const F=matrix(step.transition,'transition',n,n),Q=factor(step.processFactor,'processFactor',n);
    const H=array(step.observationMatrix,'observationMatrix',1,32).map(row=>vector(row,'observation row',n,n)),m=H.length;
    const R=factor(step.observationFactor,'observationFactor',m);
    const y=array(step.observation,'observation',m,m).map(v=>v===null?null:number(v,'observation'));
    const offset=step.offset===undefined?Array(n).fill(0):vector(step.offset,'offset',n,n);
    work+=n**3+m*(n+m)**2;
    if(work>20000000)throw new RangeError('Kalman work budget exceeded');
    mean=mv(F,mean).map((v,i)=>v+offset[i]);finite([mean],'Kalman mean');
    const FS=mm(F,S);S=lowerFactor(FS.map((row,i)=>[...row,...Q[i]]));
    const observed=y.map((v,i)=>v===null?-1:i).filter(i=>i>=0);
    const innovation=[],independent=[],q=[],white=[];
    let logLikelihood=0;
    if(observed.length){
      const HH=observed.map(i=>H[i]);
      const HS=mm(HH,S),predicted=mv(HH,mean);
      const B=S.map(row=>[...row,...Array(m).fill(0)]);
      for(let i=0;i<observed.length;i++){
        const channel=observed[i],residual=y[channel]-predicted[i];
        if(!Number.isFinite(residual))throw new RangeError('Kalman innovation overflow');
        innovation.push(residual);
        const row=[...HS[i],...R[channel]],orth=[...row],coeff=Array(q.length).fill(0);
        // Two passes limit loss of orthogonality in near-dependent measurements.
        for(let pass=0;pass<2;pass++)for(let j=0;j<q.length;j++){
          const c=dot(orth,q[j]);coeff[j]+=c;
          for(let h=0;h<orth.length;h++)orth[h]-=c*q[j][h];
        }
        const conditionalResidual=residual-dot(coeff,white);
        const norm=Math.hypot(...orth),scale=Math.hypot(...row);
        const tolerance=1e-12*Math.max(1,scale);
        if(norm<=tolerance){
          const allowable=1e-10*(1+Math.abs(residual)+coeff.reduce((s,c,j)=>s+Math.abs(c*white[j]),0));
          if(Math.abs(conditionalResidual)>allowable)
            throw new RangeError(`inconsistent deterministic observation channel ${channel}`);
          continue;
        }
        const unit=orth.map(v=>v/norm),w=conditionalResidual/norm;
        if(!Number.isFinite(w))throw new RangeError('Kalman conditioning overflow');
        q.push(unit);white.push(w);independent.push(channel);
        logLikelihood-=0.5*(Math.log(2*Math.PI)+2*Math.log(norm)+w*w);
      }
      if(!Number.isFinite(logLikelihood))throw new RangeError('Kalman likelihood overflow');
      const posteriorMean=[...mean];
      for(let j=0;j<q.length;j++){
        const a=mv(B,q[j]);
        for(let i=0;i<n;i++)posteriorMean[i]+=a[i]*white[j];
      }
      finite([posteriorMean],'Kalman mean');
      for(const unit of q){
        const a=mv(B,unit);
        for(let i=0;i<n;i++)for(let j=0;j<B[i].length;j++)B[i][j]-=a[i]*unit[j];
      }
      S=lowerFactor(B);mean=posteriorMean;
    }
    history.push({mean:[...mean],factor:S.map(row=>[...row]),observedChannels:observed,innovation,
      independentChannels:independent,innovationRank:independent.length,logLikelihood});
  }
  return {domain:'TIME_VARYING_QR_SQUARE_ROOT_KALMAN',mean,factor:S,history,
    logLikelihood:history.reduce((s,step)=>s+step.logLikelihood,0),
    formulation:'factor-only Givens QR and rank-revealing conditioning; exact redundant channels checked for consistency; likelihood is for independent channels only; numerical tolerance 1e-12 relative to unit scale'};
}
