import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const VALID_DIGEST = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') &&
    !isAbsolute(path) && !path.startsWith('/') && posix.normalize(path) === path &&
    path.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function boundedFile(root, path, limit) {
  if (!safePath(path)) throw new Error('Unsafe repository-relative path');
  const file = resolve(root, path);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) {
    throw new Error('Not a bounded regular file');
  }
  const realRoot = await realpath(root);
  const realFile = await realpath(file);
  const inside = relative(realRoot, realFile);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('Path escapes checkout');
  }
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error('File exceeds bound');
  return bytes;
}

// An independent byte check: verify the actual registered file contents instead
// of trusting a reported hash. This does not authenticate workflow provenance.
export async function verifyAuditSource({ root, audit }) {
  const findings = [];
  const fail = (code, detail) => findings.push({ code, detail });
  if (!audit || typeof audit !== 'object' || !VALID_DIGEST.test(audit.manifestSha256) ||
      !Array.isArray(audit.nodes) || audit.nodes.length < 1 || audit.nodes.length > 2048) {
    return { status: 'MISMATCH', verifiedNodes: 0, findings: [{ code: 'INVALID_SOURCE_REPORT', detail: 'manifest or nodes' }] };
  }
  let registry;
  try {
    const manifest = await boundedFile(root, 'forja/registry.json', 512 * 1024);
    if (digest(manifest) !== audit.manifestSha256) fail('MANIFEST_BYTES_MISMATCH', 'forja/registry.json');
    registry = JSON.parse(manifest.toString('utf8'));
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.nodes) || registry.nodes.length !== audit.nodes.length) {
      fail('REGISTRY_NODE_SET_MISMATCH', 'different number or version');
      registry = null;
    }
  } catch (cause) {
    fail('MANIFEST_UNAVAILABLE', String(cause?.message ?? cause));
  }
  let verifiedNodes = 0;
  if (registry) {
    const expected = new Map();
    const expectedPaths = new Set();
    for (const node of registry.nodes) {
      if (!node || typeof node.id !== 'string' || expected.has(node.id) || !safePath(node.path) ||
          expectedPaths.has(node.path)) {
        fail('REGISTRY_NODE_SET_MISMATCH', 'invalid or duplicate node or path');
        continue;
      }
      expected.set(node.id, node.path);
      expectedPaths.add(node.path);
    }
    const seen = new Set();
    for (const node of audit.nodes) {
      if (!node || typeof node.id !== 'string' || seen.has(node.id) || expected.get(node.id) !== node.path ||
          !VALID_DIGEST.test(node.sha256)) {
        fail('REPORTED_NODE_MISMATCH', node?.id ?? null);
        continue;
      }
      seen.add(node.id);
      try {
        const bytes = await boundedFile(root, node.path, MAX_SOURCE_BYTES);
        if (digest(bytes) !== node.sha256) fail('SOURCE_BYTES_MISMATCH', node.id);
        else verifiedNodes += 1;
      } catch (cause) {
        fail('SOURCE_UNAVAILABLE', { id: node.id, reason: String(cause?.message ?? cause) });
      }
    }
    if (seen.size !== expected.size) fail('REGISTRY_NODE_SET_MISMATCH', 'reported nodes omit registry entries');
  }
  return { status: findings.length ? 'MISMATCH' : 'MATCH', verifiedNodes, findings };
}
