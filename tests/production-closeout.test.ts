import { describe, expect, test } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMemoryCms, defineCmsSchema, parseCmsDocument } from '../lib/cms-lite.mjs';

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

  test('scaffold is deterministic and refuses an existing target', () => {
    const name = `proof-${process.pid}`;
    const target = join(process.cwd(), 'apps', name);
    rmSync(target, { recursive: true, force: true });
    try {
      const first = spawnSync(process.execPath, ['scripts/scaffold-client.mjs', name], { cwd: process.cwd(), encoding: 'utf8' });
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      const manifest = JSON.parse(readFileSync(join(target, '.nexus/scaffold-manifest.json'), 'utf8'));
      expect(manifest.authority).toBe('NEXUS_SCAFFOLD_V1');
      expect(manifest.client).toBe(name);
      expect(manifest.files.length).toBeGreaterThan(0);
      const second = spawnSync(process.execPath, ['scripts/scaffold-client.mjs', name], { cwd: process.cwd(), encoding: 'utf8' });
      expect(second.status).not.toBe(0);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 20_000);
});
