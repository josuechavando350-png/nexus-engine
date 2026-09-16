// Exact bounded arithmetic. BigInt intermediates prevent IEEE-754 loss of integrality.
const fail=m=>{throw new TypeError(m);};
const shape=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join('|')!==keys.slice().sort().join('|'))fail(`expected exactly ${keys.join(',')}`);};
const int=(v,name,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(`${name} must be safe integer in [${min},${max}]`);return v;};
const freeze=Object.freeze;
const gcd=(a,b)=>{a=Math.abs(a);b=Math.abs(b);while(b)[a,b]=[b,a%b];return a;};
const factors=n=>{const out=[];for(let p=2;p*p<=n;p++){if(n%p)continue;let e=0;while(n%p===0){n/=p;e++;}out.push([p,e]);}if(n>1)out.push([n,1]);return out;};
const egcd=(a,b)=>{let oldR=a,r=b,oldS=1n,s=0n,oldT=0n,t=1n;while(r!==0n){const q=oldR/r;[oldR,r]=[r,oldR-q*r];[oldS,s]=[s,oldS-q*s];[oldT,t]=[t,oldT-q*t];}return [oldR,oldS,oldT];};
const mod=(a,m)=>((a%m)+m)%m;
const isPrime=n=>{if(n<2)return false;for(let d=2;d*d<=n;d++)if(n%d===0)return false;return true;};
export function mobiusFunction(input){shape(input,['n']);const n=int(input.n,'n',1,1e9),f=factors(n);return freeze({mu:f.some(([,e])=>e>1)?0:(f.length%2?-1:1)});}
export function exactDivisorSum(input){shape(input,['n']);const n=int(input.n,'n',1,1e9);let total=1n;
 for(const [p,e] of factors(n)){let power=1n,sum=1n;for(let k=0;k<e;k++){power*=BigInt(p);sum+=power;}total*=sum;}
 return freeze({sum:total.toString()});}
export function exactDivisorCount(input){shape(input,['n']);const n=int(input.n,'n',1,1e9),count=factors(n).reduce((s,[,e])=>s*(e+1),1);return freeze({count});}
export function multiplicativeOrder(input){shape(input,['base','modulus']);const m=int(input.modulus,'modulus',2,10000),a=mod(int(input.base,'base',-1e9,1e9),m);
 if(gcd(a,m)!==1)fail('multiplicative order requires coprime base and modulus');let x=1;
 for(let k=1;k<=m;k++){x=x*a%m;if(x===1)return freeze({order:k});}throw new Error('order existence invariant violated');}
export function boundedPrimeDiscreteLog(input){shape(input,['base','target','prime']);const p=int(input.prime,'prime',2,10000);if(!isPrime(p))fail('prime must be prime');const a=mod(int(input.base,'base',-1e9,1e9),p),target=mod(int(input.target,'target',-1e9,1e9),p);
 if(a===0)fail('discrete logarithm requires nonzero base');let value=1;
 for(let x=0;x<p-1;x++){if(value===target)return freeze({exponent:x,exists:true});value=value*a%p;}
 return freeze({exponent:null,exists:false});}
export function jacobiSymbol(input){shape(input,['numerator','denominator']);let a=int(input.numerator,'numerator',-1e9,1e9),n=int(input.denominator,'denominator',3,1e9);
 if(n%2===0)fail('Jacobi denominator must be odd');a=mod(a,n);let sign=1;
 while(a){while(a%2===0){a/=2;const r=n%8;if(r===3||r===5)sign=-sign;}[a,n]=[n,a];if(a%4===3&&n%4===3)sign=-sign;a%=n;}
 return freeze({symbol:n===1?sign:0});}
export function modularSquareRootsPrime(input){shape(input,['value','prime']);const p=int(input.prime,'prime',2,5000),a=mod(int(input.value,'value',-1e9,1e9),p);
 if(!isPrime(p))fail('modulus must be prime');const roots=[];for(let x=0;x<p;x++)if(x*x%p===a)roots.push(x);
 return freeze({roots:freeze(roots),hasRoot:roots.length>0});}
export function solveLinearCongruence(input){shape(input,['a','b','modulus']);const m=int(input.modulus,'modulus',2,5000),a=int(input.a,'a',-1e9,1e9),b=int(input.b,'b',-1e9,1e9);
 const divisor=gcd(a,m);if(b%divisor!==0)return freeze({solutions:freeze([]),solvable:false});
 const roots=[];for(let x=0;x<m;x++)if(mod(a*x-b,m)===0)roots.push(x);
 if(roots.length!==divisor)throw new Error('congruence solution count invariant violated');
 return freeze({solutions:freeze(roots),solvable:true});}
export function linearDiophantineWitness(input){shape(input,['a','b','c']);const a=int(input.a,'a',-1e9,1e9),b=int(input.b,'b',-1e9,1e9),c=int(input.c,'c',-1e9,1e9);
 if(a===0&&b===0)fail('at least one coefficient must be nonzero');let [g,x,y]=egcd(BigInt(a),BigInt(b));if(g<0n){g=-g;x=-x;y=-y;}
 if(BigInt(c)%g!==0n)return freeze({solvable:false,gcd:g.toString(),x:null,y:null});const q=BigInt(c)/g;
 return freeze({solvable:true,gcd:g.toString(),x:(x*q).toString(),y:(y*q).toString()});}
export function rationalContinuedFraction(input){shape(input,['numerator','denominator']);let a=int(input.numerator,'numerator',-1e9,1e9),b=int(input.denominator,'denominator',1,1e9);
 const quotients=[];while(b){const q=Math.floor(a/b);quotients.push(q);[a,b]=[b,a-q*b];}
 return freeze({quotients:freeze(quotients)});}
export function fareySequence(input){shape(input,['order']);const n=int(input.order,'order',1,64),fractions=[];let a=0,b=1,c=1,d=n;
 fractions.push(freeze([0,1]));while(c<=n){fractions.push(freeze([c,d]));const k=Math.floor((n+b)/d);[a,b,c,d]=[c,d,k*c-a,k*d-b];}
 return freeze({fractions:freeze(fractions),length:fractions.length});}
export function primitivePythagoreanTriples(input){shape(input,['maxHypotenuse']);const limit=int(input.maxHypotenuse,'maxHypotenuse',5,500),triples=[];
 for(let m=2;m*m+1<=limit;m++)for(let n=1;n<m;n++)if((m-n)%2!==0&&gcd(m,n)===1){const a=m*m-n*n,b=2*m*n,c=m*m+n*n;if(c<=limit)triples.push(freeze([Math.min(a,b),Math.max(a,b),c]));}
 triples.sort((a,b)=>a[2]-b[2]||a[0]-b[0]);return freeze({triples:freeze(triples)});}
