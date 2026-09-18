// Native Node.js only. Every public kernel validates bounded JSON input.
export function obj(x, required) {
 if (!x || typeof x !== 'object' || Array.isArray(x) || JSON.stringify(Object.keys(x).sort()) !== JSON.stringify([...required].sort())) throw new TypeError(`expected exactly ${required.join(',')}`);
 return x;
}
export function int(x,name,lo=0,hi=100000) {if(!Number.isSafeInteger(x)||x<lo||x>hi)throw new RangeError(`${name}: bounded safe integer required`);return x;}
export function arr(x,name,min=0,max=100) {if(!Array.isArray(x)||x.length<min||x.length>max)throw new TypeError(`${name}: bounded array required`);return x;}
export function frozen(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))frozen(v);Object.freeze(x);}return x;}
export function result(x){return frozen(x);}
export function entries(defs,prefix,domain,start){return Object.freeze(defs.map(([tag,description,execute,input],i)=>Object.freeze({id:`GAUSS.${prefix}.${tag}.${start+i}`,domain,description,execute,input:frozen(input)})));}
export function bigintString(x){return String(x);}
export function choose(n,k){if(k<0||k>n)return 0n;k=Math.min(k,n-k);let r=1n;for(let j=1;j<=k;j++)r=r*BigInt(n-j+1)/BigInt(j);return r;}
export function factorial(n){let x=1n;for(let k=2;k<=n;k++)x*=BigInt(k);return x;}
export function sorted(a){return a.slice().sort((x,y)=>x-y);}
export function lexLess(a,b){if(b===null)return true;for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]<b[i];return a.length<b.length;}
