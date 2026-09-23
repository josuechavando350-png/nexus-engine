//! Explicit client/evaluator separation for the Némesis #89 boolean TFHE backend.
//! Linux-only, local, experimental file transport. Evaluation never loads a ClientKey.
//! This is NOT an authenticated remote protocol or a production key-management system.
#![cfg(unix)]
use bincode::Options;
use nemesis_fhe::{Circuit, Gate};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use tfhe::boolean::gen_keys;
use tfhe::boolean::prelude::*;

const MAX_KEY: usize = 256 * 1024 * 1024;
const MAX_CIPHERTEXT: usize = 128 * 1024 * 1024;
const MAX_BITS: usize = 128;
const MAX_GATES: usize = 2048;
const MAX_OUTPUTS: usize = 128;
const VERSION: u16 = 1;

#[derive(Serialize, Deserialize)]
struct Envelope<T> {
    version: u16,
    key_id: [u8; 32],
    body: T,
}

fn codec() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .reject_trailing_bytes()
}
fn serialize<T: Serialize>(value: &T, max: usize) -> Result<Vec<u8>, String> {
    let bytes = codec().with_limit(max as u64).serialize(value).map_err(|_| "artifact serialization failed")?;
    if bytes.len() > max { return Err("artifact exceeds size budget".into()); }
    Ok(bytes)
}
fn verify_private_parent(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() { return Err("private key requires absolute path".into()); }
    let parent = p.parent().ok_or("private key requires parent directory")?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| "cannot inspect private key directory")?;
    // The local private key must never be created or read from a group-writable,
    // world-readable or symlinked parent. This does not protect against the same UID.
    if !metadata.file_type().is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("unsafe private key directory".into());
    }
    Ok(())
}
fn read_file(path: &str, max: usize, private_key: bool) -> Result<Vec<u8>, String> {
    // Do not follow symlinks, special devices or files replaced between validation and open.
    // A private key must be single-linked and inaccessible to group and other users.
    if private_key { verify_private_parent(path)?; }
    let before = fs::symlink_metadata(path).map_err(|_| "cannot read artifact")?;
    if !before.file_type().is_file() || (private_key && before.nlink() != 1) {
        return Err("unsafe artifact type or link count".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // Linux O_NOFOLLOW: reject even a symlink introduced after symlink_metadata().
    #[cfg(target_os = "linux")]
    options.custom_flags(0o400000);
    let file = options.open(path).map_err(|_| "cannot read artifact")?;
    let opened = file.metadata().map_err(|_| "cannot inspect artifact")?;
    if !opened.file_type().is_file() || before.dev() != opened.dev() || before.ino() != opened.ino()
        || (private_key && (opened.nlink() != 1 || opened.permissions().mode() & 0o077 != 0)) {
        return Err("unsafe artifact permissions or identity".into());
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes).map_err(|_| "cannot read artifact")?;
    if bytes.len() > max { return Err("artifact exceeds size budget".into()); }
    Ok(bytes)
}
fn load<T: DeserializeOwned>(path: &str, max: usize, private_key: bool) -> Result<Envelope<T>, String> {
    let bytes = read_file(path, max, private_key)?;
    let envelope: Envelope<T> = codec().with_limit(max as u64).deserialize(&bytes).map_err(|_| "invalid artifact")?;
    if envelope.version != VERSION { return Err("unsupported artifact version".into()); }
    Ok(envelope)
}
fn save(path: &str, bytes: &[u8]) -> Result<(u64, u64), String> {
    // create_new rejects existing files and symlinks; 0600 prevents other local users reading keys.
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
        .open(path).map_err(|_| "cannot create new artifact")?;
    let created = file.metadata().map_err(|_| "cannot inspect new artifact")?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        // Do not unlink a different file substituted at the destination after creation.
        drop(file);
        if let Ok(current) = fs::symlink_metadata(path) {
            if current.dev() == created.dev() && current.ino() == created.ino() {
                let _ = fs::remove_file(path);
            }
        }
        return Err("cannot persist artifact".into());
    }
    Ok((created.dev(), created.ino()))
}
fn key_id(server: &ServerKey) -> Result<[u8; 32], String> {
    let bytes = serialize(server, MAX_KEY)?;
    Ok(Sha256::digest(bytes).into())
}
fn read_bits() -> Result<Vec<bool>, String> {
    let mut raw = Vec::new();
    io::stdin().take(MAX_BITS as u64 + 1).read_to_end(&mut raw).map_err(|_| "cannot read private input")?;
    if raw.is_empty() || raw.len() > MAX_BITS || raw.iter().any(|b| !matches!(*b, b'0' | b'1')) {
        return Err("private input must contain 1..128 binary digits".into());
    }
    Ok(raw.into_iter().map(|b| b == b'1').collect())
}
fn index(raw: &str) -> Result<usize, String> {
    if raw.is_empty() || (raw.len() > 1 && raw.starts_with('0')) || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err("noncanonical wire index".into());
    }
    raw.parse().map_err(|_| "wire index out of range".into())
}
fn circuit(inputs: usize, gates: &str, outputs: &str) -> Result<Circuit, String> {
    if inputs == 0 || inputs > MAX_BITS || gates.len() > 65_536 || outputs.len() > 4_096 {
        return Err("circuit input or topology budget exceeded".into());
    }
    let mut parsed = Vec::new();
    if !gates.is_empty() {
        if gates.bytes().filter(|b| *b == b';').count() >= MAX_GATES {
            return Err("gate budget exceeded".into());
        }
        for raw in gates.split(';') {
            let parts: Vec<&str> = raw.split(':').collect();
            let gate = match parts.as_slice() {
                ["not", a] => Gate::Not(index(a)?),
                ["and", a, b] => Gate::And(index(a)?, index(b)?),
                ["or", a, b] => Gate::Or(index(a)?, index(b)?),
                ["xor", a, b] => Gate::Xor(index(a)?, index(b)?),
                ["nand", a, b] => Gate::Nand(index(a)?, index(b)?),
                ["nor", a, b] => Gate::Nor(index(a)?, index(b)?),
                ["xnor", a, b] => Gate::Xnor(index(a)?, index(b)?),
                ["mux", s, a, b] => Gate::Mux(index(s)?, index(a)?, index(b)?),
                _ => return Err("malformed circuit gate".into()),
            };
            parsed.push(gate);
        }
    }
    let output_wires: Vec<usize> = if outputs.is_empty() { vec![] } else {
        outputs.split(',').map(index).collect::<Result<_, _>>()?
    };
    if output_wires.len() > MAX_OUTPUTS { return Err("output budget exceeded".into()); }
    let result = Circuit { inputs, gates: parsed, outputs: output_wires };
    result.validate()?;
    Ok(result)
}
fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [_, "keygen", client_path, server_path] => {
            if client_path == server_path { return Err("keys require distinct files".into()); }
            verify_private_parent(client_path)?;
            let (client, server) = gen_keys();
            let id = key_id(&server)?;
            let client_bytes = serialize(&Envelope { version: VERSION, key_id: id, body: client }, MAX_KEY)?;
            let server_bytes = serialize(&Envelope { version: VERSION, key_id: id, body: server }, MAX_KEY)?;
            let client_identity = save(client_path, &client_bytes)?;
            if let Err(error) = save(server_path, &server_bytes) {
                // Do not strand an incomplete secret; do not unlink an artifact
                // substituted for our private key during the failed pair write.
                let owned = fs::symlink_metadata(client_path)
                    .map(|m| m.file_type().is_file() && (m.dev(), m.ino()) == client_identity)
                    .unwrap_or(false);
                if !owned || fs::remove_file(client_path).is_err() {
                    return Err("cannot complete key pair or safely remove incomplete secret".into());
                }
                return Err(error);
            }
            Ok(())
        }
        [_, "encrypt", client_path, ciphertext_path] => {
            let bits = read_bits()?; // Private values only via stdin, never process argv.
            let client: Envelope<ClientKey> = load(client_path, MAX_KEY, true)?;
            let encrypted: Vec<Ciphertext> = bits.into_iter().map(|bit| client.body.encrypt(bit)).collect();
            let bytes = serialize(&Envelope { version: VERSION, key_id: client.key_id, body: encrypted }, MAX_CIPHERTEXT)?;
            save(ciphertext_path, &bytes).map(|_| ())
        }
        [_, "evaluate", server_path, input_path, output_path, gates, outputs] => {
            // Evaluator has no secret-key path, deserializer or decrypt operation.
            let server: Envelope<ServerKey> = load(server_path, MAX_KEY, false)?;
            if key_id(&server.body)? != server.key_id { return Err("server key identity mismatch".into()); }
            let inputs: Envelope<Vec<Ciphertext>> = load(input_path, MAX_CIPHERTEXT, false)?;
            if server.key_id != inputs.key_id { return Err("ciphertext belongs to another key".into()); }
            let circuit = circuit(inputs.body.len(), gates, outputs)?;
            let evaluated = circuit.evaluate(&server.body, &inputs.body)?;
            let bytes = serialize(&Envelope { version: VERSION, key_id: server.key_id, body: evaluated }, MAX_CIPHERTEXT)?;
            save(output_path, &bytes).map(|_| ())
        }
        [_, "decrypt", client_path, output_path] => {
            let client: Envelope<ClientKey> = load(client_path, MAX_KEY, true)?;
            let output: Envelope<Vec<Ciphertext>> = load(output_path, MAX_CIPHERTEXT, false)?;
            if client.key_id != output.key_id || output.body.is_empty() || output.body.len() > MAX_OUTPUTS {
                return Err("wrong key or invalid output count".into());
            }
            let bits: String = output.body.iter().map(|ct| if client.body.decrypt(ct) { '1' } else { '0' }).collect();
            println!("{bits}");
            Ok(())
        }
        _ => Err("usage: nemesis89_roles keygen <client.key> <server.key> | encrypt <client.key> <inputs.ct> | evaluate <server.key> <inputs.ct> <outputs.ct> <gates> <wires> | decrypt <client.key> <outputs.ct>".into()),
    }
}
fn main() {
    if let Err(error) = run() {
        // These are fixed errors only: never print paths, raw errors, keys or ciphertexts.
        eprintln!("NEMESIS_89_ROLES_ERROR: {error}");
        std::process::exit(1);
    }
}
