// Exact degree-2 Vélu isogeny over an explicitly small prime field.
// This is a mathematical primitive, NOT an isogeny-based signature scheme.
function integer(x, name, max=1009) {
  if (!Number.isSafeInteger(x) || x < 0 || x > max) throw new TypeError(`${name} must be integer in [0, ${max}]`);
  return x;
}
function prime(n) {
  if(n < 3 || n % 2 === 0) return false;
  for(let d=3; d*d<=n; d+=2) if(n%d===0) return false;
  return true;
}
function field(p) {
  const m=x=>((x%p)+p)%p;
  const pow=(x,k)=>{let a=m(x),r=1;for(;k>0;k=Math.floor(k/2),a=m(a*a))if(k%2)r=m(r*a);return r;};
  const inv=x=>{if(m(x)===0)throw new RangeError('inverse of zero');return pow(x,p-2);};
  return {m,inv};
}
function eq(P,Q){return P===null?Q===null:Q!==null&&P.x===Q.x&&P.y===Q.y;}
function add(P,Q,a,f) {
  if(P===null)return Q;
  if(Q===null)return P;
  const {m,inv}=f;
  if(P.x===Q.x && m(P.y+Q.y)===0)return null;
  const slope=eq(P,Q)?m((3*P.x*P.x+a)*inv(2*P.y)):m((Q.y-P.y)*inv(Q.x-P.x));
  const x=m(slope*slope-P.x-Q.x),y=m(slope*(P.x-x)-P.y);
  return {x,y};
}
/** 2-isogeny with kernel {O,(kernelX,0)}, over F_p, p <= 1009. */
export function evaluateTwoIsogeny(input){
  if(input===null||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['p','a','b','kernelX','points'].includes(k)))throw new TypeError('expected {p,a,b,kernelX,points}');
  const p=integer(input.p,'p'); if(!prime(p)||p===3)throw new TypeError('p must be an odd prime >= 5');
  const a=integer(input.a,'a',p-1),b=integer(input.b,'b',p-1),r=integer(input.kernelX,'kernelX',p-1);
  const {m}=field(p),f=field(p);
  if(m(4*a*a*a+27*b*b)===0)throw new TypeError('singular source curve');
  if(m(r*r*r+a*r+b)!==0)throw new TypeError('kernelX must be a rational 2-torsion point');
  if(!Array.isArray(input.points)||input.points.length>128)throw new TypeError('points must be an array <=128');
  const a2=m(a-5*(3*r*r+a)),b2=m(b-7*(5*r*r*r+3*a*r+2*b));
  if(m(4*a2*a2*a2+27*b2*b2)===0)throw new Error('invalid Vélu codomain');
  const K={x:r,y:0};
  const mapped=input.points.map((P,i)=>{
    if(P===null)return null;
    if(P===null||typeof P!=='object'||Array.isArray(P)||Object.keys(P).sort().join(',')!=='x,y')throw new TypeError(`points[${i}] must be {x,y} or null`);
    const x=integer(P.x,`points[${i}].x`,p-1),y=integer(P.y,`points[${i}].y`,p-1);
    if(m(y*y-x*x*x-a*x-b)!==0)throw new TypeError(`points[${i}] not on source curve`);
    if(eq(P,K))return null;
    const S=add(P,K,a,f),image={x:m(x+S.x-r),y:m(y+S.y)};
    if(m(image.y*image.y-image.x**3-a2*image.x-b2)!==0)throw new Error('isogeny image invalid');
    return image;
  });
  return {domain:'VELU_DEGREE_2_SMALL_PRIME_FIELD_NOT_SIGNATURE',source:{p,a,b},target:{p,a:a2,b:b2},kernel:{x:r,y:0},images:mapped,warning:'Finite-field 2-isogeny arithmetic only; no signing, verification, post-quantum security or production use.'};
}
