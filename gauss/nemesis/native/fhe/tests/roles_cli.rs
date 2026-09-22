//! Real separate OS processes: the evaluator receives only a server key and ciphertext.
#![cfg(unix)]
use std::fs::{self, Permissions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
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
    let status = run(&["keygen", &client, &server], None);
    assert!(status.status.success(), "key generation failed");
    assert!(status.stdout.is_empty(), "key material reached stdout");
    assert_eq!(fs::metadata(&client).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::metadata(&server).unwrap().permissions().mode() & 0o777, 0o600);

    let status = run(&["encrypt", &client, &input], Some(b"101"));
    assert!(status.status.success(), "client encryption failed");
    assert!(status.stdout.is_empty());
    // No client key is available in evaluator arguments or in its working directory.
    let status = run(&["evaluate", &server, &input, &output,
        "xor:0:1;mux:2:3:0;not:4", "3,4,5"], None);
    assert!(status.status.success(), "ciphertext-only evaluation failed");
    assert!(status.stdout.is_empty(), "plaintext leaked from evaluator");
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
