#!/usr/bin/env python3
"""Fail-closed historical Aave premium tests without trading or network access."""
from __future__ import annotations
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
import rmc016_historical_aave_flash_premium as m

PRE_BLOCKS=(25938047,26024989,26071848)
BLOCKS=(25938048,26024990,26071849)
DEBTS=(10684013854557827871,1827043650017560428,866504893554112580)
AFTER=(96136430295441074,81693946535782254,38776135687875734)
GAS=(19694395579376,523017715007964,216584522059332)
HASHES=tuple("0x"+f"{i+1:064x}" for i in range(3))
PRE_HASHES=tuple("0x"+f"{i+90:064x}" for i in range(3))
PRICES=(250480170000,269328000000,268440000000)

def fixtures():
    rows=[]
    for i in range(9):
        j=min(i,2)
        tx=m.KNOWN_RANKS[i] if i<3 else "0x"+f"{i+30:064x}"
        rows.append({
            "transaction_hash":tx, "block_number":BLOCKS[j],
            "block_hash":HASHES[j],
            "winner_full_tx_gas_wei":str(GAS[j]),
            "historical_weth_debt_raw_wei":str(DEBTS[j]),
            "collateral_minus_debt_minus_winner_gas_wei":str(AFTER[j]),
            "hypothetical_flash_premium_wei_ceil":str((DEBTS[j]*5+9999)//10000)
        })
    audit={"status":"RMC016_HISTORICAL_WETH_WETH_COST_BUDGET_DIAGNOSTIC_ONLY",
           "historical_weth_weth_winner_transactions":9,
           "historical_positive_after_hypothetical_5bps_transactions":8,
           "external_flash_principal_authenticated":False,
           "real_market_census_closed":False,
           "all_nine_weth_weth_records":rows}
    rank2={"status":"RMC016_RANK2_WETH_DUAL_OPERATOR_PREBLOCK_ORACLE_PASS",
           "selected_rank":2,"nexus_net_profit_proven":False,
           "real_market_census_closed":False,
           "row":{"transaction_hash":m.KNOWN_RANKS[1],
                  "two_independent_operator_price_consensus":True,
                  "historical_preblock_oracle":{"block":PRE_BLOCKS[1],"hash":PRE_HASHES[1],
                                                 "oracle_usd_base_1e8":str(PRICES[1])},
                  "historical_winner_block_end_oracle":{"block":BLOCKS[1],"hash":HASHES[1]},
                  "historical_winner_full_tx_gas_wei":str(GAS[1]),
                  "historical_after_winner_gas_wei":str(AFTER[1])}}
    priced={"status":"TWO_HISTORICAL_WETH_WINNER_PREBLOCK_ORACLE_PRICES_PASS",
            "nexus_realized_profitability_proven":False,
            "real_market_census_closed":False,
            "exact_intratransaction_price_proven":False,
            "transactions":[{
                "transaction_hash":m.KNOWN_RANKS[i],
                "historical_winner_gas_wei":str(GAS[i]),
                "preblock":{"block":PRE_BLOCKS[i],"hash":PRE_HASHES[i],
                            "oracle_usd_base_1e8":str(PRICES[i])},
                "block_end":{"block":BLOCKS[i],"hash":HASHES[i]},
            } for i in (0,2)]}
    return audit,rank2,priced

def rpc_response(url,method,params,fee_bps=5):
    if method=="eth_chainId":return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(params[0],16);j=PRE_BLOCKS.index(n)
        return {"number":hex(n),"hash":PRE_HASHES[j]}
    if method=="eth_call":
        assert params[0]=={"to":m.AAVE_POOL,"data":m.SELECTOR}
        assert int(params[1],16) in PRE_BLOCKS
        return "0x"+f"{fee_bps:064x}"
    raise AssertionError("unexpected RPC method")

class HistoricalFlashPremiumTests(unittest.TestCase):
    def acquire(self,call=rpc_response):
        candidates=m.verified_candidates(*fixtures())
        history,operators=m.historical_observation(
            candidates,request=call,
            providers=[("drpc","dRPC","https://drpc.invalid"),
                       ("blast","BlastAPI","https://blast.invalid")])
        return history,operators

    def test_true_top_three_historical_premiums_and_denomination(self):
        rows,operators=self.acquire()
        self.assertEqual([r["aave_flashloan_simple_premium_bps_preblock"] for r in rows],[5]*3)
        self.assertEqual([r["transaction_hash"] for r in rows],list(m.KNOWN_RANKS))
        self.assertTrue(all(r["historical_pool_fee_is_availability_quote"] is False for r in rows))
        self.assertTrue(all(r["nexus_external_gas_funding_proven"] is False for r in rows))
        self.assertEqual(len(operators),2)

    def test_actual_percentmul_round_half_up_not_ceil(self):
        rows,_=self.acquire()
        for x in rows:
            debt=int(x["original_debt_weth_wei"])
            self.assertEqual(int(x["historical_pool_premium_wei_percentmul_half_up"]),
                             (debt*5+5000)//10000)

    def test_fees_can_change_across_history(self):
        def changed(url,method,params):
            if method!="eth_call":return rpc_response(url,method,params)
            n=int(params[1],16)
            bps={PRE_BLOCKS[0]:9,PRE_BLOCKS[1]:5,PRE_BLOCKS[2]:0}[n]
            return rpc_response(url,method,params,bps)
        rows,_=self.acquire(changed)
        self.assertEqual([r["aave_flashloan_simple_premium_bps_preblock"] for r in rows],[9,5,0])
        self.assertFalse(rows[0]["historical_pool_fee_matches_illustrative_5bps"])

    def test_independent_provider_disagreement_denied(self):
        def changed(url,method,params):
            if method=="eth_call" and "blast" in url:
                return rpc_response(url,method,params,fee_bps=6)
            return rpc_response(url,method,params)
        with self.assertRaisesRegex(ValueError,"disagree"):
            self.acquire(changed)

    def test_wrong_chain_denied(self):
        def changed(url,method,params):
            return "0x2" if method=="eth_chainId" else rpc_response(url,method,params)
        with self.assertRaisesRegex(ValueError,"chain"):
            self.acquire(changed)

    def test_block_hash_drift_denied(self):
        def changed(url,method,params):
            if method=="eth_getBlockByNumber":
                v=rpc_response(url,method,params);v["hash"]="0x"+"f"*64;return v
            return rpc_response(url,method,params)
        with self.assertRaisesRegex(ValueError,"header drift"):
            self.acquire(changed)

    def test_malformed_fee_return_denied(self):
        for value in ("0x5",0,None,True):
            def bad(url,method,params):
                return value if method=="eth_call" else rpc_response(url,method,params)
            with self.assertRaises(ValueError):
                self.acquire(bad)

    def test_bps_over_10000_denied(self):
        with self.assertRaisesRegex(ValueError,"bps domain"):
            self.acquire(lambda u,m,p: rpc_response(u,m,p,10001))

    def test_exact_two_distinct_operators(self):
        c=m.verified_candidates(*fixtures())
        with self.assertRaisesRegex(ValueError,"independently operated"):
            m.historical_observation(c,request=rpc_response,
                providers=[("drpc","Provider A","a"),("blast","Provider A","b")])

    def test_provenance_wrong_ranking_denied(self):
        a,b,c=fixtures()
        a["all_nine_weth_weth_records"][0],a["all_nine_weth_weth_records"][1] = (
            a["all_nine_weth_weth_records"][1],a["all_nine_weth_weth_records"][0])
        with self.assertRaisesRegex(ValueError,"top-3 rank"):
            m.verified_candidates(a,b,c)

    def test_source_gas_mismatch_denied(self):
        a,b,c=fixtures()
        c["transactions"][0]["historical_winner_gas_wei"]="1"
        with self.assertRaises(ValueError):
            m.verified_candidates(a,b,c)

    def test_source_oracle_prestate_mismatch_denied(self):
        a,b,c=fixtures()
        b["row"]["historical_preblock_oracle"]["block"]+=1
        with self.assertRaises(ValueError):
            m.verified_candidates(a,b,c)

    def test_fraudulent_monthly_claim_denied(self):
        a,b,c=fixtures()
        a["external_flash_principal_authenticated"]=True
        with self.assertRaises(ValueError):
            m.verified_candidates(a,b,c)

    def test_source_archive_mutation_and_wrong_report_hash_denied(self):
        with tempfile.TemporaryDirectory() as p:
            zpath=Path(p)/"test.zip"
            report={"status":"TEST","value":7}
            def write(stored_report,duplicate=False):
                raw=m.canonical(stored_report)
                with zipfile.ZipFile(zpath,"w") as z:
                    z.writestr("proof.json",raw)
                    z.writestr("archive.sha256",m.digest(raw)+"  proof.json\n")
                    if duplicate:
                        import warnings
                        with warnings.catch_warnings():
                            warnings.simplefilter("ignore",UserWarning)
                            z.writestr("proof.json",raw)
            data=report.copy();data["report_sha256"]=m.digest(m.canonical(report))
            write(data)
            self.assertEqual(m.load_verified_archive(zpath,m.digest(zpath.read_bytes()),"proof.json")["status"],"TEST")
            altered=data.copy();altered["value"]=8;write(altered)
            with self.assertRaisesRegex(ValueError,"commitment"):
                m.load_verified_archive(zpath,m.digest(zpath.read_bytes()),"proof.json")
            write(data,duplicate=True)
            with self.assertRaises(ValueError):
                m.load_verified_archive(zpath,m.digest(zpath.read_bytes()),"proof.json")

if __name__=="__main__":unittest.main()
