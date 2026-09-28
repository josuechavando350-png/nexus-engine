//! The standalone offline verifier: build a fixture, verify it, copy it to a
//! second location and verify again, then tamper with referenced evidence and
//! require a non-zero exit. Also the filesystem-boundary and unknown-state
//! rules, and the pinned golden evidence root of the synthetic fixture.

mod support;

use nqc_census_store::verify::{verify_store, VerifyRequest};
use nqc_census_store::{HeadStatus, Store, StoreError};
use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use support::{
    build_fixture, chunk_paths, copy_tree, flip_last_byte, make_writable, tree_listing, Damage,
    TempDir, TestResult,
};

const VERIFIER: &str = env!("CARGO_BIN_EXE_nqc-census-store-verify");

/// Evidence root of `support::build_fixture`. CI recomputes it with an
/// independent (non-Rust) implementation of the documented format.
const GOLDEN_FIXTURE_EVIDENCE_ROOT: &str =
    "66347fd573ba57847f53df5b70c57cf1be17393562831ef67e1e26e8de6cc28a";

fn run(args: &[&str]) -> Result<Output, Box<dyn std::error::Error>> {
    // An empty environment proves the verifier needs no configuration, secret,
    // credential or proxy setting.
    Ok(Command::new(VERIFIER).env_clear().args(args).output()?)
}

fn field<'a>(stdout: &'a str, key: &str) -> Option<&'a str> {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
}

fn verify_cli(root: &Path, extra: &[&str]) -> Result<Output, Box<dyn std::error::Error>> {
    let root = root.to_str().ok_or("non-utf8 path")?;
    let mut args = vec!["--store", root];
    args.extend_from_slice(extra);
    run(&args)
}

#[test]
fn fixture_verifies_copies_verify_identically_and_tamper_fails() -> TestResult {
    let dir = TempDir::new("offline-fixture")?;
    let (store, scopes) = build_fixture(&dir.join("store"))?;
    let chain_scope = scopes.first().ok_or("no scope")?.id()?.to_hex();
    let require = format!("{chain_scope}:100:139");

    let first = verify_cli(&dir.join("store"), &["--require-range", &require])?;
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let stdout = String::from_utf8(first.stdout)?;
    assert!(stdout.starts_with("RMC_004_OFFLINE_VERIFY=PASS\n"));
    assert_eq!(field(&stdout, "streams"), Some("2"));
    assert_eq!(field(&stdout, "orphan_artifacts"), Some("1"));
    assert_eq!(field(&stdout, "staging_files"), Some("0"));
    let root = field(&stdout, "evidence_root").ok_or("no root")?.to_owned();

    // Copy the whole store elsewhere: it verifies to the same evidence root.
    copy_tree(&dir.join("store"), &dir.join("copy"))?;
    let second = verify_cli(&dir.join("copy"), &["--require-range", &require])?;
    assert!(second.status.success());
    let copied = String::from_utf8(second.stdout)?;
    assert_eq!(field(&copied, "evidence_root"), Some(root.as_str()));

    // Requiring one block more than is durable fails.
    let beyond = format!("{chain_scope}:100:140");
    let partial = verify_cli(&dir.join("copy"), &["--require-range", &beyond])?;
    assert_eq!(partial.status.code(), Some(1));
    assert!(String::from_utf8(partial.stderr)?.contains("code=RANGE_INCOMPLETE"));

    // Tampering with referenced evidence in the copy fails with exit 1 while
    // the original still verifies.
    let chunk = chunk_paths(&Store::open_existing(&dir.join("copy"))?)?
        .into_iter()
        .next()
        .ok_or("no chunk")?;
    flip_last_byte(&chunk)?;
    let tampered = verify_cli(&dir.join("copy"), &[])?;
    assert_eq!(tampered.status.code(), Some(1));
    assert!(String::from_utf8(tampered.stderr)?.contains("RMC_004_OFFLINE_VERIFY=FAIL"));
    assert!(verify_cli(&dir.join("store"), &[])?.status.success());
    drop(store);
    Ok(())
}

