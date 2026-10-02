//! RMC-008 upstream authority: `state-inputs.json` binds every consumed file
//! to one certified upstream run, and every binding is checked offline.

use nqc_census_chain::json::Json;
use nqc_census_state::inputs::{verify_pins, verify_upstream};
use nqc_census_state::stage::sha256_plain;
use std::error::Error;
use std::path::{Path, PathBuf};

type Result<T = ()> = std::result::Result<T, Box<dyn Error>>;

const COMMIT: &str = "a33a012591cd6625ddb921d995bb1bd95b4a5406";
const TREE: &str = "eda36fdc07e82ccdcc9666799fa8fe21aacc7f1d";
const OTHER: &str = "7e223cc5f89374f5542ca862d2322201b46d1fc8";

struct Fixture {
    root: PathBuf,
    pins: PathBuf,
    /// `(role, path, bytes)` of every pinned file.
    files: Vec<(String, String, Vec<u8>)>,
    source: Vec<(String, Json)>,
    /// Closeout names listed in the upstream evidence manifest, with digests.
    listed: Vec<(String, String)>,
    manifest_commit: String,
    manifest_tree: String,
}

fn scratch(tag: &str) -> Result<PathBuf> {
    Ok(std::env::temp_dir().join(format!(
        "nqc-rmc008-pins-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    )))
}

impl Fixture {
    fn new(tag: &str) -> Result<Self> {
        let root = scratch(tag)?;
        let reserves = b"{\"asset\":\"0x01\"}\n".to_vec();
        let surface = b"{\"schema\":\"surface\"}".to_vec();
        Ok(Self {
            pins: root.join("state-inputs.json"),
            root,
            listed: vec![(
                "aave-reserve-manifest.jsonl".to_owned(),
                sha256_plain(&reserves),
            )],
            files: vec![
                (
                    "d06_current_surface".to_owned(),
                    "d06/aave-current-surface.json".to_owned(),
                    surface,
                ),
                (
                    "d06_reserve_manifest".to_owned(),
                    "d06/closeout/aave-reserve-manifest.jsonl".to_owned(),
                    reserves,
                ),
            ],
            source: vec![
                ("node".to_owned(), Json::string("D06")),
                ("workflow_run_id".to_owned(), Json::uint(36627517591)),
                ("artifact_id".to_owned(), Json::uint(11062164175)),
                ("artifact".to_owned(), Json::string("nqc-rmc006-evidence")),
                ("code_commit".to_owned(), Json::string(COMMIT)),
                ("code_tree".to_owned(), Json::string(TREE)),
                (
                    "artifact_digest".to_owned(),
                    Json::string(format!("sha256:{}", "5f".repeat(32))),
                ),
            ],
            manifest_commit: COMMIT.to_owned(),
            manifest_tree: TREE.to_owned(),
        })
    }

    fn set(&mut self, key: &str, value: Json) {
        self.source.retain(|(name, _)| name != key);
        self.source.push((key.to_owned(), value));
    }

    /// Writes the files, the upstream evidence manifest and the pins; the
    /// source declares the manifest's real digest unless `declared` is set.
    fn write(&self, declared: Option<&str>, extra: &[(&str, &str, &[u8])]) -> Result<()> {
        let manifest = Json::object([
            ("code_commit", Json::string(self.manifest_commit.clone())),
            ("code_tree", Json::string(self.manifest_tree.clone())),
            (
                "artifacts",
                Json::array(self.listed.iter().map(|(name, sha256)| {
                    Json::object([
                        ("name", Json::string(name.clone())),
                        ("sha256", Json::string(sha256.clone())),
                    ])
                })),
            ),
        ])
        .canonical()?;
        let manifest_sha256 = sha256_plain(&manifest);
        let mut files: Vec<(String, String, Vec<u8>)> = self.files.clone();
        files.push((
            "d06_evidence_manifest".to_owned(),
            "d06/closeout/evidence-manifest.json".to_owned(),
            manifest,
        ));
        for (role, path, bytes) in extra {
            files.push(((*role).to_owned(), (*path).to_owned(), bytes.to_vec()));
        }
        let mut entries = Vec::new();
        for (role, path, bytes) in &files {
            let target = self.root.join(path);
            std::fs::create_dir_all(target.parent().ok_or("parent")?)?;
            std::fs::write(&target, bytes)?;
            entries.push(Json::object([
                ("role", Json::string(role.clone())),
                ("path", Json::string(path.clone())),
                ("sha256", Json::string(sha256_plain(bytes))),
            ]));
        }
        let mut source = self.source.clone();
        if !source
            .iter()
            .any(|(name, _)| name == "evidence_manifest_sha256")
        {
            source.push((
                "evidence_manifest_sha256".to_owned(),
                Json::string(declared.unwrap_or(&manifest_sha256)),
            ));
        }
        let pins = Json::object([
            ("status", Json::string("PINNED")),
            ("sources", Json::Array(vec![Json::object(source)])),
            ("files", Json::Array(entries)),
        ]);
        std::fs::write(&self.pins, pins.canonical()?)?;
        Ok(())
    }

    fn verify(&self) -> std::result::Result<Json, String> {
        let files = verify_pins(&self.pins, &self.root).map_err(|error| format!("{error:?}"))?;
        verify_upstream(&self.pins, &files).map_err(|error| format!("{error:?}"))
    }
}

fn refused(fixture: &Fixture, needle: &str) -> Result {
    match fixture.verify() {
        Ok(_) => Err(format!("accepted, expected a refusal naming {needle:?}").into()),
        Err(error) if error.contains(needle) => Ok(()),
        Err(error) => Err(format!("refused for another reason: {error}").into()),
    }
}

#[test]
fn certified_upstream_pins_verify_and_are_returned_for_the_evidence_manifest() -> Result {
    let fixture = Fixture::new("pass")?;
    fixture.write(None, &[])?;
    let sources = fixture.verify()?;
    let [source] = sources.as_array().ok_or("sources")? else {
        return Err("one source".into());
    };
    assert_eq!(source.str_field("code_commit")?, COMMIT);
    assert_eq!(source.str_field("code_tree")?, TREE);
    assert_eq!(
        source.get("workflow_run_id"),
        Some(&Json::uint(36627517591))
    );
    Ok(())
}

#[test]
fn a_tampered_consumed_file_or_upstream_manifest_fails_closed() -> Result {
    // The declared evidence manifest digest is not the pinned manifest.
    let fixture = Fixture::new("declared")?;
    fixture.write(Some(&"ab".repeat(32)), &[])?;
    refused(&fixture, "evidence manifest is pinned")?;

    // A consumed closeout file whose bytes differ from its pin.
    let fixture = Fixture::new("tampered")?;
    fixture.write(None, &[])?;
    std::fs::write(
        fixture
            .root
            .join("d06/closeout/aave-reserve-manifest.jsonl"),
        b"{\"asset\":\"0x02\"}\n",
    )?;
    refused(&fixture, "has sha256")?;

    // The upstream manifest lists the consumed file with another digest.
    let mut fixture = Fixture::new("listed")?;
    fixture.listed[0].1 = "cd".repeat(32);
    fixture.write(None, &[])?;
    refused(&fixture, "is not in the D06 evidence manifest")?;

    // The upstream manifest does not list the consumed file at all.
    let mut fixture = Fixture::new("unlisted")?;
    fixture.listed.clear();
    fixture.write(None, &[])?;
    refused(&fixture, "is not in the D06 evidence manifest")
}

#[test]
fn an_upstream_manifest_of_another_commit_or_tree_fails_closed() -> Result {
    let mut fixture = Fixture::new("commit")?;
    fixture.manifest_commit = OTHER.to_owned();
    fixture.write(None, &[])?;
    refused(&fixture, "not written by the pinned commit and tree")?;

    let mut fixture = Fixture::new("tree")?;
    fixture.manifest_tree = OTHER.to_owned();
    fixture.write(None, &[])?;
    refused(&fixture, "not written by the pinned commit and tree")
}

#[test]
fn malformed_or_missing_upstream_identity_fails_closed() -> Result {
    for (tag, key, value) in [
        ("short-commit", "code_commit", Json::string(&COMMIT[..39])),
        ("upper-tree", "code_tree", Json::string(TREE.to_uppercase())),
        (
            "bare-digest",
            "artifact_digest",
            Json::string("5f".repeat(32)),
        ),
        ("zero-run", "workflow_run_id", Json::uint(0)),
        ("empty-artifact", "artifact", Json::string("")),
    ] {
        let mut fixture = Fixture::new(tag)?;
        fixture.set(key, value);
        fixture.write(None, &[])?;
        match fixture.verify() {
            Ok(_) => return Err(format!("{tag} accepted").into()),
            Err(error) if error.contains("identity is malformed") || error.contains(key) => {}
            Err(error) => return Err(format!("{tag}: {error}").into()),
        }
    }
    let mut fixture = Fixture::new("no-tree")?;
    fixture.source.retain(|(name, _)| name != "code_tree");
    fixture.write(None, &[])?;
    refused(&fixture, "missing string field")
}

#[test]
fn a_file_of_no_declared_source_or_outside_its_node_fails_closed() -> Result {
    let fixture = Fixture::new("orphan")?;
    fixture.write(
        None,
        &[(
            "d07_pair_manifest",
            "d07/closeout/v2-pair-manifest.jsonl",
            b"{}\n",
        )],
    )?;
    refused(&fixture, "belongs to no declared source")?;

    let fixture = Fixture::new("outside")?;
    fixture.write(None, &[("d06_pair_manifest", "d07/pairs.jsonl", b"{}\n")])?;
    refused(&fixture, "is pinned outside d06/")
}

#[test]
fn the_committed_pins_declare_complete_upstream_identity() -> Result {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ci/nqc-census/state-inputs.json");
    let pins = Json::parse(&std::fs::read(path)?)?;
    assert_eq!(pins.str_field("status")?, "PINNED");
    let mut nodes = Vec::new();
    for source in pins
        .get("sources")
        .and_then(Json::as_array)
        .ok_or("sources")?
    {
        for key in [
            "code_commit",
            "code_tree",
            "artifact",
            "artifact_digest",
            "evidence_manifest_sha256",
        ] {
            assert!(!source.str_field(key)?.is_empty(), "{key}");
        }
        nodes.push(source.str_field("node")?.to_owned());
    }
    assert_eq!(nodes, ["D06", "D07"]);
    let mut roles: Vec<&str> = pins
        .get("files")
        .and_then(Json::as_array)
        .ok_or("files")?
        .iter()
        .map(|file| file.str_field("role"))
        .collect::<std::result::Result<_, _>>()?;
    roles.sort_unstable();
    assert_eq!(
        roles,
        [
            "d06_current_surface",
            "d06_deployment_manifest",
            "d06_evidence_manifest",
            "d06_reserve_manifest",
            "d07_current_surface",
            "d07_deployment_admission",
            "d07_evidence_manifest",
            "d07_pair_manifest",
        ]
    );
    Ok(())
}
