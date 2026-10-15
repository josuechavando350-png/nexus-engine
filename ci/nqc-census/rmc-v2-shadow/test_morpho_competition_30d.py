import copy, unittest, tempfile, io, sys, contextlib, json
from unittest.mock import patch
import morpho_competition_30d as module
from morpho_competition_30d import consume,validate_event,BadEvidence,PAGE_SIZE,aggregate_records,source_bisect
SINCE=1000;UNTIL=3000
EX={'chain':{'id':1},'txHash':'0x'+'a'*64,'logIndex':2,'timestamp':2000,'blockNumber':10001,
    'market':{'marketId':'0x'+'b'*64,'loanAsset':{'symbol':'USDC','decimals':6},'collateralAsset':{'symbol':'WETH','decimals':18}},
    'data':{'liquidator':'0x'+'c'*40,'repaidAssets':'1000000','seizedAssets':'200000','badDebtAssets':'0'}}
def page(items,total):return {'items':items,'pageInfo':{'count':len(items),'countTotal':total}}
class Proof(unittest.TestCase):
    def test_nominal(self):
        r=consume([page([EX],1)],SINCE,UNTIL);self.assertEqual(r['status'],'COMPLETE_MORPHO_API_WINDOW_INDEX_ONLY');self.assertEqual(r['unique_winning_transactions'],1);self.assertEqual(r['markets'][0]['leading_liquidator_event_share_bps'],10000)
    def test_same_tx_different_logs_one_win(self):
        y=copy.deepcopy(EX);y['logIndex']=3; r=consume([page([EX,y],2)],SINCE,UNTIL);self.assertEqual(r['event_count'],2);self.assertEqual(r['unique_winning_transactions'],1)
    def test_same_tx_two_chains_two_wins(self):
        y=copy.deepcopy(EX);y['chain']['id']=8453;r=consume([page([EX,y],2)],SINCE,UNTIL);self.assertEqual(r['unique_winning_transactions'],2)
    def test_duplicate_same_event_fails(self):
        with self.assertRaises(BadEvidence):consume([page([EX,copy.deepcopy(EX)],2)],SINCE,UNTIL)
    def test_missing_page_count_fails(self):
        with self.assertRaises(BadEvidence):consume([{'items':[EX],'pageInfo':{'count':0,'countTotal':1}}],SINCE,UNTIL)
    def test_empty_window(self):
        r=consume([page([],0)],SINCE,UNTIL);self.assertEqual(r['event_count'],0)
    def test_future_event_rejected(self):
        y=copy.deepcopy(EX);y['timestamp']=UNTIL+1
        with self.assertRaises(BadEvidence):validate_event(y,SINCE,UNTIL)
    def test_wrong_market_id(self):
        y=copy.deepcopy(EX);y['market']['marketId']='0x00'
        with self.assertRaises(BadEvidence):validate_event(y,SINCE,UNTIL)
    def test_missing_liquidator(self):
        y=copy.deepcopy(EX);y['data']['liquidator']='0x123'
        with self.assertRaises(BadEvidence):validate_event(y,SINCE,UNTIL)
    def test_negative_raw(self):
        y=copy.deepcopy(EX);y['data']['repaidAssets']=-10
        with self.assertRaises(BadEvidence):validate_event(y,SINCE,UNTIL)
    def test_missing_bad_debt(self):
        y=copy.deepcopy(EX);del y['data']['badDebtAssets']
        with self.assertRaises(BadEvidence):validate_event(y,SINCE,UNTIL)
    def test_shift_total(self):
        chunk=[copy.deepcopy(EX) for _ in range(PAGE_SIZE)]
        for j,e in enumerate(chunk):e['logIndex']=j
        y=copy.deepcopy(EX);y['logIndex']=101
        with self.assertRaises(BadEvidence):consume([page(chunk,102),page([y],101)],SINCE,UNTIL)
    def test_incomplete_not_certified(self):
        chunk=[copy.deepcopy(EX) for _ in range(PAGE_SIZE)]
        for j,e in enumerate(chunk):e['logIndex']=j
        r=consume([page(chunk,101)],SINCE,UNTIL);self.assertEqual(r['status'],'INCOMPLETE_MORPHO_API_WINDOW')
    def test_double_liquidator_share(self):
        x=copy.deepcopy(EX);x['logIndex']=3;x['data']['liquidator']='0x'+'d'*40
        r=consume([page([EX,x],2)],SINCE,UNTIL);self.assertEqual(r['markets'][0]['distinct_liquidator_count'],2);self.assertEqual(r['markets'][0]['leading_liquidator_event_share_bps'],5000)
    def test_false_income_prohibited(self):
        r=consume([page([EX],1)],SINCE,UNTIL);self.assertEqual(r['nqc_pnl_usd'],'0');self.assertFalse(r['gas_sponsor_proven']);self.assertFalse(r['competitive_capture_proven']);self.assertFalse(r['market_canonical_completeness_proven'])
    def test_main_full_output_offline_no_name_error(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(sys,'argv',['morpho_competition_30d.py','--out',temp]),\
                patch.object(module,'request_page',return_value=page([],0)),\
                patch.object(module.time,'sleep',return_value=None),\
                contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(module.main(),0)
            with open(temp+'/census.json') as evidence:
                report=json.load(evidence)
            self.assertEqual(report['status'],'COMPLETE_MORPHO_API_WINDOW_INDEX_ONLY')
            self.assertEqual(report['days_attempted'],30)
            self.assertIn('queries=',output.getvalue())
    def test_temporal_bisect_rescues_short_page(self):
        samples=[]
        for i in range(4):
            x=copy.deepcopy(EX);x['timestamp']=2000+i*100;x['logIndex']=i;samples.append(x)
        def fetch(skip,lo,hi):
            found=[e for e in samples if lo<=e['timestamp']<=hi]
            return page(found[:2],len(found))
        trace=[]
        records,total=source_bisect(2000,2400,fetch,trace,[30])
        self.assertEqual(total,4);self.assertEqual(len(records),4)
        self.assertTrue(len(trace)>1)
    def test_bisect_rejects_parent_child_total_drift(self):
        def fetch(skip,lo,hi):
            if lo==1000 and hi==1002:return page([EX],3)
            return page([],0)
        with self.assertRaises(BadEvidence):source_bisect(1000,1002,fetch,[],[10])
    def test_same_second_unpageable_rejected(self):
        def fetch(skip,lo,hi):return page([EX],2)
        with self.assertRaises(BadEvidence):source_bisect(1000,1000,fetch,[],[10])
    def test_budget_bounded(self):
        def fetch(skip,lo,hi):return page([EX],3)
        with self.assertRaises(BadEvidence):source_bisect(1000,1400,fetch,[],[1])
    def test_aggregate_two_days_unique_winners(self):
        x=copy.deepcopy(EX);y=copy.deepcopy(EX);y['logIndex']=3;y['timestamp']=2900
        a=consume([page([x],1)],1000,2499)
        b=consume([page([y],1)],2500,3000)
        r=aggregate_records(a['events']+b['events'])
        self.assertEqual(r['unique_winning_transactions'],1)
        self.assertEqual(r['markets'][0]['distinct_liquidator_count'],1)
    def test_disjoint_days_forbid_off_window(self):
        with self.assertRaises(BadEvidence): consume([page([EX],1)],2001,3000)
    def test_invalid_boolean_uint(self):
        x=copy.deepcopy(EX);x['logIndex']=True
        with self.assertRaises(BadEvidence):validate_event(x,SINCE,UNTIL)
if __name__=='__main__':unittest.main()
