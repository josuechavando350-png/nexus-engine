/**
 * Verify pinned Némesis source and reviewed test fixtures by byte digest.
 * The original archive was verified separately at import. This check does NOT
 * certify all 100 conceptual motors or cryptographic production security.
 */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,relative,sep} from 'node:path';
const root=fileURLToPath(new URL('../engine/',import.meta.url));
const lock=JSON.parse(readFileSync(new URL('../source-lock.json',import.meta.url),'utf8'));
function walk(dir,extension){
 const base=join(root,dir),result=[];
 function visit(where){for(const name of readdirSync(where).sort()){
  const full=join(where,name),stat=lstatSync(full);
  if(stat.isSymbolicLink())throw Error('NEMESIS_SOURCE_LINK_NOT_ALLOWED: '+full);
  if(stat.isDirectory())visit(full);
  else if(stat.isFile()&&full.endsWith(extension))result.push(full);
 }}visit(base);
 return result;
}
function digest(files){const hasher=createHash('sha256');for(const full of files){
 const path=relative(root,full).split(sep).join('/');
 hasher.update(path).update('\0').update(readFileSync(full)).update('\0');
 }return hasher.digest('hex');}
for(const [directory,extension] of [['src','.mjs'],['test','.test.mjs'],['examples','.json']]){
 const files=walk(directory,extension),expected=lock[directory];
 if(files.length!==expected.count||digest(files)!==expected.sha256)throw Error(`NEMESIS_SOURCE_LOCK_MISMATCH: ${directory}: ${files.length} files`);
}
for(const filename of ['INVENTARIO_100.json','package.json']){
 const actual=createHash('sha256').update(readFileSync(join(root,filename))).digest('hex');
 if(actual!==lock[filename])throw Error('NEMESIS_SOURCE_LOCK_MISMATCH: '+filename);
}
const inventory=JSON.parse(readFileSync(join(root,'INVENTARIO_100.json'),'utf8'));
if(!Array.isArray(inventory)||inventory.length!==100||new Set(inventory.map(x=>x.numero)).size!==100||inventory.some((x,i)=>x.numero!==i+1))throw Error('NEMESIS_INVENTORY_NOT_100');
console.log(JSON.stringify({status:'PASS',scope:'REVIEWED_NEMESIS_SOURCE_LOCK_ONLY',src:lock.src.count,tests:lock.test.count,examples:lock.examples.count,reviewedChangesFromOrigin:lock.reviewedChangesFromOrigin??[],certifiesAll100:false}));
