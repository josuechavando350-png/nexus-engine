/* Independent, bounded, deterministic number-theory references. Do not import GAUSS implementations or fixture answers. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS, getGaussLayer} from '../core/registry.mjs';

const SEED = 0x51a91e3;
const CASES = 100;
const ID = name => `GAUSS.MATH.${name}`;
const mod = (a, m) => ((a % m) + m) % m;
function gcd(a, b) { while (b !== 0) [a, b] = [b, a % b]; return Math.abs(a); }
function divisors(n) { const found = []; for (let d = 1; d <= n; d++) if (n % d === 0) found.push(d); return found; }
function mu(n) { let square = false, distinct = 0, remainder = n; for (let p = 2; p <= remainder; p++) { if (remainder % p !== 0) continue; let copies = 0; while (remainder % p === 0) { copies++; remainder /= p; } if (copies > 1) square = true; distinct++; } return square ? 0 : distinct % 2 ? -1 : 1; }
function primeFactors(n) { const out = []; for (let p = 2; p <= n; p++) while (n % p === 0) { out.push(p); n /= p; } return out; }
function jacobiByResidues(a, n) { let value = 1; for (const p of primeFactors(n)) { const residue = mod(a, p); if (residue === 0) return 0; let found = false; for (let x = 1; x < p; x++) if ((x * x) % p === residue) { found = true; break; } value *= found ? 1 : -1; } return value; }
function order(a, m) { let power = 1n; for (let k = 1; k <= m; k++) { power = power * BigInt(mod(a, m)) % BigInt(m); if (power === 1n) return k; } throw Error('reference order absent'); }
function logarithm(base, target, prime) { let power = 1n; for (let x = 0; x < prime - 1; x++) { if (power === BigInt(mod(target, prime))) return {exponent:x, exists:true}; power = power * BigInt(mod(base, prime)) % BigInt(prime); } return {exponent:null, exists:false}; }
function farey(n) { const fractions = []; for (let b = 1; b <= n; b++) for (let a = 0; a <= b; a++) if (gcd(a, b) === 1) fractions.push([a,b]); fractions.sort((a,b) => a[0]*b[1]-b[0]*a[1]); return {fractions, length: fractions.length}; }
function triples(limit) { const result = []; for (let a = 1; a <= limit; a++) for (let b = a+1; b <= limit; b++) { const c = Math.sqrt(a*a+b*b); if (Number.isInteger(c) && c <= limit && gcd(a,b) === 1) result.push([a,b,c]); } result.sort((a,b) => a[2]-b[2] || a[0]-b[0]); return {triples:result}; }
function rng(seed) { let state = seed >>> 0; return max => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; }; }
const samples = [1,2,4,6,12,30,49,60,97,360,997];
const nCase = (i,r) => i < samples.length ? samples[i] : 1 + r(1000);
const primes = [2,3,5,7,11,13,17,19,23,29];
const odd = [3,5,7,9,11,15,21,25,27,35,45,49,77,99];
const arithmetic = (i,r) => ({n:nCase(i,r)});
const definitions = [
  {id:ID('MOBIUS_FUNCTION.047'), make:arithmetic, reference:({n})=>({mu:mu(n)}), bad: {n:0}},
  {id:ID('DIVISOR_SUM.048'), make:arithmetic, reference:({n})=>({sum:divisors(n).reduce((s,d)=>s+BigInt(d),0n).toString()}), bad: {n:0}},
  {id:ID('DIVISOR_COUNT.049'), make:arithmetic, reference:({n})=>({count:divisors(n).length}), bad: {n:0}},
  {id:ID('MULTIPLICATIVE_ORDER.050'), make:(i,r)=>{const modulus=2+r(39); let base=r(201)-100; while(gcd(base,modulus)!==1) base++; return {base,modulus};}, reference:({base,modulus})=>({order:order(base,modulus)}), bad:{base:2,modulus:1}},
  {id:ID('DISCRETE_LOG_PRIME.051'), make:(i,r)=>{const prime=primes[r(primes.length)]; return {base:1+r(prime-1),target:r(prime),prime};}, reference:({base,target,prime})=>logarithm(base,target,prime), bad:{base:2,target:1,prime:4}},
  {id:ID('JACOBI_SYMBOL.052'), make:(i,r)=>({numerator:r(1001)-500,denominator:odd[r(odd.length)]}), reference:({numerator,denominator})=>({symbol:jacobiByResidues(numerator,denominator)}), bad:{numerator:1,denominator:2}},
  {id:ID('MODULAR_SQRT_PRIME.053'), make:(i,r)=>({value:r(501)-250,prime:primes[r(primes.length)]}), reference:({value,prime})=>{const roots=[]; for(let x=0;x<prime;x++) if(BigInt(x)*BigInt(x)%BigInt(prime)===BigInt(mod(value,prime))) roots.push(x); return {roots,hasRoot:roots.length>0};}, bad:{value:1,prime:4}},
  {id:ID('LINEAR_CONGRUENCE.054'), make:(i,r)=>({a:r(201)-100,b:r(201)-100,modulus:2+r(40)}), reference:({a,b,modulus})=>{const solutions=[]; for(let x=0;x<modulus;x++) if(mod(a*x-b,modulus)===0) solutions.push(x); return {solutions,solvable:solutions.length>0};}, bad:{a:1,b:2,modulus:1}},
  {id:ID('LINEAR_DIOPHANTINE.055'), make:(i,r)=>({a:i===0?0:r(201)-100,b:i===0?1:r(201)-100,c:r(201)-100}), reference:({a,b,c})=>({solvable:c%gcd(a,b)===0,gcd:String(gcd(a,b))}), bad:{a:0,b:0,c:1}, witness:true},
  {id:ID('FAREY_SEQUENCE.057'), make:(i,r)=>({order:1+r(16)}), reference:({order})=>farey(order), bad:{order:0}},
  {id:ID('PRIMITIVE_PYTHAGOREAN_TRIPLES.058'), make:(i,r)=>({maxHypotenuse:5+r(56)}), reference:({maxHypotenuse})=>triples(maxHypotenuse), bad:{maxHypotenuse:4}},
];
function verifyWitness(input, expected, actual) {
  assert.deepStrictEqual(Object.keys(actual).sort(), ['gcd','solvable','x','y']);
  assert.equal(actual.gcd,expected.gcd);
  assert.equal(actual.solvable,expected.solvable);
  if (!expected.solvable) { assert.equal(actual.x,null); assert.equal(actual.y,null); return; }
  assert.equal(typeof actual.x,'string'); assert.equal(typeof actual.y,'string');
  assert.equal(BigInt(input.a)*BigInt(actual.x)+BigInt(input.b)*BigInt(actual.y),BigInt(input.c));
}
export function runNumberTheoryBank({resolveLayer=getGaussLayer}={}) {
  assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
  assert.equal(new Set(definitions.map(d=>d.id)).size,definitions.length);
  const report={schemaVersion:1,subject:'GAUSS bounded exact number theory',seed:`0x${SEED.toString(16)}`,oracle:'independent divisor enumeration, residue enumeration, BigInt modular powers and brute-force integer witnesses',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
  const hash=createHash('sha256');
  for(const definition of definitions) {
    const layer=resolveLayer(definition.id);
    assert.equal(typeof layer?.execute,'function',`missing GAUSS operator ${definition.id}`);
    const r=rng(Number.parseInt(createHash('sha256').update(definition.id).digest('hex').slice(0,8),16)^SEED);
    const item={id:definition.id,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
    for(let index=0;index<CASES;index++) {
      let input=definition.make(index,r);
      if(definition.witness && input.a===0 && input.b===0) input={...input,b:1};
      const expected=definition.reference(input);
      hash.update(JSON.stringify({id:definition.id,index,input,expected}));
      item.validCases++; report.validCases++;
      let actual;
      try { actual=layer.execute(structuredClone(input)); if(definition.witness) verifyWitness(input,expected,actual); else assert.deepStrictEqual(actual,expected); item.passed++; report.passedValidCases++; }
      catch(error) { item.failed++; report.failedValidCases++; if(report.failures.length<20) report.failures.push({id:definition.id,index,input,expected,actual:actual??null,reason:String(error)}); }
      if(index===0) {
        const first=Object.keys(input)[0];
        const invalid=[{...input,unexpected:true},{...input,[first]:1.5},definition.bad];
        for(const [invalidIndex, bad] of invalid.entries()) {
          item.invalidCases++; report.invalidCases++;
          try { const output=layer.execute(structuredClone(bad)); item.invalidAccepted++; report.failedInvalidRejections++; if(report.failures.length<20) report.failures.push({id:definition.id,index:`invalid-${invalidIndex}`,input:bad,expected:'rejection',actual:output,reason:'invalid input accepted'}); }
          catch { item.rejected++; report.passedInvalidRejections++; }
        }
      }
    }
    report.coveredOperators++; report.operatorResults.push(item);
  }
  report.untestedOperators=1000-report.coveredOperators;
  report.caseDigest=`sha256:${hash.digest('hex')}`;
  report.validPassRate=report.passedValidCases/report.validCases;
  report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;
  return report;
}
