/** Execute the real Rust binary through GAUSS's public Némesis namespace. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {runGaussNemesis} from '../bridge.mjs';
const binary=fileURLToPath(new URL('../native/fhe/target/release/nemesis-fhe',import.meta.url));
const expectedBinarySha256=createHash('sha256').update(readFileSync(binary)).digest('hex');
const pin={binary,expectedBinarySha256};
const add=await runGaussNemesis('89',{action:'native-add-u8',a:255,b:255,...pin});
if(add.sum!==510||!add.verified)throw Error('GAUSS #89 native addition failed');
const circuit=await runGaussNemesis('89',{action:'native-circuit',inputs:[true,false,true],gates:[{op:'xor',a:0,b:1},{op:'mux',s:2,a:3,b:1},{op:'not',a:4}],outputs:[3,4,5],...pin});
if(!circuit.verified||JSON.stringify(circuit.outputs)!==JSON.stringify([true,true,false]))throw Error('GAUSS #89 native circuit failed');
let pinRejected=false;
try{await runGaussNemesis('89',{action:'native-add-u8',a:1,b:2,binary,expectedBinarySha256:'0'.repeat(64)});}catch(e){pinRejected=/PIN_MISMATCH/.test(e.message);}
if(!pinRejected)throw Error('GAUSS #89 accepted incorrect executable SHA-256');
const evidence={schemaVersion:1,scope:'GAUSS_NEMESIS_89_NATIVE_SMOKE_ONLY',binarySha256:expectedBinarySha256,addition:add.sum,outputs:circuit.outputs,circuitSha256:circuit.circuitSha256,pinRejected:true,status:'PASS',certifiesAll100:false};
const out=join(dirname(fileURLToPath(import.meta.url)),'../evidence/native-89-ci.json');mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
