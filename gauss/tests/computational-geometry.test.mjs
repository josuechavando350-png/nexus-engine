import test from 'node:test';
import assert from 'node:assert/strict';
import {
 signedOrientation, segmentIntersectionClass, convexHullMonotone, polygonSignedArea,
 polygonCentroid, polygonPerimeter, pointInSimplePolygon, closestPairSquared,
 farthestPairSquared, pointSegmentProjection, lineIntersectionCoordinates,
 latticePolygonInterior, convexPolygonDiameter,
} from '../core/layers/computational-geometry.mjs';
let seed = 0x338ab1ce;
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; }
const rand = n => Math.floor(random() * n);
const near = (a, b, tolerance = 1e-8) => assert(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const rectangles = () => { const x = rand(25) - 12, y = rand(25) - 12, width = 1 + rand(15), height = 1 + rand(15); return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]; };
test('orientation matches the independent determinant formula on 300 integer triangles', () => {
 for(let k=0;k<300;k++) {
  const a=[rand(100)-50,rand(100)-50],b=[rand(100)-50,rand(100)-50],c=[rand(100)-50,rand(100)-50];
  const expected=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  assert.deepEqual(signedOrientation({a,b,c}),{twiceSignedArea:expected,orientation:Math.sign(expected)});
 }
});
test('segments distinguish proper intersection, endpoint touch, overlap and disjointness', () => {
 const cases = [
  {a:[0,0],b:[4,4],c:[0,4],d:[4,0],expected:'PROPER_CROSS'},
  {a:[0,0],b:[4,0],c:[4,0],d:[5,2],expected:'TOUCH'},
  {a:[0,0],b:[4,0],c:[2,0],d:[6,0],expected:'OVERLAP'},
  {a:[0,0],b:[4,0],c:[5,0],d:[6,0],expected:'DISJOINT'},
  {a:[0,0],b:[4,0],c:[2,-1],d:[2,0],expected:'TOUCH'},
  {a:[0,0],b:[4,0],c:[4,0],d:[0,0],expected:'OVERLAP'},
 ];
 for(const {expected,...args} of cases)assert.equal(segmentIntersectionClass(args).relation,expected);
});
test('convex hull excludes all non-extreme points of rectangles, including duplicate vertices', () => {
 for(let k=0;k<250;k++) {
  const r=rectangles(), inside=[r[0][0]+rand(r[1][0]-r[0][0]+1),r[0][1]+rand(r[2][1]-r[0][1]+1)];
  const pts=[r[2],inside,r[0],r[3],r[1],r[2]];
  assert.deepEqual(convexHullMonotone({vertices:pts}).hull,r);
 }
 assert.deepEqual(convexHullMonotone({vertices:[[3,0],[1,0],[2,0],[2,0]]}).hull,[[1,0],[3,0]]);
});
test('signed area agrees with independent rectangle area and changes sign under reversal', () => {
 for(let k=0;k<250;k++) {
  const v=rectangles(),area=(v[1][0]-v[0][0])*(v[2][1]-v[1][1]);
  assert.equal(polygonSignedArea({vertices:v}).area,area);
  assert.equal(polygonSignedArea({vertices:[...v].reverse()}).area,-area);
 }
});
test('polygon centroid equals rectangle diagonals midpoint in 200 translated polygons', () => {
 for(let k=0;k<200;k++){
  const v=rectangles(),out=polygonCentroid({vertices:v}).centroid;
  near(out[0],(v[0][0]+v[2][0])/2);near(out[1],(v[0][1]+v[2][1])/2);
  const reversed=polygonCentroid({vertices:[...v].reverse()}).centroid;near(out[0],reversed[0]);near(out[1],reversed[1]);
 }
});
test('perimeter agrees with independent edge hypot sum and analytic rectangle dimensions', () => {
 for(let k=0;k<200;k++){
  const v=rectangles(),out=polygonPerimeter({vertices:v});
  near(out.perimeter,2*(v[1][0]-v[0][0]+v[2][1]-v[1][1]));
  near(out.perimeter,v.reduce((s,p,i)=>s+Math.hypot(...p.map((x,j)=>x-v[(i+1)%v.length][j])),0));
 }
});
test('point containment returns inside, boundary and outside on independently known rectangles', () => {
 for(let k=0;k<200;k++) {
  const v=rectangles(),[x0,y0]=v[0],[x1,y1]=v[2];
  for(const [q,expected] of [ [[x0,y0],'BOUNDARY'],[[x1,y1],'BOUNDARY'],[[x0,y1],'BOUNDARY'],[[x0-1,y0],'OUTSIDE'],[[x1+1,y1],'OUTSIDE'] ]) {
   assert.equal(pointInSimplePolygon({vertices:v,query:q}).location,expected);
  }
  if(x1-x0>1&&y1-y0>1)assert.equal(pointInSimplePolygon({vertices:v,query:[x0+1,y0+1]}).location,'INSIDE');
 }
 const concave=[[0,0],[4,0],[4,1],[1,1],[1,4],[0,4]];
 assert.equal(pointInSimplePolygon({vertices:concave,query:[2,2]}).location,'OUTSIDE');
 assert.equal(pointInSimplePolygon({vertices:concave,query:[0,2]}).location,'BOUNDARY');
});
test('closest pair finds the independent exhaustive distance and valid witness', () => {
 for(let k=0;k<250;k++) {
  const v=Array.from({length:2+rand(12)},()=>[rand(31)-15,rand(31)-15]);
  let expected=Infinity;for(let i=0;i<v.length;i++)for(let j=i+1;j<v.length;j++)expected=Math.min(expected,d2(v[i],v[j]));
  const out=closestPairSquared({vertices:v});assert.equal(out.distanceSquared,expected);
  assert.equal(d2(v[out.indices[0]],v[out.indices[1]]),expected);
 }
});
test('farthest pair finds independent exhaustive diameter and valid witness', () => {
 for(let k=0;k<250;k++){
  const v=Array.from({length:2+rand(12)},()=>[rand(31)-15,rand(31)-15]);
  let expected=-1;for(let i=0;i<v.length;i++)for(let j=i+1;j<v.length;j++)expected=Math.max(expected,d2(v[i],v[j]));
  const out=farthestPairSquared({vertices:v});assert.equal(out.distanceSquared,expected);
  assert.equal(d2(v[out.indices[0]],v[out.indices[1]]),expected);
 }
});
test('point-to-segment projection matches independent one-dimensional constrained quadratic optimum', () => {
 for(let k=0;k<250;k++){
  const a=[rand(31)-15,rand(31)-15],b=[rand(31)-15,rand(31)-15],query=[rand(31)-15,rand(31)-15];if(d2(a,b)===0)continue;
  const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((query[0]-a[0])*dx+(query[1]-a[1])*dy)/(dx*dx+dy*dy)));
  const out=pointSegmentProjection({a,b,query});near(out.parameter,t);
  near(out.distanceSquared,d2(query,[a[0]+t*dx,a[1]+t*dy]));
  for(const candidate of [0,.1,.25,.5,.75,.9,1])assert(out.distanceSquared <= d2(query,[a[0]+candidate*dx,a[1]+candidate*dy])+1e-8);
 }
});
test('line intersection satisfies both line equations and identifies parallel/coincident lines', () => {
 for(let k=0;k<250;k++){
  const a=[rand(31)-15,rand(31)-15],b=[rand(31)-15,rand(31)-15],c=[rand(31)-15,rand(31)-15],d=[rand(31)-15,rand(31)-15];if(d2(a,b)===0||d2(c,d)===0)continue;
  const out=lineIntersectionCoordinates({a,b,c,d}),cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  if(out.relation==='INTERSECT'){near(cross(a,b,out.intersection),0,1e-5);near(cross(c,d,out.intersection),0,1e-5);}
  else if(out.relation==='COINCIDENT')assert.equal(cross(a,b,c),0);
  else assert.equal((b[0]-a[0])*(d[1]-c[1]),(b[1]-a[1])*(d[0]-c[0]));
 }
});
test('Pick lattice polygon theorem matches independent lattice enumeration for small rectangles',()=>{
 for(let k=0;k<200;k++){
  const v=rectangles(),x0=v[0][0],y0=v[0][1],x1=v[2][0],y1=v[2][1];
  let interior=0,boundary=0;for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++) {
   if(x>x0&&x<x1&&y>y0&&y<y1)interior++;else boundary++;
  }
  const out=latticePolygonInterior({vertices:v});assert.equal(out.interior,interior);assert.equal(out.boundary,boundary);
  assert.equal(out.twiceArea,2*(x1-x0)*(y1-y0));
 }
});
test('convex-polygon diameter agrees with independent pairwise distance oracle',()=>{
 for(let k=0;k<200;k++){
  const v=rectangles(),out=convexPolygonDiameter({vertices:v});
  assert.equal(out.diameterSquared,d2(v[0],v[2]));
  assert.equal(d2(v[out.vertexIndices[0]],v[out.vertexIndices[1]]),out.diameterSquared);
 }
});
test('geometric operators reject malformed, self-intersecting, degenerate and unbounded inputs',()=>{
 assert.throws(()=>signedOrientation({a:[0,0],b:[1,0],c:[Infinity,0]}),/bounded/);
 assert.throws(()=>segmentIntersectionClass({a:[0,0],b:[0,0],c:[0,1],d:[1,1]}),/distinct/);
 assert.throws(()=>convexHullMonotone({vertices:[]}),/bounds/);
 assert.throws(()=>polygonSignedArea({vertices:[[0,0],[2,2],[0,2],[2,0]]}),/simple|nonzero/);
 assert.throws(()=>polygonCentroid({vertices:[[0,0],[1,1],[2,2]]}),/nonzero/);
 assert.throws(()=>polygonPerimeter({vertices:[[0,0],[1,1],[2,2]]}),/nonzero/);
 assert.throws(()=>pointInSimplePolygon({vertices:[[0,0],[1,1],[2,2]],query:[0,0]}),/nonzero/);
 assert.throws(()=>closestPairSquared({vertices:[[0,0]]}),/bounds/);
 assert.throws(()=>farthestPairSquared({vertices:[[0,0]]}),/bounds/);
 assert.throws(()=>pointSegmentProjection({a:[0,0],b:[0,0],query:[1,1]}),/distinct/);
 assert.throws(()=>lineIntersectionCoordinates({a:[0,0],b:[0,0],c:[1,1],d:[2,2]}),/distinct/);
 assert.throws(()=>latticePolygonInterior({vertices:[[0,0],[1,1],[2,2]]}),/nonzero/);
 assert.throws(()=>convexPolygonDiameter({vertices:[[0,0],[0,1],[1,1],[1,0]]}),/counterclockwise/);
});
