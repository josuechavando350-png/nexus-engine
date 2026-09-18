/* Count elementary equiprobable strings and labeled-ball assignments independently of GAUSS formula kernels. */
import {runFinalBank,range} from './final-common-v1.mjs';
const tags=['COIN_EXACT_HEADS','COIN_AT_MOST_HEADS','COIN_AT_LEAST_HEADS','COIN_EXACT_RUNS','COIN_FIRST_HEAD','COIN_LAST_HEAD','COIN_MAX_ONES_RUN','COIN_ADJACENT_ONES','COIN_ZERO_ONE_TRANSITIONS','COIN_NONADJACENT_K_HEADS','WALK_ENDPOINT','WALK_MAX_BOUND','WALK_FIRST_RETURN','OCCUPANCY_NO_COLLISIONS','OCCUPANCY_COLLISION','OCCUPANCY_ALL_BINS','OCCUPANCY_K_NONEMPTY','OCCUPANCY_BIN_EMPTY','OCCUPANCY_BIN_EXACT','OCCUPANCY_BIN_TAIL','OCCUPANCY_EQUAL','OCCUPANCY_ONE_DOUBLE','OCCUPANCY_MAX_TWO'];
const gcd=(a,b)=>{while(b)[a,b]=[b,a%b];return a;};
const rational=(num,den)=>{const g=gcd(num,den);return {numerator:String(num/g),denominator:String(den/g)};};
const bitwords=n=>range(2**n).map(mask=>range(n).map(i=>mask>>i&1));
function coinEvent(tag,b,k){const n=b.length,heads=b.reduce((a,c)=>a+c,0);let runs=0,longest=0,current=0,adjacent=0,transitions=0,pos=0,max=0,firstReturn=-1;
 for(let i=0;i<n;i++){
  if(i===0||b[i]!==b[i-1])runs++;
  current=b[i]?current+1:0;longest=Math.max(longest,current);
  if(i&&b[i]&&b[i-1])adjacent++;
  if(i&&!b[i-1]&&b[i])transitions++;
  pos+=b[i]?1:-1;max=Math.max(max,pos);
  if(pos===0&&firstReturn<0)firstReturn=i+1;
 }
 switch(tag){
 case 'COIN_EXACT_HEADS':return heads===k;
 case 'COIN_AT_MOST_HEADS':return heads<=k;
 case 'COIN_AT_LEAST_HEADS':return heads>=k;
 case 'COIN_EXACT_RUNS':return runs===k;
 case 'COIN_FIRST_HEAD':return b.indexOf(1)===k-1&&k>=1;
 case 'COIN_LAST_HEAD':return b.lastIndexOf(1)===k-1&&k>=1;
 case 'COIN_MAX_ONES_RUN':return longest<=k;
 case 'COIN_ADJACENT_ONES':return adjacent===k;
 case 'COIN_ZERO_ONE_TRANSITIONS':return transitions===k;
 case 'COIN_NONADJACENT_K_HEADS':return heads===k&&adjacent===0;
 case 'WALK_ENDPOINT':return pos===k;
 case 'WALK_MAX_BOUND':return max<=k;
 case 'WALK_FIRST_RETURN':return firstReturn===n&&n>0;
 default:throw Error('unknown binary event '+tag);
 }
}
function binsEvent(tag,balls,m,k){const count=range(m).map(j=>balls.filter(v=>v===j).length),active=count.filter(v=>v>0).length,doubles=count.filter(v=>v===2).length;
 switch(tag){
 case 'OCCUPANCY_NO_COLLISIONS':return count.every(v=>v<=1);
 case 'OCCUPANCY_COLLISION':return count.some(v=>v>=2);
 case 'OCCUPANCY_ALL_BINS':return active===m;
 case 'OCCUPANCY_K_NONEMPTY':return active===k;
 case 'OCCUPANCY_BIN_EMPTY':return count[0]===0;
 case 'OCCUPANCY_BIN_EXACT':return count[0]===k;
 case 'OCCUPANCY_BIN_TAIL':return count[0]>=k;
 case 'OCCUPANCY_EQUAL':return count.every(v=>v===count[0]);
 case 'OCCUPANCY_ONE_DOUBLE':return doubles===1&&count.every(v=>v<=2);
 case 'OCCUPANCY_MAX_TWO':return count.every(v=>v<=2);
 default:throw Error('unknown occupancy event '+tag);
 }
}
function reference(tag,x){let total=0n,wins=0n;
 if(tag.startsWith('OCCUPANCY_')){
  const {n,m,k}=x;
  for(let encoded=0;encoded<m**n;encoded++){
   let z=encoded;const outcome=range(n).map(()=>{const v=z%m;z=Math.floor(z/m);return v;});
   total++;if(binsEvent(tag,outcome,m,k))wins++;
  }
 }else{
  const {n,k}=x;
  for(const outcome of bitwords(n)){total++;if(coinEvent(tag,outcome,k))wins++;}
 }
 return rational(wins,total);
}
function sample(tag,i,r){if(tag.startsWith('OCCUPANCY_')){
 const n=r(7),m=1+r(4),k=r(8);return ['OCCUPANCY_K_NONEMPTY','OCCUPANCY_BIN_EXACT','OCCUPANCY_BIN_TAIL'].includes(tag)?{n,m,k}:{n,m};
 }
 const n=r(9),k=tag==='WALK_FIRST_RETURN'?0:r(11);return {n,k};
}
const definitions=tags.map((tag,index)=>({id:`GAUSS.STATS.${tag}.${201+index}`,make:(i,r)=>sample(tag,i,r),reference:x=>reference(tag,x)}));
export const runFinalFiniteEventsBank=options=>runFinalBank({name:'AXIOMA 23 bounded equiprobable coin walk occupancy events',definitions,...options});
