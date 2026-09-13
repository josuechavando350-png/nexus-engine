import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const legacyReaderUrl = new URL("../evidence/tenant-evidence.mjs", import.meta.url);
const versionedReaderUrl = new URL("../evidence/versioned-evidence-reader.mjs", import.meta.url);

async function assertReadOnlyFilesystemImports(sourceUrl) {
  const source = await readFile(sourceUrl, "utf8");
  const match = source.match(/import \{([^}]+)\} from "node:fs\/promises";/);
  assert.ok(match, "expected explicit node:fs/promises import");
  const imported = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(imported, ["lstat", "readFile", "readdir", "realpath"]);
  assert.doesNotMatch(source, /from "node:fs"/);
  assert.doesNotMatch(source, /node:child_process|node:worker_threads|node:net|node:http|node:https/);
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|mkdir|rename|rm|unlink|truncate|open)\b/);
}

test("legacy-compatible tenant evidence reader imports only read-only filesystem primitives", async () => {
  await assertReadOnlyFilesystemImports(legacyReaderUrl);
});

test("versioned evidence reader imports only read-only filesystem primitives", async () => {
  await assertReadOnlyFilesystemImports(versionedReaderUrl);
});
