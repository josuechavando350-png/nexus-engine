import copy, json, tempfile
from pathlib import Path
import unittest
import morpho_cbXRP_prospective_cohort as p

A = '0x'+'a'*40
B = '0x'+'b'*40
C = '0x'+'c'*40

def row(addr=A, shares='1000000', loan='1000000', market=p.MARKET, collateral='900000'):
    return {'user': {'address':addr}, 'market': {'marketId':market},
            'state': {'borrowShares':shares,'borrowAssets':loan,'borrowAssetsUsd':'1.0',
                      'collateral':collateral,'collateralUsd':'1.5'}}

def response(rows, total=None):
    return {'data': {'marketPositions':{'pageInfo':{'count':len(rows),'countTotal':len(rows) if total is None else total},'items':rows}}}

class Spec(unittest.TestCase):
    def test_metadata_pinned(self):
        self.assertEqual(p.CHAIN,8453)
        self.assertEqual(len(p.MARKET),66)
        self.assertTrue('chainId_in: [8453]' in p.QUERY)
    def test_parses(self):
        x=p.validate_graphql(response([row()]),'ok',30)
        self.assertEqual(x['rows'][0]['borrower'],A)
        self.assertTrue(x['complete_page'])
    def test_pages_not_promoted(self):
        x=p.validate_graphql(response([row()],20),'censored',30)
        self.assertTrue(x['complete_page'])
        x=p.validate_graphql(response([row()],40),'censored',30)
        self.assertFalse(x['complete_page'])
    def test_duplicate_reject(self):
        with self.assertRaises(p.Rejected):p.validate_graphql(response([row(),row()]),'same')
    def test_wrong_market_reject(self):
        with self.assertRaises(p.Rejected):p.validate_graphql(response([row(market='0x'+'f'*64)]),'market')
    def test_forged_address_reject(self):
        with self.assertRaises(p.Rejected):p.validate_graphql(response([row(addr='0xdead')]),'addr')
    def test_negative_debt_reject(self):
        with self.assertRaises(p.Rejected):p.validate_graphql(response([row(loan='-100')]),'debt')
    def test_missing_collateral_reject(self):
        bad=row();del bad['state']['collateral']
        with self.assertRaises(p.Rejected):p.validate_graphql(response([bad]),'missing')
    def test_source_gql_errors_reject(self):
        with self.assertRaises(p.Rejected):p.validate_graphql({'errors':[{'message':'denied'}]},'bad')
    def test_count_total_shift_reject(self):
        r=response([row()]);r['data']['marketPositions']['pageInfo']['count']=2
        with self.assertRaises(p.Rejected):p.validate_graphql(r,'count')
    def test_nonfinite_usd_reject(self):
        r=row();r['state']['borrowAssetsUsd']='NaN'
        with self.assertRaises(p.Rejected):p.validate_graphql(response([r]),'nan')
    def test_union_dedup_source(self):
        x=p.validate_graphql(response([row(A),row(B)]),'top')
        y=p.validate_graphql(response([row(A),row(C)]),'near')
        f=p.freeze(x,y)
        self.assertEqual(f['cohort_size'],3)
        self.assertEqual(f['cohort'][0]['cohort_sources'],['top_debt','near_hf_indexer'])
    def test_no_zero_debt(self):
        f=p.freeze(p.validate_graphql(response([row(A,shares='0'),row(B)]),'top'),p.validate_graphql(response([]),'near'))
        self.assertEqual(f['cohort_size'],1)
    def test_delisted_not_liquidated(self):
        fr=p.freeze(p.validate_graphql(response([row()]),'first'),p.validate_graphql(response([]),'near'))
        got=p.compare(fr,p.validate_graphql(response([]),'later'))
        self.assertEqual(got['missing_in_followup'],1)
        self.assertFalse(got['onchain_liquidatability_proven'])
    def test_new_later_user_must_reject(self):
        fr=p.freeze(p.validate_graphql(response([row(A)]),'first'),p.validate_graphql(response([]),'near'))
        with self.assertRaises(p.Rejected):p.compare(fr,p.validate_graphql(response([row(B)]),'later'))
    def test_full_run_freeze_order(self):
        calls=[]
        def fake(v):
            q=v['query'];vars=v['variables'];calls.append(v)
            if len(calls)==1:
                self.assertEqual(vars['near'],None);self.assertIn('orderBy: BorrowShares',q)
                return response([row(A),row(B)],2)
            if len(calls)==2:
                self.assertEqual(vars['near'],1.08);self.assertIn('orderBy: HealthFactor',q)
                return response([row(B),row(C)])
            self.assertEqual(set(vars['users']),{A,B,C})
            return response([row(A,loan='1000010'),row(B),row(C)],3)
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)
            def sleeper(_):
                self.assertEqual(len(calls),2)
                self.assertTrue((out/'frozen-cohort-commitment.json').is_file())
                self.assertTrue((out/'frozen-cohort.json').is_file())
            result=p.run(out,0,client=p.Client(fake),sleeper=sleeper)
            self.assertEqual(result['status'],'TWO_TIME_ORDERED_MORPHO_API_SNAPSHOTS_INDEXER_ONLY')
            self.assertEqual(result['observations']['cohort_size'],3)
            self.assertEqual(result['observations']['observed_twice'],3)
            self.assertEqual(result['observations']['changes'][0]['debt_delta_raw'],'10')
            self.assertEqual(result['nqc_realized_pnl_usd'],'0')
            self.assertEqual(len(calls),3)
    def test_reject_http_402_without_retry(self):
        def fake(_):raise p.Rejected('API_HTTP_402')
        with tempfile.TemporaryDirectory() as td:
            r=p.run(Path(td),0,client=p.Client(fake))
            self.assertEqual(r['status'],'INCOMPLETE_MORPHO_PROSPECTIVE_SOURCE')
            self.assertEqual(r['queries_executed'],1)
            self.assertEqual(r['failure_reason'],'API_HTTP_402')
    def test_freeze_not_sufficient_for_live(self):
        with tempfile.TemporaryDirectory() as td:
            r=p.run(Path(td),0,client=p.Client(lambda v:response([])),sleeper=lambda _:None)
            self.assertFalse(r['canary_authorized'])
            self.assertFalse(r['shadow_p2_certified'])
            self.assertTrue(r['commercial_score_not_automatically_promoted'])
    def test_invalid_wait(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(p.Rejected):p.run(Path(td),61,client=p.Client(lambda v:response([])))
    def test_budget(self):
        c=p.Client(lambda v:response([]));c.calls=4
        with self.assertRaises(p.Rejected):c.query('extra')

if __name__=='__main__':unittest.main()

class RawSourceDiagnostic(unittest.TestCase):
    def test_unparseable_source_preserved_before_rejection(self):
        bad=row();bad['state']['borrowAssets']=3.14159
        with tempfile.TemporaryDirectory() as d:
            archive=Path(d)
            cli=p.Client(lambda _:response([bad]),raw_dir=archive)
            with self.assertRaises(p.Rejected):cli.query('TOP_DEBT')
            raw=json.loads((archive/'raw-top_debt.json').read_text())
            self.assertEqual(raw['data']['marketPositions']['items'][0]['state']['borrowAssets'],3.14159)

class VerifiedOriginalApiScalarTypes(unittest.TestCase):
    def test_observed_api_int_loan_collateral(self):
        valid=row();valid['state']['borrowAssets']=204836190116
        valid['state']['collateral']=470934168784
        state=p.validate_graphql(response([valid]),'observed')
        self.assertEqual(state['rows'][0]['debt_raw'],'204836190116')
        self.assertEqual(state['rows'][0]['collateral_raw'],'470934168784')
    def test_reject_float_even_integral_looking(self):
        valid=row();valid['state']['borrowAssets']=1000000.0
        with self.assertRaises(p.Rejected):p.validate_graphql(response([valid]),'float')
    def test_reject_bool_and_negative(self):
        for v in (True,False,-1):
            with self.subTest(v=v):
                valid=row();valid['state']['collateral']=v
                with self.assertRaises(p.Rejected):p.validate_graphql(response([valid]),'unsafe')
    def test_reject_uint256_overflow(self):
        valid=row();valid['state']['borrowAssets']=2**256
        with self.assertRaises(p.Rejected):p.validate_graphql(response([valid]),'overflow')
    def test_reject_leading_zero_raw(self):
        valid=row();valid['state']['borrowAssets']='01234'
        with self.assertRaises(p.Rejected):p.validate_graphql(response([valid]),'zero-prefix')
