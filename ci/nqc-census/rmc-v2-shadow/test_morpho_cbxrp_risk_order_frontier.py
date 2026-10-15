"""Adversarial source tests: sample-selection, exact integer risk and no trading authority."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import morpho_cbxrp_risk_order_frontier as m

U1='0x'+'1'*40
U2='0x'+'2'*40
U3='0x'+'3'*40
PRICE=1200000000000000000000000000000000000

def pos(user,coll,borrow,shares):
 return {'user':{'address':user},'market':{'marketId':m.MARKET,'chain':{'id':m.CHAIN}},
         'state':{'collateral':str(coll),'borrowAssets':str(borrow),'borrowShares':str(shares)}}

def mock_graph(rows):
 return {'data':{'marketById':{
     'marketId':m.MARKET,'lltv':str(m.LLTV),
     'loanAsset':{'address':m.USDC,'symbol':'USDC','decimals':6},
     'collateralAsset':{'address':m.CBXRP,'symbol':'cbXRP','decimals':6},
     'oracle':{'address':m.ORACLE}},
     'marketPositions':{'items':rows,'pageInfo':{'count':len(rows),'countTotal':len(rows)}}}}

def mock_oracle(price=PRICE,block=2500):
 return {'data':{'price':str(price),'last_indexed_block':str(block),
                 'last_updated_at':'2026-10-14T20:00:00Z'}}

R1=pos(U1,100_000000,50_000000,50_000000)
R2=pos(U2,100_000000,76_000000,40_000000)
class SourceWitnessTests(unittest.TestCase):
 def test_nominal_market_and_risk(self):
  rows=m.market_snapshot(mock_graph([R1,R2]));o=m.oracle_snapshot(mock_oracle())
  self.assertEqual(len(rows),2)
  risk=m.borrower_risk(rows,o)
  self.assertEqual(risk[0]['user'],U2)
  self.assertTrue(risk[0]['under_hf_1_indexer_model'])
  self.assertGreater(int(risk[1]['health_factor_wad_from_INDEXED_API']),m.WAD)
 def test_exact_integer_liquidation_boundary(self):
  self.assertEqual(m.hf_wad(100_000000,75_000000,PRICE),m.WAD)
  self.assertLess(m.hf_wad(100_000000,75_000001,PRICE),m.WAD)
  self.assertGreater(m.hf_wad(100_000000,74_999999,PRICE),m.WAD)
 def test_zero_borrow_no_false_zero_hf(self):self.assertIsNone(m.hf_wad(100,0,PRICE))
 def test_zero_price_rejected(self):
  with self.assertRaises(m.Incomplete):m.hf_wad(100,1,0)
 def test_wrong_debt_data_rejected(self):
  for bad in ('1.2','-1',' 100','1e6',False,None):
   with self.assertRaises(m.Incomplete):m.uint(bad,'bad')
 def test_wrong_provider_denied_before_transport(self):
  with self.assertRaises(m.Incomplete):m.api_post_json('https://attacker.example/graphql','POST',{'query':'hi'})
  with self.assertRaises(m.Incomplete):m.api_post_json(m.URL,'GET')
 def test_wrong_chain(self):
  f=mock_graph([R1]);f['data']['marketPositions']['items'][0]['market']['chain']['id']=1
  with self.assertRaises(m.Incomplete):m.market_snapshot(f)
 def test_wrong_token_decimals(self):
  f=mock_graph([R1]);f['data']['marketById']['loanAsset']['decimals']=18
  with self.assertRaises(m.Incomplete):m.market_snapshot(f)
 def test_wrong_collateral(self):
  f=mock_graph([R1]);f['data']['marketById']['collateralAsset']['address']=m.USDC
  with self.assertRaises(m.Incomplete):m.market_snapshot(f)
 def test_wrong_market_id_or_lltv(self):
  for attr,value in [('marketId','0x'+'a'*64),('lltv','800000000000000000')]:
   f=mock_graph([R1]);f['data']['marketById'][attr]=value
   with self.assertRaises(m.Incomplete):m.market_snapshot(f)
 def test_duplicate_user_rejected(self):
  with self.assertRaises(m.Incomplete):m.market_snapshot(mock_graph([R1,R1]))
 def test_source_hf_order_not_borrowshare_order(self):
  self.assertEqual(len(m.market_snapshot(mock_graph([R2,R1]))),2)
 def test_bad_graphql_error(self):
  f=mock_graph([R1]);f['errors']=[{'message':'Unauthenticated'}]
  with self.assertRaises(m.Incomplete):m.market_snapshot(f)
 def test_empty_fails_to_claim_completeness(self):
  snap=m.snapshot_from_documents(mock_graph([]),mock_oracle(),'2026-10-14T10:00Z')
  self.assertEqual(snap['borrower_count_in_risk100'],0)
  self.assertFalse(snap['sample_may_exclude_other_market_positions'])
 def test_bad_oracle_block_rejected(self):
  for bad in (None,'0','-1','notint'):
   f=mock_oracle();f['data']['last_indexed_block']=bad
   with self.assertRaises(m.Incomplete):m.oracle_snapshot(f)
 def test_missing_price_rejected(self):
  f=mock_oracle();del f['data']['price']
  with self.assertRaises(m.Incomplete):m.oracle_snapshot(f)
 def test_conservative_oracle_bound(self):
  for price in (0,1,10**50):
   with self.assertRaises(m.Incomplete):m.oracle_snapshot(mock_oracle(price))
 def test_oracle_height_reorg_censor(self):
  first=m.snapshot_from_documents(mock_graph([R1]),mock_oracle(block=100),'a')
  second=m.snapshot_from_documents(mock_graph([R1]),mock_oracle(block=99),'b')
  with self.assertRaises(m.Incomplete):m.comparative_report(first,second,44)
 def test_no_temporal_overlap_assumption(self):
  f=m.snapshot_from_documents(mock_graph([R1,R2]),mock_oracle(),'a')
  s=m.snapshot_from_documents(mock_graph([R2,pos(U3,1_000000,1_000000,30_000000)]),mock_oracle(block=2600),'b')
  r=m.comparative_report(f,s,35)
  self.assertEqual(r['first_cohort_size'],2)
  self.assertEqual(r['shared_followup_count'],1)
  self.assertEqual(r['original_cohort_not_seen_in_followup'],1)
  self.assertFalse(r['commercial_promotion_allowed'])
 def test_short_gap_rejected(self):
  f=m.snapshot_from_documents(mock_graph([R1]),mock_oracle(),'a')
  with self.assertRaises(m.Incomplete):m.comparative_report(f,f,20)
 def test_hindsight_crossing_only_if_frozen(self):
  first=m.snapshot_from_documents(mock_graph([R1]),mock_oracle(),'a')
  second=m.snapshot_from_documents(mock_graph([pos(U1,100_000000,76_000000,50_000000),R2]),mock_oracle(block=3000),'b')
  r=m.comparative_report(first,second,48)
  self.assertEqual(r['new_hf_crossings_IN_INDEXER_MODEL_only'],1)
  self.assertEqual(r['followup_shared_indexer_suspected_unhealthy'],1)
  self.assertFalse(r['can_execute_a_liquidation_now_proven'])
 def test_output_integrated_no_live_network(self):
  dummy=[(mock_graph([R1]),'a'*64),(mock_oracle(),'b'*64),
         (mock_graph([R1]),'c'*64),(mock_oracle(block=2501),'d'*64)]
  with tempfile.TemporaryDirectory() as d:
   with patch.object(m,'api_post_json',side_effect=dummy) as http, patch.object(m.time,'monotonic',side_effect=[0,40,41]):
    result=m.main(['--out',d,'--delay','30'])
   self.assertEqual(result,0)
   self.assertEqual(http.call_count,4)
   rep=json.loads((Path(d)/'prospective-risk-report.json').read_text())
   self.assertEqual(rep['status'],'RISK_FIRST_TWO_SNAPSHOTS_INDEXER_ONLY')
   self.assertFalse(rep['capture_probability_proven'])
   self.assertEqual(rep['realized_nqc_pnl_usd'],'0')
 def test_fails_closed_if_api_denied(self):
  with tempfile.TemporaryDirectory() as d:
   with patch.object(m,'api_post_json',side_effect=m.Incomplete('SOURCE_HTTP_403_GRAPHQL')):
    self.assertEqual(m.main(['--out',d,'--delay','30']),0)
   rep=json.loads((Path(d)/'prospective-risk-report.json').read_text())
   self.assertEqual(rep['status'],'INCOMPLETE_PROSPECTIVE_MORPHO_INDEXER')
   self.assertEqual(rep['reason'],'SOURCE_HTTP_403_GRAPHQL')
 def test_source_hf_query_is_risk_first(self):
  self.assertIn('orderBy: HealthFactor',m.QUERY)
  self.assertIn('healthFactor_lte: 1.15',m.QUERY)
  self.assertEqual(m.CAP,100)
 def test_malformed_page_count_fails_closed(self):
  d=mock_graph([R1]);d['data']['marketPositions']['pageInfo']['count']=0
  with self.assertRaises(m.Incomplete):m.market_snapshot(d)
 def test_partial_risk_census_never_claims_full_scope(self):
  d=mock_graph([R1]);d['data']['marketPositions']['pageInfo']['countTotal']=200
  s=m.snapshot_from_documents(d,mock_oracle(),'2026-10-15T04:00Z')
  self.assertTrue(s['sample_may_exclude_other_market_positions'])
  self.assertEqual(s['risk_ordered_indexer_total_under_1_15'],200)
 def test_crypto_secrets_absent(self):
  source=Path(m.__file__).read_text().lower()
  for forbidden in ('eth_sendrawtransaction','wallet.privatekey','personal_sign','anvil_setbalance'):
   self.assertNotIn(forbidden,source)
if __name__=='__main__':unittest.main()
