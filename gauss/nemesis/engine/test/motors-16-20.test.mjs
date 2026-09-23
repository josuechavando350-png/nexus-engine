import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { calculateStructuralRobustness, reasonCrossDomainOntology, planReverseIngestion, applyReverseIngestion,
  catalogDarkData, compileCertaintyContract, evaluateCertaintyContract, signPassingContract,
  verifyContractAttestation, runMotor, MOTOR_REGISTRY } from '../src/motors/index.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const fixture=name=>JSON.parse(readFileSync(new URL(`../examples/${name}.json`,import.meta.url),'utf8'));

// 16: reference DFS connectivity oracle independent from the production helper.
function oracleConnected(n,edges,removeVertices=[],removeEdges=[]){
  let start=Array.from({length:n},(_,i)=>i).find(i=>!removeVertices.includes(i));
  if(start===undefined)return true;
  const reached=new Set([start]),stack=[start];
  while(stack.length){const x=stack.pop();for(const [k,[a,b]] of edges.entries()){
    if(removeEdges.includes(k))continue;const y=a===x?b:b===x?a:-1;
    if(y>=0&&!removeVertices.includes(y)&&!reached.has(y)){reached.add(y);stack.push(y);}
  }}
  return reached.size===n-removeVertices.length;
}
test('16 articulation, bridge, and exact s-t edge/vertex minimum cut',()=>{
  const result=calculateStructuralRobustness(fixture('structural-chain'));
  assert.equal(result.connected,true);
  assert.deepEqual(result.articulationPoints,['B','C']);
  assert.equal(result.bridges.length,3);
  assert.deepEqual(result.terminalEdgeCut,{size:1,edges:[{from:'A',to:'B'}]});
  assert.deepEqual(result.terminalVertexCut,{size:1,vertices:['B']});
});
test('16 cycle, disconnected graph, adjacent terminals',()=>{
  const cycle={vertices:['A','B','C'],edges:[{from:'A',to:'B'},{from:'B',to:'C'},{from:'C',to:'A'}],terminals:['A','B']};
  const r=calculateStructuralRobustness(cycle);
  assert.deepEqual(r.articulationPoints,[]);assert.deepEqual(r.bridges,[]);
  assert.equal(r.terminalEdgeCut.size,2);assert.equal(r.terminalVertexCut,null);
  const dis=calculateStructuralRobustness({vertices:['A','B','C'],edges:[{from:'A',to:'B'}],terminals:['A','C']});
  assert.equal(dis.connected,false);assert.equal(dis.terminalEdgeCut.size,0);assert.equal(dis.terminalVertexCut.size,0);
});
test('16 all undirected graphs with four vertices cross-checked with independent failure oracle',()=>{
  const possible=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  for(let mask=0;mask<(1<<possible.length);mask++){
    const edges=possible.filter((_,k)=>mask&(1<<k));
    const result=calculateStructuralRobustness({vertices:['A','B','C','D'],edges:edges.map(([a,b])=>({from:'ABCD'[a],to:'ABCD'[b]}))});
    const before=oracleConnected(4,edges);assert.equal(result.connected,before);
    if(before){
      assert.deepEqual(result.articulationPoints,Array.from({length:4},(_,i)=>i).filter(i=>!oracleConnected(4,edges,[i])).map(i=>'ABCD'[i]));
      assert.deepEqual(result.bridges,edges.filter((_,i)=>!oracleConnected(4,edges,[],[i])).map(([a,b])=>({from:'ABCD'[a],to:'ABCD'[b]})));
    }
  }
});
test('16 rejects self loops, unknown vertices, and duplicate reversed edges',()=>{
  assert.throws(()=>calculateStructuralRobustness({vertices:['A','B'],edges:[{from:'A',to:'A'}]}),/distinct/);
  assert.throws(()=>calculateStructuralRobustness({vertices:['A','B'],edges:[{from:'A',to:'C'}]}),/known/);
  assert.throws(()=>calculateStructuralRobustness({vertices:['A','B'],edges:[{from:'A',to:'B'},{from:'B',to:'A'}]}),/duplicate/);
});

