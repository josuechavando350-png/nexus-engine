import assert from "node:assert/strict";
import test from "node:test";

import { buildGrowthScenarioReport } from "../growth-scenario/scenario-engine.mjs";

function searchRows() {
  return [
    {
      query: "abogado penalista ciudad de mexico",
      page_url: "https://example.test/defensa-penal",
      clicks: 500,
      impressions: 10_000,
      average_position_milli: 8_000,
    },
  ];
}

function funnelRows() {
  return [
    {
      source_id: "organic-search",
      sessions: 1_000,
      lead_conversion_ppm: 100_000,
      close_rate_ppm: 200_000,
      average_ticket_micros: 50_000_000,
    },
  ];
}

function profile() {
  return {
    schema_version: 1,
    profile_id: "first-party-calibration-v1",
    provenance: "operator supplied scenario assumptions; not Google constants",
    click_to_session_ppm: 800_000,
    organic_funnel_source_ids: ["organic-search"],
    scenarios: [
      {
        scenario_id: "CONSERVATIVE",
        target_ctr_ppm: { TOP_10: 60_000, TOP_3: 120_000, TOP_1: 180_000 },
      },
      {
        scenario_id: "BASE",
        target_ctr_ppm: { TOP_10: 80_000, TOP_3: 150_000, TOP_1: 220_000 },
      },
      {
        scenario_id: "UPSIDE",
        target_ctr_ppm: { TOP_10: 100_000, TOP_3: 200_000, TOP_1: 300_000 },
      },
    ],
  };
}

test("base Top 3 scenario converts explicit CTR assumptions through the observed funnel", () => {
  const report = buildGrowthScenarioReport({
    searchPerformanceRecords: searchRows(),
    revenueFunnelRecords: funnelRows(),
    assumptionProfile: profile(),
  });

  assert.equal(report.status, "SCENARIO_READY");
  assert.equal(report.interpretation, "BOUNDED_HYPOTHETICAL_NOT_FORECAST");
  assert.deepEqual(report.observed.search, {
    queryCount: 1,
    pageCount: 1,
    impressions: 10_000,
    clicks: 500,
    ctrPpm: 50_000,
    impressionWeightedPositionMilli: 8_000,
  });
  assert.equal(report.observed.funnel.leadConversionPpm, 100_000);
  assert.equal(report.observed.funnel.closeRatePpm, 200_000);
  assert.equal(report.observed.funnel.averageTicketMicros, 50_000_000);
  assert.deepEqual(report.modeledCurrent, {
    clicksMilli: 500_000,
    sessionsMilli: 400_000,
    leadsMilli: 40_000,
    clientsMilli: 8_000,
    revenueMicros: 400_000_000,
  });

  const base = report.scenarios.find((item) => item.scenarioId === "BASE");
  const top3 = base.targets.find((item) => item.rankTarget === "TOP_3");
  assert.equal(top3.targetPositionMaxMilli, 3_000);
  assert.equal(top3.assumedCtrPpm, 150_000);
  assert.deepEqual(top3.projected, {
    clicksMilli: 1_500_000,
    sessionsMilli: 1_200_000,
    leadsMilli: 120_000,
    clientsMilli: 24_000,
    revenueMicros: 1_200_000_000,
  });
  assert.deepEqual(top3.incrementalVsModeledCurrent, {
    clicksMilli: 1_000_000,
    sessionsMilli: 800_000,
    leadsMilli: 80_000,
    clientsMilli: 16_000,
    revenueMicros: 800_000_000,
  });
});

test("identical evidence and assumptions are byte-deterministic and assumption-bound", () => {
  const first = buildGrowthScenarioReport({
    searchPerformanceRecords: searchRows(),
    revenueFunnelRecords: funnelRows(),
    assumptionProfile: profile(),
  });
  const second = buildGrowthScenarioReport({
    searchPerformanceRecords: searchRows(),
    revenueFunnelRecords: funnelRows(),
    assumptionProfile: profile(),
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.assumptionProfile.sha256, /^sha256:[0-9a-f]{64}$/);

  const changed = profile();
  changed.scenarios[1].target_ctr_ppm.TOP_3 = 160_000;
  const third = buildGrowthScenarioReport({
    searchPerformanceRecords: searchRows(),
    revenueFunnelRecords: funnelRows(),
    assumptionProfile: changed,
  });
  assert.notEqual(first.assumptionProfile.sha256, third.assumptionProfile.sha256);
});

test("floating-point evidence is rejected instead of rounded", () => {
  const rows = searchRows();
  rows[0].average_position_milli = 8_000.5;
  assert.throws(
    () => buildGrowthScenarioReport({ searchPerformanceRecords: rows, revenueFunnelRecords: funnelRows(), assumptionProfile: profile() }),
    /integer in range/,
  );
});

test("scenario CTR must improve monotonically by rank target", () => {
  const assumptions = profile();
  assumptions.scenarios[1].target_ctr_ppm.TOP_3 = 70_000;
  assert.throws(
    () => buildGrowthScenarioReport({ searchPerformanceRecords: searchRows(), revenueFunnelRecords: funnelRows(), assumptionProfile: assumptions }),
    /target CTR must be monotonic/,
  );
});

test("scenario bands cannot invert conservative/base/upside", () => {
  const assumptions = profile();
  assumptions.scenarios[2].target_ctr_ppm.TOP_3 = 140_000;
  assert.throws(
    () => buildGrowthScenarioReport({ searchPerformanceRecords: searchRows(), revenueFunnelRecords: funnelRows(), assumptionProfile: assumptions }),
    /CTR must be monotonic from CONSERVATIVE to UPSIDE/,
  );
});

test("missing selected organic funnel evidence remains insufficient data", () => {
  const assumptions = profile();
  assumptions.organic_funnel_source_ids = ["not-present"];
  assert.throws(
    () => buildGrowthScenarioReport({ searchPerformanceRecords: searchRows(), revenueFunnelRecords: funnelRows(), assumptionProfile: assumptions }),
    /INSUFFICIENT_DATA:organic_funnel_rows_missing/,
  );
});

test("zero observed search demand remains insufficient instead of fake upside", () => {
  const rows = searchRows();
  rows[0].clicks = 0;
  rows[0].impressions = 0;
  assert.throws(
    () => buildGrowthScenarioReport({ searchPerformanceRecords: rows, revenueFunnelRecords: funnelRows(), assumptionProfile: profile() }),
    /INSUFFICIENT_DATA:search_impressions_empty/,
  );
});

test("successful output carries explicit no-guarantee and client-quality boundaries", () => {
  const report = buildGrowthScenarioReport({
    searchPerformanceRecords: searchRows(),
    revenueFunnelRecords: funnelRows(),
    assumptionProfile: profile(),
  });
  assert.ok(report.warnings.includes("NO_RANK_GUARANTEE"));
  assert.ok(report.warnings.includes("NO_TRAFFIC_GUARANTEE"));
  assert.ok(report.warnings.includes("NO_LEAD_OR_REVENUE_GUARANTEE"));
  assert.ok(report.warnings.includes("CTR_ASSUMPTIONS_ARE_NOT_GOOGLE_CONSTANTS"));
  assert.ok(report.warnings.includes("CLIENT_QUALITY_REQUIRES_SEGMENTED_FIRST_PARTY_FUNNEL_EVIDENCE"));
});
