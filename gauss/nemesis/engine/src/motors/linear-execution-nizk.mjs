import {createHash, getDiffieHellman, randomBytes} from 'node:crypto';
// Fiat–Shamir generalized Schnorr proof that committed inputs satisfy a public
// affine program modulo q. Not a Groth16/PLONK proof or arbitrary execution SNARK.
const p=BigInt('0x'+getDiffieHellman('modp14').getPrime('hex'));
const q=(p-1n)/2n,g=4n;
const mod=(x,n=q)=>((x%n)+n)%n;
function pow(a,e){let b=mod(a,p),r=1n;for(;e>0n;e>>=1n,b=mod(b*b,p))if(e&1n)r=mod(r*b,p);return r;}
function scalar(v,label){if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v))throw new TypeError(`${label} must be unsigned canonical decimal`);const x=BigInt(v);if(x>=q)throw new RangeError(`${label} outside field`);return x;}
function point(v,label){if(typeof v!=='string'||!/^[1-9][0-9]*$/.test(v))throw new TypeError(`${label} must be canonical group element`);const x=BigInt(v);if(x>=p||pow(x,q)!==1n)throw new TypeError(`${label} outside prime-order subgroup`);return x;}
function randomScalar(){const n=Math.ceil(q.toString(2).length/8),excess=n*8-q.toString(2).length;for(;;){const bytes=randomBytes(n);bytes[0]&=(255>>>excess);const x=BigInt('0x'+bytes.toString('hex'));if(x<q)return x;}}
// SHA256-to-QR; the implementation does not know log_g(h).
const digest=BigInt('0x'+createHash('sha256').update('NEMESIS-PEDERSEN-SECOND-GENERATOR-V1').digest('hex'));
const h=pow(mod(digest,p),2n);
if(pow(g,q)!==1n||h===1n||h===g)throw new Error('invalid group parameters');
function statementObject(statement){
 if(statement===null||typeof statement!=='object'||Array.isArray(statement)||Object.keys(statement).sort().join(',')!=='coefficients,commitments,constant,context,output')throw new TypeError('invalid statement');
 if(!Array.isArray(statement.coefficients)||statement.coefficients.length<2||statement.coefficients.length>8||!Array.isArray(statement.commitments)||statement.commitments.length!==statement.coefficients.length)throw new TypeError('expected 2–8 witness commitments');
 if(typeof statement.context!=='string'||statement.context.length<1||statement.context.length>512)throw new TypeError('invalid context');
 const a=statement.coefficients.map((x,i)=>scalar(x,`coefficients[${i}]`));
 const cs=statement.commitments.map((x,i)=>point(x,`commitments[${i}]`));
 const constant=scalar(statement.constant,'constant'),output=scalar(statement.output,'output');
 if(a.every(x=>x===0n))throw new TypeError('at least one nonzero coefficient required');
 return {a,cs,constant,output};
}
function challenge(s,T,Ty){return BigInt('0x'+createHash('sha256').update('NEMESIS-AFFINE-EXECUTION-NIZK-V1\0').update(JSON.stringify([s,T,Ty])).digest('hex'))%q;}
/** Proof of knowledge of concealed inputs that obey a public linear computation. */
export function proveLinearExecution(input){
 if(input===null||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='coefficients,constant,context,witness')throw new TypeError('invalid proof input');
 if(!Array.isArray(input.witness)||!Array.isArray(input.coefficients)||input.witness.length!==input.coefficients.length||input.witness.length<2||input.witness.length>8)throw new TypeError('2–8 inputs required');
 const x=input.witness.map((v,i)=>scalar(v,`witness[${i}]`)),a=input.coefficients.map((v,i)=>scalar(v,`coefficients[${i}]`)),constant=scalar(input.constant,'constant');
 if(a.every(v=>v===0n))throw new TypeError('at least one nonzero coefficient required');
 if(typeof input.context!=='string'||input.context.length<1||input.context.length>512)throw new TypeError('invalid context');
 const blind=x.map(()=>randomScalar()),u=x.map(()=>randomScalar()),v=x.map(()=>randomScalar());
 const commitments=x.map((xi,i)=>mod(pow(g,xi)*pow(h,blind[i]),p).toString());
 const output=mod(constant+a.reduce((acc,ai,i)=>acc+ai*x[i],0n));
 const statement={coefficients:input.coefficients,constant:input.constant,output:output.toString(),commitments,context:input.context};
 const T=u.map((ui,i)=>mod(pow(g,ui)*pow(h,v[i]),p).toString());
 const Ty=mod(a.reduce((acc,ai,i)=>acc+ai*u[i],0n)).toString();
 const c=challenge(statement,T,Ty);
 const proof={T,Ty,z:u.map((ui,i)=>mod(ui+c*x[i]).toString()),w:v.map((vi,i)=>mod(vi+c*blind[i]).toString())};
 return {domain:'LINEAR_EXECUTION_NIZK_NOT_GENERAL_ZK_SNARK',statement,proof,warning:'Proof of committed affine execution modulo q; proof grows linearly with input count. Not a zk-SNARK for arbitrary code; no audited implementation.'};
}
export function verifyLinearExecution({statement,proof}={}){
 const {a,cs,constant,output}=statementObject(statement);
 if(proof===null||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).sort().join(',')!=='T,Ty,w,z'||!Array.isArray(proof.T)||!Array.isArray(proof.z)||!Array.isArray(proof.w)||proof.T.length!==a.length||proof.z.length!==a.length||proof.w.length!==a.length)throw new TypeError('invalid proof shape');
 const T=proof.T.map((v,i)=>point(v,`T[${i}]`)),Ty=scalar(proof.Ty,'Ty'),z=proof.z.map((v,i)=>scalar(v,`z[${i}]`)),w=proof.w.map((v,i)=>scalar(v,`w[${i}]`));
 const c=challenge(statement,proof.T,proof.Ty);
 const commitmentEquations=cs.every((C,i)=>mod(pow(g,z[i])*pow(h,w[i]),p)===mod(T[i]*pow(C,c),p));
 const outputEquation=mod(a.reduce((acc,ai,i)=>acc+ai*z[i],0n))===mod(Ty+c*mod(output-constant));
 return {domain:'LINEAR_EXECUTION_NIZK_NOT_GENERAL_ZK_SNARK',verified:commitmentEquations&&outputEquation};
}
export function runLinearExecutionProof(input){if(input?.mode==='prove'){const {mode,...rest}=input;return proveLinearExecution(rest);}if(input?.mode==='verify')return verifyLinearExecution(input);throw new TypeError('mode must be prove or verify');}
