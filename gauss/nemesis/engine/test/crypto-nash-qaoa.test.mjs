import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {generateLatticeStorageKeypair,encryptLatticeStorage,decryptLatticeStorage,enumerateBimatrixEquilibriumPolytopes,evaluateDiagonalQAOA,trainDiagonalQAOA,runMotor} from '../src/index.mjs';
const close=(a,b,t=1e-7)=>assert.ok(Math.abs(a-b)<=t,`${a} vs ${b}`);
const decimal=x=>{const [n,d]=x.split('/').map(Number);return n/d;};
const mlkemAvailable=typeof crypto.encapsulate==='function'&&typeof crypto.decapsulate==='function';
const mlkemTest=mlkemAvailable?test:test.skip;
const getMlkemFixture=()=>({keys:generateLatticeStorageKeypair(),context:'nemesis:tenant-1:document-12:v1'});
mlkemTest('69 ML-KEM storage roundtrips empty, arbitrary binary, UTF-8 and large payload',()=>{
 const {keys,context}=getMlkemFixture();
 for(const data of [Buffer.alloc(0),Buffer.from([0,255,128,1]),Buffer.from('Némesis 🔐'),crypto.randomBytes(1024*1024)]){
  const container=encryptLatticeStorage({publicKey:keys.publicKey,data,context});assert.deepEqual(decryptLatticeStorage({privateKey:keys.privateKey,container:JSON.parse(JSON.stringify(container)),expectedContext:context}),data);
  assert.equal(container.header.algorithm,'ML-KEM-768-HKDF-SHA256-AES-256-GCM');
 }
});
mlkemTest('69 independently assembled KEM/HKDF/AES-GCM decrypts storage envelope',()=>{
 const {keys,context}=getMlkemFixture();
 const data=Buffer.from('independent assembly'),c=encryptLatticeStorage({publicKey:keys.publicKey,data,context}),h=c.header;
 const shared=crypto.decapsulate(keys.privateKey,Buffer.from(h.kemCiphertext,'base64'));
 const derived=crypto.hkdfSync('sha256',shared,Buffer.from(h.salt,'base64'),Buffer.from('NEMESIS_STORAGE_V1\0'+h.recipient),32);
 const decipher=crypto.createDecipheriv('aes-256-gcm',derived,Buffer.from(h.nonce,'base64'));
 const aad='{'+Object.keys(h).sort().map(k=>JSON.stringify(k)+':'+JSON.stringify(h[k])).join(',')+'}';
 decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(Buffer.from(c.tag,'base64'));
 assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(c.ciphertext,'base64')),decipher.final()]),data);shared.fill(0);
});
mlkemTest('69 alteration of every authenticated field or wrong key is rejected',()=>{
 const {keys,context}=getMlkemFixture();
 const base=encryptLatticeStorage({publicKey:keys.publicKey,data:Buffer.from('private bytes'),context});
 for(const field of ['ciphertext','tag','kemCiphertext','salt','nonce']){
  const changed=structuredClone(base),where=field in changed?changed:changed.header,b=Buffer.from(where[field],'base64');b[0]^=1;where[field]=b.toString('base64');
  assert.throws(()=>decryptLatticeStorage({privateKey:keys.privateKey,container:changed,expectedContext:context}),/authentication/);
 }
 for(const [field,value] of [['version',2],['algorithm','AES'],['recipient','0'.repeat(64)],['context','other'],['byteLength',1]]){
  const changed=structuredClone(base);changed.header[field]=value;assert.throws(()=>decryptLatticeStorage({privateKey:keys.privateKey,container:changed,expectedContext:context}));
 }
 assert.throws(()=>decryptLatticeStorage({privateKey:generateLatticeStorageKeypair().privateKey,container:base,expectedContext:context}),/recipient/);
 assert.throws(()=>decryptLatticeStorage({privateKey:keys.privateKey,container:base,expectedContext:'different'}),/context/);
});
mlkemTest('69 randomized encryption and registry PEM interface; no private material in ciphertext',()=>{
 const {keys,context}=getMlkemFixture();
 const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}),privateKeyPem=keys.privateKey.export({type:'pkcs8',format:'pem'}),dataBase64=Buffer.from('hello').toString('base64');
 const a=runMotor('69',{action:'encrypt',payload:{publicKeyPem,dataBase64,context}}),b=runMotor('69',{action:'encrypt',payload:{publicKeyPem,dataBase64,context}});assert.notEqual(a.container.ciphertext,b.container.ciphertext);
 assert.equal(runMotor('69',{action:'decrypt',payload:{privateKeyPem,container:a.container,expectedContext:context}}).dataBase64,dataBase64);
 assert.ok(!JSON.stringify(a).includes('PRIVATE KEY'));
 assert.throws(()=>runMotor('69',{action:'encrypt',payload:{publicKeyPem,dataBase64:'not canonical?',context}}),/encoding|base64/);
 assert.throws(()=>encryptLatticeStorage({publicKey:crypto.generateKeyPairSync('ed25519').publicKey,data:Buffer.from('x'),context}),/ML-KEM/);
});

