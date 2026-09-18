// Shared strict bounded contracts. This module has no network, environment or package imports.
export function fields(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new TypeError(`expected exactly {${keys.join(',')}}`);return value;}
export function int(x,name='integer',min=-1000000,max=1000000){if(!Number.isSafeInteger(x)||x<min||x>max)throw new TypeError(`${name} must be a bounded safe integer`);return x;}
export function vector(xs,{min=0,max=32}={}){if(!Array.isArray(xs)||xs.length<min||xs.length>max)throw new TypeError('expected bounded vector');return xs.map((v,i)=>BigInt(int(v,`vector[${i}]`)));}
export function matrix(m){if(!Array.isArray(m)||!m.length||m.length>8||!Array.isArray(m[0])||!m[0].length||m[0].length>8||m.some(row=>!Array.isArray(row)||row.length!==m[0].length))throw new TypeError('expected rectangular matrix of size 1..8');return m.map(row=>vector(row,{min:1,max:8}));}
export function scalar(v){return BigInt(int(v));}
export function freeze(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;}
export function pack(x){const safe=v=>typeof v==='bigint'?v.toString():Array.isArray(v)?v.map(safe):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,safe(x)])):v;return freeze(safe(x));}
export function gcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b)[a,b]=[b,a%b];return a;}
export function boundedBig(x){if(x.toString().replace('-','').length>4096)throw new RangeError('exact integer exceeds 4096 decimal digits');return x;}
export function graph(input,{directed=false}={}){fields(input,['vertexCount','edges']);const n=int(input.vertexCount,'vertexCount',1,12);if(!Array.isArray(input.edges)||input.edges.length>n*(n-1))throw new TypeError('bounded edges required');const edges=[],seen=new Set();for(const e of input.edges){fields(e,['from','to']);const a=int(e.from,'from',0,n-1),b=int(e.to,'to',0,n-1);if(a===b)throw new TypeError('self loops unsupported');const key=directed?`${a}:${b}`:`${Math.min(a,b)}:${Math.max(a,b)}`;if(seen.has(key))throw new TypeError('duplicate edge');seen.add(key);edges.push([a,b]);}return {n,edges};}
export function seq(input,keys=['values']){fields(input,keys);return vector(input.values,{min:0,max:14});}
export function choose(n,k){if(k<0||k>n)return 0n;k=Math.min(k,n-k);let v=1n;for(let i=1;i<=k;i++)v=v*BigInt(n-k+i)/BigInt(i);return v;}
export function abs(x){return x<0n?-x:x;}
