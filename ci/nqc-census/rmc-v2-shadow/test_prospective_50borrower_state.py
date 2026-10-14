"""Adversarial source identity and prospective on-chain read-only state tests."""
import copy
from hashlib import sha256
import unittest
from unittest.mock import patch

import prospective_50borrower_state as s


TEST_TIME=1792000000
TEST_TIP=26190000
TEST_BLOCK=TEST_TIP-s.MIN_CONFIRMATIONS


def fake_archive_rows():
    result=[]
    for i in range(50):
        borrower='0x'+f'{i+1:040x}'
        if i<18:
            collateral=s.source.WETH
            debt=s.source.USDC if i%2==0 else s.source.USDT
        else:
            collateral='0x'+f'{200+i:040x}'
            debt='0x'+f'{300+i:040x}'
        result.append({
            'block':26095352+i,
            'tx_hash':'0x'+f'{i+1:064x}',
            'log_index':i,
            'collateral_asset':collateral,
            'debt_asset':debt,
            'raw_topics':['0x'+'f1'*32,
                          '0x'+'0'*24+collateral[2:],
                          '0x'+'0'*24+debt[2:],
                          '0x'+'0'*24+borrower[2:]],
            'borrower_sha256':sha256(borrower.encode()).hexdigest()})
    for n in (0,18,19):
        copy_row=copy.deepcopy(result[n])
        copy_row['block']+=50
        copy_row['log_index']+=1000
        copy_row['tx_hash']='0x'+f'{100+n:064x}'
        result.append(copy_row)
    assert len(result)==53
    return result


def fake_header(n=TEST_BLOCK,digest=None):
    return {'number':hex(n), 'hash':digest or '0x'+'12'*32,
            'parentHash':'0x'+'34'*32,
            'stateRoot':'0x'+'56'*32,
            'timestamp':hex(TEST_TIME-40)}


def account(hf, debt=1000, collateral=1400):
    return '0x'+''.join(f'{v:064x}' for v in
                         (collateral,debt,400,8250,8000,hf))


def fixture_reader(provider, *, mismatch=False, error=False, old=False):
    def reader(url,method,params):
        if provider not in url and False:
            raise AssertionError('unexpected URL')
        if method=='eth_chainId':return '0x1'
        if method=='eth_blockNumber':return hex(TEST_TIP)
        if method=='eth_getBlockByNumber':
            return fake_header(TEST_BLOCK, '0x'+'fe'*32 if mismatch else None,
                               ) if not old else {
                **fake_header(TEST_BLOCK),'timestamp':hex(TEST_TIME-1000)}
        if method=='eth_call':
            if error:raise OSError('429 rate limited')
            borrower='0x'+params[0]['data'][-40:]
            index=int(borrower[2:],16)
            health=(s.WAD-1 if index==1 else
                    s.WAD+s.WAD//1000 if index==2 else
                    s.WAD+s.WAD//100 if index==3 else
                    s.WAD*2)
            if mismatch and index==5:health+=1
            return account(health,debt=0 if index==50 else 1000)
        raise AssertionError(method)
    return reader


