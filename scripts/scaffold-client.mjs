#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const [name] = process.argv.slice(2);
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('usage: node scripts/scaffold-client.mjs <kebab-case-name>');
const root = process.cwd();
const source = join(root, 'apps/_experience-seed');
const target = join(root, `apps/${name}`);
if (!existsSync(source)) throw new Error('apps/_experience-seed is missing');
if (existsSync(target)) throw new Error(`target already exists: apps/${name}`);
cpSync(source, target, { recursive: true, preserveTimestamps: false });

const replaceTokens = (directory) => {
  for (const entry of readdirSync(directory).sort((a, b) => a.localeCompare(b, 'en'))) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) replaceTokens(path);
    else {
      const bytes = readFileSync(path);
      if (!bytes.includes(0)) {
        const text = bytes.toString('utf8').replaceAll('__NEXUS_CLIENT_SLUG__', name);
        writeFileSync(path, text);
      }
    }
  }
};
replaceTokens(target);

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory).sort((a, b) => a.localeCompare(b, 'en'))) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(target);
const manifest = files.map((path) => ({
  path: relative(target, path).replaceAll('\\', '/'),
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
}));
mkdirSync(join(target, '.nexus'), { recursive: true });
writeFileSync(join(target, '.nexus/scaffold-manifest.json'), `${JSON.stringify({ authority: 'NEXUS_SCAFFOLD_V1', client: name, files: manifest }, null, 2)}\n`);
console.log(`scaffolded apps/${name}`);
