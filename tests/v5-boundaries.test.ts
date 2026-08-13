import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
describe('V5 boundaries',()=>{it('control core does not depend on UI',()=>{const s=fs.readFileSync('runtime/crates/nexus-control-plane/Cargo.toml','utf8');expect(s).not.toMatch(/react|next|control-sdk/)});it('secrets contract never exposes plaintext',()=>{const s=fs.readFileSync('runtime/crates/nexus-secrets-v5/src/lib.rs','utf8');expect(s).not.toContain('secret_value')});});
