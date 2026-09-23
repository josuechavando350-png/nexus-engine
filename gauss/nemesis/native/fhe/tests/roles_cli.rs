//! Real separate OS processes: the evaluator receives only a server key and ciphertext.
#![cfg(unix)]
use std::fs::{self, Permissions};
use std::io::Write;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn run(args: &[&str], input: Option<&[u8]>) -> std::process::Output {
    let bin = env!("CARGO_BIN_EXE_nemesis89_roles");
    let mut child = Command::new(bin).args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    if let Some(bytes) = input { child.stdin.take().unwrap().write_all(bytes).unwrap(); }
    child.wait_with_output().unwrap()
}

#[test]
fn separate_client_and_evaluator_processes_enforce_key_roles() {
    let root = std::env::temp_dir().join(format!("nemesis89-roles-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir(&root).unwrap();
    let path = |name: &str| root.join(name).to_str().unwrap().to_string();
    let client = path("client.key");
    let server = path("server.key");
    let input = path("input.ct");
    let output = path("output.ct");
    let wrong = path("wrong.ct");

    // Do not generate sensitive key material in a directory accessible to other users.
    fs::set_permissions(&root, Permissions::from_mode(0o755)).unwrap();
    let rejection = run(&["keygen", &client, &server], None);
    assert!(!rejection.status.success(), "insecure parent accepted private key generation");
    assert!(!root.join("client.key").exists());
    assert!(!root.join("server.key").exists());
    fs::set_permissions(&root, Permissions::from_mode(0o700)).unwrap();

    // Force failure on the SECOND key write and prove the first secret is removed.
    // The existing server artifact must not be overwritten or deleted.
    fs::write(&server, b"pre-existing server artifact").unwrap();
    let rejection = run(&["keygen", &client, &server], None);
    assert!(!rejection.status.success(), "existing evaluator key must reject keygen");
    assert!(!root.join("client.key").exists(), "keygen stranded a private key");
    assert_eq!(fs::read(&server).unwrap(), b"pre-existing server artifact");
    fs::remove_file(&server).unwrap();

    let status = run(&["keygen", &client, &server], None);
    assert!(status.status.success(), "key generation failed");
    assert!(status.stdout.is_empty(), "key material reached stdout");
    assert_eq!(fs::metadata(&client).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::metadata(&server).unwrap().permissions().mode() & 0o777, 0o600);

    fs::set_permissions(&root, Permissions::from_mode(0o755)).unwrap();
    let rejection = run(&["encrypt", &client, &input], Some(b"101"));
    assert!(!rejection.status.success(), "private key from exposed directory accepted");
    assert!(!root.join("input.ct").exists());
    fs::set_permissions(&root, Permissions::from_mode(0o700)).unwrap();

    // An accidentally exposed, linked or redirected client key must not be consumed.
    fs::set_permissions(&client, Permissions::from_mode(0o644)).unwrap();
    let rejection = run(&["encrypt", &client, &input], Some(b"101"));
    assert!(!rejection.status.success(), "world-readable private key accepted");
    assert!(!root.join("input.ct").exists());
    fs::set_permissions(&client, Permissions::from_mode(0o600)).unwrap();

    let client_link = path("client-link.key");
    symlink(&client, &client_link).unwrap();
    let rejection = run(&["encrypt", &client_link, &input], Some(b"101"));
    assert!(!rejection.status.success(), "symlink to private key accepted");
    assert!(!root.join("input.ct").exists());
    fs::remove_file(&client_link).unwrap();

    let hardlink = path("client-hardlink.key");
    fs::hard_link(&client, &hardlink).unwrap();
    let rejection = run(&["encrypt", &client, &input], Some(b"101"));
    assert!(!rejection.status.success(), "multiply linked private key accepted");
    assert!(!root.join("input.ct").exists());
    fs::remove_file(&hardlink).unwrap();

    let status = run(&["encrypt", &client, &input], Some(b"101"));
    assert!(status.status.success(), "client encryption failed");
    assert!(status.stdout.is_empty());

    let server_link = path("server-link.key");
    symlink(&server, &server_link).unwrap();
    let rejection = run(&["evaluate", &server_link, &input, &path("reject-link.ct"), "", "0"], None);
    assert!(!rejection.status.success(), "symlinked server key accepted");
    assert!(!root.join("reject-link.ct").exists());
    fs::remove_file(&server_link).unwrap();

    let input_link = path("input-link.ct");
    symlink(&input, &input_link).unwrap();
    let rejection = run(&["evaluate", &server, &input_link, &path("reject-input.ct"), "", "0"], None);
    assert!(!rejection.status.success(), "symlinked ciphertext accepted");
    assert!(!root.join("reject-input.ct").exists());
    fs::remove_file(&input_link).unwrap();

    // No client key is available in evaluator arguments or in its working directory.
    let status = run(&["evaluate", &server, &input, &output,
        "xor:0:1;mux:2:3:0;not:4", "3,4,5"], None);
    assert!(status.status.success(), "ciphertext-only evaluation failed");
    assert!(status.stdout.is_empty(), "plaintext leaked from evaluator");

    fs::set_permissions(&root, Permissions::from_mode(0o755)).unwrap();
    let rejection = run(&["decrypt", &client, &output], None);
    assert!(!rejection.status.success(), "decryption accepted private key from exposed directory");
    assert!(rejection.stdout.is_empty(), "rejected decryption exposed plaintext");
    fs::set_permissions(&root, Permissions::from_mode(0o700)).unwrap();

    fs::set_permissions(&client, Permissions::from_mode(0o640)).unwrap();
    let rejection = run(&["decrypt", &client, &output], None);
    assert!(!rejection.status.success(), "group-readable private key accepted for decryption");
    assert!(rejection.stdout.is_empty(), "rejected decryption exposed plaintext");
    fs::set_permissions(&client, Permissions::from_mode(0o600)).unwrap();
    let decrypted = run(&["decrypt", &client, &output], None);
    assert!(decrypted.status.success(), "client decryption failed");
    assert_eq!(decrypted.stdout, b"110\n");

    // Reject a ciphertext declaring the wrong key ID before any FHE operation.
    let mut altered = fs::read(&input).unwrap();
    altered[2] ^= 1; // u16 version is first, then 32-byte key identifier.
    fs::write(&wrong, altered).unwrap();
    let rejection = run(&["evaluate", &server, &wrong, &path("reject.ct"), "", "0"], None);
    assert!(!rejection.status.success());
    assert!(!root.join("reject.ct").exists());

    // The evaluator cannot use a ClientKey where a ServerKey is required.
    let rejection = run(&["evaluate", &client, &input, &path("reject2.ct"), "", "0"], None);
    assert!(!rejection.status.success());
    assert!(!root.join("reject2.ct").exists());

    // Existing output artifacts cannot be overwritten or redirected via a symlink.
    let rejection = run(&["evaluate", &server, &input, &output, "", "0"], None);
    assert!(!rejection.status.success());
    let _ = fs::set_permissions(&root, Permissions::from_mode(0o700));
    fs::remove_dir_all(&root).unwrap();
}
