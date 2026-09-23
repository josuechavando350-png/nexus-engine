import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const p=JSON.parse(await readFile(new URL("./search-console-bootstrap-v1.json",import.meta.url),"utf8"));

test("recently configured Search Console is bootstrap, not strategy failure",()=>{
  assert.equal(p.currentKnownState.tournamentState,"BOOTSTRAP");
  const b=p.states.find(x=>x.state==="BOOTSTRAP");
  assert.equal(b.tournamentEffect,"COLLECT_AND_BUILD_NO_RANKING_WINNER_OR_PENALTY");
  assert(b.forbiddenUses.includes("DECLARE_STRATEGY_FAILURE"));
});
test("bootstrap does not weaken five-client business goal",()=>{
  assert.match(p.commercialRule,/5_SIGNED_ORGANIC_CLIENT_TARGET_REMAINS_UNCHANGED/);
});
test("no arbitrary waiting period replaces evidence sufficiency",()=>{
  assert.match(p.progressionRule,/DO_NOT_USE_A_FIXED_CALENDAR_WAIT/);
});
