/**
 * Némesis #81: real SQIsign NIST-API transport, not a home-made isogeny signature.
 * The executable is compiled from pinned SQIsign source, independently SHA-256
 * pinned by the caller, and copied to a private directory before execution.
 * No network access is needed at runtime; source provenance and third-party
 * implementation must be reviewed separately. Not a production certification.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_BINARY = fileURLToPath(new URL('./native/isogeny81/bin/nexus81_p324_3', import.meta.url));
const PK_BYTES = 83;
const SK_BYTES = 270;
const SIGNATURE_BYTES = 200;
const MAX_MESSAGE_BYTES = 65536;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fields(value, allowed, required) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('motor 81: expected a plain object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`motor 81: unexpected ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`motor 81: missing ${key}`);
}

function decode(value, name, requiredLength) {
  if (typeof value !== 'string' || value.length > 90000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new TypeError(`motor 81: invalid ${name} base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > MAX_MESSAGE_BYTES ||
      (requiredLength !== undefined && bytes.length !== requiredLength)) {
    bytes.fill(0);
    throw new TypeError(`motor 81: invalid ${name} length or encoding`);
  }
  return bytes;
}

function invoke(binary, pin, mode, stdin, expectedLength) {
  if (typeof binary !== 'string' || !binary || Array.from(binary).some(c => c.charCodeAt(0) < 32))
    throw new TypeError('motor 81: invalid executable path');
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin))
    throw new TypeError('motor 81: a trusted expectedBinarySha256 is required');
  let bytes;
  try { bytes = readFileSync(resolve(binary)); }
  catch { throw new Error('NEMESIS_81_NATIVE_BINARY_MISSING'); }
  if (bytes.length > 128 * 1024 * 1024) throw new Error('NEMESIS_81_NATIVE_BINARY_TOO_LARGE');
  const digest = hash(bytes);
  if (digest !== pin) throw new Error('NEMESIS_81_BINARY_PIN_MISMATCH');
  const dir = mkdtempSync(join(tmpdir(), 'gauss-nemesis81-'));
  try {
    const path = join(dir, 'nexus81');
    writeFileSync(path, bytes, {mode: 0o700, flag: 'wx'});
    const proc = spawnSync(path, [mode], {input: stdin, encoding: null, shell: false, windowsHide: true,
      timeout: 300000, maxBuffer: 1024 * 1024});
    // NEVER surface stdout/stderr or OS exceptions: a malicious backend could echo the secret key.
    if (proc.error || proc.status !== 0) throw new Error('NEMESIS_81_NATIVE_EXECUTION_FAILED');
    if (!Buffer.isBuffer(proc.stdout) || proc.stdout.length !== expectedLength)
      throw new Error('NEMESIS_81_NATIVE_RESPONSE_LENGTH_MISMATCH');
    if (mode === '--verify' && proc.stdout[0] !== 0 && proc.stdout[0] !== 1)
      throw new Error('NEMESIS_81_NATIVE_INVALID_VERDICT');
    return {bytes: proc.stdout, binarySha256: digest};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

/** Only SQIsign p324_3. Keys and signatures use canonical base64; messages are raw bytes in base64. */
export function runGaussNemesis81Signature(input) {
  fields(input,
    ['action', 'binary', 'expectedBinarySha256', 'messageBase64', 'secretKeyBase64', 'publicKeyBase64', 'signatureBase64'],
    ['action', 'expectedBinarySha256']);
  const binary = input.binary ?? DEFAULT_BINARY;
  const pin = input.expectedBinarySha256;
  if (input.action === 'sqisign-keygen') {
    fields(input, ['action', 'binary', 'expectedBinarySha256'], ['action', 'expectedBinarySha256']);
    const result = invoke(binary, pin, '--keygen', Buffer.alloc(0), PK_BYTES + SK_BYTES);
    try { return {domain: 'SQISIGN_P324_3_NATIVE', publicKeyBase64: result.bytes.subarray(0, PK_BYTES).toString('base64'),
      secretKeyBase64: result.bytes.subarray(PK_BYTES).toString('base64'), binarySha256: result.binarySha256}; }
    finally { result.bytes.fill(0); }
  }
  if (input.action === 'sqisign-sign') {
    fields(input, ['action', 'binary', 'expectedBinarySha256', 'secretKeyBase64', 'messageBase64'],
      ['action', 'expectedBinarySha256', 'secretKeyBase64', 'messageBase64']);
    const key = decode(input.secretKeyBase64, 'secret key', SK_BYTES);
    let message, payload;
    try {
      message = decode(input.messageBase64, 'message');
      payload = Buffer.concat([key, message]);
      const result = invoke(binary, pin, '--sign', payload, SIGNATURE_BYTES);
      return {domain: 'SQISIGN_P324_3_NATIVE', signatureBase64: result.bytes.toString('base64'),
        binarySha256: result.binarySha256};
    } finally { payload?.fill(0); message?.fill(0); key.fill(0); }
  }
  if (input.action === 'sqisign-verify') {
    fields(input, ['action', 'binary', 'expectedBinarySha256', 'publicKeyBase64', 'signatureBase64', 'messageBase64'],
      ['action', 'expectedBinarySha256', 'publicKeyBase64', 'signatureBase64', 'messageBase64']);
    const publicKey = decode(input.publicKeyBase64, 'public key', PK_BYTES);
    const signature = decode(input.signatureBase64, 'signature', SIGNATURE_BYTES);
    const message = decode(input.messageBase64, 'message');
    const result = invoke(binary, pin, '--verify', Buffer.concat([publicKey, signature, message]), 1);
    return {domain: 'SQISIGN_P324_3_NATIVE', verified: result.bytes[0] === 1,
      binarySha256: result.binarySha256};
  }
  throw new TypeError('motor 81: unsupported signature action');
}
