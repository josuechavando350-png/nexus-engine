import * as crypto from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {generateLatticeStorageKeypair,encryptLatticeStorage,decryptLatticeStorage} from '../src/index.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const report={motor:69,backend:'ML_KEM_768_AES_256_GCM',startedAt:new Date().toISOString(),node:process.version,status:'NOT_RUN',mlKemAvailable:typeof crypto.encapsulate==='function'&&typeof crypto.decapsulate==='function',sourceSha256:{}};
for(const name of ['src/motors/lattice-storage.mjs','scripts/verify-mlkem-69.mjs'])report.sourceSha256[name]=createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex');
mkdirSync(path.join(root,'evidence'),{recursive:true});
if(!report.mlKemAvailable){
  report.status='SKIPPED_UNSUPPORTED_NODE';
  report.reason='Node runtime does not expose crypto.encapsulate/decapsulate for ML-KEM';
}else{
  const {publicKey,privateKey}=generateLatticeStorageKeypair();
  const context='nemesis:verification:69';
  const plaintext=Buffer.from('NEMESIS verification payload 69');
  const container=encryptLatticeStorage({publicKey,data:plaintext,context});
  const roundtrip=decryptLatticeStorage({privateKey,container,expectedContext:context});
  const tampered=structuredClone(container);
  const c=Buffer.from(tampered.ciphertext,'base64'); c[0]^=1; tampered.ciphertext=c.toString('base64');
  let tamperRejected=false;
  try{decryptLatticeStorage({privateKey,container:tampered,expectedContext:context});}catch{tamperRejected=true;}
  report.status=Buffer.compare(roundtrip,plaintext)===0 && tamperRejected ? 'PASS' : 'BLOCKED_OR_FAILED';
  report.roundtripSha256=createHash('sha256').update(roundtrip).digest('hex');
  report.containerHeader={algorithm:container.header.algorithm,recipient:container.header.recipient,byteLength:container.header.byteLength};
  report.tamperRejected=tamperRejected;
  roundtrip.fill(0);
}
report.finishedAt=new Date().toISOString();
writeFileSync(path.join(root,'evidence','mlkem-69-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=report.status==='PASS'||report.status==='SKIPPED_UNSUPPORTED_NODE'?0:1;