#[test]
fn every_class_of_referenced_object_tamper_is_detected_by_the_binary() -> TestResult {
    let cases: [(&str, Damage); 8] = [
        ("empty-non-canonical-fanout", |root| {
            Ok(fs::create_dir(root.join("objects/chunks/zz"))?)
        }),
        ("manifest", |root| {
            let artifacts = support::files_under(&root.join("objects/artifacts"))?;
            flip_last_byte(artifacts.first().ok_or("no manifest")?)
        }),
        ("chunk-removed", |root| {
            let chunk = support::files_under(&root.join("objects/chunks"))?
                .into_iter()
                .next()
                .ok_or("no chunk")?;
            Ok(fs::remove_file(chunk)?)
        }),
        ("checkpoint", |root| {
            let stream = support::files_under(&root.join("streams"))?
                .into_iter()
                .find(|path| path.to_string_lossy().contains("checkpoints"))
                .ok_or("no checkpoint")?;
            flip_last_byte(&stream)
        }),
        ("scope", |root| {
            let scope = support::files_under(&root.join("streams"))?
                .into_iter()
                .find(|path| path.ends_with("SCOPE"))
                .ok_or("no scope")?;
            flip_last_byte(&scope)
        }),
        ("config", |root| flip_last_byte(&root.join("STORE"))),
        ("unknown-file", |root| {
            Ok(fs::write(root.join("objects/NOTES.txt"), b"unexpected")?)
        }),
        ("artifact-removed", |root| {
            let manifest = support::files_under(&root.join("objects/artifacts"))?
                .into_iter()
                .next()
                .ok_or("no manifest")?;
            Ok(fs::remove_file(manifest)?)
        }),
    ];
    for (label, damage) in cases {
        let dir = TempDir::new(&format!("offline-tamper-{label}"))?;
        build_fixture(&dir.join("store"))?;
        assert!(verify_cli(&dir.join("store"), &[])?.status.success());
        damage(&dir.join("store"))?;
        let output = verify_cli(&dir.join("store"), &[])?;
        assert_eq!(output.status.code(), Some(1), "{label} was not detected");
        assert!(
            verify_store(&dir.join("store"), &VerifyRequest::default()).is_err(),
            "{label} passed the library verifier"
        );
    }
    Ok(())
}

#[test]
fn usage_errors_exit_two_and_missing_store_fails() -> TestResult {
    assert_eq!(run(&[])?.status.code(), Some(2));
    assert_eq!(run(&["--store"])?.status.code(), Some(2));
    assert_eq!(
        run(&["--store", "/nonexistent", "--require-range", "zz:1:2"])?
            .status
            .code(),
        Some(2)
    );
    assert_eq!(run(&["--bogus", "x"])?.status.code(), Some(2));
    let dir = TempDir::new("offline-missing")?;
    let missing = dir.join("absent");
    assert_eq!(
        verify_cli(&missing, &[])?.status.code(),
        Some(1),
        "a missing store must not verify"
    );
    fs::create_dir(dir.join("empty"))?;
    let failure = verify_store(&dir.join("empty"), &VerifyRequest::default())
        .err()
        .ok_or("empty dir verified")?;
    assert!(matches!(failure.error, StoreError::StoreNotInitialized(_)));
    Ok(())
}

