import {keys,integer,array,vector,asBig,rat,out,tuple} from './batch-500-common.mjs';
const p=(x,label='point')=>vector(x,label,3,100000).map(asBig);
const pair=(x)=>{keys(x,['a','b']);return [p(x.a,'a'),p(x.b,'b')];};
const three=(x)=>{keys(x,['a','b','c']);return [p(x.a,'a'),p(x.b,'b'),p(x.c,'c')];};
const four=x=>{keys(x,['a','b','c','d']);return [p(x.a,'a'),p(x.b,'b'),p(x.c,'c'),p(x.d,'d')];};
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const scale=(a,k)=>a.map(v=>v*k);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0n);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>dot(a,a);
const triple=(a,b,c)=>dot(a,cross(b,c));
const result=x=>out({value:String(x)});
const vr=a=>a.map(String);
const coords=(n,d)=>n.map(v=>rat(v,d));
const normal=(a,b,c)=>cross(sub(b,a),sub(c,a));
const nonzero=(v,label)=>{if(norm(v)===0n)throw new RangeError(`${label} must be nonzero`);return v;};
const box=x=>{keys(x,['min','max']);const lo=p(x.min,'min'),hi=p(x.max,'max');if(lo.some((v,i)=>v>hi[i]))throw new RangeError('min must not exceed max');return {lo,hi};};
export function dotProduct3(x){const [a,b]=pair(x);return result(dot(a,b));}
export function crossProduct3(x){const [a,b]=pair(x);return out({vector:vr(cross(a,b))});}
export function squaredNorm3(x){keys(x,['vector']);return result(norm(p(x.vector,'vector')));}
export function squaredDistance3(x){const [a,b]=pair(x);return result(norm(sub(a,b)));}
export function scalarTriple3(x){const [a,b,c]=three(x);return result(triple(a,b,c));}
export function tetrahedronSixVolume(x){const [a,b,c,d]=four(x),six=triple(sub(b,a),sub(c,a),sub(d,a));return out({sixTimesVolume:String(six<0n?-six:six)});}
export function orientation3(x){const [a,b,c,d]=four(x),v=triple(sub(b,a),sub(c,a),sub(d,a));return out({orientation:v>0n?1:v<0n?-1:0});}
export function collinear3(x){const [a,b,c]=three(x);return out({collinear:norm(normal(a,b,c))===0n});}
export function coplanar3(x){const [a,b,c,d]=four(x);return out({coplanar:triple(sub(b,a),sub(c,a),sub(d,a))===0n});}
export function orthogonal3(x){const [a,b]=pair(x);return out({orthogonal:dot(a,b)===0n});}
export function parallel3(x){const [a,b]=pair(x);return out({parallel:norm(cross(a,b))===0n});}
export function angleClass3(x){const [a,b]=pair(x);nonzero(a,'a');nonzero(b,'b');const v=dot(a,b);return out({angle:v>0n?'ACUTE':v<0n?'OBTUSE':'RIGHT'});}
export function triangleAreaSquared(x){const [a,b,c]=three(x);return out({areaSquared:rat(norm(normal(a,b,c)),4n)});}
export function parallelogramAreaSquared(x){const [a,b]=pair(x);return result(norm(cross(a,b)));}
export function midpoint3(x){const [a,b]=pair(x);return out({coordinates:coords(add(a,b),2n)});}
export function affineWeightedPoint3(x){keys(x,['a','b','weightA','weightB']);const a=p(x.a,'a'),b=p(x.b,'b'),u=BigInt(integer(x.weightA,'weightA',-100000,100000)),v=BigInt(integer(x.weightB,'weightB',-100000,100000));if(u+v===0n)throw new RangeError('total weight zero');return out({coordinates:coords(add(scale(a,u),scale(b,v)),u+v)});}
export function centroid3(x){keys(x,['points']);const pp=array(x.points,'points',1,128).map((q,i)=>p(q,`points[${i}]`)),sum=pp.reduce(add,[0n,0n,0n]);return out({coordinates:coords(sum,BigInt(pp.length))});}
export function boundingBox3(x){keys(x,['points']);const pp=array(x.points,'points',1,128).map((q,i)=>p(q,`points[${i}]`));return out({min:[0,1,2].map(i=>String(pp.reduce((v,q)=>q[i]<v?q[i]:v,pp[0][i]))),max:[0,1,2].map(i=>String(pp.reduce((v,q)=>q[i]>v?q[i]:v,pp[0][i])))});}
export function intersectBoxes3(x){keys(x,['left','right']);const a=box(x.left),b=box(x.right),lo=a.lo.map((v,i)=>v>b.lo[i]?v:b.lo[i]),hi=a.hi.map((v,i)=>v<b.hi[i]?v:b.hi[i]);const nonempty=lo.every((v,i)=>v<=hi[i]);return out({nonempty,min:nonempty?vr(lo):null,max:nonempty?vr(hi):null});}
export function boxVolume3(x){const {lo,hi}=box(x);return result(hi.reduce((prod,v,i)=>prod*(v-lo[i]),1n));}
export function spherePointRelation3(x){keys(x,['center','point','radiusSquared']);const c=p(x.center,'center'),q=p(x.point,'point'),r=BigInt(integer(x.radiusSquared,'radiusSquared',0,1e12)),d=norm(sub(c,q));return out({relation:d<r?'INSIDE':d>r?'OUTSIDE':'BOUNDARY',distanceSquared:String(d)});}
export function projectPointLine3(x){keys(x,['origin','direction','point']);const o=p(x.origin,'origin'),d=nonzero(p(x.direction,'direction'),'direction'),q=p(x.point,'point'),t=dot(sub(q,o),d),den=norm(d);return out({parameter:rat(t,den),coordinates:coords(add(scale(o,den),scale(d,t)),den)});}
export function pointLineDistanceSquared3(x){keys(x,['origin','direction','point']);const o=p(x.origin,'origin'),d=nonzero(p(x.direction,'direction'),'direction'),q=p(x.point,'point');return out({distanceSquared:rat(norm(cross(sub(q,o),d)),norm(d))});}
export function pointPlaneDistanceSquared3(x){keys(x,['origin','normal','point']);const o=p(x.origin,'origin'),n=nonzero(p(x.normal,'normal'),'normal'),q=p(x.point,'point'),v=dot(n,sub(q,o));return out({distanceSquared:rat(v*v,norm(n))});}
export function barycentricTriangle3(x){keys(x,['a','b','c','point']);const a=p(x.a,'a'),b=p(x.b,'b'),c=p(x.c,'c'),q=p(x.point,'point'),u=sub(b,a),v=sub(c,a),w=sub(q,a),uu=norm(u),uv=dot(u,v),vv=norm(v),wu=dot(w,u),wv=dot(w,v),den=uu*vv-uv*uv;
 if(!den)throw new RangeError('degenerate triangle');const beta=wu*vv-wv*uv,gamma=wv*uu-wu*uv,alpha=den-beta-gamma;
 const onPlane=dot(w,cross(u,v))===0n,within=alpha>=0n&&beta>=0n&&gamma>=0n;
 return out({onPlane,inside:onPlane&&within,weights:[rat(alpha,den),rat(beta,den),rat(gamma,den)]});}