const matching={rowPayoffs:[['1','-1'],['-1','1']],columnPayoffs:[['-1','1'],['1','-1']]};
test('03 exact mixed equilibrium of matching pennies and full continuum of zero game',()=>{
 const r=enumerateBimatrixEquilibriumPolytopes(matching);assert.equal(r.families.length,1);assert.deepEqual(r.families[0].rowVertices,[['1/2','1/2']]);assert.deepEqual(r.families[0].columnVertices,[['1/2','1/2']]);
 const zero=enumerateBimatrixEquilibriumPolytopes({rowPayoffs:[['0','0'],['0','0']],columnPayoffs:[['0','0'],['0','0']]});
 assert.ok(zero.families.some(f=>f.rowVertices.length===2&&f.columnVertices.length===2&&f.containsContinuum));assert.equal(zero.completeForInput,true);
});
test('03 unequal supports and degenerate rational polytope vertices satisfy Nash inequalities',()=>{
 const A=[[1,1,0],[1,1,0],[0,0,2]],B=[[2,2,0],[2,2,0],[0,0,1]],input={rowPayoffs:A.map(r=>r.map(String)),columnPayoffs:B.map(r=>r.map(String))},r=runMotor('03',{action:'enumerate',payload:input});
 assert.ok(r.families.some(f=>f.rowSupport.length!==f.columnSupport.length));
 for(const f of r.families){
  // An interior convex combination tests continuous families, in addition to vertices.
  const mix=vs=>vs[0].map((_,j)=>vs.reduce((s,row)=>s+decimal(row[j]),0)/vs.length);
  const ps=[...f.rowVertices.map(row=>row.map(decimal)),mix(f.rowVertices)],qs=[...f.columnVertices.map(row=>row.map(decimal)),mix(f.columnVertices)];
  for(const p of ps)for(const q of qs){const rows=A.map(row=>row.reduce((s,v,j)=>s+v*q[j],0)),cols=B[0].map((_,j)=>B.reduce((s,row,i)=>s+p[i]*row[j],0));close(p.reduce((s,v)=>s+v,0),1);close(q.reduce((s,v)=>s+v,0),1);p.forEach((v,i)=>{if(v>0)close(rows[i],Math.max(...rows));});q.forEach((v,j)=>{if(v>0)close(cols[j],Math.max(...cols));});}
 }
 assert.throws(()=>enumerateBimatrixEquilibriumPolytopes({...input,maxVertexSystems:1}),/budget/);
});
test('04 differentiable diagonal circuit agrees with independent legacy MaxCut simulator',()=>{
 const angles=[.7,.2],newResult=evaluateDiagonalQAOA({costs:[0,1,1,0],layers:1,angles}),old=runMotor('04',{vertices:2,edges:[{u:0,v:1,weight:1}],gammas:[angles[0]],betas:[angles[1]]});close(newResult.expectation,old.expectedCut);
 for(let j=0;j<2;j++){const a=[...angles],b=[...angles];a[j]+=1e-5;b[j]-=1e-5;close(newResult.gradient[j],(evaluateDiagonalQAOA({costs:[0,1,1,0],layers:1,angles:a}).expectation-evaluateDiagonalQAOA({costs:[0,1,1,0],layers:1,angles:b}).expectation)/2e-5);}
});
test('04 angle training reaches known single-edge bound and supports non-MaxCut Hamiltonian',()=>{
 const r=trainDiagonalQAOA({costs:[0,1,1,0],layers:1,seed:19,starts:3,iterations:100});assert.ok(r.expectation>.999999);assert.ok(r.expectationOptimalityGap<1e-6);assert.equal(r.quantumHardware,false);
 const general=runMotor('04',{action:'evaluate',payload:{costs:[-2,3,1,5],layers:2,angles:[.2,.4,.1,.5]}});close(general.normalization,1);assert.ok(general.expectation>=-2&&general.expectation<=5);
 assert.throws(()=>evaluateDiagonalQAOA({costs:[0,1,2,3,4],layers:1,angles:[0,0]}),/power of two/);
});
