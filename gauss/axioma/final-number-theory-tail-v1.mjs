/* Independent small-modulus exhaustive square residues and multiplicative cycles. */
import {runFinalBank,range} from './final-common-v1.mjs';
const gcd=(a,b)=>b?gcd(b,a%b):a;
const definitions=[
 {id:'GAUSS.MATH.QUADRATIC_RESIDUE_COUNT.248',make:(i,r)=>({n:1+r(160)}),reference:({n})=>({value:String(new Set(range(n).map(x=>x*x%n)).size)})},
 {id:'GAUSS.MATH.PRIMITIVE_ROOT_COUNT.249',make:(i,r)=>({n:2+r(75)}),reference:({n})=>{const units=range(n).filter(x=>gcd(x,n)===1),groupSize=units.length;let total=0;for(const generator of units){let v=1;const elements=new Set();for(let k=0;k<groupSize;k++){elements.add(v);v=v*generator%n;}if(elements.size===groupSize)total++;}return {value:String(total)};}}
];
export const runFinalNumberTheoryTailBank=options=>runFinalBank({name:'AXIOMA quadratic residues and primitive unit cycles',definitions,...options});
