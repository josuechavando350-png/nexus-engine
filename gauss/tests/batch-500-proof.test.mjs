import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BATCH_500_ADDITIONS as all} from '../core/batch-500-additions.mjs';
import * as auto from '../core/layers/batch-500-automata.mjs';
import * as gf from '../core/layers/batch-500-coding.mjs';
import * as geo from '../core/layers/batch-500-geometry.mjs';
import * as num from '../core/layers/batch-500-numerical.mjs';
import {executeBatch500,hash,canonical} from '../scripts/batch-500-runner.mjs';
import {verifyReport} from '../scripts/verify-batch-500.mjs';
let seed=0x31415926;
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const r=(lo,hi)=>lo+random()%(hi-lo+1);
const approx=(a,b,t=1e-8)=>assert(Math.abs(a-b)<=t*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const b=x=>BigInt(x);
const words=(a,n)=>n===0?['']:words(a,n-1).flatMap(w=>a.map(c=>w+c));
const dfaOracle=(x,w)=>{let s=x.start;for(const c of w)s=x.transitions[s][x.alphabet.indexOf(c)];return x.accepting.includes(s);};
const matmul=(A,B)=>A.map(row=>B[0].map((_,j)=>B.reduce((v,b,k)=>v^(row[k]&b[j]),0)));
const mmul=(A,v)=>A.map(row=>row.reduce((acc,x,i)=>acc^(x&v[i]),0));
const enumRank=A=>{const set=new Set();for(let mask=0;mask<2**A.length;mask++){let row=Array(A[0].length).fill(0);for(let i=0;i<A.length;i++)if(mask>>i&1)row=row.map((x,j)=>x^A[i][j]);set.add(row.join(''));}return Math.log2(set.size);};
const dot=(a,c)=>a.reduce((s,v,i)=>s+v*c[i],0);
const minus=(a,c)=>a.map((v,i)=>v-c[i]);
const cross=(a,c)=>[a[1]*c[2]-a[2]*c[1],a[2]*c[0]-a[0]*c[2],a[0]*c[1]-a[1]*c[0]];
const rational=v=>Number(v.numerator)/Number(v.denominator);
const value=v=>BigInt(v.value);
const fixture=JSON.parse(await readFile(new URL('../fixtures/batch-500-problem.json',import.meta.url),'utf8'));
const prior=JSON.parse(await readFile(new URL('../fixtures/prior-200-ids.json',import.meta.url),'utf8'));

test('exactly 100 distinct new executable definitions, disjoint from all 200 prior batch IDs',()=>{
 assert.equal(all.length,100);assert.equal(prior.length,200);
 assert.equal(new Set([...all.map(o=>o.id),...prior]).size,300);
 assert.equal(new Set(all.map(o=>o.execute)).size,100);
 assert.deepEqual([...new Set(all.map(o=>o.domain))].sort(),['COMPUTER_SCIENCE','CONTROL_DYNAMICS','INFORMATION_THEORY','MATHEMATICS']);
 for(const domain of ['COMPUTER_SCIENCE','CONTROL_DYNAMICS','INFORMATION_THEORY','MATHEMATICS'])assert.equal(all.filter(o=>o.domain===domain).length,25);
 assert.deepEqual(new Set(all.map(o=>o.id)),new Set(fixture.tasks.map(o=>o.layerId)));
 for(const op of all){assert.match(op.description,/\w+/);assert.equal(typeof op.execute,'function');assert(Object.isFrozen(op.input));
  const v=op.execute(structuredClone(op.input));assert(Object.isFrozen(v));assert.equal(canonical(v),canonical(op.execute(structuredClone(op.input))));
  assert.throws(()=>op.execute(null),undefined,`${op.id} accepted null input`);
 }
});

test('all DFA acceptance/count/shortest witnesses and reachable states match independent exhaustive word oracles',()=>{
 for(let iter=0;iter<70;iter++){
  const n=r(1,4),a=['0','1'],transitions=Array.from({length:n},()=>a.map(()=>r(0,n-1))),accepting=Array.from({length:n},(_,i)=>i).filter(()=>r(0,1)),start=r(0,n-1),z={alphabet:a,start,accepting,transitions};
  const seen=new Set([start]),q=[start];for(const s of q)for(const v of transitions[s])if(!seen.has(v)){seen.add(v);q.push(v);}
  assert.deepEqual(auto.dfaReachable(z).states,[...seen].sort((x,y)=>x-y));
  const co=Array.from({length:n},(_,i)=>i).filter(s=>Array.from({length:n+1},(_,k)=>words(a,k)).flat().some(w=>{let v=s;for(const c of w)v=transitions[v][a.indexOf(c)];return accepting.includes(v);}));
  assert.deepEqual(auto.dfaCoaccessible(z).states,co);
  for(let len=0;len<=5;len++){
   const ws=words(a,len),accepted=ws.filter(w=>dfaOracle(z,w));
   assert.equal(auto.dfaAcceptedWordCount({dfa:z,length:len}).count,String(accepted.length));
   assert.equal(auto.dfaRejectedWordCount({dfa:z,length:len}).count,String(ws.length-accepted.length));
   for(const w of ws){const got=auto.dfaAccept({dfa:z,word:w}),trace=auto.dfaTrace({dfa:z,word:w});assert.equal(got.accepted,dfaOracle(z,w));assert.equal(trace.accepted,got.accepted);assert.equal(trace.states.length,w.length+1);}
  }
  const allw=Array.from({length:n+2},(_,len)=>words(a,len)).flat();
  const good=allw.find(w=>dfaOracle(z,w))??null,bad=allw.find(w=>!dfaOracle(z,w))??null;
  assert.equal(auto.dfaNonEmptyWitness(z).witness,good);assert.equal(auto.dfaRejectionWitness(z).witness,bad);
  assert.equal(auto.dfaShortestAcceptedLength(z).length,good===null?null:good.length);
  const m=auto.dfaMinimize(z).dfa,c=auto.dfaCanonicalSignature(z);
  assert(m.transitions.length<=n);
  for(const w of allw)assert.equal(dfaOracle(m,w),dfaOracle(z,w));
  const complemented=auto.dfaComplement(z);for(const w of allw)assert.equal(dfaOracle(complemented,w),!dfaOracle(z,w));
  assert.deepEqual(auto.dfaCanonicalSignature(m),c);
 }
});

test('DFA Boolean language products, witnesses, finiteness, trim and NFA reversal have actual language semantics',()=>{
 const a=['0','1'];for(let iter=0;iter<45;iter++){
  const create=()=>{const n=r(1,4);return {alphabet:a,start:r(0,n-1),accepting:Array.from({length:n},(_,i)=>i).filter(()=>r(0,1)),transitions:Array.from({length:n},()=>a.map(()=>r(0,n-1)))}};
  const left=create(),right=create(),input={left,right},ws=Array.from({length:7},(_,len)=>words(a,len)).flat();
  const bools=[auto.dfaIntersection(input),(auto.dfaUnion(input)),auto.dfaDifference(input),auto.dfaSymmetricDifference(input)];
  for(const w of ws){const p=dfaOracle(left,w),q=dfaOracle(right,w);assert.deepEqual(bools.map(z=>dfaOracle(z,w)),[p&&q,p||q,p&&!q,p!==q]);}
  const eq=auto.dfaEquivalence(input),incl=auto.dfaInclusion(input),dis=auto.dfaDisjointness(input);
  assert.equal(eq.equivalent,eq.witness===null);assert.equal(incl.included,incl.counterexample===null);assert.equal(dis.disjoint,dis.commonWord===null);
  for(const [w,pred] of [[eq.witness,(p,q)=>p!==q],[incl.counterexample,(p,q)=>p&&!q],[dis.commonWord,(p,q)=>p&&q]])if(w!==null)assert(pred(dfaOracle(left,w),dfaOracle(right,w)));
  const rev=auto.reverseDfaToNfa(left);for(const w of ws.slice(0,127))assert.equal(auto.nfaAccept({nfa:rev,word:w}).accepted,dfaOracle(left,[...w].reverse().join('')));
  const trim=auto.dfaTrim(left);for(const w of ws.slice(0,100))assert.equal(trim.empty?false:dfaOracle(trim.dfa,w),dfaOracle(left,w));
 }
 const finite={alphabet:['0','1'],start:0,accepting:[1],transitions:[[1,2],[2,2],[2,2]]};
 assert.equal(auto.dfaFiniteLanguage(finite).finite,true);
 assert.equal(auto.dfaFiniteLanguage({alphabet:['0'],start:0,accepting:[0],transitions:[[0]]}).finite,false);
});

test('NFA epsilon closure, determinization, and acceptance obey epsilon-transition semantics',()=>{
 const nfa={alphabet:['0','1'],starts:[0],accepting:[3],transitions:[[[1],[]],[[],[2]],[[],[3]],[[],[]]],epsilon:[[0,2],[2,1]]};
 assert.deepEqual(auto.nfaEpsilonClosure({nfa,states:[0]}).states,[0,1,2]);
 const d=auto.nfaDeterminize(nfa);
 for(let len=0;len<=7;len++)for(const w of words(nfa.alphabet,len))assert.equal(auto.nfaAccept({nfa,word:w}).accepted,dfaOracle(d.dfa,w),w);
 assert.equal(auto.dfaEquivalence({left:d.dfa,right:d.dfa}).equivalent,true);
});

test('all binary-field linear algebra kernels agree with independent brute-force row-space oracles',()=>{
 for(let iter=0;iter<130;iter++){
  const n=r(1,4),cols=r(1,5),A=Array.from({length:n},()=>Array.from({length:cols},()=>r(0,1))),rank=enumRank(A),e=gf.gf2Rref({matrix:A});
  assert.equal(gf.gf2Rank({matrix:A}).rank,rank);assert.equal(e.rank,rank);
  assert.equal(gf.gf2Nullity({matrix:A}).nullity,cols-rank);
  assert.equal(gf.gf2KernelCardinality({matrix:A}).cardinality,String(2**(cols-rank)));
  const ker=gf.gf2Nullspace({matrix:A}).basis;assert.equal(ker.length,cols-rank);for(const v of ker)assert(mmul(A,v).every(x=>x===0));
  assert.equal(enumRank(ker.length?ker:[Array(cols).fill(0)]),ker.length);
  for(const row of e.rref)assert(row.every(v=>v===0||v===1));
  const col=gf.gf2ImageBasis({matrix:A}).columns;assert.equal(col.length,rank);
  if(col.length)assert.equal(enumRank(col),rank);
  const b=Array.from({length:n},()=>r(0,1)),res=gf.gf2Solve({matrix:A,rhs:b});
  const allSolutions=Array.from({length:2**cols},(_,mask)=>Array.from({length:cols},(_,j)=>mask>>j&1)).filter(v=>JSON.stringify(mmul(A,v))===JSON.stringify(b));
  assert.equal(res.consistent,allSolutions.length>0);if(res.consistent){assert.deepEqual(mmul(A,res.solution),b);assert.equal(res.unique,allSolutions.length===1);}
  const t=gf.gf2Transpose({matrix:A}).matrix;assert.deepEqual(t,A[0].map((_,j)=>A.map(row=>row[j])));
  const bCols=r(1,4),B=Array.from({length:cols},()=>Array.from({length:bCols},()=>r(0,1)));assert.deepEqual(gf.gf2Multiply({left:A,right:B}).matrix,matmul(A,B));
  if(n===cols){const det=gf.gf2Determinant({matrix:A});assert.equal(det.determinant,rank===n?1:0);const inverse=gf.gf2Inverse({matrix:A});assert.equal(inverse.invertible,rank===n);
   if(inverse.invertible)assert.deepEqual(matmul(A,inverse.inverse),A.map((_,i)=>A.map((_,j)=>Number(i===j))));}
 }
});

test('binary codewords, dual, erasure recovery, nearest decoding and Hamming bit-error correction',()=>{
 for(let iter=0;iter<90;iter++){
  const k=r(1,4),n=r(k,7),G=Array.from({length:k},()=>Array.from({length:n},()=>r(0,1))),messages=Array.from({length:2**k},(_,m)=>G.map((_,i)=>m>>i&1));
  const outputs=messages.map(message=>gf.gf2Encode({generator:G,message}).codeword),unique=[...new Set(outputs.map(v=>v.join('')))].map(s=>[...s].map(Number));
  const W=gf.gf2WeightEnumerator({generator:G}).counts.map(Number),weights=unique.map(v=>v.reduce((s,q)=>s+q,0));
  assert.deepEqual(W,Array.from({length:n+1},(_,i)=>weights.filter(w=>w===i).length));
  assert.equal(gf.gf2CodeMinimumDistance({generator:G}).distance,weights.filter(Boolean).length?Math.min(...weights.filter(Boolean)):null);
  const H=gf.gf2DualGenerator({generator:G}).parityCheck;for(const cw of outputs)assert(H.every(row=>dot(row,cw)%2===0));
  const received=Array.from({length:n},()=>r(0,1)),decoded=gf.gf2NearestDecode({generator:G,received}),d=Math.min(...unique.map(v=>v.reduce((s,q,i)=>s+(q!==received[i]),0)));
  assert.equal(decoded.distance,d);assert(unique.some(v=>JSON.stringify(v)===JSON.stringify(decoded.codeword)));
  const target=unique[r(0,unique.length-1)],erasures=target.map(v=>r(0,2)===0?null:v),matches=unique.filter(cw=>cw.every((v,i)=>erasures[i]===null||erasures[i]===v));
  const got=gf.gf2ErasureRecover({generator:G,received:erasures});assert.equal(got.candidates,matches.length);if(matches.length===1)assert.deepEqual(got.recovered,matches[0]);
 }
 for(let mask=0;mask<16;mask++){const data=Array.from({length:4},(_,i)=>mask>>i&1),code=gf.hamming74Encode({data}).codeword;
  for(let flip=-1;flip<7;flip++){const r=code.slice();if(flip>=0)r[flip]^=1;const d=gf.hamming74Decode({received:r});assert.deepEqual(d.data,data);assert.deepEqual(d.codeword,code);assert.equal(d.correctedPosition,flip<0?null:flip+1);}}
});

test('binary polynomial division and GCD preserve exact GF(2) polynomial identities',()=>{
 const decode=p=>p.reduce((s,v)=>s*2+v,0),degree=x=>x?Math.floor(Math.log2(x)):-1;
 const imod=(a,b)=>{while(a&&degree(a)>=degree(b))a^=b<<(degree(a)-degree(b));return a;};
 for(let i=0;i<200;i++){
  const a=r(1,1023),b=r(1,127),bitsOf=v=>v.toString(2).split('').map(Number),q=gf.gf2PolynomialDivision({dividend:bitsOf(a),divisor:bitsOf(b)}),v=decode(q.remainder),u=decode(q.quotient);
  assert.equal(v,imod(a,b));assert(v===0||degree(v)<degree(b));
  let reconstructed=v;for(let j=0;j<=degree(u);j++)if(u>>j&1)reconstructed^=b<<j;assert.equal(reconstructed,a);
  let aa=a,bb=b;while(bb){[aa,bb]=[bb,imod(aa,bb)];}assert.equal(decode(gf.gf2PolynomialGcd({left:bitsOf(a),right:bitsOf(b)}).gcd),aa);
 }
});

test('exact lattice geometry agrees with independent small-integer vector arithmetic',()=>{
 for(let i=0;i<180;i++){
  const a=Array.from({length:3},()=>r(-20,20)),c=Array.from({length:3},()=>r(-20,20)),d=Array.from({length:3},()=>r(-20,20)),e=Array.from({length:3},()=>r(-20,20)),p={a,b:c};
  assert.equal(value(geo.dotProduct3(p)),b(dot(a,c)));assert.deepEqual(geo.crossProduct3(p).vector,cross(a,c).map(String));
  assert.equal(value(geo.squaredNorm3({vector:a})),b(dot(a,a)));assert.equal(value(geo.squaredDistance3(p)),b(dot(minus(a,c),minus(a,c))));
  const tr=dot(a,cross(c,d));assert.equal(value(geo.scalarTriple3({a,b:c,c:d})),b(tr));
  assert.equal(geo.orthogonal3(p).orthogonal,dot(a,c)===0);
  assert.equal(geo.parallel3(p).parallel,cross(a,c).every(v=>v===0));
  assert.equal(geo.collinear3({a,b:c,c:d}).collinear,cross(minus(c,a),minus(d,a)).every(v=>v===0));
  assert.equal(geo.coplanar3({a,b:c,c:d,d:e}).coplanar,dot(minus(c,a),cross(minus(d,a),minus(e,a)))===0);
  approx(rational(geo.triangleAreaSquared({a,b:c,c:d}).areaSquared),dot(cross(minus(c,a),minus(d,a)),cross(minus(c,a),minus(d,a)))/4);
  assert.deepEqual(geo.midpoint3(p).coordinates.map(rational),a.map((v,j)=>(v+c[j])/2));
  if(c.some(Boolean)){
   const proj=geo.projectPointLine3({origin:a,direction:c,point:d}),t=rational(proj.parameter),q=proj.coordinates.map(rational),v=minus(d,q);
   approx(dot(v,c),0,1e-7);for(let j=0;j<3;j++)approx(q[j],a[j]+t*c[j]);
   const lineD=geo.pointLineDistanceSquared3({origin:a,direction:c,point:d}).distanceSquared;approx(rational(lineD),dot(v,v));
  }
  const bbox=geo.boundingBox3({points:[a,c,d,e]});assert.deepEqual(bbox.min,a.map((_,j)=>String(Math.min(a[j],c[j],d[j],e[j]))));
  if(cross(minus(c,a),minus(d,a)).some(Boolean)){
   const q=a.map((v,j)=>v+minus(c,a)[j]+minus(d,a)[j]),bar=geo.barycentricTriangle3({a,b:c,c:d,point:q});assert.equal(bar.onPlane,true);assert.equal(bar.inside,false);
   approx(bar.weights.map(rational).reduce((s,v)=>s+v,0),1);}
 }
});

test('numerical root methods, quadratures, derivatives, ODE convergence and declared input budgets',()=>{
 const p=[-2,0,1],params={coefficients:p,lower:0,upper:2,tolerance:1e-10,maxIterations:120};
 for(const fn of [num.bisection,num.regulaFalsi,num.ridderRoot]){const sol=fn(params);assert(sol.converged);approx(sol.root,Math.SQRT2,1e-9);assert(Math.abs(sol.residual)<1e-9);}
 for(const fn of [num.secantRoot,num.newtonRoot,num.halleyRoot]){const sol=fn({coefficients:p,x0:1.2,...(fn===num.secantRoot?{x1:1.5}:{}),tolerance:1e-10,maxIterations:50});assert(sol.converged);approx(sol.root,Math.SQRT2,1e-9);}
 const poly=[1,2,3,4,5];const derivative=x=>2+6*x+12*x*x+20*x*x*x,second=x=>6+24*x+60*x*x;
 for(let i=0;i<70;i++){const x=r(-10,10)/10,h=0.0005,base={coefficients:poly,at:x,h};
  approx(num.centralDerivative(base).estimate,derivative(x),1e-5);
  approx(num.fivePointDerivative(base).estimate,derivative(x),1e-7);
  approx(num.richardsonDerivative(base).estimate,derivative(x),1e-7);
  approx(num.secondCentralDerivative(base).estimate,second(x),2e-5);
 }
 // Integral of 1+2x+3x²+4x³+5x⁴ over [0,1] is exactly 5.
 for(const fn of [num.booleIntegral,num.gaussLegendreThree,num.rombergIntegral,num.adaptiveSimpson]){
  const x=fn===num.rombergIntegral?{coefficients:poly,lower:0,upper:1,levels:5}:fn===num.adaptiveSimpson?{coefficients:poly,lower:0,upper:1,tolerance:1e-9,maxDepth:12}:{coefficients:poly,lower:0,upper:1,steps:8};
  approx(fn(x).integral,5,1e-9);
 }
 const ode={a:0.4,b:0,c:0.2,t0:0,y0:1,dt:0.1,steps:10},exact=(1+0.2/0.4)*Math.exp(0.4)-0.2/0.4;
 const errors=[num.eulerOde,num.heunOde,num.midpointOde,num.rk4Ode].map(fn=>Math.abs(fn(ode).values.at(-1)-exact));
 assert(errors[0]>errors[1]&&errors[1]>errors[3]);assert(errors[2]>errors[3]);assert(errors[3]<1e-6);
 const osc=num.symplecticEulerOscillator({position:1,velocity:0,omegaSquared:1,dt:0.05,steps:1000});assert.equal(osc.positions.length,1001);assert(Math.abs(osc.energyDrift)<0.03);
 assert.throws(()=>num.simpsonIntegral({coefficients:poly,lower:0,upper:1,steps:3}),/even/);
 assert.throws(()=>num.bisection({...params,lower:3,upper:4}),/opposite endpoint signs/);
});

test('100-task offline report independently replays and rejects fraudulent rehashed result',async()=>{
 const report=await executeBatch500();assert.equal(report.results.length,100);assert.equal(report.failedCount,0);
 const verification=await verifyReport(report);assert.equal(verification.verified,true);
 const forgery=structuredClone(report);forgery.results[52].output={forged:true};forgery.results[52].outputSha256=hash(forgery.results[52].output);
 const {reportSha256,...unsigned}=forgery;void reportSha256;forgery.reportSha256=hash(unsigned);
 await assert.rejects(verifyReport(forgery),/independent rerun differs/);
 const invalidFixture=structuredClone(fixture);invalidFixture.tasks[0].input={malicious:true};await assert.rejects(executeBatch500(invalidFixture),/fixture input or definition mismatch/);
});
