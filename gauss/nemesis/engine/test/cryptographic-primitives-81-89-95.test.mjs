import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {getDiffieHellman} from 'node:crypto';
import {evaluateTwoIsogeny,generateToyHeKey,encryptToyBit,evaluateToyGate,decryptToyBit,runLeveledHeCircuit,proveLinearExecution,verifyLinearExecution,runMotor,MOTOR_REGISTRY,runMotorPipeline} from '../src/index.mjs';
const root=new URL('../',import.meta.url);
function mod(x,p){return ((x%p)+p)%p;}
function invert(n,p){for(let i=1;i<p;i++)if(mod(n*i,p)===1)return i;throw Error('invalid inverse');}
function add(P,Q,a,p){if(!P)return Q;if(!Q)return P;if(P.x===Q.x&&mod(P.y+Q.y,p)===0)return null;let slope=P.x===Q.x&&P.y===Q.y?mod((3*P.x*P.x+a)*invert(2*P.y,p),p):mod((Q.y-P.y)*invert(Q.x-P.x,p),p);const x=mod(slope*slope-P.x-Q.x,p);return{x,y:mod(slope*(P.x-x)-P.y,p)};}
test('81: independently enumerate all F11 points; Vélu map preserves group law and maps kernel to identity',()=>{
 const p=11,a=1,b=0,points=[null];for(let x=0;x<p;x++)for(let y=0;y<p;y++)if(mod(y*y-x*x*x-a*x-b,p)===0)points.push({x,y});
 const out=evaluateTwoIsogeny({p,a,b,kernelX:0,points});assert.equal(out.images.length,points.length);assert.equal(out.images[0],null);assert.equal(out.images[points.findIndex(P=>P&&P.x===0&&P.y===0)],null);
 const image=new Map(points.map((P,i)=>[JSON.stringify(P),out.images[i]]));
 for(let i=0;i<points.length;i++)for(let j=0;j<points.length;j++){
  const L=image.get(JSON.stringify(add(points[i],points[j],a,p)));
  const R=add(out.images[i],out.images[j],out.target.a,p);
  assert.deepEqual(L,R,`group law pair ${i},${j}`);
 }
 assert.match(out.domain,/NOT_SIGNATURE/);
});
test('81: refuses singular curves, invalid two-torsion, composites, foreign points and domain overflow',()=>{
 const x={p:11,a:1,b:0,kernelX:0,points:[{x:0,y:0}]};
 assert.throws(()=>evaluateTwoIsogeny({...x,p:9}),/odd prime/);
 assert.throws(()=>evaluateTwoIsogeny({...x,a:0,b:0}),/singular/);
 assert.throws(()=>evaluateTwoIsogeny({...x,kernelX:2}),/2-torsion/);
 assert.throws(()=>evaluateTwoIsogeny({...x,points:[{x:1,y:1}]}),/not on source/);
 assert.throws(()=>evaluateTwoIsogeny({...x,p:1013}),/integer/);
});
test('89: encrypted-only evaluation matches exhaustive Boolean gate truth tables',()=>{
 for(let a=0;a<2;a++)for(let b=0;b<2;b++){
  const key=generateToyHeKey(),x=encryptToyBit(key,a),y=encryptToyBit(key,b);
  for(const [op,expected] of Object.entries({XOR:a^b,AND:a&b,OR:a|b,NAND:1-(a&b),NOT:1-a})){
   const c=evaluateToyGate(op,x,y);assert.equal(decryptToyBit(key,c),expected,`${op}(${a},${b})`);
   assert.equal(Object.hasOwn(c,'secret'),false);
  }
 }
 const actual=runLeveledHeCircuit({bits:[1,0],gates:[{id:'s',op:'OR',left:'in0',right:'in1'},{id:'n',op:'NOT',left:'s'}],output:'n'});
 assert.equal(actual.result,0);assert.match(actual.domain,/NOT_FHE/);assert.equal(Object.hasOwn(actual,'secret'),false);
});
test('89: exhausted noise and malformed circuit fail closed; public evaluation never receives private key',()=>{
 const key=generateToyHeKey(),x=encryptToyBit(key,1);let c=x;
 assert.throws(()=>{for(let i=0;i<16;i++)c=evaluateToyGate('AND',c,c);},/noise bound exhausted/);
 assert.throws(()=>evaluateToyGate('AND',x,{ciphertext:'abc',bound:'1'}),/BigInt|convert/);
 assert.throws(()=>runLeveledHeCircuit({bits:[1],gates:[{id:'x',op:'XOR',left:'in0',right:'future'}],output:'x'}),/future/);
 assert.throws(()=>runLeveledHeCircuit({bits:[0,2],gates:[],output:'in0'}),/must be a bit/);
 assert.equal(typeof key.secret,'string');assert.ok(!JSON.stringify(x).includes(key.secret));
});
test('95: non-interactive proof attests committed affine computation and does not contain secret inputs',()=>{
 const input={coefficients:['2','3','4'],constant:'5',context:'bind-run-1',witness:['7','11','13']};
 const a=proveLinearExecution(input),b=proveLinearExecution(input);
 assert.equal(a.statement.output,'104');assert.equal(verifyLinearExecution(a).verified,true);
 assert.equal(a.statement.commitments.length,3);assert.notDeepEqual(a.statement.commitments,b.statement.commitments);
 assert.equal(Object.hasOwn(a,'witness'),false);assert.equal(Object.hasOwn(a,'blindings'),false);
 assert.equal(JSON.stringify(a).includes('"witness"'),false);
 assert.match(a.domain,/NOT_GENERAL_ZK_SNARK/);
});
test('95: output, affine program, context, commitments and proof tampering all invalidate',()=>{
 const p=proveLinearExecution({coefficients:['2','3'],constant:'5',context:'bind-1',witness:['7','11']});
 for(const statement of [{...p.statement,output:'53'},{...p.statement,coefficients:['3','3']},{...p.statement,context:'bind-2'},{...p.statement,constant:'6'},{...p.statement,commitments:[p.statement.commitments[1],p.statement.commitments[0]]}])assert.equal(verifyLinearExecution({statement,proof:p.proof}).verified,false);
 assert.equal(verifyLinearExecution({statement:p.statement,proof:{...p.proof,z:['0',p.proof.z[1]]}}).verified,false);
 const bigp=BigInt('0x'+getDiffieHellman('modp14').getPrime('hex'));
 assert.throws(()=>verifyLinearExecution({statement:{...p.statement,commitments:[(bigp-1n).toString(),p.statement.commitments[1]]},proof:p.proof}),/subgroup/);
 assert.throws(()=>proveLinearExecution({coefficients:['1'],constant:'0',context:'x',witness:['1']}),/2–8/);
});
test('three incomplete primitives are runnable and verification failures propagate through CLI',()=>{
 for(const id of ['81','89','95']){
  assert.equal(typeof MOTOR_REGISTRY[id],'function');
  const fixture=new URL(`examples/motor-${id}.json`,root).pathname;
  const p=spawnSync(process.execPath,['cli.mjs','motor',fixture,id],{cwd:root,encoding:'utf8',timeout:15000});
  assert.equal(p.status,0,p.stderr);assert.ok(JSON.parse(p.stdout).domain);
 }
 const p=proveLinearExecution({coefficients:['2','3'],constant:'5',context:'cli',witness:['7','11']});p.statement.output='53';
 const rejected=runMotor('95',{mode:'verify',statement:p.statement,proof:p.proof});assert.equal(rejected.verified,false);
});

test('95: forged proof is rejected by standalone CLI and by pipeline, never certified',async()=>{
 const proof=proveLinearExecution({coefficients:['2','3'],constant:'5',context:'negative-boundary',witness:['7','11']});
 const bad={...proof,statement:{...proof.statement,output:'53'}};
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const folder=mkdtempSync(join(tmpdir(),'nemesis-95-negative-'));
 try {
  const path=join(folder,'forged.json');writeFileSync(path,JSON.stringify({mode:'verify',statement:bad.statement,proof:bad.proof}));
  const cli=spawnSync(process.execPath,['cli.mjs','motor',path,'95'],{cwd:root,encoding:'utf8',timeout:15000});
  assert.equal(cli.status,1);assert.equal(JSON.parse(cli.stdout).verified,false);
  const blocked=await runMotorPipeline({tasks:[{id:'forged',motor:'95',input:{mode:'verify',statement:bad.statement,proof:bad.proof}},{id:'unused',motor:'81',input:JSON.parse(readFileSync(new URL('examples/motor-81.json',root)))}]});
  assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.failedTaskId,'forged');assert.equal(blocked.tasks.length,0);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
