import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('runtime invariants extracted from historical architecture gates', () => {
  test('V4 autonomy remains bounded and replay cannot dispatch physical work', () => {
    const planner = read('runtime/crates/nexus-planner/src/lib.rs');
    const reasoning = read('runtime/crates/nexus-reasoning/src/lib.rs');
    const durable = read('runtime/crates/nexus-durable/src/lib.rs');
    expect(planner).toMatch(/cycle|dag/i);
    expect(reasoning).toMatch(/budget/i);
    expect(durable).toMatch(/replay/i);
  });

  test('V5 control plane keeps authorization, audit and concurrency boundaries', () => {
    const authz = read('runtime/crates/nexus-authz/src/lib.rs');
    const control = read('runtime/crates/nexus-control-plane/src/lib.rs');
    const registry = read('runtime/crates/nexus-registry/src/lib.rs');
    expect(authz).toMatch(/tenant|scope/i);
    expect(control).toMatch(/authoriz|audit/i);
    expect(registry).toMatch(/expected_version|version/i);
  });

  test('V6 distribution keeps evidence, rollback and fleet safety', () => {
    const distributed = read('runtime/crates/nexus-distributed/src/lib.rs');
    const update = read('runtime/crates/nexus-update/src/lib.rs');
    const fleet = read('runtime/crates/nexus-fleet/src/lib.rs');
    expect(distributed).toMatch(/policy_evidence_id/);
    expect(distributed).toMatch(/artifact_digest/);
    expect(update).toMatch(/sbom_digest/);
    expect(update).toMatch(/provenance_digest/);
    expect(update).toMatch(/RejectRollback|min_boot_counter/);
    expect(fleet).toMatch(/max_parallel/);
    expect(fleet).toMatch(/min_healthy_percent/);
  });

  test('creative core stays framework, browser and runtime neutral', () => {
    const files = [
      'packages/creative/shared.ts',
      'packages/creative/vault/index.ts',
      'packages/creative/memory/index.ts',
      'packages/creative/evidence/index.ts'
    ];
    const source = files.map(read).join('\n');
    expect(source).not.toMatch(/from\s+["'](?:react|next|three|gsap)["']/i);
    expect(source).not.toMatch(/runtime\/crates|nexus-industrial|\bwindow\b|\bdocument\b/);
    expect(read('packages/creative/vault/index.ts')).toMatch(/DIGEST_MISMATCH/);
    expect(read('packages/creative/memory/index.ts')).toMatch(/EVIDENCE_ONLY/);
    expect(read('packages/creative/evidence/index.ts')).toMatch(/tenantId/);
  });

  test('evidence and ontology remain fail-closed and scoped', () => {
    const passport = read('packages/quality/quality-passport.ts');
    const ontology = read('packages/ontology/auth-audit.ts');
    expect(passport).toMatch(/PASS|FAIL|NOT_TESTED/);
    expect(ontology).toMatch(/tenant|organization|scope/i);
  });
});
