import {object,array,integer,number} from './shared.mjs';
function extrema(x){const max=[],min=[];for(let i=1;i<x.length-1;i++){if(x[i]>x[i-1]&&x[i]>=x[i+1])max.push(i);if(x[i]<x[i-1]&&x[i]<=x[i+1])min.push(i);}return {max,min};}
function envelope(x,points){const p=[0,...points,x.length-1],result=Array(x.length);for(let k=0;k<p.length-1;k++){const a=p[k],b=p[k+1];for(let i=a;i<=b;i++)result[i]=x[a]+(x[b]-x[a])*(i-a)/(b-a);}return result;}
/** EMD via explicitly specified linear-envelope sifting; endpoint and stopping choices matter. */
export function decomposeEmpiricalModes(input){
 object(input,'emd',['signal','maxModes','maxSifts','tolerance'],['signal']);
 const signal=array(input.signal,'signal',5,4096).map((v,i)=>number(v,`signal[${i}]`,-1e9,1e9));
 const maxModes=integer(input.maxModes??6,'maxModes',1,32),maxSifts=integer(input.maxSifts??50,'maxSifts',1,200),tolerance=number(input.tolerance??.001,'tolerance',1e-10,.5);
 let residual=[...signal];const modes=[],sifts=[];
 for(let m=0;m<maxModes;m++){
  let ex=extrema(residual);if(ex.max.length===0||ex.min.length===0)break;
  let h=[...residual],n=0;
  for(;n<maxSifts;n++){
   ex=extrema(h);if(!ex.max.length||!ex.min.length)break;
   const hi=envelope(h,ex.max),lo=envelope(h,ex.min),mean=hi.map((v,i)=>(v+lo[i])/2);
   const next=h.map((v,i)=>v-mean[i]);
   const ratio=mean.reduce((s,v)=>s+v*v,0)/(h.reduce((s,v)=>s+v*v,0)+1e-24);
   h=next;if(ratio<tolerance){n++;break;}
  }
  if(!h.every(Number.isFinite))throw new RangeError('nonfinite sifting result');
  modes.push(h);sifts.push(n);residual=residual.map((v,i)=>v-h[i]);
 }
 const reconstruction=signal.map((_,i)=>residual[i]+modes.reduce((s,m)=>s+m[i],0));
 const maxReconstructionError=Math.max(...signal.map((x,i)=>Math.abs(x-reconstruction[i])));
 return {domain:'FINITE_LINEAR_ENVELOPE_EMD',modes,residual,sifts,maxReconstructionError,note:'Linear envelope extrema EMD, not cubic-spline EMD or a unique physical frequency decomposition.'};
}
