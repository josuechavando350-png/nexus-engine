// Reporter is loaded by Node's test runner, outside the candidate worktree.
// Test stdout is data, never an authority for the final machine-readable receipt.
export default async function* forjaTestEventReporter(source) {
  const tests = [];
  let plan = null;
  const diagnostics = [];
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      tests.push({
        name: d.name,
        file: d.file,
        line: d.line,
        column: d.column,
        nesting: d.nesting,
        passed: event.type === 'test:pass',
        skipped: Boolean(d.skip),
        todo: Boolean(d.todo),
      });
      if (event.type === 'test:fail') {
        diagnostics.push(`${d.file ?? ''}: ${d.name}: ${d.details?.error?.message ?? d.details?.error?.cause?.message ?? 'test failed'}`);
      }
    } else if (event.type === 'test:plan' && event.data.nesting === 0) {
      plan = event.data.count;
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      diagnostics.push(String(event.data.message).slice(-2000));
    }
    if (tests.length > 20000) throw new Error('Too many tests for a bounded FORJA run');
  }
  yield JSON.stringify({ schemaVersion: 1, tests, plan, diagnostics: diagnostics.join('\n').slice(-12000) });
}
