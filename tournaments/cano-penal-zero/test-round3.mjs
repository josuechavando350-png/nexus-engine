import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const portfolio=JSON.parse(await readFile(new URL("./organic-keyword-portfolio-v1.json",import.meta.url),"utf8"));
const plan=JSON.parse(await readFile(new URL("./round3-architecture-plan-v1.json",import.meta.url),"utf8"));

test("Round 3 defines exactly six proposed semifinal architectures and no live mutation",()=>{
  assert.equal(plan.status,"PROPOSED_NOT_LIVE");
  assert.equal(plan.architectures.length,6);
  assert.deepStrictEqual(plan.semifinalistInputIds,["S01","S04","S05","S09","S10","S15"]);
  assert.equal(plan.globalRequirements.noProductionMutation,true);
});

test("every architecture maps to portfolio queries and has internal links, evidence and boundaries",()=>{
  const qids=new Set(portfolio.keywords.map(x=>x.id));
  for(const arch of plan.architectures){
    assert(arch.targetQueryIds.length>0);
    assert(arch.internalLinkPlan.length>0);
    assert(arch.evidencePlan.length>0);
    assert(arch.boundaries.length>0);
    for(const id of arch.targetQueryIds)assert(qids.has(id));
  }
});

test("calendar architecture is interactive and explicitly not a PDF lead gate",()=>{
  const row=plan.architectures.find(x=>x.strategyId==="S05");
  assert.equal(row.primaryAsset.path,"/herramientas/calendario-fiscal");
  assert.equal(row.primaryAsset.mode,"PROPOSED_NEW_INTERACTIVE");
  assert(row.boundaries.includes("NO_PDF_DEPENDENCY"));
  assert(row.boundaries.includes("NO_FORCED_LEAD_GATE"));
});

test("fiscal hub architecture strengthens existing URL instead of duplicating it",()=>{
  const row=plan.architectures.find(x=>x.strategyId==="S01");
  assert.equal(row.primaryAsset.path,"/areas/delitos-fiscales-y-financieros");
  assert.equal(row.primaryAsset.mode,"STRENGTHEN_EXISTING");
  assert(row.boundaries.includes("NO_DUPLICATE_FISCAL_LANDING"));
});

test("global measurement counts signed organic matters, not contacts",()=>{
  assert.equal(plan.globalRequirements.successTarget,"AT_LEAST_5_SIGNED_CLIENTS_ATTRIBUTABLE_TO_ORGANIC_PER_MONTH");
  assert.equal(plan.globalRequirements.repeatabilityTarget,"3_CONSECUTIVE_MONTHS_AT_OR_ABOVE_5");
  assert(plan.globalRequirements.measurement.includes("signed_matter_anonymized_id"));
});
