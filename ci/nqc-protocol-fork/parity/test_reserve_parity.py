"""Adversarial harness checks. Synthetic values are never historical evidence."""
import copy
import json
import unittest
from unittest.mock import patch

from generate_reserve_parity import generate
from reserve_balance_witness import LOCK, LOCK_SHA, PROVIDERS, active_ids, address, decode_words, digest, rpc


def synthetic_witness():
    locked = json.loads(LOCK.read_text())
    cases = []
    for c in locked["cases"]:
        ids = sorted({i for m in c["canonical_users"].values() for i in active_ids(m["user_configuration_raw"])})
        reserves = []
        for i in ids:
            r = dict(reserve_id=i, asset=address(i + 1), a_token=address(i + 201), variable_debt_token=address(i + 401),
                     configuration="0", last_update_timestamp=1, liquidation_grace_period_until=0)
            r.update({k: "1" for k in ("liquidity_index_ray", "variable_borrow_index_ray", "liquidity_rate_ray", "variable_borrow_rate_ray", "price_oracle_units", "price_usd_wad")})
            reserves.append(r)
        users = [dict(user=u, meta=m, positions=[dict(asset=address(i + 1), reserve_id=i, scaled_atoken_balance="1", scaled_variable_debt="1")
                 for i in active_ids(m["user_configuration_raw"])]) for u, m in sorted(c["canonical_users"].items())]
        cases.append(dict(case_id=c["case_id"], block_number=c["block_number"], block_hash=c["block_hash"], timestamp=1,
                          addresses_provider=address(700), price_oracle=address(701), oracle_base_unit="100000000", reserves=reserves, users=users))
    w = dict(pool=locked["pool"], locked_user_meta_sha256=LOCK_SHA, providers=[p[0] for p in PROVIDERS], cases=cases)
    return seal(w)


def seal(w):
    w["attestation_sha256"] = digest({k: v for k, v in w.items() if k != "attestation_sha256"})
    return w


class HarnessGuards(unittest.TestCase):
    def test_uint256_configuration_edges(self):
        self.assertEqual(active_ids(3 | (2 << 254)), [0, 127])
        for n in (-1, 2**256):
            with self.assertRaises(ValueError): active_ids(n)

    def test_canonical_abi_rejects_truncation_and_trailing_words(self):
        self.assertEqual(decode_words("0x" + "f" * 64, 1, "test"), [2**256 - 1])
        for data in ("0x", "0x" + "0" * 128, "0x" + "z" * 64):
            with self.assertRaises(ValueError): decode_words(data, 1, "test")
        for word in (0, -1, 2**160):
            with self.assertRaises(ValueError): address(word)

    def test_modified_evidence_rejected(self):
        w = synthetic_witness()
        w["cases"][0]["reserves"][0]["liquidity_index_ray"] = "2"
        with self.assertRaisesRegex(ValueError, "attestation"): generate(w)

    def test_resealed_missing_coverage_rejected(self):
        mutations = [lambda w: w["cases"][0]["users"].pop(),
                     lambda w: w["cases"][0]["reserves"].pop(),
                     lambda w: w["cases"][0]["users"][0]["positions"].pop(),
                     lambda w: w["cases"][0].update(block_number=1)]
        for mutate in mutations:
            w = synthetic_witness()
            mutate(w)
            with self.assertRaises(ValueError): generate(seal(w))

    def test_resealed_duplicate_borrower_rejected(self):
        w = synthetic_witness()
        w["cases"][0]["users"].append(copy.deepcopy(w["cases"][0]["users"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"): generate(seal(w))

    def test_rpc_rejects_wrong_response_id(self):
        with patch("reserve_balance_witness.urllib.request.urlopen") as req:
            req.return_value.__enter__.return_value.read.return_value = b'{"jsonrpc":"2.0","id":2,"result":"0x1"}'
            with self.assertRaisesRegex(ValueError, "envelope"): rpc("https://example.invalid", "eth_chainId", [], 1)

    def test_generated_program_is_recovered_code_execution(self):
        source = generate(synthetic_witness())
        self.assertIn("bootstrap.bootstrap_at(anchor).await?", source)
        self.assertIn("reader.read_refresh_at(&request, anchor).await?", source)
        self.assertIn("assert_eq!(user_checks, 15)", source)
        self.assertNotIn("tolerance", source)


if __name__ == "__main__":
    unittest.main()
