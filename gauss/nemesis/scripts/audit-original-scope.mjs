/**
 * Re-executable, fail-closed 100-ID scope audit for Némesis embedded in GAUSS.
 * The historical matrix summarizes user-supplied screenshots; it is NOT a
 * verbatim specification. Existence and one example do not certify scope.
 */
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const base=fileURLToPath(new URL('../',import.meta.url));
const engine=resolve(base,'engine');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireFile=path=>{const full=resolve(engine,path);if(!full.startsWith(engine+sep)||!statSync(full).isFile())throw Error(`Unsafe or missing source: ${path}`);return full;};
const accepted=new Set(['CONSISTENT','PASS','REPAIRED','ALREADY_PASSING','DRY_RUN','APPLIED_IN_MEMORY','OPTIMAL_FINITE','FEASIBLE_CANDIDATE','QUORUM_CERTIFIED','CONVERGED']);

export async function auditOriginalScope(){
  const matrixPath=requireFile('docs/MATRIZ_100_MOTORES.json');
  const matrix=JSON.parse(readFileSync(matrixPath,'utf8'));
  if(matrix.ids_presentes!==100||matrix.motores?.length!==100||new Set(matrix.motores.map(item=>item.id)).size!==100||
    matrix.motores.some((item,index)=>item.id!==index+1))throw Error('NEMESIS_AUDIT_MATRIX_INCOMPLETE');
  const inventory=JSON.parse(readFileSync(requireFile('INVENTARIO_100.json'),'utf8'));
  if(inventory.length!==100||inventory.some((item,index)=>item.numero!==index+1))throw Error('NEMESIS_AUDIT_INVENTORY_INCOMPLETE');
  const smoke=readFileSync(requireFile('scripts/smoke-100.mjs'),'utf8');
  const table=smoke.match(/const named=\{([^}]+)\};/);
  if(!table)throw Error('NEMESIS_AUDIT_SMOKE_MAPPING_MISSING');
  const names=new Map([...table[1].matchAll(/(\d+):'([a-z0-9-]+)'/g)].map(m=>[Number(m[1]),m[2]]));
  if(names.size!==40||Array.from({length:40},(_,i)=>i+1).some(id=>!names.has(id)))throw Error('NEMESIS_AUDIT_SMOKE_MAPPING_INCOMPLETE');
  const {MOTOR_REGISTRY,runMotor,verifyFiniteSystem}=await import(pathToFileURL(requireFile('src/index.mjs')).href);
  if(Object.keys(MOTOR_REGISTRY).length!==99||Array.from({length:99},(_,i)=>String(i+2).padStart(2,'0')).some(id=>typeof MOTOR_REGISTRY[id]!=='function'))throw Error('NEMESIS_AUDIT_REGISTRY_INCOMPLETE');
  const rows=[];
  for(const item of matrix.motores){
    if(typeof item.nombre_original!=='string'||!item.nombre_original||!item.codigo_base||!item.alcance_actual||
      !item.pendiente_segun_capturas_resumido||item.cierre_total_original!=='NO_ACREDITADO')throw Error(`NEMESIS_AUDIT_SCOPE_UNDOCUMENTED: ${item.id}`);
    const source=requireFile(item.codigo_base),id=item.id;
    const example=`examples/${names.get(id)??`motor-${id}`}.json`;
    const exampleFile=requireFile(example),input=JSON.parse(readFileSync(exampleFile,'utf8'));
    let matchedExpected=false,error=null;
    try{
      const output=await (id===1?verifyFiniteSystem(input):runMotor(String(id).padStart(2,'0'),input));
      const successful=output.verified!==false&&output.valid!==false&&output.converged!==false&&(!output.status||accepted.has(output.status));
      const expectedNegative=id===12&&output.status==='BREACH'&&output.conditionalValueAtRisk==='55/1'&&output.withinLimit===false;
      matchedExpected=successful||expectedNegative;
      if(!matchedExpected)error='Example output failed the explicit smoke acceptance contract';
    }catch(e){error=e instanceof Error?e.message:String(e);}
    rows.push({id,name:item.nombre_original,source:relative(engine,source).split(sep).join('/'),sourceSha256:sha(readFileSync(source)),
      example,exampleSha256:sha(readFileSync(exampleFile)),exampleMatched:matchedExpected,exampleError:error,
      historicalCurrentScope:item.alcance_actual,historicalOpenScope:item.pendiente_segun_capturas_resumido,
      originalScopeCertified:false,evidenceLevel:matchedExpected?'SOURCE_PRESENT_AND_ONE_EXAMPLE':'SOURCE_PRESENT_EXAMPLE_FAILED'});
  }
  const exampleMatches=rows.filter(row=>row.exampleMatched).length;
  const report={schemaVersion:1,scopeSource:'Némesis v17 historical matrix summarizing earlier user screenshots; not a verbatim signed acceptance spec',
    originalMatrixSha256:sha(readFileSync(matrixPath)),engineIds:rows.length,exampleMatches,
    originalScopeCertifiedCount:0,meaning:'Source plus one example and native smoke are insufficient to prove each original promise. All historical scope gaps remain open until requirement-level independent evidence exists.',rows};
  if(exampleMatches!==100)throw Error(`NEMESIS_AUDIT_GOLDEN_EXAMPLES_FAILED: ${exampleMatches}/100: ${rows.filter(r=>!r.exampleMatched).map(r=>`${r.id} ${r.exampleError}`).join('; ')}`);
  return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  auditOriginalScope().then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error);process.exitCode=1;});
}
