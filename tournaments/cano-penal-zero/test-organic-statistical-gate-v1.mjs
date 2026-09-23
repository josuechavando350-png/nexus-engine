import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const gate=JSON.parse(await readFile(new URL("./organic-statistical-gate-v1.json",import.meta.url),"utf8"));

test("statistical gate uses 99.9 percent confidence and 95 percent comparison power",()=>{
  assert.equal(gate.statisticalStandard.highConfidenceProbability,0.999);
  assert.equal(gate.statisticalStandard.comparisonPower,0.95);
  assert.equal(gate.statisticalStandard.comparisonAlphaTwoSided,0.001);
});

test("commercial target remains five signed organic clients for three consecutive months",()=>{
  assert.equal(gate.commercialTarget.minimumSignedClientsPerCalendarMonth,5);
  assert.equal(gate.commercialTarget.repeatabilityMonths,3);
  assert.equal(gate.commercialTarget.attributionRequired,true);
});

test("scenario matrix is explicitly not a forecast and requires measured CTR and client rate",()=>{
  assert(gate.interpretationBoundaries.includes("SCENARIO_MATRIX_IS_NOT_A_FORECAST"));
  assert(gate.interpretationBoundaries.includes("CTR_AND_CLIENT_RATE_MUST_BE_MEASURED_NOT_ASSUMED"));
  assert.equal(gate.continuationRules.doNotAssumeConversionRate,true);
});

test("at two percent signed-client rate the 99.9 percent five-client threshold is 735 organic sessions",()=>{
  const row=gate.clientRateScenarioMatrix.find(x=>x.ratePercent===2);
  assert.equal(row.organicSessionsForAtLeast5With999Probability,735);
  assert.equal(row.impressionsAt5PercentCtr,14700);
  assert.equal(row.impressionsAt10PercentCtr,7350);
});

test("impressions, clicks and WhatsApp contacts never count as clients",()=>{
  assert.equal(gate.continuationRules.doNotUseImpressionsAlone,true);
  assert(gate.interpretationBoundaries.includes("IMPRESSIONS_ARE_NOT_CLIENTS"));
  assert(gate.interpretationBoundaries.includes("CLICKS_ARE_NOT_CLIENTS"));
  assert(gate.interpretationBoundaries.includes("WHATSAPP_CONTACTS_ARE_NOT_CLIENTS"));
});
