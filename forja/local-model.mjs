#!/usr/bin/env node
// Optional loopback-only adapter for an operator-run OpenAI-compatible local inference server.
const MAX_BYTES = 256 * 1024;
const args = process.argv.slice(2);
const urlArg = args.find((arg) => arg.startsWith('--url='));
const modelArg = args.find((arg) => arg.startsWith('--model='));
const url = urlArg?.slice(6) ?? 'http://127.0.0.1:8080/v1/chat/completions';
const model = modelArg?.slice(8);
const fail = (reason) => { throw new Error(reason); };

async function main() {
  if (args.some((arg) => !arg.startsWith('--url=') && !arg.startsWith('--model=')) || !model || model.length > 200) fail('Specify --model=<local-model-name>');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== '/v1/chat/completions') fail('Only HTTP 127.0.0.1 /v1/chat/completions is allowed');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_BYTES) fail('Model request exceeds byte budget');
  }
  const task = JSON.parse(input);
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(110_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, stream: false, messages: [
      { role: 'system', content: 'You are a bounded code repair model. Return ONLY a JSON object {"edits":[{"path":"...","content":"full UTF-8 file"}]}. Edit ONLY the supplied source files, never tests. Fix the failing regression without hiding or disabling it. No commands, markdown, or commentary.' },
      { role: 'user', content: JSON.stringify(task) },
    ] }),
  });
  if (!response.ok) fail(`Local inference HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) fail('Inference response too large');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); fail('Inference response too large'); }
    chunks.push(Buffer.from(value));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') fail('Inference response lacks choices[0].message.content');
  const proposal = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!proposal || !Array.isArray(proposal.edits)) fail('Model did not propose edits');
  process.stdout.write(JSON.stringify(proposal));
}

try { await main(); } catch (error) { console.error(`Local inference: ${error.message}`); process.exitCode = 1; }
