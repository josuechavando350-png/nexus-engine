#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {compileExecutionCircuit} from '../src/motors/execution-snark.mjs';
if(process.argv.length!==4){console.error('Usage: node scripts/prepare-snark-95.mjs <program.json> <empty-or-dedicated-output-directory>');process.exit(2);}
try{
 const program=JSON.parse(readFileSync(process.argv[2],'utf8')),dir=resolve(process.argv[3]);
 mkdirSync(dir,{recursive:true});
 const c=compileExecutionCircuit(program);
 writeFileSync(join(dir,'nemesis95.circom'),c.circomSource,{flag:'wx',mode:0o600});
 writeFileSync(join(dir,'program-sha256.txt'),c.programSha256+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({programSha256:c.programSha256,sourceSha256:c.sourceSha256,circuit:join(dir,'nemesis95.circom'),r1csConstraints:c.r1cs.numberOfConstraints}));
}catch(error){console.error(error.message);process.exitCode=1;}
