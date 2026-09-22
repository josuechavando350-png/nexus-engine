import { array, number, integer, object, id } from './shared.mjs';
import { cholesky, solveLinear, dot, vector, matrix } from './numerics.mjs';
export { array, number, integer, object, id, cholesky, solveLinear, dot, vector, matrix };
export function prob(row, name, n) {
  array(row,name,n,n); row.forEach((v,i)=>number(v,`${name}[${i}]`,0,1));
  if(Math.abs(row.reduce((a,b)=>a+b,0)-1)>1e-10)throw new TypeError(`${name} probabilities must sum to one`);
  return row;
}
export function square(A,name,min=1,max=64){ const n=array(A,name,min,max).length; return matrix(A,name,n,n); }
export function assertFinite(x,name='result'){if(!Number.isFinite(x))throw new RangeError(`${name} numerical overflow`);return x;}
export function mod(x,p){let v=x%p;return v<0n?v+p:v;}
export function modPow(a,e,p){if(e<0n)throw new TypeError('negative exponent'); let r=1n;for(a=mod(a,p);e;e>>=1n,a=a*a%p)if(e&1n)r=r*a%p;return r;}
export function transpose(A){return A[0].map((_,j)=>A.map(r=>r[j]));}
export function mul(A,B){return A.map(row=>B[0].map((_,j)=>row.reduce((s,x,k)=>s+x*B[k][j],0)));}
export function eye(n){return Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>+(i===j)));}
export function canon(value){if(value===null||typeof value==='boolean'||typeof value==='string'||(typeof value==='number'&&Number.isFinite(value)))return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canon).join(',')}]`;if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return `{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canon(value[k])).join(',')}}`;throw new TypeError('canonical JSON contains unsupported value');}
