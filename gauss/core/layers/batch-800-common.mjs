// Dependency-free bounded JSON contracts for offline GAUSS scientific kernels.
export function record(value, keys) {
 if(value===null||typeof value!=='object'||Array.isArray(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...keys].sort()))throw new TypeError(`expected exactly: ${keys.join(',')}`);
 return value;
}
export function integer(v,name='integer',lo=0,hi=1000000){if(!Number.isSafeInteger(v)||v<lo||v>hi)throw new RangeError(`${name} must be a safe integer in [${lo},${hi}]`);return v;}
export function array(v,name='array',lo=0,hi=1000){if(!Array.isArray(v)||v.length<lo||v.length>hi)throw new TypeError(`${name} must be an array with length in [${lo},${hi}]`);return v;}
export function uniqueInts(v,n,name='set'){const a=array(v,name,0,n).map((x,i)=>integer(x,`${name}[${i}]`,0,n-1));if(new Set(a).size!==a.length)throw new TypeError(`${name} has duplicates`);return a.sort((a,b)=>a-b);}
export function deepFreeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v);}return v;}
export const output=deepFreeze;
export function entries(specs,prefix,domain,start){return Object.freeze(specs.map(([tag,description,execute,input],i)=>Object.freeze({id:`GAUSS.${prefix}.${tag}.${start+i}`,domain,description,execute,input:deepFreeze(input)})));}
export const range=n=>Array.from({length:n},(_,i)=>i);
export function choose(n,k){if(k<0||k>n)return 0n;k=Math.min(k,n-k);let r=1n;for(let j=1;j<=k;j++)r=r*BigInt(n-j+1)/BigInt(j);return r;}
export function gcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b){[a,b]=[b,a%b];}return a;}
export function rational(n,d=1n){if(d===0n)throw new RangeError('zero denominator');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return `${n/g}/${d/g}`;}
