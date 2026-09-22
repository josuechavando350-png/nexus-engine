/**
 * Exact algebraic duality check for the degree-two Vélu primitive.
 * This is a finite-field mathematics component, not a signature scheme.
 * Its point operations are variable-time and MUST NOT process secret keys.
 */
import {evaluateTwoIsogeny} from './engine/src/motors/isogeny-2.mjs';

const mod=(n,p)=>((n%p)+p)%p;
function inverse(n,p) {
  let t=0,newT=1,r=p,newR=mod(n,p);
  while(newR!==0){const q=Math.floor(r/newR);[t,newT]=[newT,t-q*newT];[r,newR]=[newR,r-q*newR];}
  if(r!==1)throw new RangeError('non-invertible field element');
  return mod(t,p);
}
function twice(P,a,p){
  if(P===null||P.y===0)return null;
  const slope=mod((3*P.x*P.x+a)*inverse(2*P.y,p),p);
  const x=mod(slope*slope-2*P.x,p);
  return {x,y:mod(slope*(P.x-x)-P.y,p)};
}
function same(P,Q){return P===null?Q===null:Q!==null&&P.x===Q.x&&P.y===Q.y;}

/**
 * If phi:E->E' is normalized Vélu with kernel <(r,0)>, the normalized
 * dual phi':E'->E'' has kernel <(-2r,0)>. E''=(16a,64b) is isomorphic
 * to E by (x,y)->(x/4,y/8), yielding dual(phi)(phi(P))=[2]P.
 * Checks every supplied point against independently computed doubling.
 */
export function verifyTwoIsogenyDualIdentity(input){
  const first=evaluateTwoIsogeny(input);
  const {p,a,b}=first.source;
  const dualKernelX=mod(-2*first.kernel.x,p);
  const second=evaluateTwoIsogeny({p,a:first.target.a,b:first.target.b,kernelX:dualKernelX,points:first.images});
  if(second.target.a!==mod(16*a,p)||second.target.b!==mod(64*b,p))
    throw new Error('DUAL_CODOMAIN_MISMATCH');
  const inv4=inverse(4,p),inv8=inverse(8,p);
  const doubled=second.images.map((P,i)=>{
    const actual=P===null?null:{x:mod(P.x*inv4,p),y:mod(P.y*inv8,p)};
    const expected=twice(input.points[i],a,p);
    if(!same(actual,expected))throw new Error(`DUAL_COMPOSITION_MISMATCH_AT_${i}`);
    return actual;
  });
  return {
    domain:'VELU_DEGREE_2_DUAL_IDENTITY_FINITE_FIELD_NOT_SIGNATURE',
    source:first.source,
    target:first.target,
    dualKernel:{x:dualKernelX,y:0},
    pointsChecked:doubled.length,
    doubled,
    verified:true,
    warning:'Mathematical identity only. No key generation, signature, verification, post-quantum claim or constant-time implementation.'
  };
}
