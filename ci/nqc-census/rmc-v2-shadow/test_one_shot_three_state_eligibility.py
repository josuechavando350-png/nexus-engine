"""Anti-lookahead three source state gate; exact real PR726 bytes, offline tests."""
from __future__ import annotations

import copy
from hashlib import sha256
import os
from pathlib import Path
import unittest

import one_shot_three_state_eligibility as q


def mock_row(mode,hf,eq,ok,reason=None,klass=None):
    return {
        "mode":mode,
        "source_parent_header_authenticated":True,
        "source_is_same_historical_borrower":True,
        "risk_abi_exactly_source_after_oracle":eq,
        "hf_wad":hf,
        "dry_run_returned_evm_bytecode":ok,
        "dry_run_evm_revert_reason":reason,
        "dry_run_rpc_error_class":klass,
    }


class ThreeStateProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path=os.environ.get("NQC_PR726_ONE_SHOT_ZIP")
        if not path:
            raise AssertionError("Set exact PR726 authenticated source ZIP")
        cls.archive=Path(path).read_bytes()
        cls.src=q.authenticate_archive(cls.archive)

    def good(self):
        return {
            q.PRE_ORACLE:mock_row(
                q.PRE_ORACLE,1006076184268984731,False,False,
                "EXECUTION_STATE_EXCEEDS_ONE_PPM_DRIFT","EVM_REVERT"),
            q.AFTER_ORACLE:mock_row(
                q.AFTER_ORACLE,q.EXPECTED_HF_WAD,True,True),
            q.AFTER_WINNER:mock_row(
                q.AFTER_WINNER,1200000000000000000,False,False,
                "EXECUTION_STATE_EXCEEDS_ONE_PPM_DRIFT","EVM_REVERT"),
        }

    def test_immutable_30_members_head_tree_and_complete_nested_PR698(self):
        self.assertEqual(sha256(self.archive).hexdigest(),q.ARCHIVE_SHA)
        self.assertEqual(self.src["archive_manifest_member_count"],30)
        self.assertEqual(self.src["source_provenance"]["commit"],q.ARCHIVE_HEAD)
        self.assertEqual(self.src["source_provenance"]["tree"],q.ARCHIVE_TREE)
        self.assertEqual(self.src["source_provenance"]["source_one_shot_local_receipt_gas_used"],3914680)

    def test_same_exact_18732_byte_constructor_reused_for_all_states(self):
        self.assertEqual(len(self.src["initcode"]),2+18732*2)
        self.assertEqual(sha256(bytes.fromhex(self.src["initcode"][2:])).hexdigest(),q.EXPECTED_INIT_SHA)
        self.assertEqual(self.src["address"],"0x47878d4e4cb14fba4e85da0f54c3bfc589cd7e31")
        self.assertEqual(self.src["borrower"],"0xc8097d434b46888a14be77dfc836d86971e3c40f")
        self.assertIn(self.src["borrower"][2:],self.src["initcode"])
        self.assertIn(self.src["original_abi"][2:],self.src["initcode"])

    def test_historical_source_pre_winner_hf_below_one(self):
        self.assertEqual(self.src["source_words"][5],q.EXPECTED_HF_WAD)
        self.assertLess(q.EXPECTED_HF_WAD,10**18)
        self.assertEqual(self.src["parent"],"0x772dfe7b438a71374fb11f4b02ed1a8a27b480e0e5eb7f561480650a5abb6a17")

    def test_archive_truncation_and_appended_byte_fail(self):
        for blob in (self.archive[:-1],self.archive+b'\x00'):
            with self.subTest(n=len(blob)),self.assertRaises(q.Rejected):
                q.authenticate_archive(blob)

    def test_success_requires_one_strict_three_state_matrix(self):
        self.assertTrue(q.validate_report(self.good()))
        self.assertEqual(set(self.good()),set(q.MODES))

    def test_preoracle_liquidatable_state_does_not_count_as_source_negative(self):
        a=self.good()
        a[q.PRE_ORACLE]["hf_wad"]=10**18-1
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_postoracle_abi_must_match_original_six_words(self):
        a=self.good()
        a[q.AFTER_ORACLE]["risk_abi_exactly_source_after_oracle"]=False
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_postoracle_dryrun_cannot_revert(self):
        a=self.good()
        a[q.AFTER_ORACLE]["dry_run_returned_evm_bytecode"]=False
        a[q.AFTER_ORACLE]["dry_run_rpc_error_class"]="EVM_REVERT"
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_postwinner_original_state_must_have_changed(self):
        a=self.good()
        a[q.AFTER_WINNER]["risk_abi_exactly_source_after_oracle"]=True
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_postwinner_success_is_fatal_false_capture(self):
        a=self.good()
        a[q.AFTER_WINNER]["dry_run_returned_evm_bytecode"]=True
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_provider_error_cannot_be_certified_as_position_revert(self):
        a=self.good()
        a[q.AFTER_WINNER]["dry_run_rpc_error_class"]="SOURCE_ERROR"
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_negative_revert_reason_must_be_known_source_guard(self):
        a=self.good()
        a[q.PRE_ORACLE]["dry_run_evm_revert_reason"]="HTTP429"
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_no_missing_or_duplicate_modes(self):
        a=self.good()
        a.pop(q.AFTER_ORACLE)
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_no_unverified_canonical_parent(self):
        a=self.good()
        a[q.PRE_ORACLE]["source_parent_header_authenticated"]=False
        with self.assertRaises(q.Rejected):q.validate_report(a)

    def test_decode_EVM_revert_error_string_requires_actual_bytes(self):
        reason="EXECUTION_STATE_EXCEEDS_ONE_PPM_DRIFT".encode()
        payload=("0x08c379a0"+f'{32:064x}'+f'{len(reason):064x}'+
                 (reason+b'\0'*((32-len(reason)%32)%32)).hex())
        self.assertEqual(q.extract_revert_reason({
            "code":-32000,"message":"execution reverted","data":payload,
        }),"EXECUTION_STATE_EXCEEDS_ONE_PPM_DRIFT")
        self.assertIsNone(q.extract_revert_reason({
            "code":-32000,"message":"internal RPC error"
        }))

    def test_only_loopback_endpoint_accepted(self):
        with self.assertRaises(q.Rejected):
            q.OnlyLocalRPC("https://eth.drpc.org")
        self.assertEqual(q.OnlyLocalRPC().url,"http://127.0.0.1:18546")

    def test_no_broadcast_rpc_methods_or_nonce_mutations(self):
        rpc=q.OnlyLocalRPC()
        for method in ("eth_sendRawTransaction","eth_sendTransaction",
                       "anvil_setStorageAt","anvil_impersonateAccount",
                       "eth_sign","personal_unlockAccount"):
            with self.subTest(method=method),self.assertRaises(q.Rejected):
                rpc.call(method,[])
        self.assertEqual(rpc.calls,0)

    def test_eth_call_address_data_method_scope_enforced_offline(self):
        rpc=q.OnlyLocalRPC()
        bad=[
            [{"to":"0x"+"aa"*20,"data":"0x1234"},"latest"],
            [{"from":self.src["address"],"to":q.old.POOL,
              "data":self.src["initcode"],"gas":"0x989680","value":"0x0"},"latest"],
            [{"from":self.src["address"],"data":"0x1234",
              "gas":"0x989680","value":"0x0"},"latest"],
        ]
        for entry in bad:
            with self.assertRaises(q.Rejected):rpc.call("eth_call",entry)
        self.assertEqual(rpc.calls,0)

    def test_only_one_empty_local_synthetic_block_is_permitted(self):
        rpc=q.OnlyLocalRPC()
        for args in (["0x2"],[],["pending"]):
            with self.assertRaises(q.Rejected):rpc.call("anvil_mine",args)
        self.assertEqual(rpc.calls,0)

    def test_original_source_account_u256_rejects_malformed_or_short(self):
        for raw in ("0x","0x0","0x"+"ff"*31,True,None):
            with self.subTest(value=str(raw)[:12]),self.assertRaises(q.Rejected):
                q.decode_account(raw)


if __name__=="__main__":
    unittest.main()
