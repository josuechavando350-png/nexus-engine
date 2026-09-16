import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256Canonical } from '../core/common.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { verifyGaussFoundationEvidence } from '../../walle/gauss-evidence-verify.mjs';

const problem = JSON.parse(await readFile(new URL('../fixtures/selftest-problem.json', import.meta.url), 'utf8'));
const report = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
const ids = [
 'GAUSS.MATH.ORIENTATION_2D.022',
 'GAUSS.MATH.SEGMENT_INTERSECTION.023',
 'GAUSS.MATH.CONVEX_HULL_2D.024',
 'GAUSS.MATH.POLYGON_SIGNED_AREA.025',
 'GAUSS.MATH.POLYGON_CENTROID.026',
 'GAUSS.MATH.POLYGON_PERIMETER.027',
 'GAUSS.MATH.POINT_POLYGON_LOCATION.028',
 'GAUSS.MATH.CLOSEST_PAIR_2D.029',
 'GAUSS.MATH.FARTHEST_PAIR_2D.030',
 'GAUSS.MATH.POINT_SEGMENT_PROJECTION.031',
 'GAUSS.MATH.LINE_INTERSECTION_2D.032',
 'GAUSS.MATH.PICK_LATTICE_INTERIOR.033',
 'GAUSS.MATH.CONVEX_POLYGON_DIAMETER.034',
];

test('all thirteen geometry operators run exactly once in WALLE replay', async () => {
 assert.equal(report.status, 'PASS');
 assert.equal(report.executedLayerCount, problem.tasks.length);
 assert.equal(new Set(problem.tasks.map(row => row.layerId)).size, problem.tasks.length);
 for (const id of ids) assert.equal(report.taskResults.filter(row => row.layerId === id).length, 1, id);
 const receipt = await verifyGaussFoundationEvidence({ problem, report });
 assert.equal(receipt.executedLayerCount, problem.tasks.length);
});

test('WALLE refuses each forged geometry output with rehashed task and report', async () => {
 for (const id of ids) {
  const fake = structuredClone(report);
  const result = fake.taskResults.find(row => row.layerId === id);
  assert(result, `missing geometry operator ${id}`);
  result.output = { ...result.output, forgedGeometryClaim: 1000 };
  result.outputSha256 = sha256Canonical(result.output);
  const { reportSha256: oldHash, ...unsigned } = fake;
  void oldHash;
  fake.reportSha256 = sha256Canonical(unsigned);
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u, `${id} accepted forged evidence`);
 }
});