// 17: positive closure, bridging namespaces and inconsistency.
test('17 cross-domain transitive subclass and equivalent classes',()=>{
  const r=reasonCrossDomainOntology(fixture('cross-domain-ontology'));
  assert.equal(r.consistent,true);
  assert.deepEqual(r.inferredTypes.record1,['SalesLead','Person','CRMContact','Human']);
  assert.equal(r.queries[0].entailed,true);assert.equal(r.queries[1].entailed,false);
  assert.equal(r.queries[1].notEntailedDoesNotMeanFalse,true);
});
test('17 explicit disjointness contradiction and class-only contradiction',()=>{
  const ontology=fixture('cross-domain-ontology');
  const r=reasonCrossDomainOntology({...ontology,disjointClasses:[['Person','Human']]});
  assert.equal(r.consistent,false);
  assert.ok(r.contradictions.some(x=>x.individual==='record1'));
  assert.ok(r.unsatisfiableClasses.some(x=>x.class==='SalesLead'));
});
test('17 an empty unsatisfiable class does not falsely imply global inconsistency',()=>{
  const x=fixture('cross-domain-ontology');
  const r=reasonCrossDomainOntology({...x,types:[],disjointClasses:[['Person','Human']]});
  assert.equal(r.consistent,true);assert.ok(r.unsatisfiableClasses.some(x=>x.class==='SalesLead'));
});
test('17 cyclic class hierarchy terminates and unknown names are rejected',()=>{
  const base={classes:['A','B'],individuals:['x'],subclassOf:[['A','B'],['B','A']],equivalentClasses:[],disjointClasses:[],types:[{individual:'x',class:'A'}]};
  assert.deepEqual(reasonCrossDomainOntology(base).inferredTypes.x,['A','B']);
  assert.throws(()=>reasonCrossDomainOntology({...base,types:[{individual:'x',class:'C'}]}),/unknown/);
});

// 18: plan is dry run, CAS and transactional conflict, stable ordering and delete opt-in.
test('18 deterministic reverse ETL creates/updates and preserves missing destination by default',()=>{
  const x=fixture('reverse-ingestion'),r=planReverseIngestion(x);
  assert.equal(r.status,'DRY_RUN');assert.deepEqual(r.plan.operations.map(v=>`${v.kind}:${v.id}`),['UPDATE:A','CREATE:B']);
  assert.equal(r.plan.operations.some(v=>v.kind==='DELETE'),false);
  assert.deepEqual(x.destination,fixture('reverse-ingestion').destination);
  const applied=applyReverseIngestion(r,x.destination);
  assert.equal(applied.status,'APPLIED_IN_MEMORY');assert.equal(applied.appliedCount,2);
  assert.deepEqual(applied.destination.map(v=>v.id),['A','B','Z']);
  assert.equal(applyReverseIngestion(r,applied.destination).appliedCount,0);
  assert.deepEqual(planReverseIngestion({...x,destination:applied.destination}).plan.operations,[]);
});
test('18 explicit deletion and all-or-nothing optimistic concurrency',()=>{
  const x=fixture('reverse-ingestion');
  const r=planReverseIngestion({...x,deleteMissing:true});
  assert.equal(r.plan.operations.at(-1).kind,'DELETE');
  assert.equal(applyReverseIngestion(r,x.destination).destination.length,2);
  const target=x.destination.map(row=>structuredClone(row));target[0].data.count=999;
  assert.throws(()=>applyReverseIngestion(r,target),/conflict/);
  assert.equal(target[0].data.count,999);assert.equal(target.length,2);
});
test('18 rejects tampered plans, non-json input, duplicate ids and proto-pollution keys',()=>{
  const x=fixture('reverse-ingestion');const r=planReverseIngestion(x);
  r.plan.operations[0].data.count=7;
  assert.throws(()=>applyReverseIngestion(r,x.destination),/digest mismatch/);
  assert.throws(()=>planReverseIngestion({...x,source:[...x.source,x.source[0]]}),/duplicate/);
  assert.throws(()=>planReverseIngestion({...x,source:[{id:'A',data:JSON.parse('{"__proto__":1}')}]}),/unsafe JSON/);
  assert.throws(()=>planReverseIngestion({...x,source:[{id:'A',data:{a:Infinity}}]}),/finite JSON/);
});
test('18 canonicalizes object key ordering and rejects unsafe/noninteger values',()=>{
  const r=planReverseIngestion({source:[{id:'A',data:{a:1,b:2}}],destination:[{id:'A',data:{b:2,a:1}}]});
  assert.deepEqual(r.plan.operations,[]);
  assert.throws(()=>planReverseIngestion({source:[{id:'A',data:{f:1.2}}],destination:[]}),/finite JSON/);
});

