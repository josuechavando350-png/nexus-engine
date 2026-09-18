import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BATCH_500_ADDITIONS} from '../core/batch-500-additions.mjs';
import {executeBatch500} from './batch-500-runner.mjs';
import {verifyReport} from './verify-batch-500.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
async function walk(dir){let out=[];for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())out.push(...await walk(path));else if(e.isFile())out.push(path);else throw new Error('symbolic links or special files forbidden');}return out;}
const files=(await walk(join(root,'gauss'))).sort();
const prior=JSON.parse(await readFile(join(root,'gauss/fixtures/prior-200-ids.json'),'utf8'));
const ids=BATCH_500_ADDITIONS.map(op=>op.id);
if(prior.length!==200||new Set(prior).size!==200||ids.length!==100||new Set([...prior,...ids]).size!==300||new Set(BATCH_500_ADDITIONS.map(op=>op.execute)).size!==100)throw new Error('ID/implementation uniqueness audit failed');
const imports=[],suspect=[];
for(const file of files.filter(path=>path.endsWith('.mjs')&&path.includes('/gauss/core/'))){const text=await readFile(file,'utf8');
 const matches=[...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/gu)].map(m=>m[1]);
 for(const target of matches){imports.push({file:relative(root,file),target});if(!target.startsWith('./')&&!target.startsWith('../')&&!target.startsWith('node:'))suspect.push({file:relative(root,file),target});}
 if(/\b(?:fetch\s*\(|XMLHttpRequest\b|https?:\/\/|process\.env\b|child_process\b|require\s*\()/u.test(text))suspect.push({file:relative(root,file),reason:'network, environment, child-process or CommonJS token'});
}
if(suspect.length)throw new Error(`dependency/static review failed: ${JSON.stringify(suspect)}`);
const report=await executeBatch500();await verifyReport(report);
const proof=await readFile(join(root,'proof.tap'),'utf8');const tests=Number(proof.match(/^# tests (\d+)/mu)?.[1]),passed=Number(proof.match(/^# pass (\d+)/mu)?.[1]),failed=Number(proof.match(/^# fail (\d+)/mu)?.[1]);
if(tests<10||passed!==tests||failed!==0)throw new Error('local test proof does not pass');
const digests={};for(const path of files){const data=await readFile(path);digests[relative(root,path)]={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};}
const audit={kind:'GAUSS_THIRD_100_OFFLINE_AUDIT',status:'LOCAL_PASS_NOT_INTEGRATED',node:process.version,priorIds:200,newRegisteredIds:100,uniqueExecutableFunctions:100,collisions:0,byDomain:Object.fromEntries([...new Set(BATCH_500_ADDITIONS.map(o=>o.domain))].sort().map(domain=>[domain,BATCH_500_ADDITIONS.filter(o=>o.domain===domain).length])),localTests:{tests,passed,failed},offlineExecution:{executed:report.results.length,failed:report.failedCount,reportSha256:report.reportSha256,independentReplay:true,forgedRehashedEvidenceRejected:true},staticReview:{importsChecked:imports.length,thirdPartyImports:0,externalApiOrEnvironmentTokens:0,warning:'static token scan only; not a security certification'},limitations:['not merged or installed in Nexus','not tested in Nexus→Quantum→WALLE CI','no third-party security or performance audit','floating numerical methods are approximate, unlike GF(2) and bounded integer geometry','bounded inputs; exponential automata/code operations are not unlimited'],files:digests};
await writeFile(join(root,'AUDIT.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify({status:audit.status,operators:audit.newRegisteredIds,tests,passed,reportSha256:report.reportSha256,files:files.length}));
