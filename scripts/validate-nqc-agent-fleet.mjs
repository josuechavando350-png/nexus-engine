#!/usr/bin/env node
import { readFileSync } from "node:fs";

const mesh = JSON.parse(readFileSync("ci/nqc-quant-firm/AGENT_MESH_CONTRACT.json", "utf8"));
const fleet = JSON.parse(readFileSync("ci/nqc-quant-firm/AGENT_FLEET_350.json", "utf8"));

function fail(message) {
  console.error(`NQC_AGENT_FLEET_INVALID ${message}`);
  process.exit(1);
}

if (mesh.operational_agent_count !== 350) fail("mesh operational_agent_count must equal 350");
if (mesh.hard_agent_cap !== 350) fail("mesh hard_agent_cap must equal 350");
if (mesh.agent_351_behavior !== "FAIL_CLOSED") fail("agent 351 must fail closed");
if (mesh.llm_hot_path_allowed !== false) fail("LLM/agent inference must remain outside the hot path");
if (mesh.execution_authority !== "DETERMINISTIC_CERTIFIED_RUNTIME_ONLY") {
  fail("execution authority must remain deterministic certified runtime only");
}

if (fleet.full_fleet_agent_count !== 350 || fleet.hard_cap !== 350) {
  fail("fleet count/cap must both equal 350");
}
if (fleet.canonical_role_count !== 48) fail("fleet must contain 48 canonical roles");

const roles = fleet.desks.flatMap((desk) =>
  desk.roles.map((role) => ({ ...role, desk: desk.id }))
);
if (roles.length !== 48) fail(`expected 48 role allocations, got ${roles.length}`);

const unique = new Set(roles.map((role) => role.role));
if (unique.size !== 48) fail("role names must be unique");

const total = roles.reduce((sum, role) => {
  if (!Number.isInteger(role.count) || role.count < 1) {
    fail(`role ${role.role} must have a positive integer count`);
  }
  return sum + role.count;
}, 0);
if (total !== 350) fail(`role allocations sum to ${total}, expected 350`);

const deskTotal = fleet.desks.reduce((sum, desk) => {
  const actual = desk.roles.reduce((s, role) => s + role.count, 0);
  if (actual !== desk.count) fail(`desk ${desk.id} count mismatch: ${actual} != ${desk.count}`);
  return sum + actual;
}, 0);
if (deskTotal !== 350) fail(`desk totals sum to ${deskTotal}, expected 350`);

const meshRoles = new Set(mesh.desks.flatMap((desk) => desk.roles));
for (const role of roles) {
  if (!meshRoles.has(role.role)) fail(`fleet role ${role.role} missing from mesh contract`);
}
if (meshRoles.size !== roles.length) fail("mesh/fleet canonical role sets differ");

console.log("PASS NQC_AGENT_FLEET_350");
console.log(JSON.stringify({
  operational_agents: total,
  hard_cap: fleet.hard_cap,
  canonical_roles: roles.length,
  desks: fleet.desks.length,
  llm_hot_path_allowed: mesh.llm_hot_path_allowed,
  execution_authority: mesh.execution_authority
}));
