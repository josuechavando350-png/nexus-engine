import * as crypto from 'node:crypto';
import {object,number} from './shared.mjs';
import {canon} from './finite-tools.mjs';
const ALGORITHM='ML-KEM-768-HKDF-SHA256-AES-256-GCM',MAX_BYTES=16*1024*1024;
function available(){if(typeof crypto.encapsulate!=='function'||typeof crypto.decapsulate!=='function')throw new Error('ML-KEM storage requires Node.js >=24 with ML-KEM support; no insecure fallback');}
function key(raw,privateKey=false){const k=raw instanceof crypto.KeyObject?raw:privateKey?crypto.createPrivateKey(raw):crypto.createPublicKey(raw);if(k.type!==(privateKey?'private':'public')||k.asymmetricKeyType!=='ml-kem-768')throw new TypeError('expected ML-KEM-768 '+(privateKey?'private':'public')+' key');return k;}
const fingerprint=k=>crypto.createHash('sha256').update((k.type==='private'?crypto.createPublicKey(k):k).export({format:'der',type:'spki'})).digest('hex');
function context(raw){if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>4096||Buffer.from(raw,'utf8').toString('utf8')!==raw)throw new TypeError('context must be canonical UTF-8 string <=4096 bytes');return raw;}
function b64(raw,label,length,max=length){if(typeof raw!=='string'||raw.length>4*Math.ceil(max/3))throw new TypeError('invalid '+label+' base64');const bytes=Buffer.from(raw,'base64');if(bytes.toString('base64')!==raw||bytes.length<length||bytes.length>max)throw new TypeError('invalid '+label+' length or encoding');return bytes;}
export function generateLatticeStorageKeypair(){available();return crypto.generateKeyPairSync('ml-kem-768');}
export function encryptLatticeStorage({publicKey,data,context:rawContext}){
 available();const recipient=key(publicKey),ctx=context(rawContext);
 if(!Buffer.isBuffer(data)&&!(data instanceof Uint8Array))throw new TypeError('data must be bytes');if(data.byteLength>MAX_BYTES)throw new RangeError('storage message exceeds 16 MiB');
 const {sharedKey,ciphertext:kemCiphertext}=crypto.encapsulate(recipient),salt=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
 const header={version:1,algorithm:ALGORITHM,recipient:fingerprint(recipient),context:ctx,byteLength:data.byteLength,kemCiphertext:kemCiphertext.toString('base64'),salt:salt.toString('base64'),nonce:nonce.toString('base64')};
 let derived;
 try{derived=Buffer.from(crypto.hkdfSync('sha256',sharedKey,salt,Buffer.from('NEMESIS_STORAGE_V1\0'+header.recipient),32));const cipher=crypto.createCipheriv('aes-256-gcm',derived,nonce,{authTagLength:16});cipher.setAAD(Buffer.from(canon(header)));const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);return {header,ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};}
 finally{sharedKey.fill(0);derived?.fill(0);}
}
export function decryptLatticeStorage({privateKey,container,expectedContext}){
 available();const secret=key(privateKey,true),ctx=context(expectedContext);object(container,'storage container',['header','ciphertext','tag']);
 const h=object(container.header,'storage header',['version','algorithm','recipient','context','byteLength','kemCiphertext','salt','nonce']);
 if(h.version!==1||h.algorithm!==ALGORITHM)throw new TypeError('unsupported storage format');
 if(h.recipient!==fingerprint(secret)||context(h.context)!==ctx)throw new Error('storage recipient or context mismatch');
 if(!Number.isSafeInteger(h.byteLength)||h.byteLength<0||h.byteLength>MAX_BYTES)throw new TypeError('invalid byteLength');
 const kem=b64(h.kemCiphertext,'KEM ciphertext',1088),salt=b64(h.salt,'salt',32),nonce=b64(h.nonce,'nonce',12),tag=b64(container.tag,'tag',16),ciphertext=b64(container.ciphertext,'ciphertext',h.byteLength);
 let sharedKey,derived,unverified;
 try{sharedKey=crypto.decapsulate(secret,kem);derived=Buffer.from(crypto.hkdfSync('sha256',sharedKey,salt,Buffer.from('NEMESIS_STORAGE_V1\0'+h.recipient),32));const decipher=crypto.createDecipheriv('aes-256-gcm',derived,nonce,{authTagLength:16});decipher.setAAD(Buffer.from(canon(h)));decipher.setAuthTag(tag);unverified=decipher.update(ciphertext);const tail=decipher.final();return Buffer.concat([unverified,tail]);}
 catch{throw new Error('storage authentication failed');}
 finally{sharedKey?.fill(0);derived?.fill(0);unverified?.fill(0);}
}
export function runLatticeStorage(input){
 object(input,'storage action',['action','payload']);
 if(input.action==='encrypt'){object(input.payload,'encrypt payload',['publicKeyPem','dataBase64','context']);const data=b64(input.payload.dataBase64,'data',0,MAX_BYTES);return {domain:'NEMESIS_LATTICE_AUTHENTICATED_STORAGE',container:encryptLatticeStorage({publicKey:input.payload.publicKeyPem,data,context:input.payload.context})};}
 if(input.action==='decrypt'){object(input.payload,'decrypt payload',['privateKeyPem','container','expectedContext']);const data=decryptLatticeStorage({privateKey:input.payload.privateKeyPem,container:input.payload.container,expectedContext:input.payload.expectedContext});try{return {domain:'NEMESIS_LATTICE_AUTHENTICATED_STORAGE',dataBase64:data.toString('base64'),authenticated:true};}finally{data.fill(0);}}
 throw new TypeError('unsupported lattice storage action');
}
