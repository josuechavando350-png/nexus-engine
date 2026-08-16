import { randomUUID } from "node:crypto";
import type { OntologyScope } from "./index";
import type { OntologyPersistencePort, OntologySnapshot } from "./persistence-query";

export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY";
export type SignalLevel = "INFO" | "WARN" | "ERROR";

export interface HealthComponent {
  readonly name: string;
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly components: readonly HealthComponent[];
}

export interface HealthPolicy {
  readonly requiredComponents: readonly string[];
  readonly maxComponentAgeMs: number;
}

export interface OperationalSignal {
  readonly occurredAt: string;
  readonly scope: OntologyScope;
  readonly level: SignalLevel;
  readonly name: string;
  readonly value?: number;
  readonly detail?: string;
}

export interface ObservabilityPort {
  emit(signal: OperationalSignal): void;
  list(scope: OntologyScope): readonly OperationalSignal[];
  health(checkedAt: string, components: readonly HealthComponent[]): HealthReport;
}

export interface BackupRecord {
  readonly backupId: string;
  readonly scope: OntologyScope;
  readonly createdAt: string;
  readonly snapshotDigest: string;
  readonly snapshot: OntologySnapshot;
}

export interface DisasterRecoveryPort {
  backup(scope: OntologyScope, createdAt: string): BackupRecord;
  restore(backupId: string): void;
  listBackups(scope: OntologyScope): readonly Omit<BackupRecord, "snapshot">[];
}

function canonicalUtc(value: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("timestamp must be canonical ISO-8601 UTC");
}

function scopeKey(scope: OntologyScope): string {
  return `${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.brandId ?? ""}`;
}

function sameScope(a: OntologyScope, b: OntologyScope): boolean {
  return a.tenantId === b.tenantId && a.organizationId === b.organizationId && a.brandId === b.brandId;
}

function aggregateHealth(components: readonly HealthComponent[]): HealthStatus {
  if (components.some((item) => item.status === "UNHEALTHY")) return "UNHEALTHY";
  if (components.some((item) => item.status === "DEGRADED")) return "DEGRADED";
  return "HEALTHY";
}

function assertHealthPolicy(policy: HealthPolicy): void {
  if (policy.requiredComponents.length === 0) throw new Error("health policy requires at least one required component");
  if (new Set(policy.requiredComponents).size !== policy.requiredComponents.length) throw new Error("health policy required components must be unique");
  if (policy.requiredComponents.some((name) => !name.trim())) throw new Error("health policy component names must be non-empty");
  if (!Number.isFinite(policy.maxComponentAgeMs) || policy.maxComponentAgeMs <= 0) throw new Error("health policy maxComponentAgeMs must be positive");
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function secureBackupId(scope: OntologyScope): string {
  return `backup:${scope.tenantId}:${randomUUID()}`;
}

export class InMemoryObservability implements ObservabilityPort {
  private readonly signals = new Map<string, OperationalSignal[]>();

  constructor(
    private readonly healthPolicy: HealthPolicy = { requiredComponents: ["ontology", "storage"], maxComponentAgeMs: 30_000 },
    private readonly maxSignalsPerScope = 100_000,
  ) {
    assertHealthPolicy(healthPolicy);
    positiveInteger(maxSignalsPerScope, "maxSignalsPerScope");
  }

  emit(signal: OperationalSignal): void {
    canonicalUtc(signal.occurredAt);
    if (!signal.name.trim()) throw new Error("signal name must be non-empty");
    if (signal.value !== undefined && !Number.isFinite(signal.value)) throw new Error("signal value must be finite");
    const key = scopeKey(signal.scope);
    const history = this.signals.get(key) ?? [];
    if (history.length >= this.maxSignalsPerScope) throw new Error("observability signal capacity exceeded for scope");
    this.signals.set(key, [...history, { ...signal, scope: { ...signal.scope } }]);
  }

  list(scope: OntologyScope): readonly OperationalSignal[] {
    return (this.signals.get(scopeKey(scope)) ?? []).map((item) => ({ ...item, scope: { ...item.scope } }));
  }

  health(checkedAt: string, components: readonly HealthComponent[]): HealthReport {
    canonicalUtc(checkedAt);
    if (components.length === 0) throw new Error("health report requires at least one component");
    const checkedAtMs = new Date(checkedAt).getTime();
    const names = new Set<string>();
    for (const component of components) {
      if (!component.name.trim()) throw new Error("health component name must be non-empty");
      if (names.has(component.name)) throw new Error(`duplicate health component ${component.name}`);
      names.add(component.name);
      canonicalUtc(component.checkedAt);
      const age = checkedAtMs - new Date(component.checkedAt).getTime();
      if (age < 0) throw new Error(`health component ${component.name} is from the future`);
      if (age > this.healthPolicy.maxComponentAgeMs) throw new Error(`health component ${component.name} is stale`);
    }
    for (const required of this.healthPolicy.requiredComponents) {
      if (!names.has(required)) throw new Error(`required health component ${required} is missing`);
    }
    return { status: aggregateHealth(components), checkedAt, components: components.map((item) => ({ ...item })) };
  }
}

export class InMemoryDisasterRecovery implements DisasterRecoveryPort {
  private readonly backups = new Map<string, BackupRecord>();

  constructor(
    private readonly persistence: OntologyPersistencePort,
    private readonly maxBackupsPerScope = 1_000,
  ) {
    positiveInteger(maxBackupsPerScope, "maxBackupsPerScope");
  }

  backup(scope: OntologyScope, createdAt: string): BackupRecord {
    canonicalUtc(createdAt);
    const scopedBackups = [...this.backups.values()].filter((record) => sameScope(record.scope, scope)).length;
    if (scopedBackups >= this.maxBackupsPerScope) throw new Error("backup retention capacity exceeded for scope");
    const snapshot = this.persistence.exportSnapshot(scope, createdAt);
    let backupId = secureBackupId(scope);
    while (this.backups.has(backupId)) backupId = secureBackupId(scope);
    const record: BackupRecord = { backupId, scope: { ...scope }, createdAt, snapshotDigest: snapshot.digest, snapshot };
    this.backups.set(backupId, record);
    return { ...record, scope: { ...record.scope }, snapshot: { ...snapshot, scope: { ...snapshot.scope }, objects: [...snapshot.objects], relationships: [...snapshot.relationships] } };
  }

  restore(backupId: string): void {
    const record = this.backups.get(backupId);
    if (!record) throw new Error(`backup ${backupId} not found`);
    if (record.snapshot.digest !== record.snapshotDigest) throw new Error(`backup ${backupId} digest metadata mismatch`);
    this.persistence.restoreSnapshot(record.snapshot, record.scope);
  }

  listBackups(scope: OntologyScope): readonly Omit<BackupRecord, "snapshot">[] {
    return [...this.backups.values()]
      .filter((record) => sameScope(record.scope, scope))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => ({ backupId: record.backupId, scope: { ...record.scope }, createdAt: record.createdAt, snapshotDigest: record.snapshotDigest }));
  }
}
