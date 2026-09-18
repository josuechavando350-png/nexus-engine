/* Independent 3D lattice-vector oracle; exact BigInt determinants and reduced rational coordinates. */
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['DOT3','CROSS3','NORM_SQUARED3','DISTANCE_SQUARED3','SCALAR_TRIPLE3','TETRA_SIX_VOLUME3','ORIENTATION3','COLLINEAR3','COPLANAR3','ORTHOGONAL3','PARALLEL3','ANGLE_CLASS3','TRIANGLE_AREA_SQUARED3','PARALLELOGRAM_AREA_SQUARED3','BARYCENTRIC_TRIANGLE3','MIDPOINT3','AFFINE_WEIGHTED3','CENTROID3','BOUNDING_BOX3','BOX_INTERSECTION3','BOX_VOLUME3','SPHERE_POINT3','PROJECT_POINT_LINE3','POINT_LINE_DISTANCE3','POINT_PLANE_DISTANCE3'];
const gcd=(a,b)=>b?gcd(b,a%b):a<0n?-a:a,rat=(n,d=1n)=>{if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {numerator:String(n/g),denominator:String(d/g)};};
const sum=v=>v.reduce((s,x)=>s+x,0n),to=a=>a.map(BigInt),sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>sum(a.map((v,i)=>v*b[i])),norm=a=>dot(a,a);
const determinant=(a,b,c)=>a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],coord=(a,d)=>a.map(v=>rat(v,d));
function input(tag,i,r){const point=()=>seq(3).map(()=>r(7)-3),a=point(),b=point(),c=point(),d=point(),x={a,b};if(['SCALAR_TRIPLE3','COLLINEAR3','TRIANGLE_AREA_SQUARED3'].includes(tag))x.c=c;if(['TETRA_SIX_VOLUME3','ORIENTATION3','COPLANAR3'].includes(tag))Object.assign(x,{c,d});
 if(tag==='NORM_SQUARED3')return {vector:a};
 if(tag==='BARYCENTRIC_TRIANGLE3')return {a:[0,0,0],b:[2,0,0],c:[0,2,0],point:point()};
 if(tag==='MIDPOINT3')return x;
 if(tag==='AFFINE_WEIGHTED3')return {...x,weightA:1+r(4),weightB:1+r(4)};
 if(['CENTROID3','BOUNDING_BOX3'].includes(tag))return {points:seq(1+i%5).map(point)};
 if(['BOX_INTERSECTION3','BOX_VOLUME3'].includes(tag)){const box=()=>{const aa=point(),bb=point();return {min:aa.map((v,j)=>Math.min(v,bb[j])),max:aa.map((v,j)=>Math.max(v,bb[j]))};};return tag==='BOX_VOLUME3'?box():{left:box(),right:box()};}
 if(tag==='SPHERE_POINT3')return {center:a,point:b,radiusSquared:r(25)};
 if(['PROJECT_POINT_LINE3','POINT_LINE_DISTANCE3'].includes(tag))return {origin:a,direction:b.every(v=>v===0)?[1,0,0]:b,point:c};
 if(tag==='POINT_PLANE_DISTANCE3')return {origin:a,normal:b.every(v=>v===0)?[1,0,0]:b,point:c};
 if(tag==='ANGLE_CLASS3')return {a:a.every(v=>v===0)?[1,0,0]:a,b:b.every(v=>v===0)?[0,1,0]:b};
 return x;
}
function ref(tag,x){const a=to(x.a??x.vector??x.origin??x.center??x.min??[0,0,0]),b=to(x.b??x.direction??x.normal??x.point??x.max??[0,0,0]),c=to(x.c??x.point??[0,0,0]),d=to(x.d??[0,0,0]);const v=sub(b,a),w=sub(c,a),h=sub(d,a),vol=determinant(v,w,h),cr=cross(v,w);
 switch(tag){
 case 'DOT3':return {value:String(dot(a,b))};
 case 'CROSS3':return {vector:cross(a,b).map(String)};
 case 'NORM_SQUARED3':return {value:String(norm(a))};
 case 'DISTANCE_SQUARED3':return {value:String(norm(sub(a,b)))};
 case 'SCALAR_TRIPLE3':return {value:String(determinant(a,b,c))};
 case 'TETRA_SIX_VOLUME3':return {sixTimesVolume:String(vol<0n?-vol:vol)};
 case 'ORIENTATION3':return {orientation:vol>0n?1:vol<0n?-1:0};
 case 'COLLINEAR3':return {collinear:norm(cr)===0n};
 case 'COPLANAR3':return {coplanar:vol===0n};
 case 'ORTHOGONAL3':return {orthogonal:dot(a,b)===0n};
 case 'PARALLEL3':return {parallel:norm(cross(a,b))===0n};
 case 'ANGLE_CLASS3':return {angle:dot(a,b)>0n?'ACUTE':dot(a,b)<0n?'OBTUSE':'RIGHT'};
 case 'TRIANGLE_AREA_SQUARED3':return {areaSquared:rat(norm(cr),4n)};
 case 'PARALLELOGRAM_AREA_SQUARED3':return {value:String(norm(cross(a,b)))};
 case 'BARYCENTRIC_TRIANGLE3':{const u=sub(b,a),v2=sub(c,a),q=sub(to(x.point),a),uu=dot(u,u),vv=dot(v2,v2),uv=dot(u,v2),den=uu*vv-uv*uv,beta=dot(q,u)*vv-dot(q,v2)*uv,gamma=dot(q,v2)*uu-dot(q,u)*uv,alpha=den-beta-gamma;return {onPlane:determinant(q,u,v2)===0n,inside:determinant(q,u,v2)===0n&&alpha>=0n&&beta>=0n&&gamma>=0n,weights:[rat(alpha,den),rat(beta,den),rat(gamma,den)]};}
 case 'MIDPOINT3':return {coordinates:coord(a.map((v,i)=>v+b[i]),2n)};
 case 'AFFINE_WEIGHTED3':{const u=BigInt(x.weightA),v2=BigInt(x.weightB);return {coordinates:coord(a.map((v,i)=>v*u+b[i]*v2),u+v2)};}
 case 'CENTROID3':{const p=x.points.map(to);return {coordinates:coord(seq(3).map(j=>sum(p.map(v=>v[j]))),BigInt(p.length))};}
 case 'BOUNDING_BOX3':{const p=x.points.map(to);return {min:seq(3).map(j=>String(p.reduce((s,v)=>v[j]<s?v[j]:s,p[0][j]))),max:seq(3).map(j=>String(p.reduce((s,v)=>v[j]>s?v[j]:s,p[0][j])))};}
 case 'BOX_INTERSECTION3':{const lo=x.left.min.map((v,i)=>Math.max(v,x.right.min[i])),hi=x.left.max.map((v,i)=>Math.min(v,x.right.max[i])),nonempty=lo.every((v,i)=>v<=hi[i]);return {nonempty,min:nonempty?lo.map(String):null,max:nonempty?hi.map(String):null};}
 case 'BOX_VOLUME3':return {value:String(seq(3).reduce((s,i)=>s*BigInt(x.max[i]-x.min[i]),1n))};
 case 'SPHERE_POINT3':{const squared=norm(sub(to(x.point),to(x.center))),r=BigInt(x.radiusSquared);return {relation:squared<r?'INSIDE':squared>r?'OUTSIDE':'BOUNDARY',distanceSquared:String(squared)};}
 case 'PROJECT_POINT_LINE3':{const origin=to(x.origin),direction=to(x.direction),delta=sub(to(x.point),origin),numerator=dot(delta,direction),denominator=norm(direction);return {parameter:rat(numerator,denominator),coordinates:coord(origin.map((v,i)=>v*denominator+direction[i]*numerator),denominator)};}
 case 'POINT_LINE_DISTANCE3':{const direction=to(x.direction),delta=sub(to(x.point),to(x.origin));return {distanceSquared:rat(norm(cross(delta,direction)),norm(direction))};}
 case 'POINT_PLANE_DISTANCE3':{const normal=to(x.normal),delta=sub(to(x.point),to(x.origin)),z=dot(normal,delta);return {distanceSquared:rat(z*z,norm(normal))};}
 default:throw Error('missing geometry reference '+tag);
 }
}
export const runGeometry438Bank=options=>runBatchBank({name:'AXIOMA integer 3D geometry determinant references 401–425',prefix:'MATH',start:401,tags,input,reference:ref,...options});