const a=[1,2,3],b=[4,0,2],c=[2,5,1],d=[1,1,8],sample={a,b},t={a,b,c},tet={a,b,c,d};
const boxes={left:{min:[0,0,0],max:[4,6,8]},right:{min:[2,-1,3],max:[5,2,9]}};
const definitions=[
 ['DOT3','Exact integer dot product in three dimensions',dotProduct3,sample],
 ['CROSS3','Exact integer three-dimensional cross product',crossProduct3,sample],
 ['NORM_SQUARED3','Exact squared Euclidean norm without a square root',squaredNorm3,{vector:b}],
 ['DISTANCE_SQUARED3','Exact squared Euclidean point distance',squaredDistance3,sample],
 ['SCALAR_TRIPLE3','Signed scalar triple product of integer vectors',scalarTriple3,t],
 ['TETRA_SIX_VOLUME3','Six times absolute tetrahedral volume',tetrahedronSixVolume,tet],
 ['ORIENTATION3','Exact signed orientation of four points in 3D',orientation3,tet],
 ['COLLINEAR3','Exact collinearity predicate for three points in 3D',collinear3,t],
 ['COPLANAR3','Exact coplanarity predicate for four points in 3D',coplanar3,tet],
 ['ORTHOGONAL3','Exact orthogonality predicate for integer vectors',orthogonal3,sample],
 ['PARALLEL3','Exact three-dimensional vector parallelism',parallel3,sample],
 ['ANGLE_CLASS3','Exact acute, right or obtuse nonzero vector angle classification',angleClass3,sample],
 ['TRIANGLE_AREA_SQUARED3','Exact rational squared Euclidean triangle area',triangleAreaSquared,t],
 ['PARALLELOGRAM_AREA_SQUARED3','Exact squared parallelogram area by Lagrange identity',parallelogramAreaSquared,sample],
 ['BARYCENTRIC_TRIANGLE3','Exact rational triangle barycentric coordinates and planar inclusion',barycentricTriangle3,{a,b,c,point:a}],
 ['MIDPOINT3','Reduced rational midpoint of two integer points',midpoint3,sample],
 ['AFFINE_WEIGHTED3','Exact rational weighted affine combination of two points',affineWeightedPoint3,{a,b,weightA:2,weightB:3}],
 ['CENTROID3','Exact rational centroid of a bounded point cloud',centroid3,{points:[a,b,c,d]}],
 ['BOUNDING_BOX3','Minimum integer axis-aligned box enclosing point cloud',boundingBox3,{points:[a,b,c,d]}],
 ['BOX_INTERSECTION3','Axis-aligned box intersection with closed-boundary semantics',intersectBoxes3,boxes],
 ['BOX_VOLUME3','Exact volume of integer axis-aligned box',boxVolume3,boxes.left],
 ['SPHERE_POINT3','Exact lattice-point containment in squared-radius sphere',spherePointRelation3,{center:a,point:b,radiusSquared:14}],
 ['PROJECT_POINT_LINE3','Exact rational orthogonal projection onto infinite 3D line',projectPointLine3,{origin:a,direction:b,point:c}],
 ['POINT_LINE_DISTANCE3','Exact rational squared point-to-line distance in 3D',pointLineDistanceSquared3,{origin:a,direction:b,point:c}],
 ['POINT_PLANE_DISTANCE3','Exact rational squared point-to-plane distance in 3D',pointPlaneDistanceSquared3,{origin:a,normal:b,point:c}],
];
export const INTEGER_GEOMETRY_500=tuple(definitions,'MATH','MATHEMATICS');
