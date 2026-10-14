"""Fail-closed tests of a fresh non-hindsight Aave Withdraw owner cohort."""
from __future__ import annotations
import copy
import unittest
import prospective_recent_withdraw_cohort as w
import test_prospective_recent_borrow_cohort as fixture

FIRST=fixture.FIRST
LAST=fixture.LAST
TIME=fixture.NOW

def withdrawal(block,idx,owner,to=None,amount=10000):
    to=to or owner
    return {'address':w.POOL,'topics':[w.WITHDRAW_TOPIC,
            '0x'+'0'*24+fixture.address(400)[2:],
            '0x'+'0'*24+owner[2:],
            '0x'+'0'*24+to[2:]],
            'data':'0x'+f'{amount:064x}',
            'transactionHash':fixture.hash32(block*1000+idx),
            'blockNumber':hex(block),
            'blockHash':fixture.hash32(block),
            'transactionIndex':hex(idx),
            'logIndex':hex(idx+20), 'removed':False}

def samples():
    return [withdrawal(LAST-25,1,fixture.address(1),to=fixture.address(99)),
            withdrawal(LAST-15,2,fixture.address(2)),
            withdrawal(LAST-2,3,fixture.address(1)),
            withdrawal(LAST-1,4,fixture.address(3))]

def source_factory(*, mismatch=None, rate_limited=None, stale=None, bad_receipt=None,
                   owner_hf_drift=None, data=None):
    rows=samples() if data is None else data
    def build(provider):
        def query(url,method,params):
            if method=='eth_chainId':return '0x1'
            if method=='eth_blockNumber':return hex(fixture.TIP)
            if method=='eth_getBlockByNumber':
                n=int(params[0],16)
                if stale==provider and n==LAST:
                    h=fixture.fake_header(n);h['timestamp']=hex(TIME-500);return h
                if mismatch==provider and n==LAST:
                    return fixture.fake_header(n,'0x'+'ef'*32)
                return fixture.fake_header(n)
            if method=='eth_getLogs':
                if rate_limited==provider:raise OSError('HTTP429 stop, no retry')
                lo=int(params[0]['fromBlock'],16);hi=int(params[0]['toBlock'],16)
                return [copy.deepcopy(x) for x in rows if lo<=int(x['blockNumber'],16)<=hi]
            if method=='eth_getTransactionReceipt':
                if bad_receipt==provider:return {'status':'0x0','logs':[]}
                group=[x for x in rows if x['transactionHash']==params[0]]
                if not group:return None
                selected=group[0]
                return {'transactionHash':selected['transactionHash'],
                        'blockHash':selected['blockHash'],
                        'blockNumber':selected['blockNumber'],
                        'transactionIndex':selected['transactionIndex'],
                        'status':'0x1','gasUsed':'0x30000','effectiveGasPrice':'0x3b9aca00',
                        'logs':[copy.deepcopy(x) for x in group]}
            if method=='eth_call':
                borrower=int(params[0]['data'][-40:],16)
                if owner_hf_drift==provider and borrower==1:
                    return fixture.abi_account(w.borrow.WAD+42)
                if borrower==1:return fixture.abi_account(w.borrow.WAD-1)
                if borrower==2:return fixture.abi_account(w.borrow.WAD+10**15)
                if borrower==3:return fixture.abi_account(w.borrow.WAD*2,debt=0)
                return fixture.abi_account(w.borrow.WAD*2)
            raise AssertionError('Unexpected method '+method)
        return query
    return build

