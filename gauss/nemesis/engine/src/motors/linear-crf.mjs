import {object,array,number,integer,matrix,vector,assertFinite} from './finite-tools.mjs';
const lse=xs=>{const m=Math.max(...xs);return m+Math.log(xs.reduce((s,v)=>s+Math.exp(v-m),0));};
/** Linear-chain CRF with supplied log potentials, exact forward/backward and MAP. */
export function inferLinearCRF(input){
 object(input,'crf',['unary','transition','start','end'],['unary','transition']);const unary=array(input.unary,'unary',1,512),k=array(unary[0],'unary[0]',2,32).length;
 const U=unary.map((r,i)=>vector(r,`unary[${i}]`,k,k)),T=matrix(input.transition,'transition',k,k),start=input.start?vector(input.start,'start',k,k):Array(k).fill(0),end=input.end?vector(input.end,'end',k,k):Array(k).fill(0),N=U.length;
 const forward=[U[0].map((v,i)=>v+start[i])],delta=[forward[0].slice()],prev=[];
 for(let t=1;t<N;t++){const a=[],d=[],back=[];for(let j=0;j<k;j++){a.push(U[t][j]+lse(forward[t-1].map((v,i)=>v+T[i][j])));const c=delta[t-1].map((v,i)=>v+T[i][j]);let b=0;for(let i=1;i<k;i++)if(c[i]>c[b])b=i;d.push(U[t][j]+c[b]);back.push(b);}forward.push(a);delta.push(d);prev.push(back);}
 const logZ=lse(forward.at(-1).map((v,j)=>v+end[j]));const backward=Array.from({length:N},()=>Array(k).fill(0));backward[N-1]=end.slice();
 for(let t=N-2;t>=0;t--)for(let i=0;i<k;i++)backward[t][i]=lse(T[i].map((v,j)=>v+U[t+1][j]+backward[t+1][j]));
 const marginals=forward.map((row,t)=>row.map((v,j)=>Math.exp(v+backward[t][j]-logZ)));let best=0;const scores=delta.at(-1).map((v,j)=>v+end[j]);for(let j=1;j<k;j++)if(scores[j]>scores[best])best=j;const path=[best];for(let t=N-2;t>=0;t--)path.unshift(best=prev[t][best]);
 assertFinite(logZ);return {domain:'FINITE_LINEAR_CHAIN_CRF',logPartition:logZ,marginals,mapPath:path,mapLogScore:Math.max(...scores),note:'Exact inference for supplied finite unary and transition log potentials; no parameter training.'};
}
