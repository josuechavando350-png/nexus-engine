import test from 'node:test';
import assert from 'node:assert/strict';
import {
  unicodeSuffixArray, unicodeAdjacentLcp, unicodeKmpOccurrences,
} from '../core/layers/exact-string-algorithms.mjs';

function naiveSuffixOrder(points) {
  return Array.from({ length: points.length }, (_, index) => index).sort((a, b) => {
    while (a < points.length && b < points.length) {
      if (points[a] !== points[b]) return points[a] - points[b];
      a += 1; b += 1;
    }
    return Number(a < points.length) - Number(b < points.length);
  });
}
function naiveLcp(points, indices) {
  return indices.map((at, i) => {
    if (i === 0) return 0;
    let length = 0;
    const previous = indices[i - 1];
    while (at + length < points.length && previous + length < points.length
      && points[at + length] === points[previous + length]) length += 1;
    return length;
  });
}
function naiveMatches(text, pattern) {
  const positions = [];
  for (let i = 0; i + pattern.length <= text.length; i += 1) {
    if (pattern.every((value, j) => text[i + j] === value)) positions.push(i);
  }
  return positions;
}

const toCodePoints = (text) => Array.from(text, (character) => character.codePointAt(0));
let seed = 0x9E3779B9;
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
const alphabet = ['a', 'b', 'z', '😀', '\u0301', '𐐷'];
const randomString = (max) => Array.from({ length: random() % (max + 1) }, () => alphabet[random() % alphabet.length]).join('');

test('known cases, Unicode code points, overlaps, and independent deterministic oracles', () => {
  assert.deepEqual(unicodeSuffixArray({ text: 'banana' }).indices, [5, 3, 1, 0, 4, 2]);
  assert.deepEqual(unicodeAdjacentLcp({ text: 'banana' }).lcp, [0, 1, 3, 0, 0, 2]);
  assert.deepEqual(unicodeKmpOccurrences({ text: 'aaaa', pattern: 'aa' }).positions, [0, 1, 2]);
  assert.deepEqual(unicodeKmpOccurrences({ text: '😀a😀', pattern: '😀' }).positions, [0, 2]);
  assert.deepEqual(unicodeSuffixArray({ text: '' }).indices, []);
  assert.deepEqual(unicodeAdjacentLcp({ text: '' }).lcp, []);
  assert.deepEqual(unicodeKmpOccurrences({ text: '', pattern: 'a' }).positions, []);
  for (let caseIndex = 0; caseIndex < 400; caseIndex += 1) {
    const text = randomString(30);
    const pattern = randomString(9) || 'a';
    const points = toCodePoints(text);
    const expected = naiveSuffixOrder(points);
    const array = unicodeSuffixArray({ text });
    const adjacent = unicodeAdjacentLcp({ text });
    assert.deepEqual(array.indices, expected, `suffixes case ${caseIndex}`);
    assert.deepEqual(adjacent.indices, expected, `adjacent ordering case ${caseIndex}`);
    assert.deepEqual(adjacent.lcp, naiveLcp(points, expected), `lcp case ${caseIndex}`);
    assert.deepEqual(unicodeKmpOccurrences({ text, pattern }).positions,
      naiveMatches(points, toCodePoints(pattern)), `KMP case ${caseIndex}`);
  }
});

test('bounded inputs, malformed input, unsupported surrogate, and exact-key rejection', () => {
  for (const invalid of [null, [], {}, { text: 1 }, { text: 'a', extra: 1 }]) {
    assert.throws(() => unicodeSuffixArray(invalid), TypeError);
  }
  for (const invalid of [{ text: 'a' }, { text: 'a', pattern: '' }, { text: 'a', pattern: 'a', extra: true }]) {
    assert.throws(() => unicodeKmpOccurrences(invalid));
  }
  assert.throws(() => unicodeSuffixArray({ text: 'a'.repeat(2049) }), RangeError);
  assert.throws(() => unicodeAdjacentLcp({ text: 'a'.repeat(2049) }), RangeError);
  assert.throws(() => unicodeKmpOccurrences({ text: 'a'.repeat(8193), pattern: 'a' }), RangeError);
  assert.throws(() => unicodeKmpOccurrences({ text: 'a', pattern: 'a'.repeat(2049) }), RangeError);
  assert.throws(() => unicodeSuffixArray({ text: '\ud800' }), /unpaired surrogate/u);
  assert.throws(() => unicodeKmpOccurrences({ text: 'ok', pattern: '\udfff' }), /unpaired surrogate/u);
  const suffix = unicodeSuffixArray({ text: 'abc' });
  assert.throws(() => suffix.indices.push(5), TypeError);
});

test('maximum suffix capacity and long overlapping KMP input', () => {
  const text = 'a'.repeat(2048);
  const order = unicodeSuffixArray({ text }).indices;
  const lcp = unicodeAdjacentLcp({ text }).lcp;
  assert.equal(order.length, 2048);
  assert.equal(order[0], 2047);
  assert.equal(order[2047], 0);
  assert.equal(lcp[2047], 2047);
  const matches = unicodeKmpOccurrences({ text: 'a'.repeat(8192), pattern: 'a'.repeat(2048) });
  assert.equal(matches.count, 6145);
  assert.equal(matches.positions.at(-1), 6144);
});
