//! These tests only check the CLI boundary; they do not substitute TFHE execution tests.
use std::process::Command;

#[test]
fn refuses_private_plaintext_on_argv_before_key_generation() {
    let binary = env!("CARGO_BIN_EXE_nemesis-fhe");
    for args in [
        vec!["255", "255"],
        vec!["--circuit", "101", "xor:0:1", "3"],
        vec!["--add-stdin", "255", "255"],
    ] {
        let output = Command::new(binary).args(&args).output().expect("execute binary");
        assert!(!output.status.success(), "legacy CLI must fail");
        let err = String::from_utf8(output.stderr).expect("UTF-8 error");
        assert!(err.contains("private values must arrive on stdin"), "{err}");
    }
}
