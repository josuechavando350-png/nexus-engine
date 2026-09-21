#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMITS = Object.freeze({ manifest: 524288, source: 2097152, nodes: 2048, links: 8192 });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const error = (code, detail) => ({ code, detail });

function pathInRepo(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') ||
    isAbsolute(path) || path.startsWith('/') || posix.normalize(path) !== path ||
    path.split('/').some((part) => part === '.' || part === '..' || !part)) {
    throw new Error(`Invalid repository-relative path: ${String(path)}`);
  }
  return path;
}

async function boundedFile(root, rootReal, path, limit) {
  const target = resolve(root, pathInRepo(path));
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit) {
    throw new Error('Not a bounded regular file');
  }
  const actual = await realpath(target);
  const inside = relative(rootReal, actual);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Path escapes repository');
  const contents = await readFile(target);
  if (contents.length > limit) throw new Error('File exceeds byte limit');
  return contents;
}

function validateRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
    !Array.isArray(value.nodes) || !Array.isArray(value.links) || !Array.isArray(value.roots) ||
    value.nodes.length === 0 || value.nodes.length > LIMITS.nodes || value.links.length > LIMITS.links ||
    value.roots.length === 0) throw new Error('Invalid FORJA registry schema or limits');
  const ids = new Set();
  const paths = new Set();
  for (const node of value.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(node.id) || ids.has(node.id)) {
      throw new Error('Invalid or duplicate node id');
    }
    ids.add(node.id);
    pathInRepo(node.path);
    if (paths.has(node.path) || !['esm', 'shell'].includes(node.kind)) throw new Error('Duplicate path or unsupported node kind');
    paths.add(node.path);
  }
  for (const id of value.roots) if (!ids.has(id)) throw new Error(`Unknown root: ${id}`);
  if (new Set(value.roots).size !== value.roots.length) throw new Error('Duplicate roots');
  const links = new Set();
  for (const link of value.links) {
    if (!link || !ids.has(link.from) || !ids.has(link.to) || !['esm-static-import', 'shell-node-exec'].includes(link.method)) {
      throw new Error('Invalid link or unsupported evidence method');
    }
    const key = `${link.from}\0${link.to}\0${link.method}`;
    if (links.has(key)) throw new Error('Duplicate link');
    links.add(key);
    const from = value.nodes.find((node) => node.id === link.from);
    const to = value.nodes.find((node) => node.id === link.to);
    if (link.method === 'esm-static-import' && (from.kind !== 'esm' || to.kind !== 'esm')) throw new Error('ESM link must join ESM nodes');
    if (link.method === 'shell-node-exec' && (from.kind !== 'shell' || to.kind !== 'esm')) throw new Error('Shell link must execute an ESM node');
  }
  return value;
}

// Mask comments and template literals without changing line boundaries.
// Preserve ordinary quoted specifiers for the deliberately narrow import check.
// This is not a full JavaScript parser; interpolation is not trusted as static evidence.
function maskNonCode(source) {
  const output = source.split('');
  let mode = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (char === "'" || char === '"') { mode = char; continue; }
      if (char === '`') { mode = 'template'; output[i] = ' '; continue; }
      if (char === '/' && next === '/') {
        mode = 'line'; output[i] = ' '; output[++i] = ' '; continue;
      }
      if (char === '/' && next === '*') {
        mode = 'block'; output[i] = ' '; output[++i] = ' '; continue;
      }
    } else if (mode === "'" || mode === '"') {
      if (char === '\\') { i += 1; continue; }
      // Regex multiline mode sees these characters as line boundaries, but
      // ECMAScript permits them inside an ordinary quoted string.
      if (char === '\u2028' || char === '\u2029') output[i] = ' ';
      if (char === mode) mode = 'code';
    } else if (mode === 'line') {
      if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') mode = 'code';
      else output[i] = ' ';
    } else if (mode === 'block') {
      if (char === '*' && next === '/') {
        output[i] = ' '; output[++i] = ' '; mode = 'code';
      } else if (char !== '\n' && char !== '\r') output[i] = ' ';
    } else if (mode === 'template') {
      if (char === '\\') {
        output[i] = ' ';
        if (i + 1 < source.length) {
          i += 1;
          if (source[i] !== '\n' && source[i] !== '\r') output[i] = ' ';
        }
      } else if (char === '`') { output[i] = ' '; mode = 'code'; }
      else if (char !== '\n' && char !== '\r') output[i] = ' ';
    }
  }
  return output.join('');
}