class ProspectiveCohortTests(unittest.TestCase):
    def setUp(self):
        self.rows=fake_archive_rows()
        self.source_report={}
        self.auth_patch=patch.object(s.source,'authenticate_index_archive',
            return_value=(self.source_report,self.rows,{'source':'test'}))
        self.rank_patch=patch.object(s.source,'build_market_slots',
            return_value={'only':'mocked_for_unit_tests'})
        self.auth_patch.start();self.rank_patch.start()
        self.addCleanup(self.auth_patch.stop)
        self.addCleanup(self.rank_patch.stop)

    def read(self, **opts):
        def factory(provider):
            return fixture_reader(provider,
                error=opts.get('error')==provider,
                mismatch=opts.get('mismatch')==provider,
                old=opts.get('old')==provider)
        return s.collect(b'unit-test-archive-replaced-with-fixture',
                         transport_factory=factory,
                         now_unix=TEST_TIME)

    def test_all_50_seeded_borrowers_and_18_weth_stables(self):
        cohort=s.build_cohort(self.source_report,self.rows)
        self.assertEqual(len(cohort),50)
        self.assertEqual(sum(x['in_historical_weth_stable_group'] for x in cohort),18)
        self.assertTrue(all(x['in_historical_weth_stable_group'] for x in cohort[:18]))
        self.assertTrue(all(not x['in_historical_weth_stable_group'] for x in cohort[18:]))

    def test_historical_borrower_hash_mismatch_cannot_enter_cohort(self):
        self.rows[0]['borrower_sha256']='00'*32
        with self.assertRaises(s.Rejected):
            s.build_cohort(self.source_report,self.rows)

    def test_missing_borrower_topics_cannot_enter(self):
        self.rows[0]['raw_topics']=self.rows[0]['raw_topics'][:3]
        with self.assertRaises(s.Rejected):
            s.build_cohort(self.source_report,self.rows)

    def test_duplicate_53_events_does_not_fabricate_53_borrowers(self):
        cohort=s.build_cohort(self.source_report,self.rows)
        self.assertEqual(sum(x['indexed_historical_liquidation_logs'] for x in cohort),53)
        self.assertEqual(cohort[0]['indexed_historical_liquidation_logs']>=1,True)

    def test_valid_six_word_aave_hf_classification(self):
        table=[
            (account(s.WAD-1), 'HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE'),
            (account(s.WAD), 'HF_1_TO_1_005_PRIORITY_WATCH_ONLY'),
            (account(s.NEAR_50BPS), 'HF_1_TO_1_005_PRIORITY_WATCH_ONLY'),
            (account(s.NEAR_50BPS+1),'HF_1_005_TO_1_02_WATCH_ONLY'),
            (account(s.NEAR_200BPS),'HF_1_005_TO_1_02_WATCH_ONLY'),
            (account(s.NEAR_200BPS+1),'HF_1_02_TO_1_10_WATCH_ONLY'),
            (account(s.NEAR_1000BPS+1),'HF_ABOVE_1_10_NO_NEAR_TRIGGER'),
            (account(s.WAD-1,debt=0),'NO_OUTSTANDING_DEBT_IN_PINNED_AAVE_SNAPSHOT'),
            (account(0),'ZERO_HF_WITH_DEBT_NEEDS_RISK_RECONSTRUCTION')
        ]
        for raw,expected in table:
            self.assertEqual(s.decode_account(raw)['status'],expected)

    def test_noncanonical_aave_abi_is_rejected(self):
        for value in (None,'0x',account(s.WAD)[:-64],
                      account(s.WAD).replace('0x','0y'),
                      account(s.WAD)+'00'):
            with self.subTest(raw=value),self.assertRaises(s.Rejected):
                s.decode_account(value)

    def test_invalid_liquidation_threshold_rejected(self):
        bad='0x'+''.join(f'{v:064x}' for v in (1200,500,0,10001,7500,s.WAD))
        with self.assertRaises(s.Rejected):s.decode_account(bad)

    def test_full_dual_rpc_canonical_observation(self):
        report=self.read()
        self.assertEqual(report['status'],'TWO_PUBLIC_RPC_SAME_BLOCK_50_HF_PARITY_NOT_P2')
        self.assertEqual(report['verified_dual_rpc_account_count'],50)
        self.assertEqual(report['weth_stable_history_borrower_count'],18)
        self.assertEqual(report['source_verified_hf_candidate_count'],1)
        self.assertEqual(report['source_verified_near_50bps_count'],1)
        self.assertEqual(report['source_verified_near_200bps_count'],2)
        self.assertEqual(report['source_verified_no_debt_count'],1)
        self.assertEqual(report['source_verified_debt_active_count'],49)
        self.assertEqual(report['weth_stable_history_hf_lt_one_count'],1)
        self.assertEqual(report['providers']['drpc']['calls_used'],54)
        self.assertEqual(report['providers']['publicnode']['calls_used'],54)
        self.assertEqual(report['nqc_realized_pnl_usd'],'0')
        self.assertFalse(report['competitive_inclusion_proven'])
        self.assertFalse(report['realized_net_pnl_certified'])

    def test_provider_state_mismatch_fails_closed(self):
        output=self.read(mismatch='publicnode')
        self.assertEqual(output['status'],'INCOMPLETE_DUAL_RPC_COHORT')
        self.assertEqual(output['verified_dual_rpc_account_count'],0)
        self.assertIsNone(output['source_verified_hf_candidate_count'])

    def test_publicnode_rate_limit_keeps_source_partial_not_zero(self):
        output=self.read(error='publicnode')
        self.assertEqual(output['status'],'INCOMPLETE_DUAL_RPC_COHORT')
        self.assertEqual(output['providers']['publicnode']['status'],'INCOMPLETE_SOURCE')
        self.assertIsNone(output['source_verified_no_debt_count'])
        self.assertEqual(output['nqc_realized_pnl_usd'],'0')

    def test_stale_canonical_headers_fail_closed(self):
        result=self.read(old='drpc')
        self.assertEqual(result['status'],'INCOMPLETE_DUAL_RPC_COHORT')
        self.assertIsNone(result['source_verified_hf_candidate_count'])

    def test_rpc_write_and_off_cohort_calls_rejected(self):
        cohort=s.build_cohort(self.source_report,self.rows)
        r=s.RPC('drpc',{cohort[0]['borrower']},transport=lambda *args:None)
        for method,params in [
            ('eth_sendRawTransaction',['0xbeef']),
            ('eth_call',[{'to':s.POOL,'data':s.call_data(cohort[1]['borrower'])},
                          {'blockHash':'0x'+'12'*32,'requireCanonical':True}]),
            ('eth_call',[{'to':s.POOL,'data':s.call_data(cohort[0]['borrower'])},
                          {'blockHash':'0x'+'12'*32,'requireCanonical':False}]),
            ('eth_getBlockByNumber',['pending',True])]:
            with self.subTest(method=method),self.assertRaises(s.Rejected):
                r.call(method,params)
        self.assertEqual(r.calls,0)

    def test_canonical_abi_query_exact(self):
        addr='0x'+'01'*20
        self.assertEqual(s.call_data(addr),s.CALL_SELECTOR+'0'*24+addr[2:])
        with self.assertRaises(s.Rejected):s.call_data('0xDEADBEEF')

    def test_malformed_block_hash_state_root_or_future_stale(self):
        h=fake_header()
        for key,bad in [('hash','0xffff'),('stateRoot',None),
                         ('parentHash',h['hash']),('number','0x1')]:
            x=copy.deepcopy(h);x[key]=bad
            with self.subTest(k=key),self.assertRaises(s.Rejected):
                s.header(x,TEST_BLOCK)

    def test_stale_publicnode_does_not_invent_no_candidates(self):
        result=self.read(old='publicnode')
        self.assertEqual(result['status'],'INCOMPLETE_DUAL_RPC_COHORT')
        self.assertEqual(result['verified_dual_rpc_account_count'],0)
        self.assertIsNone(result['source_verified_near_50bps_count'])

    def test_wrong_chain_is_rejected(self):
        def factory(provider):
            base=s.PROVIDERS[provider]
            def x(url,method,params):
                if method=='eth_chainId': return '0x89'
                return fixture_reader(provider)(url,method,params)
            return x
        report=s.collect(b'fixture',transport_factory=factory,now_unix=TEST_TIME)
        self.assertEqual(report['status'],'INCOMPLETE_DUAL_RPC_COHORT')

    def test_tip_divergence_stops_before_any_account_call(self):
        def factory(provider):
            def x(url,method,params):
                if method=='eth_blockNumber':
                    return hex(TEST_TIP+(20 if provider=='publicnode' else 0))
                return fixture_reader(provider)(url,method,params)
            return x
        report=s.collect(b'fixture',transport_factory=factory,now_unix=TEST_TIME)
        self.assertEqual(report['status'],'INCOMPLETE_DUAL_RPC_COHORT')
        self.assertTrue(report['errors'])
        self.assertEqual(report['providers']['drpc']['calls_used'],2)

    def test_no_capture_or_shadow_promotion_in_partial_source(self):
        report=self.read(error='drpc')
        self.assertFalse(report['actual_trade_route_proven'])
        self.assertFalse(report['shadow_P2_certified'])
        self.assertFalse(report['RMC_closed'])
        self.assertFalse(report['canary_live_authorized'])
        self.assertFalse(report['sponsor_nonrecourse_native_gas_proven'])


if __name__=='__main__':
    unittest.main()
