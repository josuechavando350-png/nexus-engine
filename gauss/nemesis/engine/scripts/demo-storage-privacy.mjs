import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateLatticeStorageKeypair,encryptLatticeStorage,decryptLatticeStorage,createPrivateIngestionLedger} from '../src/index.mjs';
const keys=generateLatticeStorageKeypair(),data=Buffer.from('Némesis: ejemplo sintético'),context='nemesis:demo:v1';
const container=encryptLatticeStorage({publicKey:keys.publicKey,data,context});
const restored=decryptLatticeStorage({privateKey:keys.privateKey,container,expectedContext:context});
const directory=mkdtempSync(join(tmpdir(),'nemesis-demo-')),secret=randomBytes(32);let ledger;
try{
 ledger=createPrivateIngestionLedger({databasePath:join(directory,'ledger.sqlite'),secret,budgetEpsilon:1});
 const request={requestId:'demo1',categories:['yes','no'],records:[{subjectId:'synthetic-person',value:'yes'}],epsilon:.4};
 const release=ledger.ingest(request),replay=ledger.ingest(request);
 console.log(JSON.stringify({project:'NEMESIS',storage:{algorithm:container.header.algorithm,roundtrip:restored.equals(data)},privacy:{epsilonSpent:ledger.accounting('synthetic-person').basicEpsilon,idempotent:JSON.stringify(release.privatized)===JSON.stringify(replay.privatized),replay:replay.replayed}},null,2));
}finally{restored.fill(0);secret.fill(0);ledger?.close();rmSync(directory,{recursive:true,force:true});}
