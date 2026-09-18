// Bounded, deterministic Unicode-code-point string algorithms. No runtime dependencies.
const MAX_SUFFIX_CODE_POINTS = 2048;
const MAX_TEXT_CODE_POINTS = 8192;

function validateInput(input, keys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== keys.length
    || keys.some((key) => !Object.hasOwn(input, key))) {
    throw new TypeError(`input must contain exactly: ${keys.join(', ')}`);
  }
}

function codePoints(value, name, limit) {
  if (typeof value !== 'string' || value.length > limit * 2) {
    throw new TypeError(`${name} must be a string of at most ${limit} Unicode code points`);
  }
  const result = [];
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0xD800 && point <= 0xDFFF) {
      throw new TypeError(`${name} contains an unpaired surrogate`);
    }
    result.push(point);
    if (result.length > limit) throw new RangeError(`${name} exceeds ${limit} Unicode code points`);
  }
  return result;
}

function suffixOrder(points) {
  const n = points.length;
  const indices = Array.from({ length: n }, (_, index) => index);
  if (n < 2) return indices;
  let ranks = points.slice();
  let next = new Array(n);
  for (let span = 1; span < n; span *= 2) {
    const compare = (a, b) => ranks[a] - ranks[b]
      || (a + span < n ? ranks[a + span] : -1) - (b + span < n ? ranks[b + span] : -1);
    indices.sort(compare);
    next[indices[0]] = 0;
    for (let position = 1; position < n; position += 1) {
      next[indices[position]] = next[indices[position - 1]]
        + Number(compare(indices[position - 1], indices[position]) !== 0);
    }
    [ranks, next] = [next, ranks];
    if (ranks[indices[n - 1]] === n - 1) break;
  }
  return indices;
}

export function unicodeSuffixArray(input) {
  validateInput(input, ['text']);
  const points = codePoints(input.text, 'text', MAX_SUFFIX_CODE_POINTS);
  return Object.freeze({
    indices: Object.freeze(suffixOrder(points)),
    unit: 'UNICODE_CODE_POINT',
  });
}

export function unicodeAdjacentLcp(input) {
  validateInput(input, ['text']);
  const points = codePoints(input.text, 'text', MAX_SUFFIX_CODE_POINTS);
  const indices = suffixOrder(points);
  const n = points.length;
  const rank = new Array(n);
  const lcp = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) rank[indices[i]] = i;
  let shared = 0;
  for (let i = 0; i < n; i += 1) {
    const position = rank[i];
    if (position === 0) { shared = 0; continue; }
    const j = indices[position - 1];
    while (i + shared < n && j + shared < n && points[i + shared] === points[j + shared]) shared += 1;
    lcp[position] = shared;
    if (shared > 0) shared -= 1;
  }
  return Object.freeze({
    indices: Object.freeze(indices),
    lcp: Object.freeze(lcp),
    unit: 'UNICODE_CODE_POINT',
  });
}

export function unicodeKmpOccurrences(input) {
  validateInput(input, ['text', 'pattern']);
  const text = codePoints(input.text, 'text', MAX_TEXT_CODE_POINTS);
  const pattern = codePoints(input.pattern, 'pattern', MAX_SUFFIX_CODE_POINTS);
  if (pattern.length === 0) throw new RangeError('pattern must be nonempty');
  const prefix = new Array(pattern.length).fill(0);
  for (let i = 1, matched = 0; i < pattern.length; i += 1) {
    while (matched > 0 && pattern[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (pattern[i] === pattern[matched]) matched += 1;
    prefix[i] = matched;
  }
  const positions = [];
  for (let i = 0, matched = 0; i < text.length; i += 1) {
    while (matched > 0 && text[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (text[i] === pattern[matched]) matched += 1;
    if (matched === pattern.length) {
      positions.push(i + 1 - pattern.length);
      matched = prefix[matched - 1];
    }
  }
  return Object.freeze({
    positions: Object.freeze(positions),
    count: positions.length,
    unit: 'UNICODE_CODE_POINT',
  });
}
