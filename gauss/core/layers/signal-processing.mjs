// Deterministic, bounded discrete signal operators. Numerical output is always JSON finite.
const fail = message => { throw new TypeError(message); };
const object = (x, keys) => {
  if (!x || typeof x !== 'object' || Array.isArray(x) ||
      Object.keys(x).sort().join('|') !== [...keys].sort().join('|')) fail(`expected exactly ${keys.join(',')}`);
  return x;
};
const number = (x, label, bound = 10000) => {
  if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > bound) fail(`${label} must be finite and bounded`);
  return x;
};
const integer = (x, label, min, max) => {
  if (!Number.isSafeInteger(x) || x < min || x > max) fail(`${label} must be integer in [${min},${max}]`);
  return x;
};
const vector = (x, label, max = 64, min = 1) => {
  if (!Array.isArray(x) || x.length < min || x.length > max) fail(`${label} length outside [${min},${max}]`);
  return x.map((v, i) => number(v, `${label}[${i}]`));
};
const checked = x => { if (!Number.isFinite(x)) fail('non-finite numerical result'); return x; };
const freeze = x => Object.freeze(x);
const complex = (real, imaginary) => freeze({real:freeze(real.map(checked)), imaginary:freeze(imaginary.map(checked))});
function transform(real, imaginary, sign) {
  const n = real.length, re = [], im = [];
  for (let k = 0; k < n; k++) {
    let r = 0, i = 0;
    for (let j = 0; j < n; j++) {
      const angle = sign * 2 * Math.PI * j * k / n, c = Math.cos(angle), s = Math.sin(angle);
      r += real[j] * c - imaginary[j] * s;
      i += real[j] * s + imaginary[j] * c;
    }
    re.push(r / (sign === 1 ? n : 1)); im.push(i / (sign === 1 ? n : 1));
  }
  return complex(re, im);
}
export function directDiscreteFourier(input) {
  object(input, ['real','imaginary']);
  const r = vector(input.real, 'real'), i = vector(input.imaginary, 'imaginary');
  if (r.length !== i.length) fail('complex vectors must have equal length');
  return transform(r, i, -1);
}
export function inverseDiscreteFourier(input) {
  object(input, ['real','imaginary']);
  const r = vector(input.real, 'real'), i = vector(input.imaginary, 'imaginary');
  if (r.length !== i.length) fail('complex vectors must have equal length');
  return transform(r, i, 1);
}
export function linearConvolution(input) {
  object(input, ['left','right']); const a = vector(input.left, 'left'), b = vector(input.right, 'right');
  const out = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return freeze({samples:freeze(out.map(checked))});
}
export function circularConvolution(input) {
  object(input, ['left','right']); const a = vector(input.left, 'left'), b = vector(input.right, 'right');
  if (a.length !== b.length) fail('circular convolution requires equal lengths');
  const n = a.length, out = Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[(i + j) % n] += a[i] * b[j];
  return freeze({samples:freeze(out.map(checked))});
}
export function linearCrossCorrelation(input) {
  object(input, ['left','right']); const a = vector(input.left, 'left'), b = vector(input.right, 'right');
  const lags = [], values = [];
  for (let lag = -b.length + 1; lag < a.length; lag++) {
    let sum = 0; for (let j = 0; j < b.length; j++) if (j + lag >= 0 && j + lag < a.length) sum += a[j + lag] * b[j];
    lags.push(lag); values.push(checked(sum));
  }
  return freeze({lags:freeze(lags), values:freeze(values)});
}
export function sampleAutocovariance(input) {
  object(input, ['samples','maxLag']); const a = vector(input.samples, 'samples', 128, 2);
  const maxLag = integer(input.maxLag, 'maxLag', 0, a.length - 1), mean = a.reduce((s,x)=>s+x,0)/a.length;
  const values=[]; for(let lag=0;lag<=maxLag;lag++){
    let sum=0; for(let i=0;i<a.length-lag;i++) sum+=(a[i]-mean)*(a[i+lag]-mean);
    values.push(checked(sum/a.length));
  }
  return freeze({mean:checked(mean), covariance:freeze(values)});
}
export function finiteImpulseResponse(input) {
  object(input, ['samples','taps']); const x=vector(input.samples,'samples',128), h=vector(input.taps,'taps',64);
  const out=x.map((_,t)=>{let value=0;for(let j=0;j<h.length;j++)if(t>=j)value+=h[j]*x[t-j];return checked(value);});
  return freeze({samples:freeze(out)});
}
export function firstOrderInfiniteImpulseResponse(input) {
  object(input, ['samples','feedforward','feedback','initial']);
  const x=vector(input.samples,'samples',128), b=number(input.feedforward,'feedforward',1), a=number(input.feedback,'feedback',0.999999), initial=number(input.initial,'initial');
  let previous=initial;const out=x.map(v=>{previous=checked(b*v+a*previous);return previous;});
  return freeze({samples:freeze(out), finalState:previous});
}
export function shortTimeFourier(input) {
  object(input, ['samples','window','hop']);const x=vector(input.samples,'samples',128);
  const window=integer(input.window,'window',2,32),hop=integer(input.hop,'hop',1,window);
  if(window>x.length)fail('window must fit in samples');
  const frames=[];for(let offset=0;offset+window<=x.length;offset+=hop){
    const frame=x.slice(offset,offset+window).map((v,j)=>v*(0.5-0.5*Math.cos(2*Math.PI*j/(window-1))));
    frames.push(freeze({offset,...transform(frame,Array(window).fill(0),-1)}));
  }
  return freeze({frames:freeze(frames), window, hop});
}
export function powerPeriodogram(input) {
  object(input, ['samples','samplingRate']);const x=vector(input.samples,'samples',128),rate=number(input.samplingRate,'samplingRate',100000);
  if(rate<=0)fail('samplingRate must be positive');
  const t=transform(x,Array(x.length).fill(0),-1),frequencies=[],power=[];
  for(let k=0;k<=Math.floor(x.length/2);k++){
    frequencies.push(checked(k*rate/x.length));
    power.push(checked((t.real[k]**2+t.imaginary[k]**2)/x.length));
  }
  return freeze({frequencies:freeze(frequencies),power:freeze(power)});
}
export function goertzelFrequencyBin(input) {
  object(input, ['samples','bin']);const x=vector(input.samples,'samples',128),k=integer(input.bin,'bin',0,x.length-1);
  const omega=2*Math.PI*k/x.length,coefficient=2*Math.cos(omega);
  let a=0,b=0;for(const v of x){const next=v+coefficient*a-b;b=a;a=next;}
  const r=a-b*Math.cos(omega),i=b*Math.sin(omega),phase=(x.length-1)*omega;
  const real=checked(r*Math.cos(phase)+i*Math.sin(phase));
  const imaginary=checked(i*Math.cos(phase)-r*Math.sin(phase));
  return freeze({real,imaginary,magnitudeSquared:checked(real**2+imaginary**2)});
}
export function orthonormalHaarTransform(input) {
  object(input,['samples']);const x=vector(input.samples,'samples',128),n=x.length;
  if((n&(n-1))!==0||n<2)fail('Haar transform requires power-of-two length >= 2');
  const coefficients=x.slice(),scale=1/Math.sqrt(2);
  for(let width=n;width>1;width/=2){const next=[];for(let j=0;j<width;j+=2)next.push((coefficients[j]+coefficients[j+1])*scale);
    for(let j=0;j<width;j+=2)next.push((coefficients[j]-coefficients[j+1])*scale);
    for(let j=0;j<width;j++)coefficients[j]=checked(next[j]);
  }
  return freeze({coefficients:freeze(coefficients)});
}
