#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryCms, defineCmsSchema, parseCmsDocument } from '../lib/cms-lite.mjs';

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};

const schema = defineCmsSchema((input) => {
  if (!input || typeof input !== 'object' || typeof input.title !== 'string') throw new Error('title required');
  return { title: input.title };
});
const document = parseCmsDocument({ slug: 'home', locale: 'es-MX', data: { title: 'NEXUS' } }, schema);
const cms = createMemoryCms([document]);
if (cms.get('home')?.data.title !== 'NEXUS' || cms.list().length !== 1) throw new Error('cms-lite public surface failed');

const probeName = `third-party-proof-${process.pid}`;
const probePath = join(process.cwd(), 'apps', probeName);
const probeModules = join(probePath, 'node_modules');
const temporary = mkdtempSync(join(tmpdir(), 'nexus-third-party-proof-'));
const specPath = join(temporary, 'project-spec.json');
const lockfilePath = join(process.cwd(), 'pnpm-lock.yaml');
const originalLockfile = readFileSync(lockfilePath, 'utf8');
const spec = {
  schemaVersion: 1,
  slug: probeName,
  business: { name: 'NEXUS Third-Party Proof', industry: 'Verification fixture', location: 'Local clean room', contact: { email: 'proof@example.com' }, confirmedServices: [{ name: 'Verification' }] },
  artDirection: {
    palette: [{ hex: '#111111', role: 'surface', rationale: 'Neutral proof surface' }, { hex: '#F4EFE4', role: 'accent', rationale: 'Readable proof accent' }],
    typography: { display: 'Editorial serif', body: 'Humanist sans', rationale: 'Exercise bounded typography mapping' },
    heroComposition: { direction: 'Asymmetric split', rationale: 'Exercise compiled composition' },
    sectionRhythm: { direction: 'Measured', rationale: 'Exercise compiled rhythm' },
    motion: { direction: 'Short reveals', reducedMotionBehavior: 'No transforms', rationale: 'Exercise reduced-motion contract' },
    prohibitions: ['No invented claims'],
  },
};
writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
rmSync(probePath, { recursive: true, force: true });
try {
  run(process.execPath, ['scripts/scaffold-client.mjs', probeName, '--project-spec', specPath]);
  const manifest = JSON.parse(readFileSync(join(probePath, '.nexus/scaffold-manifest.json'), 'utf8'));
  const compiled = JSON.parse(readFileSync(join(probePath, '.nexus/compiled-project.json'), 'utf8'));
  const page = readFileSync(join(probePath, 'src/app/page.tsx'), 'utf8');
  const updatedLockfile = readFileSync(lockfilePath, 'utf8');
  if (manifest.authority !== 'NEXUS_SCAFFOLD_V2' || manifest.client !== probeName || !manifest.files.length) throw new Error('scaffold manifest invalid');
  if (compiled.authority !== 'NEXUS_PROJECT_SPEC_COMPILER_V1' || compiled.specDigest !== manifest.projectSpecDigest) throw new Error('compiled project evidence invalid');
  if (/\[\s*(?:Marca|Título|Acción|Contenido|Pie|Enlace)/u.test(page)) throw new Error('compiled client still contains seed placeholders');
  if (!updatedLockfile.includes(`  apps/${probeName}:\n`)) throw new Error('scaffold did not bind the client into the workspace lockfile');

  symlinkSync(join('..', '_experience-seed', 'node_modules'), probeModules, 'dir');
  run('pnpm', ['--filter', `@nexus/${probeName}`, 'lint']);
  run('pnpm', ['--filter', `@nexus/${probeName}`, 'typecheck']);
  run('pnpm', ['--filter', `@nexus/${probeName}`, 'build']);
  rmSync(probeModules, { recursive: true, force: true });
} finally {
  rmSync(probeModules, { recursive: true, force: true });
  rmSync(probePath, { recursive: true, force: true });
  writeFileSync(lockfilePath, originalLockfile);
  rmSync(temporary, { recursive: true, force: true });
}

run(process.execPath, ['scripts/verify-declared-assets.mjs']);
console.log('THIRD_PARTY_PROOF_PASS');
console.log('PASSPORT_SIGNATURE_STATE_NOT_VERIFIED');
