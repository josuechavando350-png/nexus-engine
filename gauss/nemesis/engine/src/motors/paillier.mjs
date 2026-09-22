import {generatePrimeSync,randomBytes} from 'node:crypto';
import {object,integer,gcd} from './shared.mjs';
const mod=(a,n)=>(a%n+n)%n;
function pow(base,exponent,n){let result=1n;base=mod(base,n);for(;exponent>0n;exponent>>=1n){if(exponent&1n)result=result*base%n;base=base*base%n;}return result;}
function inverse(a,n){let [t,nt,r,nr]=[0n,1n,n,mod(a,n)];while(nr){const q=r/nr;[t,nt]=[nt,t-q*nt];[r,nr]=[nr,r-q*nr];}if(r!==1n)throw new TypeError('no modular inverse');return mod(t,n);}
function parse(v,name){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,2599})$/.test(v))throw new TypeError(`${name} must be unsigned decimal bigint`);return BigInt(v);}
function draw(n){const len=Math.ceil(n.toString(2).length/8);while(true){const r=BigInt(`0x${randomBytes(len).toString('hex')}`);if(r>0n&&r<n&&gcd(r,n)===1n)return r;}}
/** Local additive Paillier only; fresh randomness for every encryption. NOT audited cryptographic software. */
export function generatePaillierKeypair({primeBits=1024}={}){
 integer(primeBits,'primeBits',1024,2048);
 let p=generatePrimeSync(primeBits,{bigint:true}),q=generatePrimeSync(primeBits,{bigint:true});while(q===p)q=generatePrimeSync(primeBits,{bigint:true});
 const n=p*q,lambda=(p-1n)/gcd(p-1n,q-1n)*(q-1n);
 const mu=inverse(lambda,n);return {publicKey:{n:n.toString()},privateKey:{n:n.toString(),lambda:lambda.toString(),mu:mu.toString()}};
}
function pub(k){object(k,'publicKey',['n']);const n=parse(k.n,'n');if(n<2n**2046n||n%2n===0n)throw new TypeError('unsupported modulus');return n;}
export function paillierEncrypt(k,message){const n=pub(k),m=parse(message,'message');if(m>=n)throw new TypeError('plaintext must be < n');const ns=n*n,r=draw(n);return ((1n+m*n)*pow(r,n,ns)%ns).toString();}
export function paillierAdd(k,left,right){const n=pub(k),ns=n*n,a=parse(left,'left'),b=parse(right,'right');if(a<=0n||a>=ns||b<=0n||b>=ns||gcd(a,n)!==1n||gcd(b,n)!==1n)throw new TypeError('invalid ciphertext');return (a*b%ns).toString();}
export function paillierScale(k,ciphertext,scalar){const n=pub(k),ns=n*n,a=parse(ciphertext,'ciphertext'),s=parse(scalar,'scalar');if(s>1000000n)throw new TypeError('scalar too large');if(a<=0n||a>=ns||gcd(a,n)!==1n)throw new TypeError('invalid ciphertext');return pow(a,s,ns).toString();}
export function paillierDecrypt(privateKey,ciphertext){object(privateKey,'privateKey',['n','lambda','mu']);const n=pub({n:privateKey.n}),lambda=parse(privateKey.lambda,'lambda'),mu=parse(privateKey.mu,'mu'),ns=n*n,c=parse(ciphertext,'ciphertext');if(c<=0n||c>=ns||gcd(c,n)!==1n)throw new TypeError('invalid ciphertext');const u=pow(c,lambda,ns);if((u-1n)%n!==0n)throw new TypeError('invalid decrypted group value');return (mod((u-1n)/n*mu,n)).toString();}
/** CLI: public-key encryption and ciphertext homomorphic addition only; no secrets passed to JSON CLI. */
export function runPaillier(input){object(input,'input',['publicKey','message','left','right'],['publicKey']);if(Object.hasOwn(input,'message'))return {domain:'PAILLIER_ADDITIVE_ONLY',ciphertext:paillierEncrypt(input.publicKey,input.message)};if(Object.hasOwn(input,'left')&&Object.hasOwn(input,'right'))return {domain:'PAILLIER_ADDITIVE_ONLY',ciphertext:paillierAdd(input.publicKey,input.left,input.right)};throw new TypeError('message or left/right required');}