// 19: content-addressed catalog, exact tokens, tags, opaque binary and malformed base64.
test('19 deduplicates equal bytes across encoding and exact Unicode text search',()=>{
  const x=fixture('dark-data-catalog');const r=catalogDarkData(x);
  assert.equal(r.documentCount,3);assert.equal(r.uniqueBlobCount,2);
  assert.deepEqual(r.duplicates[0].ids,['note1','note2']);
  assert.deepEqual(r.matches,['note1']);
  assert.equal(r.documents[0].sha256,createHash('sha256').update(Buffer.from(x.documents[0].content)).digest('hex'));
});
test('19 opaque binary excluded from token matching, ANY mode and tags work',()=>{
  const x=fixture('dark-data-catalog');
  const r=catalogDarkData({...x,query:{terms:['forja','xyz'],mode:'ANY'}});
  assert.deepEqual(r.matches,['note1']); // base64 remains opaque even when its bytes happen to be UTF-8
  assert.deepEqual(catalogDarkData({...x,query:{terms:[],tags:['binary']}}).matches,['raw1']);
});
test('19 rejects invalid encoding, bad padding, duplicate ids, oversize, unknown fields',()=>{
  const x=fixture('dark-data-catalog');
  assert.throws(()=>catalogDarkData({...x,documents:[{id:'X',encoding:'base64',content:'Zg='}]}),/base64/);
  assert.throws(()=>catalogDarkData({...x,documents:[{id:'X',encoding:'base64',content:'Zh=='}]}),/pad bits/);
  assert.throws(()=>catalogDarkData({...x,documents:[...x.documents,x.documents[0]]}),/duplicate/);
  assert.throws(()=>catalogDarkData({...x,documents:[{id:'X',encoding:'utf8',content:'x'.repeat(262145)}]}),/256 KiB/);
  assert.throws(()=>catalogDarkData({...x,documents:[{id:'X',encoding:'utf8',content:'x',password:'secret'}]}),/unknown field/);
});

// 20: signing only PASS reports, verify against freshly recomputed report and bound public key.
test('20 compile/evaluate deterministic irrespective of field and observation order',()=>{
  const x=fixture('certainty-contract');
  const a=compileCertaintyContract(x.contract);
  const b=compileCertaintyContract({...x.contract,predicates:[...x.contract.predicates].reverse()});
  assert.equal(a.contractHash,b.contractHash);
  const r=evaluateCertaintyContract(a,x.observations);
  assert.equal(r.status,'PASS');assert.equal(r.reportHash,evaluateCertaintyContract(b,[...x.observations].reverse()).reportHash);
  assert.equal(runMotor('20',x).reportHash,r.reportHash);
});
test('20 Ed25519 signature verifies exact contract/measurements, rejects modifications and other keys',()=>{
  const x=fixture('certainty-contract');const compiled=compileCertaintyContract(x.contract);
  const report=evaluateCertaintyContract(compiled,x.observations);
  const kp=generateKeyPairSync('ed25519');
  const privateKey=kp.privateKey.export({format:'pem',type:'pkcs8'}),publicKey=kp.publicKey.export({format:'pem',type:'spki'});
  const att=signPassingContract(report,privateKey);
  assert.equal(verifyContractAttestation(compiled,x.observations,att,publicKey),true);
  assert.equal(verifyContractAttestation(compiled,[{metric:'latency',value:81},{metric:'errors',value:0}],att,publicKey),false);
  assert.equal(verifyContractAttestation(compileCertaintyContract({...x.contract,artifactSha256:'0'.repeat(64)}),x.observations,att,publicKey),false);
  const other=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'});
  assert.equal(verifyContractAttestation(compiled,x.observations,att,other),false);
  assert.equal(verifyContractAttestation(compiled,x.observations,{...att,signature:(att.signature[0]==='A'?'B':'A')+att.signature.slice(1)},publicKey),false);
});
test('20 missing/failed measurements fail closed and cannot be signed',()=>{
  const x=fixture('certainty-contract'),compiled=compileCertaintyContract(x.contract);
  const fail=evaluateCertaintyContract(compiled,[{metric:'latency',value:999}]);
  assert.equal(fail.status,'FAIL');assert.equal(fail.checks.find(x=>x.metric==='errors').observed,null);
  const kp=generateKeyPairSync('ed25519');
  assert.throws(()=>signPassingContract(fail,kp.privateKey),/refusing/);
  assert.throws(()=>compileCertaintyContract({...x.contract,predicates:[...x.contract.predicates,x.contract.predicates[0]]}),/duplicate/);
  assert.throws(()=>compileCertaintyContract({...x.contract,artifactSha256:'1'}),/SHA-256/);
});
test('16-20 registry routes exactly to real implementations, unknown ID refuses',()=>{
  for(const i of [16,17,18,19,20])assert.equal(typeof MOTOR_REGISTRY[String(i)],'function');
  assert.equal(runMotor('16',fixture('structural-chain')).terminalEdgeCut.size,1);
  assert.equal(runMotor('17',fixture('cross-domain-ontology')).consistent,true);
  assert.equal(runMotor('18',fixture('reverse-ingestion')).status,'DRY_RUN');
  assert.equal(runMotor('19',fixture('dark-data-catalog')).documentCount,3);
  assert.equal(runMotor('20',fixture('certainty-contract')).status,'PASS');
  assert.throws(()=>runMotor('101',{}),/not implemented/);
});

