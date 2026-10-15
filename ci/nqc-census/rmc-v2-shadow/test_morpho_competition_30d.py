import copy, unittest
from morpho_competition_30d import consume,validate_event,BadEvidence,PAGE_SIZE,aggregate_records
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