function referencedPaths(source, fromPath, method) {
  if (method === 'shell-node-exec') {
    // Recognizes direct repository-relative `node path` invocations only; does not execute shell.
    return [...source.matchAll(/(?:^|\n)\s*node\s+([^\s"';&|<>]+\.mjs)(?=\s|$)/g)].map((match) => match[1]);
  }
  // Restricted to static, single-line ESM imports/exports; dynamic imports are not evidence.
  return [...maskNonCode(source).matchAll(/^\s*(?:import|export)\s+(?:[^;\n]*?\sfrom\s*)?["']([^"']+)["']\s*;?\s*$/gm)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => posix.normalize(posix.join(posix.dirname(fromPath), specifier)));
}

export async function auditNexus({ root, manifest = 'forja/registry.json' }) {
  if (typeof root !== 'string') throw new Error('root is required');
  const directory = resolve(root);
  const rootReal = await realpath(directory);
  const manifestBytes = await boundedFile(directory, rootReal, manifest, LIMITS.manifest);
  const registry = validateRegistry(JSON.parse(manifestBytes.toString('utf8')));
  const findings = [];
  const inspected = new Map();
  for (const node of registry.nodes) {
    try {
      const bytes = await boundedFile(directory, rootReal, node.path, LIMITS.source);
      inspected.set(node.id, { path: node.path, kind: node.kind, sha256: sha256(bytes), source: bytes.toString('utf8') });
    } catch (cause) {
      findings.push(error('NODE_UNAVAILABLE', { id: node.id, path: node.path, reason: cause.message }));
    }
  }
  const graph = new Map(registry.nodes.map((node) => [node.id, []]));
  for (const link of registry.links) {
    const from = inspected.get(link.from);
    const to = inspected.get(link.to);
    if (!from || !to) continue;
    if (!referencedPaths(from.source, from.path, link.method).includes(to.path)) {
      findings.push(error('DECLARED_LINK_NOT_FOUND', { from: link.from, to: link.to, method: link.method }));
    } else {
      graph.get(link.from).push(link.to);
    }
  }
  const visited = new Set();
  const queue = [...registry.roots];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...graph.get(current));
  }
  for (const node of registry.nodes) {
    if (!visited.has(node.id)) findings.push(error('REGISTERED_NODE_DISCONNECTED', { id: node.id }));
  }
  const nodes = registry.nodes.map((node) => ({
    id: node.id, path: node.path, sha256: inspected.get(node.id)?.sha256 ?? null,
  }));
  return {
    schemaVersion: 1,
    tool: 'AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT',
    scope: 'registered-nodes-only',
    sourceRevision: process.env.FORJA_SOURCE_SHA || null,
    manifestSha256: sha256(manifestBytes),
    status: findings.length ? 'FAIL' : 'PASS',
    checked: { registeredNodes: registry.nodes.length, availableNodes: inspected.size, declaredLinks: registry.links.length,
      evidencedLinks: [...graph.values()].reduce((total, targets) => total + targets.length, 0), reachableNodes: visited.size },
    nodes, findings,
    limitations: ['Textual static-import/direct-node evidence is not proof of runtime behavior.',
      'Only explicitly registered nodes and links are audited; unregistered Nexus code is not covered.',
      'No production, security, deployment, or self-repair checks are performed.'],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
    console.error('Usage: node forja/audit.mjs [--root /path/to/repo]');
    process.exitCode = 2;
  } else {
    try {
      const report = await auditNexus({ root: args[1] ?? join(dirname(fileURLToPath(import.meta.url)), '..') });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'PASS') process.exitCode = 1;
    } catch (cause) {
      console.error(`FORJA_AUDIT_ERROR: ${cause.message}`);
      process.exitCode = 2;
    }
  }
}
