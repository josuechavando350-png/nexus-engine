#!/usr/bin/env python3
import copy, importlib.util, random, sys, unittest
from pathlib import Path

P=Path(__file__).with_name("rmc015_episode_model.py")
S=importlib.util.spec_from_file_location("rmc015_episode_model",P)
assert S and S.loader
m=importlib.util.module_from_spec(S); sys.modules[S.name]=m; S.loader.exec_module(m)

def pt(block,phase,tx=None,log=None):
    return {"block":block,"phase":phase,"transaction_index":tx,"log_index":log}

def episode(oid="o1",lineage="l1",triggers=None,left=False,right=False):
    birth=None if left else pt(100,"PRE_TX",0)
    terminal={"status":"RIGHT_CENSORED","order":None} if right else {"status":"CAPTURED","order":pt(102,"POST_TX",1)}
    return {
        "opportunity_id":oid,
        "lineage_id":lineage,
        "left_censored":left,
        "right_censored":right,
        "birth":birth,
        "first_actionable":pt(100,"LOG",0,2),
        "first_executable":pt(100,"POST_TX",0),
        "historical_execution_economics":{
            "pre_state_order":pt(100,"PRE_TX",0),
            "authority_commitment":"0x"+"11"*32,
        },
        "terminal":terminal,
        "lifetime_seconds":None if right else 24,
        "capture_observability":"PUBLIC_OBSERVABLE",
        "time_to_first_competitor_arrival_ms":None,
        "competitor_arrival_evidence":None,
        "nexus_counterfactual":{
            "decision_order":pt(100,"POST_TX",0),
            "max_evidence_order":pt(100,"LOG",0,2),
            "capture_probability":None,
            "prediction_commitment":"0x"+"22"*32,
        },
        "trigger_ids":triggers or ["t1"],
    }

def valid():
    return {"schema_version":1,"trigger_universe":["t1","t2"],"episodes":[episode(triggers=["t1"])],"rejections":[{"trigger_id":"t2","reason":"NO_ECONOMIC_STATE_CHANGE"}]}

class EpisodeTests(unittest.TestCase):
    def test_valid_conserves_trigger_universe(self):
        out=m.validate_document(valid())
        self.assertTrue(out["trigger_conservation_complete"])
        self.assertFalse(out["terminal_authority"])
        self.assertEqual(out["episode_count"],1)
        self.assertEqual(out["rejection_count"],1)

    def test_end_block_orders_after_transactions(self):
        a=m.OrderPoint.parse(pt(100,"POST_TX",999))
        b=m.OrderPoint.parse(pt(100,"END_BLOCK"))
        self.assertLess(a,b)

    def test_left_censoring_forbids_invented_birth(self):
        d=valid(); d["episodes"][0]["left_censored"]=True
        d["episodes"][0]["birth"]=pt(99,"END_BLOCK")
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_right_censoring_forbids_invented_lifetime(self):
        d=valid(); d["episodes"][0]=episode(triggers=["t1"],right=True)
        d["episodes"][0]["lifetime_seconds"]=1
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_right_censoring_requires_right_censored_terminal(self):
        d=valid(); d["episodes"][0]=episode(triggers=["t1"],right=True)
        d["episodes"][0]["terminal"]["status"]="CAPTURED"
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_lookahead_fails_closed(self):
        d=valid()
        d["episodes"][0]["nexus_counterfactual"]["max_evidence_order"]=pt(101,"END_BLOCK")
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_counterfactual_capture_probability_cannot_be_invented(self):
        d=valid()
        d["episodes"][0]["nexus_counterfactual"]["capture_probability"]=1.0
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_competitor_arrival_needs_direct_timestamped_flow_evidence(self):
        d=valid()
        d["episodes"][0]["time_to_first_competitor_arrival_ms"]=123
        d["episodes"][0]["competitor_arrival_evidence"]={"kind":"CHAIN_INCLUSION","timestamp_commitment":"x"}
        with self.assertRaises(ValueError): m.validate_document(d)
        d=valid()
        d["episodes"][0]["time_to_first_competitor_arrival_ms"]=123
        d["episodes"][0]["competitor_arrival_evidence"]={"kind":"MEMPOOL","timestamp_commitment":"x"}
        self.assertEqual(m.validate_document(d)["episode_count"],1)

    def test_trigger_cannot_disappear(self):
        d=valid(); d["rejections"]=[]
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_trigger_cannot_be_consumed_and_rejected(self):
        d=valid(); d["rejections"]=[{"trigger_id":"t1","reason":"X"},{"trigger_id":"t2","reason":"Y"}]
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_trigger_cannot_link_unrelated_lineages(self):
        d=valid()
        d["episodes"]=[
            episode("o1","l1",["t1"]),
            episode("o2","l2",["t1"]),
        ]
        d["trigger_universe"]=["t1","t2"]
        d["rejections"]=[{"trigger_id":"t2","reason":"X"}]
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_unknown_rejection_fails_closed(self):
        d=valid(); d["rejections"][0]["reason"]="UNKNOWN"
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_historical_authority_must_precede_executable_state(self):
        d=valid()
        d["episodes"][0]["historical_execution_economics"]["pre_state_order"]=pt(101,"END_BLOCK")
        with self.assertRaises(ValueError): m.validate_document(d)

    def test_input_order_independence_500_permutations(self):
        d={
            "schema_version":1,
            "trigger_universe":["t1","t2","t3","t4"],
            "episodes":[episode("o1","l1",["t1","t2"]),episode("o2","l2",["t3"])],
            "rejections":[{"trigger_id":"t4","reason":"NO_ECONOMIC_STATE_CHANGE"}],
        }
        base=m.validate_document(copy.deepcopy(d))["commitment"]
        rng=random.Random(15016)
        for _ in range(500):
            x=copy.deepcopy(d)
            rng.shuffle(x["trigger_universe"])
            rng.shuffle(x["episodes"])
            rng.shuffle(x["rejections"])
            for e in x["episodes"]: rng.shuffle(e["trigger_ids"])
            self.assertEqual(m.validate_document(x)["commitment"],base)

if __name__=="__main__": unittest.main()
