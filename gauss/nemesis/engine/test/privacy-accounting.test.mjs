import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createPrivateIngestionLedger} from '../src/motors/privacy-ledger.mjs';
function fixture(run){const dir=mkdtempSync(join(tmpdir(),'nemesis-privacy-')),options={databasePath:join(dir,'ledger.sqlite'),secret:randomBytes(32),budgetEpsilon:1};let ledger=createPrivateIngestionLedger(options);try{run(ledger,options);}finally{ledger.close();rmSync(dir,{recursive:true,force:true});options.secret.fill(0);}}
const request={requestId:'request1',categories:['yes','no'],records:[{subjectId:'person-secret',value:'yes'}],epsilon:.4};
test('61 transactional composition persists across restart and replay does not re-spend',()=>fixture((l,o)=>{
 const first=l.ingest(request);assert.ok(first.actualMechanismEpsilon<=.4);const again=l.ingest(request);assert.deepEqual(again.privatized,first.privatized);assert.equal(again.replayed,true);assert.equal(l.accounting('person-secret').basicEpsilon,.4);
 l.close();const reopened=createPrivateIngestionLedger(o);try{assert.equal(reopened.accounting('person-secret').basicEpsilon,.4);reopened.ingest({...request,requestId:'request2'});assert.throws(()=>reopened.ingest({...request,requestId:'request3'}),/budget/);assert.equal(reopened.accounting('person-secret').basicEpsilon,.8);}finally{reopened.close();}
}));
test('61 budget failure is atomic across subjects and repeated subjects charged individually',()=>fixture(l=>{
 l.ingest({...request,epsilon:.8});
 assert.throws(()=>l.ingest({...request,requestId:'batch',records:[{subjectId:'new-person',value:'yes'},request.records[0]]}),/budget/);
 assert.equal(l.accounting('new-person').basicEpsilon,0);
 assert.throws(()=>l.ingest({...request,requestId:'double',epsilon:.11,records:[request.records[0],request.records[0]]}),/budget/);
 assert.equal(l.accounting('person-secret').basicEpsilon,.8);
}));
test('61 policy changes, malformed data and request id rebinding are rejected',()=>fixture((l,o)=>{
 l.ingest(request);assert.throws(()=>l.ingest({...request,epsilon:.3}),/different inputs/);
 assert.throws(()=>l.ingest({...request,requestId:'bad',records:[{subjectId:'new',value:'unknown'}]}),/category/);assert.equal(l.accounting('new').basicEpsilon,0);
 assert.throws(()=>createPrivateIngestionLedger({...o,budgetEpsilon:2}),/policy/);assert.throws(()=>createPrivateIngestionLedger({...o,secret:randomBytes(32)}),/policy/);
 assert.ok(!readFileSync(o.databasePath).includes(Buffer.from('person-secret')));
}));
test('61 two connections share atomic accounting, advanced bound is explicit',()=>fixture((l,o)=>{
 const second=createPrivateIngestionLedger(o);try{l.ingest(request);second.ingest({...request,requestId:'two'});assert.equal(l.accounting('person-secret').releases,2);assert.throws(()=>l.ingest({...request,requestId:'three'}),/budget/);const r=l.accounting('person-secret',.001);assert.ok(r.composedEpsilon<=r.basicEpsilon);assert.equal(r.delta,.001);}finally{second.close();}
}));

test('61 independent processes cannot jointly overspend the same persisted budget',async()=>{
 const {spawn}=await import('node:child_process'),dir=mkdtempSync(join(tmpdir(),'nemesis-race-')),databasePath=join(dir,'ledger.sqlite'),secret=randomBytes(32),options={databasePath,secret,budgetEpsilon:1};
 const initial=createPrivateIngestionLedger(options);initial.close();
 const moduleUrl=new URL('../src/motors/privacy-ledger.mjs',import.meta.url).href;
 const source=`import {createPrivateIngestionLedger} from ${JSON.stringify(moduleUrl)}; const l=createPrivateIngestionLedger({databasePath:process.env.NEMESIS_TEST_DB,secret:Buffer.from(process.env.NEMESIS_TEST_SECRET,'hex'),budgetEpsilon:1});try{l.ingest({requestId:process.env.NEMESIS_TEST_ID,categories:['yes','no'],records:[{subjectId:'shared',value:'yes'}],epsilon:.4});process.stdout.write('released');}catch(e){if(/budget exceeded/.test(e.message))process.stdout.write('budget');else throw e;}finally{l.close();}`;
 try{
  const outcomes=await Promise.all(Array.from({length:4},(_,i)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,NEMESIS_TEST_DB:databasePath,NEMESIS_TEST_SECRET:secret.toString('hex'),NEMESIS_TEST_ID:'race'+i},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>err+=s);p.on('error',reject);p.on('exit',code=>code===0?resolve(out):reject(new Error(err)));})));
  assert.equal(outcomes.filter(s=>s==='released').length,2);assert.equal(outcomes.filter(s=>s==='budget').length,2);
  const verify=createPrivateIngestionLedger(options);try{assert.equal(verify.accounting('shared').basicEpsilon,.8);assert.equal(verify.accounting('shared').releases,2);}finally{verify.close();}
 }finally{secret.fill(0);rmSync(dir,{recursive:true,force:true});}
});
