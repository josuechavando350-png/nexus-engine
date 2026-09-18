/* Independent rectangle geometry identities, integer determinant, and line/segment witnesses. */
import assert from 'node:assert/strict';
import {runFinalBank} from './final-common-v1.mjs';
const rect=r=>{const x=r(31)-15,y=r(31)-15,w=2+2*r(6),h=w+2+2*r(4);return [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];};
const xy=x=>({x:x[0][0],y:x[0][1],w:x[1][0]-x[0][0],h:x[3][1]-x[0][1]});
const det=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const distance=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2;
const verify=(a,b,path='root')=>{if(typeof b==='number'){assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=1e-11*Math.max(1,Math.abs(b)),`${path}: ${a} != ${b}`);return;}if(Array.isArray(b)){assert.equal(a.length,b.length);b.forEach((v,i)=>verify(a[i],v,`${path}[${i}]`));return;}if(b&&typeof b==='object'){assert.deepStrictEqual(Object.keys(a).sort(),Object.keys(b).sort());for(const k of Object.keys(b))verify(a[k],b[k],`${path}.${k}`);return;}assert.deepStrictEqual(a,b);};
const invalid=x=>[null,{...x,[Object.keys(x)[0]]:null},{...x,[Object.keys(x)[0]]:'INVALID'}];
const defs=[
 {id:'GAUSS.MATH.ORIENTATION_2D.022',make:(i,r)=>({a:[r(31)-15,r(31)-15],b:[r(31)-15,r(31)-15],c:[r(31)-15,r(31)-15]}),reference:x=>{const v=det(x.a,x.b,x.c);return {twiceSignedArea:v,orientation:Math.sign(v)};}},
 {id:'GAUSS.MATH.SEGMENT_INTERSECTION.023',make:(i,r)=>{const p=rect(r),[a,b]=p,m=(a[0]+b[0])/2;switch(i%4){case 0:return {a,b,c:[m,a[1]-2],d:[m,a[1]+2]};case 1:return {a,b,c:[a[0],a[1]+2],d:[b[0],b[1]+2]};case 2:return {a,b,c:a,d:[a[0],a[1]+2]};default:return {a,b,c:[m,a[1]],d:[b[0]+2,a[1]]};}},reference:(x)=>({relation:['PROPER_CROSS','DISJOINT','TOUCH','OVERLAP'][x.a[0]===x.c[0]&&x.c[1]===x.a[1]?2:x.c[1]===x.a[1]&&x.d[1]===x.a[1]?3:x.c[1]===x.a[1]+2?1:0]})},
 {id:'GAUSS.MATH.CONVEX_HULL_2D.024',make:(i,r)=>{const p=rect(r),{x,y,w}=xy(p);return {vertices:[p[2],p[0],[x+w/2,y+1],p[3],p[1],p[0]]};},reference:x=>{const p=x.vertices,[x0,y0]=p[1],w=p[0][0]-x0,h=p[0][1]-y0;return {hull:[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h]],count:4};}},
 {id:'GAUSS.MATH.POLYGON_SIGNED_AREA.025',make:(i,r)=>({vertices:i%2?rect(r).reverse():rect(r)}),reference:x=>{const {w,h}=xy(x.vertices);const twiceSignedArea=w*h*2;return {twiceSignedArea,area:twiceSignedArea/2,absoluteArea:Math.abs(twiceSignedArea)/2};}},
 {id:'GAUSS.MATH.POLYGON_CENTROID.026',make:(i,r)=>({vertices:rect(r)}),reference:x=>{const {x:a,y:b,w,h}=xy(x.vertices);return {centroid:[a+w/2,b+h/2],twiceSignedArea:2*w*h};}},
 {id:'GAUSS.MATH.POLYGON_PERIMETER.027',make:(i,r)=>({vertices:rect(r)}),reference:x=>{const {w,h}=xy(x.vertices);return {perimeter:2*(w+h),edges:4};}},
 {id:'GAUSS.MATH.POINT_POLYGON_LOCATION.028',make:(i,r)=>{const vertices=rect(r),{x,y,w,h}=xy(vertices);return {vertices,query:i%3===0?[x+w/2,y+h/2]:i%3===1?[x,y+h/2]:[x-1,y+h/2]};},reference:x=>{const {x:a,y:b,w,h}=xy(x.vertices),[u,v]=x.query;return {location:u>a&&u<a+w&&v>b&&v<b+h?'INSIDE':u===a&&v>=b&&v<=b+h?'BOUNDARY':'OUTSIDE'};}},
 {id:'GAUSS.MATH.CLOSEST_PAIR_2D.029',make:(i,r)=>({vertices:rect(r)}),reference:x=>{const {w}=xy(x.vertices);return {distanceSquared:w*w,indices:[0,1]};}},
 {id:'GAUSS.MATH.FARTHEST_PAIR_2D.030',make:(i,r)=>({vertices:rect(r)}),reference:x=>{const {w,h}=xy(x.vertices);return {distanceSquared:w*w+h*h,indices:[0,2]};}},
 {id:'GAUSS.MATH.POINT_SEGMENT_PROJECTION.031',make:(i,r)=>{const p=rect(r),{x,y,w}=xy(p);return {a:p[0],b:p[1],query:[x+(i%3===0?w/2:i%3===1?-1:w+1),y+1+r(5)]};},reference:x=>{const {a,b,query:q}=x,w=b[0]-a[0],t=Math.min(1,Math.max(0,(q[0]-a[0])/w)),closest=[a[0]+w*t,a[1]];return {parameter:t,closest,distanceSquared:distance(q,closest)};}},
 {id:'GAUSS.MATH.LINE_INTERSECTION_2D.032',make:(i,r)=>{const p=rect(r),{x,y,w,h}=xy(p);return i%3===0?{a:[x,y],b:[x+w,y],c:[x+w/2,y-1],d:[x+w/2,y+h]}:i%3===1?{a:[x,y],b:[x+w,y],c:[x,y+1],d:[x+w,y+1]}:{a:[x,y],b:[x+w,y],c:[x+w/2,y],d:[x+w+1,y]};},reference:x=>({relation:x.c[1]===x.a[1]?'COINCIDENT':x.d[0]===x.c[0]?'INTERSECT':'PARALLEL',intersection:x.d[0]===x.c[0]?[x.c[0],x.a[1]]:null})},
 {id:'GAUSS.MATH.PICK_LATTICE_INTERIOR.033',make:(i,r)=>({vertices:rect(r)}),reference:x=>{const {w,h}=xy(x.vertices);return {interior:(w-1)*(h-1),boundary:2*(w+h),twiceArea:2*w*h};}},
 {id:'GAUSS.MATH.CONVEX_POLYGON_DIAMETER.034',make:(i,r)=>({vertices:rect(r)}),reference:x=>{const {w,h}=xy(x.vertices);return {diameterSquared:w*w+h*h,vertexIndices:[0,2]};}}
].map(def=>({...def,invalid,verify}));
export const runFinalComputationalGeometryBank=options=>runFinalBank({name:'AXIOMA 13 separately derived integer rectangle and segment references',definitions:defs,...options});
