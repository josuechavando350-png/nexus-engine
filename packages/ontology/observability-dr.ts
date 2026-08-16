import type { OntologyScope } from "./index";
import type { OntologyPersistencePort, OntologySnapshot } from "./persistence-query";

export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY";
export type SignalLevel = "INFO" | "WARN" | "ERROR";

export interface HealthComponent {
  readonly name: string;
  readonly status: HealthStatus;
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly components: readonly HealthComponent[];
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

function stableBackupId(scope: OntologyScope, createdAt: string): string {
  return `backup:${scopeKey(scope)}:${createdAt}`;
}

export class InMemoryObservability implements ObservabilityPort {
  private readonly signals = new Map<string, OperationalSignal[]>();

  emit(signal: OperationalSignal): void {
    canonicalUtc(signal.occurredAt);
    if (!signal.name.trim()) throw new Error("signal name must be non-empty");
    if (signal.value !== undefined && !Number.isFinite(signal.value)) throw new Error("signal value must be finite");
    const key = scopeKey(signal.scope);
    const history = this.signals.get(key) ?? [];
    this.signals.set(key, [...history, { ...signal, scope: { ...signal.scope } }]);
  }

  list(scope: OntologyScope): readonly OperationalSignal[] {
    return (this.signals.get(scopeKey(scope)) ?? []).map((item) => ({ ...item, scope: { ...item.scope } }));
  }

  health(checkedAt: string, components: readonly HealthComponent[]): HealthReport {
    canonicalUtc(checkedAt);
    if (components.length === 0) throw new Error("health report requires at least one component");
    return { status: aggregateHealth(components), checkedAt, components: components.map((item) => ({ ...item })) };
  }
}

export class InMemoryDisasterRecovery implements DisasterRecoveryPort {
  private readonly backups = new Map<string, BackupRecord>();

  constructor(private readonly persistence: OntologyPersistencePort) {}

  backup(scope: OntologyScope, createdAt: string): BackupRecord {
    canonicalUtc(createdAt);
    const snapshot = this.persistence.exportSnapshot(scope, createdAt);
    const backupId = stableBackupId(scope, createdAt);
    const record: BackupRecord = { backupId, scope: { ...scope }, createdAt, snapshot };
    this.backups.set(backupId, record);
    return { ...record, scope: { ...record.scope }, snapshot: { ...snapshot, scope: { ...snapshot.scope }, objects: [...snapshot.objects], relationships: [...snapshot.relationships] } };
  }

  restore(backupId: string): void {
    const record = this.backups.get(backupId);
    if (!record) throw new Error(`backup ${backupId} not found`);
    this.persistence.restoreSnapshot(record.snapshot);
  }

  listBackups(scope: OntologyScope): readonly Omit<BackupRecord, "snapshot">[] {
    return [...this.backups.values()]
      .filter((record) => sameScope(record.scope, scope))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ snapshot: _snapshot, ...record }) => ({ ...record, scope: { ...record.scope } }));
  }
}
