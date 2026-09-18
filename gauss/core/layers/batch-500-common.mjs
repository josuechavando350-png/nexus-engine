// Independent, dependency-free bounded input and output contracts.
export function keys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort()))
    throw new TypeError(`expected exactly: ${names.join(',')}`);
  return value;
}
export function integer(value, label, lo = -1000000, hi = 1000000) {
  if (!Number.isSafeInteger(value) || value < lo || value > hi) throw new RangeError(`${label}: bounded safe integer required`);
  return value;
}
export function finite(value, label, lo = -1e6, hi = 1e6) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) throw new RangeError(`${label}: bounded finite number required`);
  return value;
}
export function array(value, label, min = 0, max = 1000) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${label}: bounded array required`);
  return value;
}
export function vector(value, label, size = 3, bound = 1e5) {
  return array(value,label,size,size).map((v,i)=>integer(v,`${label}[${i}]`,-bound,bound));
}
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function out(obj) { return freeze(obj); }
export function gcd(a,b) { a=a<0n?-a:a;b=b<0n?-b:b;while(b){[a,b]=[b,a%b];}return a; }
export function rat(n,d=1n) {
  if(d===0n)throw new RangeError('zero rational denominator');
  if(d<0n){n=-n;d=-d;}const g=gcd(n,d);
  return {numerator:String(n/g),denominator:String(d/g)};
}
export function asBig(v){return BigInt(v);}
export function bit(value,label){return integer(value,label,0,1);}
export function bits(value,label='bits',lo=0,hi=256){return array(value,label,lo,hi).map((b,i)=>bit(b,`${label}[${i}]`));}
export function matrix2(value,label='matrix',maxRows=16,maxCols=16){
  const rows=array(value,label,1,maxRows),cols=array(rows[0],`${label}[0]`,1,maxCols).length;
  return rows.map((r,i)=>array(r,`${label}[${i}]`,cols,cols).map((v,j)=>bit(v,`${label}[${i}][${j}]`)));
}
export function tuple(defs,prefix,domain) {
  return Object.freeze(defs.map(([name,description,execute,input],i)=>Object.freeze({
    id:`GAUSS.${prefix}.${name}.${401+i}`,domain,description,execute,input:freeze(input)
  })));
}
