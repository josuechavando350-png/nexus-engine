import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const cwd=path.join(root,'native/fhe');
const report={motor:89,backend:'TFHE_BOOLEAN',startedAt:new Date().toISOString(),status:'NOT_RUN',steps:[],sourceSha256:{}};
for(const name of ['Cargo.toml','src/lib.rs','src/main.rs','tests/circuits.rs','tests/private_cli.rs'])report.sourceSha256[name]=createHash('sha256').update(readFileSync(path.join(cwd,name))).digest('hex');
const commands=[['rustc',['--version']],['cargo',['--version']]];
if(!existsSync(path.join(cwd,'Cargo.lock')))commands.push(['cargo',['generate-lockfile']]);
commands.push(['cargo',['test','--release','--locked','--','--test-threads=1']],
  ['cargo',['run','--release','--locked','--','--add-stdin'],'255 255'],
  ['cargo',['run','--release','--locked','--','--circuit-stdin','xor:0:1;mux:2:3:1;not:4','3,4,5'],'101']);
for(const [command,args,privateInput] of commands){
  process.stdout.write(`Running ${command} ${args.join(' ')}\n`);
  const step=spawnSync(command,args,{cwd,input:privateInput,encoding:'utf8',maxBuffer:32*1024*1024});
  report.steps.push({command,args,exitCode:step.status,error:step.error?.message??null,stdout:step.stdout??'',stderr:step.stderr??''});
  process.stdout.write(step.stdout??'');process.stderr.write(step.stderr??'');
  if(step.error||step.status!==0){report.status='BLOCKED_OR_FAILED';break;}
  if(args[0]==='run'){
    try{
      const result=JSON.parse(step.stdout);
      const expected=args.includes('--circuit-stdin')
        ? {motor:89,backend:'TFHE_BOOLEAN',outputs:[true,true,false],verified:true}
        : {motor:89,backend:'TFHE_BOOLEAN',sum:510,verified:true};
      if(JSON.stringify(result)!==JSON.stringify(expected))throw new Error('decrypted results do not match independent oracle');
      report.steps.at(-1).expectedOutput=expected;
    }catch(error){report.steps.at(-1).validationError=error.message;report.status='BLOCKED_OR_FAILED';break;}
  }
}
if(report.status!=='BLOCKED_OR_FAILED'&&report.steps.length===commands.length&&report.steps.every(s=>s.exitCode===0))report.status='PASS';
if(existsSync(path.join(cwd,'Cargo.lock')))report.lockfileSha256=createHash('sha256').update(readFileSync(path.join(cwd,'Cargo.lock'))).digest('hex');
report.finishedAt=new Date().toISOString();
mkdirSync(path.join(root,'evidence'),{recursive:true});
writeFileSync(path.join(root,'evidence/native-fhe-verification.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(`Native verification: ${report.status}\n`);
process.exitCode=report.status==='PASS'?0:1;
