import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';

const adapter = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../local-model.mjs');
async function invoke(url, model='local-test') {
  const child = spawn(process.execPath, [adapter, `--url=${url}`, `--model=${model}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', (chunk) => stderr += chunk);
  child.stdin.end(JSON.stringify({ objective: 'repair a+b', files: [{ path: 'gauss/a.mjs', content: 'bug' }], diagnostics: 'fail' }));
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('talks to local inference over loopback and returns a real edit proposal', async (t) => {
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.method, 'POST');
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.model, 'local-test');
    assert.equal(JSON.parse(request.messages[1].content).files[0].path, 'gauss/a.mjs');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: [{ path: 'gauss/a.mjs', content: 'fixed' }] }) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const { code, stdout } = await invoke(`http://127.0.0.1:${server.address().port}/v1/chat/completions`);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { edits: [{ path: 'gauss/a.mjs', content: 'fixed' }] });
});

test('rejects external model URLs without making any request', async () => {
  const result = await invoke('https://example.com/v1/chat/completions');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Only HTTP 127\.0\.0\.1/);
});