#[test]
fn symlinks_inside_the_store_are_rejected_not_followed() -> TestResult {
    let dir = TempDir::new("fs-symlink")?;
    let (store, _) = build_fixture(&dir.join("store"))?;
    let root = store.root().to_path_buf();
    drop(store);

    // A symlinked staging directory could point at another filesystem, which
    // would silently break the same-filesystem link/rename guarantee.
    fs::create_dir(dir.join("elsewhere"))?;
    fs::rename(root.join("tmp"), dir.join("old-tmp"))?;
    std::os::unix::fs::symlink(dir.join("elsewhere"), root.join("tmp"))?;
    assert!(matches!(
        Store::open_existing(&root),
        Err(StoreError::SymlinkRejected(_))
    ));
    assert!(verify_store(&root, &VerifyRequest::default()).is_err());
    fs::remove_file(root.join("tmp"))?;
    fs::rename(dir.join("old-tmp"), root.join("tmp"))?;
    Store::open_existing(&root)?;

    // A manifest replaced by a symlink to identical bytes elsewhere is still
    // rejected: store objects must be regular files inside the store.
    let manifest = support::files_under(&root.join("objects/artifacts"))?
        .into_iter()
        .next()
        .ok_or("no manifest")?;
    let outside = dir.join("outside-manifest");
    fs::copy(&manifest, &outside)?;
    make_writable(&manifest)?;
    fs::remove_file(&manifest)?;
    std::os::unix::fs::symlink(&outside, &manifest)?;
    let failure = verify_store(&root, &VerifyRequest::default())
        .err()
        .ok_or("symlinked manifest verified")?;
    assert!(matches!(failure.error, StoreError::SymlinkRejected(_)));

    // A symlinked store root is refused outright.
    let other_dir = TempDir::new("fs-symlink-root")?;
    build_fixture(&other_dir.join("real"))?;
    std::os::unix::fs::symlink(other_dir.join("real"), other_dir.join("link"))?;
    assert!(matches!(
        Store::open_existing(&other_dir.join("link")),
        Err(StoreError::SymlinkRejected(_))
    ));
    Ok(())
}

#[test]
fn store_creation_probes_link_semantics_and_layout() -> TestResult {
    let dir = TempDir::new("fs-probe")?;
    let store = Store::create(&dir.join("store"), support::small_config()?)?;
    // The probe leaves nothing behind.
    assert_eq!(support::staging_files(&store)?, 0);
    // A non-empty directory that is not a store is never adopted.
    fs::create_dir(dir.join("foreign"))?;
    fs::write(dir.join("foreign/data.bin"), b"someone else's data")?;
    assert!(matches!(
        Store::create(&dir.join("foreign"), support::small_config()?),
        Err(StoreError::UnexpectedEntry(_))
    ));
    assert!(!dir.join("foreign/STORE").exists());
    // A regular file where a store directory must be is refused.
    fs::remove_dir(dir.join("store/streams"))?;
    fs::write(dir.join("store/streams"), b"not a directory")?;
    assert!(matches!(
        Store::open_existing(&dir.join("store")),
        Err(StoreError::NotADirectory(_))
    ));
    Ok(())
}

#[test]
fn verifier_reports_head_state_without_trusting_it() -> TestResult {
    let dir = TempDir::new("offline-head")?;
    let (store, scopes) = build_fixture(&dir.join("store"))?;
    let scope = scopes.first().ok_or("no scope")?;
    let report = verify_store(store.root(), &VerifyRequest::default())?;
    assert!(report
        .streams
        .iter()
        .all(|stream| stream.head == HeadStatus::Consistent));
    // Remove a HEAD: still verifies (the cache is optional), same evidence root.
    fs::remove_file(support::head_path(&store, scope)?)?;
    let without = verify_store(store.root(), &VerifyRequest::default())?;
    assert_eq!(without.evidence_root, report.evidence_root);
    assert!(without
        .streams
        .iter()
        .any(|stream| stream.head == HeadStatus::Absent));
    Ok(())
}

#[test]
fn golden_fixture_evidence_root_is_byte_stable() -> TestResult {
    let dir = TempDir::new("offline-golden")?;
    let (store, _) = build_fixture(&dir.join("store"))?;
    let report = verify_store(store.root(), &VerifyRequest::default())?;
    assert_eq!(report.evidence_root, GOLDEN_FIXTURE_EVIDENCE_ROOT);
    // Building the fixture twice yields byte-identical trees.
    let (again, _) = build_fixture(&dir.join("again"))?;
    assert_eq!(tree_listing(store.root())?, tree_listing(again.root())?);
    Ok(())
}
