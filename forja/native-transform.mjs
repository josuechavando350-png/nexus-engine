// Deliberately small, auditable source transformation family. No model, network or command execution.
// Only an exact, single-line exported pure binary arrow is eligible.
const OPERATORS = ['+', '-', '*', '/'];
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const arrow = /^([ \t]*export[ \t]+const[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*=[ \t]*\([ \t]*([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*,[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\)[ \t]*=>[ \t]*)([A-Za-z_$][A-Za-z0-9_$]*)([ \t]*)([+*/-])([ \t]*)([A-Za-z_$][A-Za-z0-9_$]*)([ \t]*;[ \t]*)$/;

/** Enumerate changes in the selected function only; never mutate an arbitrary text match. */
export function nativeCandidates(source, spec) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 64 * 1024 ||
      !spec || spec.kind !== 'pure-binary-arithmetic' ||
      !identifier.test(spec.exportName) || Object.keys(spec).some((key) => !['kind', 'exportName'].includes(key))) {
    throw new Error('Native engine requires kind=pure-binary-arithmetic and one exportName');
  }
  const lines = source.split('\n');
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const match = arrow.exec(lines[i]);
    if (match && match[2] === spec.exportName) matches.push({ i, match });
  }
  if (matches.length !== 1) throw new Error('Native target must be one unambiguous pure exported binary arrow');
  const { i, match: m } = matches[0];
  if (m[3] === m[4] || m[3] !== m[5] || m[4] !== m[9]) {
    throw new Error('Native target must use its two distinct declared parameters exactly');
  }
  return OPERATORS.filter((op) => op !== m[7]).map((op) => {
    const next = [...lines];
    next[i] = `${m[1]}${m[5]}${m[6]}${op}${m[8]}${m[9]}${m[10]}`;
    return { content: next.join('\n'), transform: { kind: spec.kind, exportName: spec.exportName, from: m[7], to: op } };
  });
}
