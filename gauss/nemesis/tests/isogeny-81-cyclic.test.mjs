import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCyclicVelu} from '../isogeny-81-cyclic.mjs';
import {evaluateTwoIsogeny} from '../engine/src/motors/isogeny-2.mjs';

// Deliberately separate elementary arithmetic oracle: Fermat inversion rather
// than the implementation's extended-Euclidean inverse.
const mod=(n,p)=>((n%p)+p)%p;
function pow(x,n,p){let y=1;for(;n;n=Math.floor(n/2),x=mod(x*x,p))if(n%2)y=mod(y*x,p);return y;}
function sum(P,Q,a,p){
  if(!P)return Q;if(!Q)return P;
  if(P.x===Q.x&&mod(P.y+Q.y,p)===0)return null;
  const slope=P.x===Q.x&&P.y===Q.y
    ? mod((3*P.x*P.x+a)*pow(2*P.y,p-2,p),p)
    : mod((Q.y-P.y)*pow(Q.x-P.x,p-2,p),p);
  const x=mod(slope*slope-P.x-Q.x,p);
  return {x,y:mod(slope*(P.x-x)-P.y,p)};
}
function enumerate(p,a,b){
  const all=[null];
  for(let x=0;x<p;x++)for(let y=0;y<p;y++)if(mod(y*y-x*x*x-a*x-b,p)===0)all.push({x,y});
  return all;
}
const key=P=>P===null?'O':`${P.x},${P.y}`;
function pointOrder(P,a,p,limit){
  let R=null;
  for(let n=1;n<=limit;n++){R=sum(R,P,a,p);if(R===null)return n;}
  throw new Error('independent oracle exhausted point order');
}

test('81 cyclic degree 2 independently matches original normalized Vélu for full curves',()=>{
  let curves=0;
  for(const p of [5,7,11,13,17,19,23,29,31,37])for(let a=0;a<p;a++)for(let r=0;r<p;r++){
    const b=mod(-r*r*r-a*r,p);
    if(mod(4*a*a*a+27*b*b,p)===0)continue;
    const points=enumerate(p,a,b);
    const cyclic=evaluateCyclicVelu({p,a,b,degree:2,generator:{x:r,y:0},points});
    const original=evaluateTwoIsogeny({p,a,b,kernelX:r,points});
    assert.deepEqual(cyclic.target,original.target);
    assert.deepEqual(cyclic.images,original.images);
    curves++;
  }
  assert.ok(curves>1000);
});

test('81 cyclic degree 3, 5, 7 and 11 maps full rational groups homomorphically',()=>{
  const seen=new Map();
  for(const degree of [3,5,7,11])seen.set(degree,0);
  for(const p of [11,13,17,19,23,29,31,37,41,43,47,53]){
    for(const degree of seen.keys()){
      if(seen.get(degree)>=4)continue;
      let found=false;
      for(let a=0;a<p&&!found;a++)for(let b=0;b<p&&!found;b++){
        if(mod(4*a*a*a+27*b*b,p)===0)continue;
        const all=enumerate(p,a,b);
        for(const gen of all.slice(1)){
          if(pointOrder(gen,a,p,all.length)!==degree)continue;
          const result=evaluateCyclicVelu({p,a,b,degree,generator:gen,points:all});
          assert.equal(result.kernel.points.length,degree-1);
          assert.equal(new Set(result.kernel.points.map(key)).size,degree-1);
          assert.equal(result.images.filter(P=>P===null).length,degree);
          const images=new Map(all.map((P,i)=>[key(P),result.images[i]]));
          for(const P of all)for(const Q of all){
            const lhs=images.get(key(sum(P,Q,a,p)));
            const rhs=sum(images.get(key(P)),images.get(key(Q)),result.target.a,p);
            assert.deepEqual(lhs,rhs,`degree=${degree} p=${p} a=${a} b=${b}`);
          }
          // Every target curve point is independently checked, not just
          // coefficients: count of target rational points equals source count.
          assert.equal(enumerate(p,result.target.a,result.target.b).length,all.length);
          seen.set(degree,seen.get(degree)+1);
          found=true;
          break;
        }
      }
    }
  }
  assert.deepEqual(Object.fromEntries(seen),{3:4,5:4,7:4,11:4});
});

test('81 cyclic rejects wrong generator order, composite fields, foreign points and extra keys',()=>{
  const base={p:11,a:1,b:0,degree:2,generator:{x:0,y:0},points:[null,{x:0,y:0}]};
  assert.equal(evaluateCyclicVelu(base).images.length,2);
  assert.throws(()=>evaluateCyclicVelu({...base,degree:3}),/smaller than/);
  assert.throws(()=>evaluateCyclicVelu({...base,degree:4}),/smaller than/);
  assert.throws(()=>evaluateCyclicVelu({...base,p:9}),/odd prime/);
  assert.throws(()=>evaluateCyclicVelu({...base,a:0}),/singular/);
  assert.throws(()=>evaluateCyclicVelu({...base,points:[{x:1,y:1}]}),/not on source/);
  assert.throws(()=>evaluateCyclicVelu({...base,points:[{x:0,y:0,extra:2}]}),/unexpected field/);
  assert.throws(()=>evaluateCyclicVelu({...base,unexpected:1}),/unexpected field/);
  assert.throws(()=>evaluateCyclicVelu({...base,degree:32}),/degree/);
  assert.throws(()=>evaluateCyclicVelu({...base,generator:null}),/generator cannot/);
  assert.throws(()=>evaluateCyclicVelu({...base,points:Array(129).fill(null)}),/at most 128/);
});
