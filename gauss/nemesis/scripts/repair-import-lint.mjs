/**
 * One-time mechanical migration of the imported Némesis v17 source to the
 * repository's existing ESLint contract. No ESLint rule is disabled.
 * Refuses unexpected diagnostics and refuses to change any file outside the
 * Némesis bridge and the imported src/test trees. Requires subsequent tests.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const reportPath = process.argv[2];
if (!reportPath) throw new Error('Usage: node repair-import-lint.mjs <eslint-json-report>');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const allowed = new Set([
  '@typescript-eslint/no-unused-vars', 'no-empty', 'no-control-regex',
  'no-useless-assignment', 'no-self-assign',
]);
const issues = report.flatMap(entry => (entry.messages ?? [])
  .filter(message => message.severity === 2)
  .map(message => ({ ...message, file: relative(root, entry.filePath).split(sep).join('/') })));
if (issues.length !== 63) throw new Error(`Expected the 63 reviewed ESLint failures; got ${issues.length}. Stop for review.`);
if (issues.some(issue => !allowed.has(issue.ruleId))) throw new Error('Unexpected ESLint rule: manual review required');
if (issues.some(issue => !(issue.file.startsWith('gauss/nemesis/engine/src/') ||
  issue.file.startsWith('gauss/nemesis/engine/test/') || issue.file === 'gauss/nemesis/engine/scripts/smoke-100.mjs' ||
  issue.file === 'gauss/nemesis/native-fhe.mjs'))) throw new Error('Unexpected ESLint file: manual review required');

const group = new Map();
for (const issue of issues) {
  if (!group.has(issue.file)) group.set(issue.file, []);
  group.get(issue.file).push(issue);
}
const fixed = [];
for (const [path, messages] of group) {
  const filename = resolve(root, path);
  const before = readFileSync(filename, 'utf8');
  const sf = ts.createSourceFile(filename, before, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sf.parseDiagnostics.length) throw new Error(`Cannot parse ${path} with TypeScript`);
  const unused = messages.filter(m => m.ruleId === '@typescript-eslint/no-unused-vars');
  const imports = new Map(), declarations = new Map(), params = new Map();
  const handled = new Set();
  const edits = [];
  const addEdit = (start, end, text) => {
    if (edits.some(e => start < e.end && end > e.start)) throw new Error(`Overlapping patches: ${path}`);
    edits.push({start, end, text});
  };
  const candidates = [];
  function gather(node) {
    if ((ts.isImportSpecifier(node) || ts.isVariableDeclaration(node) ||
      ts.isParameter(node) || ts.isBindingElement(node)) && node.name && ts.isIdentifier(node.name)) {
      const lc = sf.getLineAndCharacterOfPosition(node.name.getStart(sf));
      candidates.push({node, name:node.name.text, line:lc.line+1, column:lc.character+1});
    }
    ts.forEachChild(node, gather);
  }
  gather(sf);
  const assigned = new Map();
  for (const diagnostic of unused) {
    const name = /^'([^']+)'/.exec(diagnostic.message)?.[1];
    const matches = candidates.filter(c => c.name === name && c.line === diagnostic.line)
      .sort((a,b) => Math.abs(a.column-diagnostic.column)-Math.abs(b.column-diagnostic.column));
    if (!matches.length || Math.abs(matches[0].column-diagnostic.column)>9 ||
      (matches.length>1 && Math.abs(matches[0].column-diagnostic.column) === Math.abs(matches[1].column-diagnostic.column))) {
      throw new Error(`Ambiguous ESLint location in ${path}:${diagnostic.line}:${diagnostic.column}: ${name}`);
    }
    if (!assigned.has(matches[0].node)) assigned.set(matches[0].node, []);
    assigned.get(matches[0].node).push(diagnostic);
  }
  const findUnused = node => assigned.get(node) ?? [];
  function visit(node) {
    if (ts.isImportSpecifier(node)) {
      const matched = findUnused(node);
      if (matched.length) {
        const owner = node.parent.parent.parent;
        if (!imports.has(owner)) imports.set(owner, new Set());
        imports.get(owner).add(node);
        matched.forEach(m => handled.add(m));
      }
    } else if (ts.isVariableDeclaration(node)) {
      const matched = findUnused(node);
      if (matched.length) {
        const owner = node.parent.parent;
        if (!ts.isVariableStatement(owner)) throw new Error(`Non-statement unused binding in ${path}`);
        if (!declarations.has(owner)) declarations.set(owner, new Set());
        declarations.get(owner).add(node);
        matched.forEach(m => handled.add(m));
      }
    } else if (ts.isParameter(node)) {
      const matched = findUnused(node);
      if (matched.length) {
        const owner = node.parent;
        if (!params.has(owner)) params.set(owner, new Set());
        params.get(owner).add(node);
        matched.forEach(m => handled.add(m));
      }
    } else if (ts.isBindingElement(node)) {
      const matched = findUnused(node);
      if (matched.length) {
        if (!['note', 'kind', 'targets', 'output', 'mode'].includes(node.name.text)) {
          throw new Error(`Unexpected unused destructuring ${node.name.text} in ${path}`);
        }
        matched.forEach(m => handled.add(m));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (handled.size !== unused.length) {
    throw new Error(`Unmapped unused bindings in ${path}: ${unused.filter(m => !handled.has(m)).map(m => `${m.line}:${m.column} ${m.message}`).join('; ')}`);
  }
  for (const [statement, removed] of imports) {
    if (!statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) {
      throw new Error(`Unsupported import form: ${path}`);
    }
    const kept = statement.importClause.namedBindings.elements.filter(e => !removed.has(e));
    if (statement.importClause.name) throw new Error(`Review mixed default import: ${path}`);
    const replacement = kept.length
      ? `import {${kept.map(e => e.getText(sf)).join(', ')}} from ${statement.moduleSpecifier.getText(sf)};`
      : `import ${statement.moduleSpecifier.getText(sf)};`;
    addEdit(statement.getStart(sf), statement.end, replacement);
  }
  for (const [statement, removed] of declarations) {
    const list = statement.declarationList;
    if (!ts.isVariableDeclarationList(list)) throw new Error(`Invalid variable list: ${path}`);
    const keyword = (list.flags & ts.NodeFlags.Const) ? 'const' : (list.flags & ts.NodeFlags.Let) ? 'let' : 'var';
    const pieces = [];
    for (const item of list.declarations) {
      if (!removed.has(item)) {
        pieces.push(`${keyword} ${item.getText(sf)};`);
      } else if (item.initializer) {
        const init = item.initializer;
        // Preserve validation, getter evaluation and throws from removed calls.
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) ||
          ts.isNumericLiteral(init) || ts.isStringLiteral(init)) continue;
        const expr = init.getText(sf);
        pieces.push(ts.isCallExpression(init) || ts.isNewExpression(init) ? `${expr};` : `void (${expr});`);
      }
    }
    addEdit(statement.getStart(sf), statement.end, pieces.join(''));
  }
  for (const [fn, removed] of params) {
    const original = [...fn.parameters];
    const kept = original.filter(p => !removed.has(p));
    if (original.some((p, i) => removed.has(p) && kept.some(k => original.indexOf(k) > i))) {
      throw new Error(`Non-trailing unused parameter requires manual review: ${path}`);
    }
    if (!original.length) throw new Error(`Empty original parameters: ${path}`);
    const start = original[0].getStart(sf), end = original.at(-1).end;
    if (original.length === 1 && ts.isArrowFunction(fn) && before[start - 1] !== '(') {
      addEdit(start, end, kept.length ? kept[0].getText(sf) : '()');
    } else {
      addEdit(start, end, kept.map(p => p.getText(sf)).join(', '));
    }
  }
  edits.sort((a,b) => b.start - a.start);
  let content = before;
  for (const edit of edits) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  const strictReplace = (from, to, expected = 1) => {
    const occurrences = content.split(from).length - 1;
    if (occurrences !== expected) throw new Error(`${path}: expected ${expected} occurrences of ${from.slice(0,50)}, found ${occurrences}`);
    content = content.split(from).join(to);
  };
  if (path.endsWith('/smoke-100.mjs')) {
    strictReplace('.map(({output,...r})=>r)', '.map(result=>{const r={...result};delete r.output;return r;})');
  }
  if (path.endsWith('/linear-execution-nizk.mjs')) {
    strictReplace('const {mode,...rest}=input;return proveLinearExecution(rest);', 'const rest={...input};delete rest.mode;return proveLinearExecution(rest);');
  }
  if (path.endsWith('/certainty-contract.mjs')) {
    strictReplace('const {engine,reportHash,note,...body}=report;', 'const {engine,reportHash,...body}=report;delete body.note;');
  }
  if (path.endsWith('/motors-82-100.test.mjs')) {
    strictReplace('.map(({kind,...v})=>v)', '.map(record=>{const v={...record};delete v.kind;return v;})');
  }
  if (path.endsWith('/neural-training.test.mjs')) {
    strictReplace('.map(({targets,...s})=>s)', '.map(sequence=>{const s={...sequence};delete s.targets;return s;})');
  }
  if (messages.some(m => m.ruleId === 'no-useless-assignment')) {
    if (path.endsWith('/batch-82-88.mjs')) strictReplace('residual=Infinity,count=0', 'residual,count=0');
    else if (path.endsWith('/finite-mean-field-game.mjs')) strictReplace('residual=Infinity,used=0', 'residual,used=0');
    else throw new Error(`Unexpected useless assignment: ${path}`);
  }
  if (messages.some(m => m.ruleId === 'no-self-assign')) {
    if (!path.endsWith('/motors-06-10.test.mjs')) throw new Error(`Unexpected self-assign: ${path}`);
    strictReplace('filter.push({x,p}); x=x; p+=0.1;', 'filter.push({x,p}); p+=0.1;');
  }
  const control = messages.filter(m => m.ruleId === 'no-control-regex');
  if (control.length) {
    const pattern = /\/\[\\x00-\\x1f\]\/\.test\((\w+)\)/g;
    let count = 0;
    content = content.replace(pattern, (_match, variable) => {
      count++;
      return `Array.from(${variable}).some(char=>char.charCodeAt(0)<32)`;
    });
    if (count !== control.length) throw new Error(`Unexpected control regex: ${path}`);
  }
  const noEmpty = messages.filter(m => m.ruleId === 'no-empty');
  if (noEmpty.length) {
    let count = 0;
    content = content.replace(/catch\s*\{\s*\}/g, () => {
      count++;
      return 'catch{/* Ignore this secondary error; the surrounding path handles failure. */}';
    });
    if (count !== noEmpty.length) throw new Error(`Unexpected empty block: ${path}`);
  }
  const after = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (after.parseDiagnostics.length) throw new Error(`Patch produced invalid JS: ${path}: ${after.parseDiagnostics[0].messageText}`);
  if (before === content) throw new Error(`No change for ${path}`);
  writeFileSync(filename, content);
  fixed.push({file:path, issues:messages.length});
}
const engine = resolve(root, 'gauss/nemesis/engine');
function digest(directory, extension) {
  const files = [];
  const walk = where => {
    for (const entry of readdirSync(where).sort()) {
      const abs = join(where, entry), st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`Symlink not allowed: ${abs}`);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && abs.endsWith(extension)) files.push(abs);
    }
  };
  walk(join(engine, directory));
  const hash = createHash('sha256');
  for (const abs of files) hash.update(relative(engine, abs).split(sep).join('/')).update('\0').update(readFileSync(abs)).update('\0');
  return {count:files.length, sha256:hash.digest('hex')};
}
const lockPath = resolve(root, 'gauss/nemesis/source-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
for (const [directory, extension] of [['src','.mjs'], ['test','.test.mjs'], ['examples','.json']]) {
  const next = digest(directory, extension);
  if (lock[directory].count !== next.count || (directory === 'examples' && lock[directory].sha256 !== next.sha256)) {
    throw new Error(`Source file count or unchanged examples digest mismatch: ${directory}`);
  }
  lock[directory] = next;
}
lock.reviewedChangesFromOrigin.push(`Némesis v17 imported JS lint-only cleanup: ${issues.length} ESLint diagnostics in ${fixed.length} files; source diffs and functional tests required before merging; original ZIP remains pinned separately`);
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({status:'LINT_PATCH_APPLIED_NOT_CERTIFIED', diagnosticCount:issues.length, changedFiles:fixed, sourceHash:lock.src.sha256, testHash:lock.test.sha256}, null, 2));
