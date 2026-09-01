import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createMemoryCms, defineCmsSchema, parseCmsDocument } from '../lib/cms-lite.mjs';

const scaffoldSpec = (slug: string) => ({
  schemaVersion: 1,
  slug,
  business: { name: 'Proof Client', industry: 'Professional services', location: 'Mexico', contact: { email: 'proof@example.com' }, confirmedServices: [{ name: 'Consultation' }] },
  artDirection: {
    palette: [{ hex: '#101010', role: 'surface', rationale: 'Neutral dark base' }, { hex: '#F5F1E8', role: 'accent', rationale: 'Readable contrast' }],
    typography: { display: 'Editorial serif', body: 'Humanist sans', rationale: 'Clear hierarchy' },
    heroComposition: { direction: 'Asymmetric split', rationale: 'Strong hierarchy' },
    sectionRhythm: { direction: 'Measured', rationale: 'Consistent pacing' },
    motion: { direction: 'Short reveals', reducedMotionBehavior: 'No transforms', rationale: 'Preserve orientation' },
    prohibitions: ['No invented claims'],
  },
});

describe('production closeout utilities', () => {
  test('CMS-lite validates documents and resolves locale-scoped content', () => {
    const schema = defineCmsSchema((input: unknown) => {
      if (!input || typeof input !== 'object' || typeof (input as { title?: unknown }).title !== 'string') throw new Error('title required');
      return { title: (input as { title: string }).title };
    });
    const es = parseCmsDocument({ slug: 'home', locale: 'es-MX', data: { title: 'Inicio' } }, schema);
    const en = parseCmsDocument({ slug: 'home', locale: 'en-US', data: { title: 'Home' } }, schema);
    const cms = createMemoryCms([es, en]);
    expect(cms.get('home', 'es-MX')?.data.title).toBe('Inicio');
    expect(cms.get('home', 'en-US')?.data.title).toBe('Home');
    expect(cms.list('es-MX')).toHaveLength(1);
    expect(() => parseCmsDocument({ slug: '../bad', data: {} }, schema)).toThrow();
  });

  test('scaffold compiles a deterministic, lockfile-bound client and refuses an existing target', () => {
    const repositoryRoot = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'nexus-production-closeout-'));
    const name = `proof-${process.pid}`;
    try {
      mkdirSync(join(root, 'apps'), { recursive: true });
      mkdirSync(join(root, 'scripts'), { recursive: true });
      cpSync(join(repositoryRoot, 'apps/_experience-seed'), join(root, 'apps/_experience-seed'), { recursive: true, filter: (source) => !source.includes('/.next/') && !source.includes('/node_modules/') });
      cpSync(join(repositoryRoot, 'scripts/scaffold-client.mjs'), join(root, 'scripts/scaffold-client.mjs'));
      cpSync(join(repositoryRoot, 'scripts/project-spec-contract.mjs'), join(root, 'scripts/project-spec-contract.mjs'));
      cpSync(join(repositoryRoot, 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'));
      writeFileSync(join(root, 'apps/_experience-seed/next-env.d.ts'), '/// <reference path="./.next/types/routes.d.ts" />\n');
      writeFileSync(join(root, 'apps/_experience-seed/.env.local'), 'NEXUS_SHOULD_NEVER_COPY=this-is-not-a-source-file\n');
      const specPath = join(root, 'project-spec.json');
      writeFileSync(specPath, JSON.stringify(scaffoldSpec(name)));

      const first = spawnSync(process.execPath, ['scripts/scaffold-client.mjs', name, '--project-spec', specPath], { cwd: root, encoding: 'utf8' });
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      const target = join(root, 'apps', name);
      const manifest = JSON.parse(readFileSync(join(target, '.nexus/scaffold-manifest.json'), 'utf8'));
      const compiled = JSON.parse(readFileSync(join(target, '.nexus/compiled-project.json'), 'utf8'));
      const page = readFileSync(join(target, 'src/app/page.tsx'), 'utf8');
      const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
      expect(manifest.authority).toBe('NEXUS_SCAFFOLD_V2');
      expect(manifest.client).toBe(name);
      expect(manifest.files.length).toBeGreaterThan(0);
      expect(compiled.authority).toBe('NEXUS_PROJECT_SPEC_COMPILER_V1');
      expect(page).not.toMatch(/\[\s*(?:Marca|Título|Acción|Contenido|Pie|Enlace)/u);
      expect(lock).toContain(`  apps/${name}:\n`);
      expect(existsSync(join(target, 'next-env.d.ts'))).toBe(false);
      expect(existsSync(join(target, '.env.local'))).toBe(false);
      expect(manifest.files.some((entry: { path: string }) => entry.path === 'next-env.d.ts' || entry.path.startsWith('.env'))).toBe(false);
      const second = spawnSync(process.execPath, ['scripts/scaffold-client.mjs', name, '--project-spec', specPath], { cwd: root, encoding: 'utf8' });
      expect(second.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
