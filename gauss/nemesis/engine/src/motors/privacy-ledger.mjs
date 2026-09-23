import {DatabaseSync} from 'node:sqlite';
import {createHmac,randomInt,timingSafeEqual} from 'node:crypto';
import {object,array,number,integer,id,unique} from './shared.mjs';
import {canon} from './finite-tools.mjs';
const SCALE=1e9;
/** Local transactional accountant. Caller owns identity authentication and protection against DB rollback. */
export function createPrivateIngestionLedger(options){
 object(options,'privacy ledger options',['databasePath','secret','budgetEpsilon']);
 if(typeof options.databasePath!=='string'||!options.databasePath)throw new TypeError('databasePath required');
 if(!Buffer.isBuffer(options.secret)||options.secret.length!==32)throw new TypeError('ledger secret must be 32 bytes');
 const budget=Math.floor(number(options.budgetEpsilon,'budgetEpsilon',.001,1000)*SCALE),secret=Buffer.from(options.secret);
 const mac=value=>createHmac('sha256',secret).update(value).digest('hex'),keyTag=mac('NEMESIS_PRIVACY_ACCOUNTANT_KEY_V1');
 const db=new DatabaseSync(options.databasePath);let closed=false;
 try{
  db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), budget INTEGER NOT NULL, key_tag TEXT NOT NULL); CREATE TABLE IF NOT EXISTS subjects (tag TEXT PRIMARY KEY, spent INTEGER NOT NULL, sum_squares REAL NOT NULL, exp_term REAL NOT NULL, releases INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);');
  const metadata=db.prepare('SELECT budget,key_tag FROM metadata WHERE id=1').get();
  if(metadata){if(metadata.budget!==budget||metadata.key_tag!==keyTag)throw new Error('ledger budget or secret does not match existing policy');}
  else db.prepare('INSERT INTO metadata(id,budget,key_tag) VALUES(1,?,?)').run(budget,keyTag);
  db.exec('COMMIT');
 }catch(error){try{db.exec('ROLLBACK');}catch{}db.close();secret.fill(0);throw error;}
 function alive(){if(closed)throw new Error('ledger is closed');}
 function subjectTag(raw){if(typeof raw!=='string'||raw.length<1||raw.length>256)throw new TypeError('subjectId must be 1..256 characters');return mac('subject\0'+raw);}
 function ingest(input){
  alive();object(input,'accounted ingestion',['requestId','categories','records','epsilon']);const requestId=id(input.requestId,'requestId'),categories=unique(array(input.categories,'categories',2,32).map(v=>id(v,'category')),'categories'),epsilon=number(input.epsilon,'epsilon',.001,16),charge=Math.ceil(epsilon*SCALE);
  const records=array(input.records,'records',1,100000).map(r=>{object(r,'record',['subjectId','value']);const tag=subjectTag(r.subjectId);if(!categories.includes(r.value))throw new TypeError('unknown category');return {tag,value:r.value};});
  const digest=mac(canon({categories,records,epsilon}));
  db.exec('BEGIN IMMEDIATE');
  try{
   const existing=db.prepare('SELECT digest,result FROM requests WHERE id=?').get(requestId);
   if(existing){if(!timingSafeEqual(Buffer.from(existing.digest,'hex'),Buffer.from(digest,'hex')))throw new Error('requestId was reused with different inputs');db.exec('COMMIT');return {...JSON.parse(existing.result),replayed:true};}
   const charges=new Map();for(const r of records)charges.set(r.tag,(charges.get(r.tag)??0)+1);
   const next=[];
   for(const [tag,count] of charges){
    const old=db.prepare('SELECT spent,sum_squares,exp_term,releases FROM subjects WHERE tag=?').get(tag)??{spent:0,sum_squares:0,exp_term:0,releases:0};
    const spent=old.spent+count*charge;if(!Number.isSafeInteger(spent)||spent>budget)throw new RangeError('privacy budget exceeded; entire request rejected');
    const e=charge/SCALE;next.push({tag,spent,sumSquares:old.sum_squares+count*e*e,expTerm:old.exp_term+count*e*Math.expm1(e),releases:old.releases+count});
   }
   // Round down truthful probability. False categories sampled uniformly with randomInt.
   // This guarantees the discrete mechanism's epsilon is no larger than the requested epsilon.
   const k=categories.length,threshold=Math.floor(Math.exp(epsilon)/(Math.exp(epsilon)+k-1)*2**32),p=threshold/2**32;
   const privatized=records.map(r=>randomInt(2**32)<threshold?r.value:categories[(categories.indexOf(r.value)+1+randomInt(k-1))%k]);
   const result={domain:'TRANSACTIONAL_LOCAL_DIFFERENTIAL_PRIVACY',requestId,epsilon,actualMechanismEpsilon:Math.log(p*(k-1)/(1-p)),privatized,accounting:next.map(r=>({subjectTag:r.tag,epsilonSpent:r.spent/SCALE,epsilonRemaining:(budget-r.spent)/SCALE,releases:r.releases})),replayed:false};
   const upsert=db.prepare('INSERT INTO subjects(tag,spent,sum_squares,exp_term,releases) VALUES(?,?,?,?,?) ON CONFLICT(tag) DO UPDATE SET spent=excluded.spent,sum_squares=excluded.sum_squares,exp_term=excluded.exp_term,releases=excluded.releases');
   for(const row of next)upsert.run(row.tag,row.spent,row.sumSquares,row.expTerm,row.releases);
   db.prepare('INSERT INTO requests(id,digest,result) VALUES(?,?,?)').run(requestId,digest,JSON.stringify(result));
   db.exec('COMMIT');return result;
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
 }
 function accounting(subjectId,delta=0){
  alive();number(delta,'delta',0,.1);const r=db.prepare('SELECT spent,sum_squares,exp_term,releases FROM subjects WHERE tag=?').get(subjectTag(subjectId))??{spent:0,sum_squares:0,exp_term:0,releases:0};
  const basic=r.spent/SCALE,advanced=delta>0?Math.sqrt(2*Math.log(1/delta)*r.sum_squares)+r.exp_term:null;
  return {basicEpsilon:basic,delta,composedEpsilon:advanced===null?basic:Math.min(basic,advanced),releases:r.releases,remainingPureEpsilon:(budget-r.spent)/SCALE,enforcedBudget:'pure epsilon sequential composition'};
 }
 return {ingest,accounting,close(){if(!closed){closed=true;db.close();secret.fill(0);}}};
}
export function runAccountedPrivacy(input){
 object(input,'accounted privacy',['databasePath','ledgerSecretHex','budgetEpsilon','request']);
 if(typeof input.ledgerSecretHex!=='string'||!/^[0-9a-f]{64}$/.test(input.ledgerSecretHex))throw new TypeError('ledgerSecretHex must encode exactly 32 bytes');
 const secret=Buffer.from(input.ledgerSecretHex,'hex');let ledger;
 try{ledger=createPrivateIngestionLedger({databasePath:input.databasePath,secret,budgetEpsilon:input.budgetEpsilon});return ledger.ingest(input.request);}
 finally{ledger?.close();secret.fill(0);}
}
