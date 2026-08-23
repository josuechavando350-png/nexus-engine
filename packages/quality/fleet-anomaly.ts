export type FleetMetricName = "LCP_P75" | "INP_P75" | "CLS_P75" | "ERROR_RATE" | "VISUAL_DIFF_RATIO";

export type FleetMetricPoint = Readonly<{
  projectId: string;
  metric: FleetMetricName;
  value: number;
}>;

export type FleetAnomaly = Readonly<{
  projectId: string;
  metric: FleetMetricName;
  value: number;
  peerCount: number;
  fleetMedian: number;
  medianAbsoluteDeviation: number;
  robustZ: number;
  status: "NORMAL" | "ANOMALOUS";
}>;

export type FleetAnomalyReport = Readonly<{
  authority: "NEXUS_FLEET_ANOMALY_V1";
  status: "MEASURED" | "NOT_TESTED" | "INSUFFICIENT_EVIDENCE";
  projectCount: number;
  anomalies: readonly FleetAnomaly[];
  reason?: string;
}>;

function median(values: readonly number[]): number {
  if (!values.length) throw new Error("median requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

export function analyzeFleetAnomalies(points: readonly FleetMetricPoint[]): FleetAnomalyReport {
  if (!points.length) {
    return Object.freeze({
      authority: "NEXUS_FLEET_ANOMALY_V1",
      status: "NOT_TESTED",
      projectCount: 0,
      anomalies: Object.freeze([]),
      reason: "NO_CLIENT_TELEMETRY",
    });
  }

  const keys = new Set<string>();
  for (const point of points) {
    const projectId = point.projectId.trim();
    if (!projectId) throw new Error("fleet metric projectId is required");
    if (!Number.isFinite(point.value) || point.value < 0) throw new Error("fleet metric value must be finite and non-negative");
    const key = `${projectId}\0${point.metric}`;
    if (keys.has(key)) throw new Error(`duplicate fleet metric point: ${projectId}/${point.metric}`);
    keys.add(key);
  }

  const projectIds = [...new Set(points.map((point) => point.projectId.trim()))].sort((a, b) => a.localeCompare(b, "en"));
  if (projectIds.length < 5) {
    return Object.freeze({
      authority: "NEXUS_FLEET_ANOMALY_V1",
      status: "INSUFFICIENT_EVIDENCE",
      projectCount: projectIds.length,
      anomalies: Object.freeze([]),
      reason: "AT_LEAST_5_CLIENT_PROJECTS_REQUIRED",
    });
  }

  const anomalies: FleetAnomaly[] = [];
  const metrics: readonly FleetMetricName[] = ["LCP_P75", "INP_P75", "CLS_P75", "ERROR_RATE", "VISUAL_DIFF_RATIO"];
  let measurableMetricCount = 0;
  for (const metric of metrics) {
    const group = points.filter((point) => point.metric === metric);
    if (group.length < 5) continue;
    measurableMetricCount += 1;
    for (const point of group) {
      const peers = group.filter((candidate) => candidate.projectId.trim() !== point.projectId.trim());
      const peerValues = peers.map((candidate) => candidate.value);
      const center = median(peerValues);
      const mad = median(peerValues.map((value) => Math.abs(value - center)));
      const robustZ = mad === 0 ? (point.value === center ? 0 : Number.POSITIVE_INFINITY) : 0.6745 * (point.value - center) / mad;
      anomalies.push(Object.freeze({
        projectId: point.projectId.trim(),
        metric,
        value: point.value,
        peerCount: peers.length,
        fleetMedian: round(center),
        medianAbsoluteDeviation: round(mad),
        robustZ: Number.isFinite(robustZ) ? round(robustZ) : robustZ,
        status: Math.abs(robustZ) > 3.5 ? "ANOMALOUS" : "NORMAL",
      }));
    }
  }

  if (measurableMetricCount === 0) {
    return Object.freeze({
      authority: "NEXUS_FLEET_ANOMALY_V1",
      status: "INSUFFICIENT_EVIDENCE",
      projectCount: projectIds.length,
      anomalies: Object.freeze([]),
      reason: "AT_LEAST_5_MEASURED_PROJECTS_PER_METRIC_REQUIRED",
    });
  }

  return Object.freeze({
    authority: "NEXUS_FLEET_ANOMALY_V1",
    status: "MEASURED",
    projectCount: projectIds.length,
    anomalies: Object.freeze(anomalies.sort((a, b) => `${a.metric}\0${a.projectId}`.localeCompare(`${b.metric}\0${b.projectId}`, "en"))),
  });
}
