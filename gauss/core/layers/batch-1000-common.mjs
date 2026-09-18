// Self-contained bounded offline GAUSS 801–1000; no external runtime services.
export function object(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(Object.keys(v).sort())!==JSON.stringify([...keys].sort()))throw new TypeError(`expected exactly ${keys.join(',')}`);return v;}
export function int(v,label='integer',lo=-1000000,hi=1000000){if(!Number.isSafeInteger(v)||v<lo||v>hi)throw new RangeError(`${label} outside [${lo},${hi}]`);return v;}
export function arr(v,label='array',lo=0,hi=32){if(!Array.isArray(v)||v.length<lo||v.length>hi)throw new TypeError(`${label} length invalid`);return v;}
export function finite(v,label='finite'){if(typeof v!=='number'||!Number.isFinite(v))throw new TypeError(`${label} must be finite`);return v;}
export function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
export function entries(specs,prefix,domain,start){return Object.freeze(specs.map(([tag,description,execute,input],i)=>Object.freeze({id:`GAUSS.${prefix}.${tag}.${start+i}`,domain,description,execute,input:freeze(input)})));}
export function range(n){return Array.from({length:n},(_,i)=>i);}
export function gcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b)[a,b]=[b,a%b];return a;}
export function choose(n,k){if(k<0||k>n)return 0n;k=Math.min(k,n-k);let r=1n;for(let j=1;j<=k;j++)r=r*BigInt(n-j+1)/BigInt(j);return r;}
export function rational(n,d=1n){if(d===0n)throw new RangeError('zero denominator');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};}
export const zero=()=>rational(0n),one=()=>rational(1n);
export function q(v){if(typeof v==='number')return rational(BigInt(int(v)));if(typeof v==='string'){if(!/^-?\d{1,1024}(?:\/[1-9]\d{0,1023})?$/.test(v))throw new TypeError('invalid rational string');const [n,d='1']=v.split('/');return rational(BigInt(n),BigInt(d));}throw new TypeError('rational input must be integer or n/d string');}
export const qa=(a,b)=>rational(a.n*b.d+b.n*a.d,a.d*b.d);
export const qs=(a,b)=>rational(a.n*b.d-b.n*a.d,a.d*b.d);
export const qm=(a,b)=>rational(a.n*b.n,a.d*b.d);
export const qd=(a,b)=>rational(a.n*b.d,a.d*b.n);
export const qneg=a=>rational(-a.n,a.d);
export const qstr=a=>`${a.n}/${a.d}`;
export function assertBudget(n,maximum=8192){if(n>maximum)throw new RangeError('bounded enumeration budget exceeded');}
export function vector(v,label='vector',lo=0,hi=20){return arr(v,label,lo,hi).map((x,i)=>int(x,`${label}[${i}]`,-1000,1000));}
