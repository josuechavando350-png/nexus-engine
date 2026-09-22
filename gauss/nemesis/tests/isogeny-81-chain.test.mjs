import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicVeluChain} from '../isogeny-81-chain.mjs';
import {evaluateCyclicVelu} from '../isogeny-81-cyclic.mjs';
const mod=(n,p)=>((n%p)+p)%p;
function pow(x,n,p){let v=1;for(;n;n=Math.floor(n/2),x=mod(x*x,p))if(n%2)v=mod(v*x,p);return v;}
function add(P,Q,a,p){
  if(!P)return Q;if(!Q)return P;if(P.x===Q.x&&mod(P.y+Q.y,p)===0)return null;
  const m= P.x===Q.x&&P.y===Q.y
    ? mod((3*P.x**2+a)*pow(2*P.y,p-2,p),p)
    : mod((Q.y-P.y)*pow(Q.x-P.x,p-2,p),p);
  const x=mod(m*m-P.x-Q.x,p);return {x,y:mod(m*(P.x-x)-P.y,p)};
}
function enumerate(p,a,b){const out=[null];for(let x=0;x<p;x++)for(let y=0;y<p;y++)if(mod(y*y-x*x*x-a*x-b,p)===0)out.push({x,y});return out;}
function findOrder(points,a,p,n){for(const P of points.slice(1)){
  let Q=null;let valid=true;for(let i=1;i<=n;i++){Q=add(Q,P,a,p);if(Q===null&&i<n){valid=false;break;}}
  if(valid&&Q===null)return P;
}return null;}

test('81 composes degree-3 and degree-5 public isogenies with independently checked intermediate group',()=>{
  let sample;
  outer:for(const p of [29,31,37,41,43,47,53,59,61])for(let a=0;a<p;a++)for(let b=0;b<p;b++){
    if(mod(4*a**3+27*b*b,p)===0)continue;
    const points=enumerate(p,a,b);
    if(points.length%15!==0)continue;
    const generator3=findOrder(points,a,p,3);
    if(!generator3)continue;
    const first=evaluateCyclicVelu({p,a,b,degree:3,generator:generator3,points});
    const intermediary=enumerate(p,first.target.a,first.target.b);
    const generator5=findOrder(intermediary,first.target.a,p,5);
    if(!generator5)continue;
    sample={p,a,b,points,first,generator3,generator5};break outer;
  }
  assert.ok(sample,'must identify an independently enumerable composite isogeny path');
  const {p,a,b,points,first,generator3,generator5}=sample;
  const second=evaluateCyclicVelu({p,a:first.target.a,b:first.target.b,degree:5,generator:generator5,points:first.images});
  const chain=evaluatePublicVeluChain({p,a,b,steps:[{degree:3,generator:generator3},{degree:5,generator:generator5}],points});
  assert.equal(chain.degreeProduct,'15');
  assert.deepEqual(chain.target,second.target);
  assert.deepEqual(chain.images,second.images);
  assert.deepEqual(chain.trace.map(({degree})=>degree),[3,5]);
  assert.equal(enumerate(p,chain.target.a,chain.target.b).length,points.length);
  assert.match(chain.domain,/NOT_SIGNATURE/);
});

test('81 chain rejects invalid intermediate generators, wrong lengths, and unknown fields',()=>{
  const base={p:11,a:1,b:0,points:[null,{x:0,y:0}],steps:[{degree:2,generator:{x:0,y:0}}]};
  const one=evaluatePublicVeluChain(base);
  assert.equal(one.degreeProduct,'2');
  assert.deepEqual(one.images,[null,null]);
  assert.throws(()=>evaluatePublicVeluChain({...base,steps:[]}),/between 1 and 16/);
  assert.throws(()=>evaluatePublicVeluChain({...base,steps:Array(17).fill(base.steps[0])}),/between 1 and 16/);
  assert.throws(()=>evaluatePublicVeluChain({...base,steps:[base.steps[0],{degree:2,generator:{x:1,y:0}}]}),/not on source|declared degree|smaller than/);
  assert.throws(()=>evaluatePublicVeluChain({...base,steps:[{degree:2,generator:{x:0,y:0},other:1}]}),/steps\[0\]/);
  assert.throws(()=>evaluatePublicVeluChain({...base,other:1}),/expected/);
});
