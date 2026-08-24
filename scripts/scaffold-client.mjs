#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const [name, specFlag, specPath] = process.argv.slice(2);
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || name.endsWith('-') || name.includes('--')) throw new Error('usage: node scripts/scaffold-client.mjs <kebab-case-name> [--project-spec <json-path>]');
if ((specFlag || specPath) && (specFlag !== '--project-spec' || !specPath)) throw new Error('usage: node scripts/scaffold-client.mjs <kebab-case-name> [--project-spec <json-path>]');
const root = process.cwd();
const source = join(root, 'apps/_experience-seed');
const target = join(root, `apps/${name}`);
if (!existsSync(source)) throw new Error('apps/_experience-seed is missing');
if (existsSync(target)) throw new Error(`target already exists: apps/${name}`);
const excluded = new Set(['.next', 'node_modules', 'dist', 'coverage', 'tsconfig.tsbuildinfo']);
cpSync(source, target, { recursive: true, preserveTimestamps: false, filter: (path) => path === source || !excluded.has(path.slice(path.lastIndexOf('/') + 1)) });

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

if (specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (spec?.schemaVersion !== 1 || spec?.slug !== name || !spec.business || !spec.artDirection) throw new Error('invalid project specification');
  const packagePath = join(target, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.name = `@nexus/${name}`;
  packageJson.description = `NEXUS client experience for ${spec.business.name}`;
  packageJson.nexus = { clientProject: true };
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  mkdirSync(join(target, '.nexus'), { recursive: true });
  writeFileSync(join(target, '.nexus/project-spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
}

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