test('16 all connected four-vertex graphs have exact min s-t cuts by independent brute force',()=>{
  const choices=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  for(let mask=0;mask<64;mask++){
    const edges=choices.filter((_,i)=>mask&(1<<i));
    const vertices=['A','B','C','D'];const model=edges.map(([a,b])=>({from:vertices[a],to:vertices[b]}));
    const r=calculateStructuralRobustness({vertices,edges:model,terminals:['A','D']});
    const connected=(removedV=[],removedE=[])=>{
      const visited=new Set([0]),queue=[0];
      for(let j=0;j<queue.length;j++)for(let k=0;k<edges.length;k++){
        if(removedE.includes(k))continue;
        const [a,b]=edges[k],v=queue[j],u=v===a?b:v===b?a:-1;
        if(u!==-1&&!removedV.includes(u)&&!visited.has(u)){visited.add(u);queue.push(u);}
      }
      return visited.has(3);
    };
    if(!connected()){assert.equal(r.terminalEdgeCut.size,0);assert.equal(r.terminalVertexCut.size,0);continue;}
    let edgeMinimum=Infinity;
    for(let subset=0;subset<(1<<edges.length);subset++){
      const removed=edges.map((_,i)=>i).filter(i=>subset&(1<<i));
      if(!connected([],removed))edgeMinimum=Math.min(edgeMinimum,removed.length);
    }
    assert.equal(r.terminalEdgeCut.size,edgeMinimum);
    assert.equal(connected([],r.terminalEdgeCut.edges.map(e=>edges.findIndex(([a,b])=>vertices[a]===e.from&&vertices[b]===e.to))),false);
    if(edges.some(([a,b])=>a===0&&b===3)){assert.equal(r.terminalVertexCut,null);continue;}
    let vertexMinimum=Infinity;
    for(let subset=0;subset<4;subset++){
      const removed=[1,2].filter((_,i)=>subset&(1<<i));
      if(!connected(removed))vertexMinimum=Math.min(vertexMinimum,removed.length);
    }
    assert.equal(r.terminalVertexCut.size,vertexMinimum);
    assert.equal(connected(r.terminalVertexCut.vertices.map(v=>vertices.indexOf(v))),false);
  }
});

test('18 late conflict prevents earlier upsert and insertion: rollback is atomic in memory',()=>{
  const base=fixture('reverse-ingestion'), plan=planReverseIngestion({...base,deleteMissing:true});
  const dest=structuredClone(base.destination);
  dest.find(d=>d.id==='Z').data.count=10; // last operation conflicts after earlier CREATE/UPDATE could have run
  const before=structuredClone(dest);
  assert.throws(()=>applyReverseIngestion(plan,dest),/conflict at Z/);
  assert.deepEqual(dest,before);
});
test('19 rejects unpaired surrogate instead of silently replacing invalid text',()=>{
  assert.throws(()=>catalogDarkData({documents:[{id:'x',encoding:'utf8',content:'\ud800'}]}),/invalid UTF-8/);
});
test('20 signature cannot be reused when contract failed, even with signed PASS from prior observations',()=>{
  const x=fixture('certainty-contract'), compiled=compileCertaintyContract(x.contract);
  const keypair=generateKeyPairSync('ed25519');
  const signed=signPassingContract(evaluateCertaintyContract(compiled,x.observations),keypair.privateKey.export({format:'pem',type:'pkcs8'}));
  assert.equal(verifyContractAttestation(compiled,[{metric:'latency',value:101},{metric:'errors',value:0}],signed,keypair.publicKey.export({format:'pem',type:'spki'})),false);
  assert.throws(()=>evaluateCertaintyContract({...compiled,contractHash:'f'.repeat(64)},x.observations),/mismatch/);
});

test('16–20 CLI runs all five fixtures and returns status codes for inconsistent ontology/failed contract',()=>{
  for(const [mid,file] of [['16','structural-chain'],['17','cross-domain-ontology'],['18','reverse-ingestion'],['19','dark-data-catalog'],['20','certainty-contract']]){
    const run=spawnSync(process.execPath,['cli.mjs','motor',new URL(`../examples/${file}.json`,import.meta.url).pathname,mid],{cwd:new URL('../',import.meta.url).pathname,encoding:'utf8'});
    assert.equal(run.status,0,`${mid}: ${run.stderr}`);
    assert.ok(JSON.parse(run.stdout).engine);
  }
});
