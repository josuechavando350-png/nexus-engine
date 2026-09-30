#!/usr/bin/env python3
"""Negative controls for verify_authority.py.

A one-node declaration (D06@A0, the smallest certified artifact) must PASS
as declared, and must FAIL once any single identity field, digest, anchor
or claim is altered, or when a required node is missing. Proves that the
integrated verifier cannot be satisfied by a wrong declaration.
"""
import copy, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def run(declaration, work, tag):
    path = os.path.join(work, f"{tag}.json")
    with open(path, "w") as handle:
        json.dump(declaration, handle)
    out = subprocess.run([sys.executable, os.path.join(HERE, "verify_authority.py"), path,
                          os.path.join(work, tag), os.path.join(work, f"{tag}-report.json")],
                         capture_output=True, text=True)
    return out.returncode, out.stdout.strip().splitlines()[-1] if out.stdout.strip() else out.stderr


def flip(text):
    return text[:-1] + ("0" if text[-1] != "0" else "1")


def main(declaration_path, work):
    os.makedirs(work, exist_ok=True)
    base = json.load(open(declaration_path))
    node = next(n for n in base["nodes"] if n["node"] == "D06@A0")
    single = {"schema": base["schema"], "required_nodes": ["D06@A0"], "nodes": [node]}
    code, line = run(single, work, "baseline")
    assert code == 0, f"baseline must pass: {line}"
    print(f"RMC_INTEGRATED_CONTROL baseline PASS {line}")
    mutations = {
        "code_commit": lambda n: n.__setitem__("code_commit", flip(n["code_commit"])),
        "code_tree": lambda n: n.__setitem__("code_tree", flip(n["code_tree"])),
        "workflow_run_id": lambda n: n.__setitem__("workflow_run_id", 36627491914),
        "artifact_name": lambda n: n.__setitem__("artifact", n["artifact"] + "x"),
        "artifact_digest": lambda n: n.__setitem__("artifact_digest", flip(n["artifact_digest"])),
        "evidence_manifest_sha256": lambda n: n["evidence_manifest"].__setitem__(
            "sha256", flip(n["evidence_manifest"]["sha256"])),
        "anchor_hash": lambda n: n["anchor"].__setitem__("hash", flip(n["anchor"]["hash"])),
        "claim": lambda n: n["claims"][1].__setitem__("equals", 66),
    }
    for name, mutate in mutations.items():
        declaration = copy.deepcopy(single)
        mutate(declaration["nodes"][0])
        code, line = run(declaration, work, name)
        assert code != 0, f"mutation {name} was accepted: {line}"
        print(f"RMC_INTEGRATED_CONTROL {name} REFUSED {line}")
    missing = copy.deepcopy(single)
    missing["required_nodes"] = ["D06@A0", "D07"]
    code, line = run(missing, work, "missing")
    assert code != 0 and "missing=D07" in line, line
    print(f"RMC_INTEGRATED_CONTROL missing_node REFUSED {line}")
    print(f"RMC_INTEGRATED_CONTROLS_PASS mutations={len(mutations) + 1}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
