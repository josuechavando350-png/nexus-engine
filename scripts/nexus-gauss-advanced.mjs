#!/usr/bin/env node
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeGaussAdvancedProblem } from '../gauss/advanced/index.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 && !(args.length === 3 && args[1] === '--out')) {
  console.error('Usage: node scripts/nexus-gauss-advanced.mjs problem.json [--out new-report.json]');
  process.exit(2);
}
const input = resolve(args[0]);
const stat = await lstat(input);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1_048_576) throw new Error('bounded non-symlink JSON input required');
const report = await executeGaussAdvancedProblem(JSON.parse(await readFile(input, 'utf8')));
const json = `${JSON.stringify(report, null, 2)}\n`;
if (args.length === 3) await writeFile(resolve(args[2]), json, { flag: 'wx', mode: 0o600 });
else process.stdout.write(json);
if (report.status !== 'PASS') process.exitCode = 1;
