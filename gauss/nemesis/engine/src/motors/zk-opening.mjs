import { createHash, getDiffieHellman, randomBytes } from 'node:crypto';
import { object, integer } from './shared.mjs';

// RFC 3526 MODP group 14 safe prime from Node/OpenSSL; QR subgroup has prime order q.
const P = BigInt(`0x${getDiffieHellman('modp14').getPrime('hex')}`);
const Q = (P - 1n) / 2n;
const G = 4n;
const BYTES = 256;
const pow = (base, exp) => {
  let out = 1n, b = base % P;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) out = out * b % P;
    b = b * b % P;
  }
  return out;
};
const hex = x => x.toString(16);
const bytes = n => Buffer.from(n.toString(16).padStart(BYTES * 2, '0'), 'hex');
// Hash to quadratic residues, without embedding a known discrete logarithm of H relative to G.
let hSeed = Buffer.alloc(0);
for (let c = 0; hSeed.length < BYTES; c++) hSeed = Buffer.concat([hSeed, createHash('sha512').update(`nemesis:zk:second-generator:v1:${c}`).digest()]);
const H = pow(BigInt(`0x${hSeed.toString('hex')}`) % P, 2n);
if (H === 1n || H === G || pow(H, Q) !== 1n) throw new Error('invalid Pedersen group generator');
function parseScalar(value, name, { nonzero = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9a-f][0-9a-f]{0,511})$/.test(value)) throw new TypeError(`${name} must be canonical hexadecimal scalar`);
  const x = BigInt(`0x${value}`);
  if (x >= Q || (nonzero && x === 0n)) throw new TypeError(`${name} outside subgroup order`);
  return x;
}
function parseElement(value, name) {
  if (typeof value !== 'string' || !/^[1-9a-f][0-9a-f]{0,511}$/.test(value)) throw new TypeError(`${name} must be canonical hexadecimal element`);
  const x = BigInt(`0x${value}`);
  if (x <= 0n || x >= P || pow(x, Q) !== 1n) throw new TypeError(`${name} not in selected subgroup`);
  return x;
}
function randomScalar() {
  for (let i = 0; i < 100; i++) {
    const n = BigInt(`0x${randomBytes(BYTES).toString('hex')}`);
    if (n > 0n && n < Q) return n;
  }
  throw new Error('secure random sampling failed');
}
function challenge(C, T) {
  return BigInt(`0x${createHash('sha256').update('NEMESIS_PEDERSEN_OPENING_FS_V1\0').update(bytes(G))
    .update(bytes(H)).update(bytes(C)).update(bytes(T)).digest('hex')}`) % Q;
}
function committed(v, r) { return pow(G, v) * pow(H, r) % P; }
export const PUBLIC_ZK_GROUP = Object.freeze({ id: 'RFC3526_MODP14_QR_PEDERSEN_V1', p: hex(P), q: hex(Q), g: hex(G), h: hex(H) });

/** Creates a hiding Pedersen commitment. The opening must be kept secret, never published. */
export function createPedersenCommitment(value) {
  const v = BigInt(integer(value, 'value', 0, 1_000_000_000));
  const r = randomScalar();
  return { group: PUBLIC_ZK_GROUP.id, commitment: hex(committed(v, r)), opening: { value: hex(v), blind: hex(r) } };
}
/** Fiat–Shamir proof of knowledge of an opening; NOT a range proof or proof of a particular program. */
export function provePedersenOpening(commitment, opening) {
  const C = parseElement(commitment, 'commitment');
  object(opening, 'opening', ['value', 'blind']);
  const v = parseScalar(opening.value, 'opening.value');
  const r = parseScalar(opening.blind, 'opening.blind', { nonzero: true });
  if (committed(v, r) !== C) throw new TypeError('opening does not match commitment');
  const kv = randomScalar(), kr = randomScalar();
  const T = committed(kv, kr), c = challenge(C, T);
  return { group: PUBLIC_ZK_GROUP.id, t: hex(T), zValue: hex((kv + c * v) % Q), zBlind: hex((kr + c * r) % Q) };
}
export function verifyPedersenOpening(commitment, proof) {
  const C = parseElement(commitment, 'commitment');
  object(proof, 'proof', ['group', 't', 'zValue', 'zBlind']);
  if (proof.group !== PUBLIC_ZK_GROUP.id) throw new TypeError('wrong group');
  const T = parseElement(proof.t, 'proof.t');
  const zv = parseScalar(proof.zValue, 'proof.zValue'), zr = parseScalar(proof.zBlind, 'proof.zBlind');
  const c = challenge(C, T);
  return committed(zv, zr) === T * pow(C, c) % P;
}
/** CLI envelope; commit/prove are PRIVATE operations; only verify has public-only inputs. */
export function runOpeningProof(input) {
  object(input, 'ZK input', ['action', 'value', 'commitment', 'opening', 'proof'], ['action']);
  if (input.action === 'commit') {
    if (Object.keys(input).length !== 2) throw new TypeError('commit requires value only');
    return { engine: 'NEMESIS_PEDERSEN_OPENING_V1', ...createPedersenCommitment(input.value), warning: 'PRIVATE opening: do not publish or log this response.' };
  }
  if (input.action === 'prove') {
    if (Object.keys(input).length !== 3) throw new TypeError('prove requires commitment and opening');
    return { engine: 'NEMESIS_PEDERSEN_OPENING_V1', proof: provePedersenOpening(input.commitment, input.opening) };
  }
  if (input.action === 'verify') {
    if (Object.keys(input).length !== 3) throw new TypeError('verify requires commitment and proof');
    return { engine: 'NEMESIS_PEDERSEN_OPENING_V1', verified: verifyPedersenOpening(input.commitment, input.proof),
      statement: 'Knowledge of a Pedersen opening under discrete-log / Fiat–Shamir assumptions; no range proof or claim about external code.' };
  }
  throw new TypeError('action must be commit, prove or verify');
}