class WithdrawSourceTests(unittest.TestCase):
    def test_canonical_topic_matches_real_aave_withdraw(self):
        self.assertEqual(w.WITHDRAW_TOPIC,
            '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7')

    def test_owner_not_destination_when_withdrawing(self):
        x=w.parse_withdraw(samples()[0],FIRST,LAST)
        self.assertEqual(x['owner'],fixture.address(1))
        self.assertEqual(x['recipient'],fixture.address(99))
        self.assertTrue(x['source_event_is_not_automatically_effective_collateral'])

    def test_wrong_topic_reserve_emitter_and_data_rejected(self):
        for key,value in [('address',fixture.address(100)),('data','0x'),
                          ('removed',True),('blockNumber',hex(FIRST-1)),
                          ('transactionHash','0xdead')]:
            y=copy.deepcopy(samples()[0]);y[key]=value
            with self.subTest(key=key),self.assertRaises(Exception):
                w.parse_withdraw(y,FIRST,LAST)
        for index in (0,1,2,3):
            y=copy.deepcopy(samples()[0]);y['topics'][index]='0x'+'ff'*32
            with self.subTest(index=index),self.assertRaises(Exception):
                w.parse_withdraw(y,FIRST,LAST)
        y=copy.deepcopy(samples()[0]);y['data']='0x'+'0'*64
        with self.assertRaises(Exception):w.parse_withdraw(y,FIRST,LAST)

    def test_exact_single_uint256_amount(self):
        for amt in (1,2**128+21):
            v=w.parse_withdraw(withdrawal(LAST,1,fixture.address(2),amount=amt),FIRST,LAST)
            self.assertEqual(int(v['amount_raw']),amt)

    def test_deterministic_latest_owner_selection_and_deduplication(self):
        parsed=[w.parse_withdraw(x,FIRST,LAST) for x in samples()]
        chosen,meta=w.select(parsed)
        self.assertEqual([x['borrower'] for x in chosen],
                         [fixture.address(3),fixture.address(1),fixture.address(2)])
        self.assertEqual(meta['distinct_withdrawing_owners'],3)
        self.assertEqual(meta['source_withdraw_event_count'],4)
        self.assertTrue(meta['withdraw_effect_on_hf_is_not_necessarily_negative'])

    def test_full_source_and_two_url_state_parity(self):
        data=w.collect(transport_factory=source_factory(),unix_now=TIME)
        self.assertEqual(data['status'],'DUAL_RPC_RECENT_WITHDRAW_OWNERS_RISK_ONLY_NOT_P2')
        self.assertEqual(data['verified_withdraw_event_count'],4)
        self.assertEqual(data['verified_distinct_owner_count'],3)
        self.assertEqual(data['verified_selected_owner_count'],3)
        self.assertEqual(data['verified_active_debt_accounts'],2)
        self.assertEqual(data['verified_no_debt_accounts'],1)
        self.assertEqual(data['verified_hf_lt_one_count'],1)
        self.assertEqual(data['verified_near_50bps_count'],1)
        self.assertEqual(data['verified_near_200bps_count'],1)
        self.assertEqual(data['verified_near_1000bps_count'],1)
        self.assertFalse(data['real_liquidation_route_proven'])
        self.assertFalse(data['competitive_capture_proven'])
        self.assertFalse(data['net_pnl_proven'])
        self.assertEqual(data['nqc_realized_pnl_usd'],'0')
        self.assertEqual(data['source_reports']['drpc']['shards_complete'],16)

    def test_selected_owner_hf_below_one_does_not_certify_route(self):
        out=w.collect(transport_factory=source_factory(),unix_now=TIME)
        self.assertEqual(out['verified_hf_lt_one_count'],1)
        self.assertTrue(out['withdraw_is_not_automatically_collateral_withdrawal'])
        self.assertFalse(out['real_liquidation_route_proven'])
        self.assertFalse(out['canary_live_authorized'])

    def test_empty_indexed_withdraw_window_narrow_only(self):
        out=w.collect(transport_factory=source_factory(data=[]),unix_now=TIME)
        self.assertEqual(out['status'],'ZERO_WITHDRAW_EVENTS_ONLY_THIS_384_BLOCK_WINDOW')
        self.assertEqual(out['verified_withdraw_event_count'],0)
        self.assertIsNone(out['verified_active_debt_accounts'])
        self.assertTrue(out['not_all_Aave_borrowers_or_collateral_users'])

    def test_rate_limit_incomplete_not_zero(self):
        out=w.collect(transport_factory=source_factory(rate_limited='publicnode'),unix_now=TIME)
        self.assertEqual(out['status'],'INCOMPLETE_WITHDRAW_COHORT_NOT_MARKET_ABSENCE')
        self.assertIsNone(out['verified_withdraw_event_count'])
        self.assertEqual(out['source_reports']['publicnode']['status'],'INCOMPLETE_WITHDRAW_SOURCE')

    def test_wrong_header_rejected(self):
        out=w.collect(transport_factory=source_factory(mismatch='publicnode'),unix_now=TIME)
        self.assertEqual(out['status'],'INCOMPLETE_WITHDRAW_COHORT_NOT_MARKET_ABSENCE')
        self.assertFalse(out['commercial_score_upgrade'])

    def test_stale_source_rejected(self):
        out=w.collect(transport_factory=source_factory(stale='publicnode'),unix_now=TIME)
        self.assertEqual(out['status'],'INCOMPLETE_WITHDRAW_COHORT_NOT_MARKET_ABSENCE')
        self.assertIsNone(out['verified_hf_lt_one_count'])

    def test_bad_receipt_censored(self):
        out=w.collect(transport_factory=source_factory(bad_receipt='drpc'),unix_now=TIME)
        self.assertEqual(out['status'],'INCOMPLETE_WITHDRAW_COHORT_NOT_MARKET_ABSENCE')
        self.assertEqual(out['source_reports']['drpc']['status'],'INCOMPLETE_WITHDRAW_SOURCE')

    def test_owner_hf_mismatch_not_authority(self):
        out=w.collect(transport_factory=source_factory(owner_hf_drift='publicnode'),unix_now=TIME)
        self.assertEqual(out['status'],'INCOMPLETE_WITHDRAW_COHORT_NOT_MARKET_ABSENCE')
        self.assertIsNone(out['verified_hf_lt_one_count'])

    def test_write_methods_or_wrong_topic_cannot_pass(self):
        rpc=w.RPC('drpc',source_factory()('drpc'))
        for name,args in [('eth_sendRawTransaction',['0xbeef']),
                          ('eth_getLogs',[{'address':w.POOL,'topics':[],
                             'fromBlock':hex(FIRST),'toBlock':hex(FIRST+24)}]),
                          ('eth_getBlockByNumber',['pending',True])]:
            with self.subTest(name=name),self.assertRaises(Exception):
                rpc.call(name,args)
        self.assertEqual(rpc.calls,0)

    def test_recipient_cannot_be_read_as_owner(self):
        rpc=w.RPC('drpc',source_factory()('drpc'))
        with self.assertRaises(Exception):
            rpc.call('eth_call',[{'to':w.POOL,
                       'data':w.borrow.call_data(fixture.address(99))},
                       {'blockHash':fixture.hash32(LAST),'requireCanonical':True}],
                       allowed_borrowers={fixture.address(1)})

    def test_invalid_aave_account_abi_rejected(self):
        with self.assertRaises(Exception):
            w.borrow.decode_account('0xdeadbeef')

    def test_caps_preserved(self):
        self.assertEqual(w.MAX_COHORT,64)
        self.assertEqual(w.MAX_RPC_CALLS,200)
        self.assertEqual(w.MAX_EVENTS,320)

    def test_no_captured_profit_or_independent_operator_claim(self):
        d=w.collect(transport_factory=source_factory(),unix_now=TIME)
        self.assertTrue(d['operator_source_independence_not_established'])
        self.assertTrue(d['only_post_inclusion_source_state_not_pending_detection'])
        self.assertFalse(d['external_native_gas_sponsor_nonrecourse_proven'])
        self.assertFalse(d['commercial_score_upgrade'])
        self.assertFalse(d['P2_shadow_certified'])
        self.assertFalse(d['RMC_closed'])
        self.assertEqual(d['nqc_realized_pnl_usd'],'0')

    def test_no_hidden_liquidator_selection(self):
        data=w.collect(transport_factory=source_factory(),unix_now=TIME)
        self.assertEqual(data['selection']['selection_rule'],
                         'LATEST_64_DISTINCT_WITHDRAW_OWNER_BEFORE_HF')
        self.assertTrue(all(x['no_future_HF_or_liquidation_selected']
                            for x in data['source_cohort']))

if __name__=='__main__':unittest.main()
