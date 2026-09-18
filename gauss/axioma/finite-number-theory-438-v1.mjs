/* Small-domain arithmetic reference with explicit divisors, residue tuples and word orbits. */
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['MERTENS','TOTIENT_SUM','DIVISOR_COUNT_SUM','GCD_SUM_MODULUS','GCD_PAIR_SUM','LCM_PAIR_SUM','SQUAREFREE_COUNT','DISTINCT_PRIME_FACTORS','PRIME_FACTORS_MULTIPLICITY','INTEGER_RADICAL','LIOUVILLE','UNITARY_DIVISOR_COUNT','UNITARY_DIVISOR_SUM','SIGMA_2','SIGMA_3','JORDAN_TOTIENT_2','JORDAN_TOTIENT_3','FAREY_LENGTH','BINARY_PRIMITIVE_WORDS','NECKLACES','PRIMITIVE_NECKLACES','BRACELETS','BINARY_NECKLACES_WEIGHT','RAMANUJAN_SUM','NTH_PRIME'];
const val=v=>({value:String(v)}),gcd=(a,b)=>b?gcd(b,a%b):a;
const divisors=n=>seq(n).map(i=>i+1).filter(d=>n%d===0);
const prime=n=>n>=2&&seq(n-2).every(i=>n%(i+2)!==0);
const factors=n=>seq(n-1).map(i=>i+2).filter(p=>prime(p)&&n%p===0);
const omega=n=>factors(n).reduce((s,p)=>{let m=n;while(m%p===0){s++;m/=p;}return s;},0);
const squarefree=n=>seq(Math.floor(Math.sqrt(n))-1).every(i=>n%((i+2)**2)!==0);
const mobius=n=>squarefree(n)?(-1)**factors(n).length:0;
const phi=n=>seq(n).filter(i=>gcd(i+1,n)===1).length;
const rotations=a=>seq(a.length).map(i=>a.slice(i).concat(a.slice(0,i)).join(','));
const canon=a=>rotations(a).sort()[0],necklace=a=>rotations(a).length===new Set(rotations(a)).size;
const words=(n,k)=>seq(k**n).map(j=>{const v=Array(n).fill(0);for(let i=0;i<n;i++){v[i]=j%k;j=Math.floor(j/k);}return v;});
function input(tag,i,r){const n=tag==='NTH_PRIME'?1+r(12):1+i%7,x={n};if(['NECKLACES','PRIMITIVE_NECKLACES','BRACELETS','BINARY_NECKLACES_WEIGHT','RAMANUJAN_SUM'].includes(tag))x.k=tag==='BINARY_NECKLACES_WEIGHT'?r(n+2):r(4);return x;}
function ref(tag,{n,k}){const ds=divisors(n),nums=seq(n).map(i=>i+1);
 switch(tag){
 case 'MERTENS':return val(nums.reduce((s,v)=>s+mobius(v),0));
 case 'TOTIENT_SUM':return val(nums.reduce((s,v)=>s+phi(v),0));
 case 'DIVISOR_COUNT_SUM':return val(nums.reduce((s,v)=>s+divisors(v).length,0));
 case 'GCD_SUM_MODULUS':return val(nums.reduce((s,v)=>s+gcd(v,n),0));
 case 'GCD_PAIR_SUM':return val(nums.reduce((s,v)=>s+nums.filter(w=>w<v).reduce((q,w)=>q+gcd(v,w),0),0));
 case 'LCM_PAIR_SUM':return val(nums.reduce((s,v)=>s+nums.filter(w=>w<v).reduce((q,w)=>q+v*w/gcd(v,w),0),0));
 case 'SQUAREFREE_COUNT':return val(nums.filter(squarefree).length);
 case 'DISTINCT_PRIME_FACTORS':return val(factors(n).length);
 case 'PRIME_FACTORS_MULTIPLICITY':return val(omega(n));
 case 'INTEGER_RADICAL':return val(factors(n).reduce((s,v)=>s*v,1));
 case 'LIOUVILLE':return val((-1)**omega(n));
 case 'UNITARY_DIVISOR_COUNT':return val(ds.filter(d=>gcd(d,n/d)===1).length);
 case 'UNITARY_DIVISOR_SUM':return val(ds.filter(d=>gcd(d,n/d)===1).reduce((s,d)=>s+d,0));
 case 'SIGMA_2':return val(ds.reduce((s,d)=>s+d*d,0));
 case 'SIGMA_3':return val(ds.reduce((s,d)=>s+d**3,0));
 case 'JORDAN_TOTIENT_2':return val(nums.reduce((s,a)=>s+nums.filter(b=>gcd(gcd(a,b),n)===1).length,0));
 case 'JORDAN_TOTIENT_3':return val(nums.reduce((s,a)=>s+nums.reduce((t,b)=>t+nums.filter(c=>gcd(gcd(gcd(a,b),c),n)===1).length,0),0));
 case 'FAREY_LENGTH':return val(1+nums.reduce((s,d)=>s+seq(d).filter(a=>gcd(a+1,d)===1).length,0));
 case 'BINARY_PRIMITIVE_WORDS':return val(words(n,2).filter(necklace).length);
 case 'NECKLACES':return val(new Set(words(n,k).map(canon)).size);
 case 'PRIMITIVE_NECKLACES':return val(new Set(words(n,k).filter(necklace).map(canon)).size);
 case 'BRACELETS':return val(new Set(words(n,k).map(a=>[...rotations(a),...rotations(a.slice().reverse())].sort()[0])).size);
 case 'BINARY_NECKLACES_WEIGHT':return val(new Set(words(n,2).filter(a=>a.reduce((s,v)=>s+v,0)===k).map(canon)).size);
 case 'RAMANUJAN_SUM':return val(Math.round(seq(n).filter(i=>gcd(i,n)===1).reduce((s,a)=>s+Math.cos(2*Math.PI*a*k/n),0)));
 case 'NTH_PRIME':{let found=0;for(let p=2;p<2000;p++)if(prime(p)&&++found===n)return val(p);throw Error('nth-prime bound');}
 default:throw Error('missing number-theory reference '+tag);
 }
}
export const runFiniteNumber438Bank=options=>runBatchBank({name:'AXIOMA bounded number theory and dihedral word orbits 223–247',prefix:'MATH',start:223,tags,input,reference:ref,...options});
