import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWalleReceipt } from '../walle-executed-probe.mjs';

const revision = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const reportSha256 = `sha256:${'c'.repeat(64)}`;
const axiomaSha256 = `sha256:${'d'.repeat(64)}`;
const identity = { sourceRevision: revision, sourceTree: tree, reportSha256, axiomaSha256 };
const lines = [
  `WALLE_GAUSS_SOURCE_REVISION=${revision}`,
  `WALLE_GAUSS_SOURCE_TREE=${tree}`,
  'WALLE_GAUSS_TARGET_LAYERS=1000',
  'WALLE_GAUSS_IMPLEMENTED_LAYERS=1000',
  'WALLE_GAUSS_QUANTUM_EXECUTED=true',
  'WALLE_GAUSS_PHYSICAL_QPU_EXECUTED=false',
  'WALLE_GAUSS_FOUNDATION_CLAIM=true',
  `WALLE_GAUSS_REPORT_SHA256=${reportSha256}`,
  `WALLE_AXIOMA_EVIDENCE_SHA256=${axiomaSha256}`,
  `WALLE_AXIOMA_SOURCE_REVISION=${revision}`,
  'WALLE_GAUSS_FULL_CATALOG_CERTIFIED=true',
];

function mutate(action) {
  const copy = [...lines];
  action(copy);
  return copy.join('\n');
}

test('accepts a complete, fixture-bound synthetic WALLE receipt', () => {
  const receipt = assertWalleReceipt(lines.join('\n'), identity);
  assert.equal(receipt.implementedLayers, 1000);
});
test('accepts duplicate matching implemented count emitted by both real adapter and verifier', () => {
  const receipt = assertWalleReceipt([...lines, 'WALLE_GAUSS_IMPLEMENTED_LAYERS=1000'].join('\n'), identity);
  assert.equal(receipt.implementedLayers, 1000);
});
test('rejects conflicting repeated implemented count', () => {
  assert.throws(() => assertWalleReceipt([...lines, 'WALLE_GAUSS_IMPLEMENTED_LAYERS=0'].join('\n'), identity), /conflicting/);
});
test('rejects missing AXIOMA evidence', () => {
  assert.throws(() => assertWalleReceipt(mutate((copy) => copy.splice(8, 1)), identity), /missing or extra/);
});
test('rejects false physical QPU claim', () => {
  assert.throws(() => assertWalleReceipt(mutate((copy) => { copy[5] = 'WALLE_GAUSS_PHYSICAL_QPU_EXECUTED=true'; }), identity), /PHYSICAL_QPU/);
});
test('rejects mismatched source revision', () => {
  assert.throws(() => assertWalleReceipt(mutate((copy) => { copy[0] = `WALLE_GAUSS_SOURCE_REVISION=${'f'.repeat(40)}`; }), identity), /SOURCE_REVISION/);
});
test('rejects false layer count', () => {
  assert.throws(() => assertWalleReceipt(mutate((copy) => { copy[3] = 'WALLE_GAUSS_IMPLEMENTED_LAYERS=999'; }), identity), /IMPLEMENTED_LAYERS/);
});
test('rejects forged report digest', () => {
  assert.throws(() => assertWalleReceipt(mutate((copy) => { copy[7] = `WALLE_GAUSS_REPORT_SHA256=sha256:${'e'.repeat(64)}`; }), identity), /REPORT_SHA256/);
});
test('rejects unexpected WALLE evidence keys', () => {
  assert.throws(() => assertWalleReceipt([...lines, 'WALLE_FAKE_PASS=true'].join('\n'), identity), /missing or extra/);
});
