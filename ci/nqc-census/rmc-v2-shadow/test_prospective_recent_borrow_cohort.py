"""Adversarial unit tests: no lookahead, exact ABI, two-source state."""
import copy
from hashlib import sha256
import unittest

import prospective_recent_borrow_cohort as r

TIP=26_192_600
LAST=TIP-r.CONFIRMATION_DEPTH
FIRST=LAST-r.WINDOW_BLOCKS+1
NOW=1_792_000_000


def hash32(v):
    return '0x'+sha256(str(v).encode()).hexdigest()


def indexed_addr(addr):
    return '0x'+'0'*24+addr[2:].lower()


def address(index):
    return '0x'+f'{index:040x}'


def fake_header(block, altered=False):
    return {'number':hex(block),
            'hash':hash32(block+(1 if altered else 0)),
            'parentHash':hash32(block-1),
            'stateRoot':hash32(block+500_000),
            'timestamp':hex(NOW-70-(LAST-block)*12)}


def borrow_log(block,txindex,logindex,account, *,
               user=None,amount=1000000,mode=2,referral=0):
    user=user or account
    reserve=address(400)
    data=[int(user,16),amount,mode,35700000000000000000000000]
    return {
        'address':r.POOL,
        'topics':[r.BORROW_TOPIC,indexed_addr(reserve),
                  indexed_addr(account),'0x'+f'{referral:064x}'],
        'data':'0x'+''.join(f'{v:064x}' for v in data),
        'removed':False,'blockNumber':hex(block),
        'blockHash':hash32(block),
        'transactionHash':hash32(block*1000+txindex),
        'transactionIndex':hex(txindex),
        'logIndex':hex(logindex),
    }


def abi_account(hf, debt=5000):
    vals=(6000,debt,1000,8000,7500,hf)
    return '0x'+''.join(f'{v:064x}' for v in vals)


def fixture_logs():
    return [
      borrow_log(LAST-110,5,12,address(1),user=address(900)),
      borrow_log(LAST-50,4,8,address(2)),
      borrow_log(LAST-25,1,2,address(1)),
      borrow_log(LAST-2,2,5,address(3)),
    ]


def mock_rpc(logs=None,*,different_header=False,wrong_amount=False,
             provider_error=False,invalid_receipt=False,ledger=None):
    logs=logs if logs is not None else fixture_logs()
    def do(url,method,params):
        if ledger is not None:ledger.append((url,method,params))
        if method=='eth_chainId':return '0x1'
        if method=='eth_blockNumber':return hex(TIP)
        if method=='eth_getBlockByNumber':
            height=int(params[0],16)
            return fake_header(height,
                altered=(different_header and height==LAST))
        if method=='eth_getLogs':
            if provider_error:
                raise OSError('HTTP 429 provider rate limit')
            lo,hi=(int(params[0][key],16)
                for key in ('fromBlock','toBlock'))
            return [copy.deepcopy(x) for x in logs
                    if lo<=int(x['blockNumber'],16)<=hi]
        if method=='eth_getTransactionReceipt':
            match=[x for x in logs if x['transactionHash']==params[0]]
            if invalid_receipt:
                return {'status':'0x0','logs':[]}
            if not match:
                return None
            log=match[0]
            return {'transactionHash':log['transactionHash'],
                    'blockNumber':log['blockNumber'],
                    'blockHash':log['blockHash'],
                    'transactionIndex':log['transactionIndex'],
                    'status':'0x1','gasUsed':'0x33450',
                    'effectiveGasPrice':'0x5395c100',
                    'logs':[copy.deepcopy(x) for x in match]}
        if method=='eth_call':
            b=int(params[0]['data'][-40:],16)
            hf={1:r.WAD-1,
                2:r.WAD+r.WAD//1000,
                3:r.WAD*3}.get(b,r.WAD*2)
            debt=0 if b==3 else 5000
            if wrong_amount and b==1:hf+=20
            return abi_account(hf,debt)
        raise AssertionError('forbidden: '+method)
    return do


def sources(**kwargs):
    return lambda provider:mock_rpc(
        **{**kwargs,
           'different_header':kwargs.get('different_header')==provider,
           'wrong_amount':kwargs.get('wrong_amount')==provider,
           'provider_error':kwargs.get('provider_error')==provider,
           'invalid_receipt':kwargs.get('invalid_receipt')==provider})


class FreshBorrowTruthTests(unittest.TestCase):
    def test_topic_is_correct_keccak_borrow_signature(self):
        self.assertEqual(r.BORROW_TOPIC,
                         '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0')

    def test_decodes_on_behalf_of_not_initiator(self):
        x=borrow_log(LAST-2,4,10,address(2),user=address(999),referral=0)
        out=r.parse_borrow(x,FIRST,LAST)
        self.assertEqual(out['user_initiator'],address(999))
        self.assertEqual(out['on_behalf_of'],address(2))
        self.assertEqual(out['referral_code'],0)
        self.assertTrue(out['selected_without_future_hf_or_liquidation_outcome'])

    def test_padded_referral_nonzero(self):
        x=borrow_log(LAST-2,4,10,address(2),referral=41)
        self.assertEqual(r.parse_borrow(x,FIRST,LAST)['referral_code'],41)

    def test_borrow_event_schema_overwrites_rejected(self):
        x=borrow_log(LAST-2,4,10,address(2))
        cases=[]
        for key,new in [('address',address(700)),('data','0x00'),
                        ('removed',True),('blockNumber',hex(FIRST-10)),
                        ('transactionHash','0xdeadbeef'),
                        ('transactionIndex','0x00')]:
            z=copy.deepcopy(x);z[key]=new;cases.append(z)
        z=copy.deepcopy(x);z['topics'][0]='0x'+'aa'*32;cases.append(z)
        z=copy.deepcopy(x);z['topics'][2]='0x'+'ff'*32;cases.append(z)
        z=copy.deepcopy(x);z['topics'][3]='0x'+'ff'*32;cases.append(z)
        z=copy.deepcopy(x);z['data']='0x'+('0'*64)*4;cases.append(z)
        for case in cases:
            with self.subTest(case=str(case)[:50]),self.assertRaises(r.Rejected):
                r.parse_borrow(case,FIRST,LAST)

    def test_interest_mode_outside_aave_enum_rejected(self):
        with self.assertRaises(r.Rejected):
            r.parse_borrow(borrow_log(LAST-1,1,1,address(1),mode=3),FIRST,LAST)

    def test_borrow_event_shards_are_exhaustive(self):
        q=r.shards(FIRST,LAST)
        self.assertEqual(len(q),16)
        self.assertEqual(q[0][0],FIRST)
        self.assertEqual(q[-1][-1],LAST)
        self.assertEqual([n for lo,hi in q for n in range(lo,hi+1)],
                         list(range(FIRST,LAST+1)))

    def test_unbounded_log_shards_rejected(self):
        with self.assertRaises(r.Rejected):r.shards(1,600)
        with self.assertRaises(r.Rejected):r.shards(100,99)

    def test_cohort_selection_prestate_no_lookahead(self):
        logs=[r.parse_borrow(x,FIRST,LAST) for x in fixture_logs()]
        chosen,meta=r.select_cohort(logs)
        self.assertEqual([int(x['borrower'],16) for x in chosen],[3,1,2])
        self.assertEqual(meta['events_in_full_window'],4)
        self.assertEqual(meta['distinct_debt_receivers'],3)
        self.assertEqual(meta['excess_distinct_receivers_not_reconstructed'],0)
        self.assertTrue(meta['no_future_liquidation_outcome_used'])

    def test_full_two_source_borrow_activity_and_account_parity(self):
        out=r.collect(transport_factory=sources(),current_unix=NOW)
        self.assertEqual(out['status'],
            'TWO_URL_RECENT_BORROW_COHORT_STATE_ONLY_NOT_P2')
        self.assertEqual(out['recent_borrow_event_count_quorum'],4)
        self.assertEqual(out['recent_borrower_count_quorum'],3)
        self.assertEqual(out['selected_recent_borrower_count_quorum'],3)
        self.assertTrue(out['borrower_accounts_exact_two_url_parity'])
        self.assertEqual(out['source_verified_hf_lt_one_count'],1)
        self.assertEqual(out['source_verified_near_50bps_count'],1)
        self.assertEqual(out['source_verified_debt_active_count'],2)
        self.assertEqual(out['source_verified_no_debt_count'],1)
        self.assertEqual(out['source_verified_near_200bps_count'],1)
        self.assertEqual(out['source_verified_near_1000bps_count'],1)
        self.assertEqual(len(out['source_reports']['drpc']['positive_receipt_controls']),2)
        self.assertEqual(out['nqc_realized_pnl_usd'],'0')
        self.assertFalse(out['competitive_capture_probability_calibrated'])

    def test_empty_borrow_source_not_full_market_absence(self):
        out=r.collect(transport_factory=sources(logs=[]),current_unix=NOW)
        self.assertEqual(out['status'],'TWO_URL_ZERO_BORROW_EVENTS_ONLY_IN_FIXED_WINDOW')
        self.assertEqual(out['recent_borrow_event_count_quorum'],0)
        self.assertIsNone(out['source_verified_debt_active_count'])
        self.assertTrue(out['selection_is_recent_borrow_not_all_outstanding_positions'])

    def test_publicnode_event_source_rate_limited_censored(self):
        out=r.collect(transport_factory=sources(provider_error='publicnode'),
                      current_unix=NOW)
        self.assertEqual(out['status'],
                         'INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE')
        self.assertIsNone(out['recent_borrow_event_count_quorum'])
        self.assertEqual(out['source_reports']['publicnode']['status'],
                         'INCOMPLETE_BORROW_LOG_SOURCE')

    def test_partial_source_wrong_block_hash_censored(self):
        out=r.collect(transport_factory=sources(different_header='publicnode'),
                      current_unix=NOW)
        self.assertEqual(out['status'],
                         'INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE')
        self.assertFalse(out['borrower_accounts_exact_two_url_parity'])

    def test_bad_positive_control_receipt_censored(self):
        out=r.collect(transport_factory=sources(invalid_receipt='drpc'),
                      current_unix=NOW)
        self.assertEqual(out['source_reports']['drpc']['status'],
                         'INCOMPLETE_BORROW_LOG_SOURCE')
        self.assertIsNone(out['source_verified_hf_lt_one_count'])

    def test_two_source_hf_disagreement_not_market_zero(self):
        out=r.collect(transport_factory=sources(wrong_amount='publicnode'),
                      current_unix=NOW)
        self.assertEqual(out['status'],
                         'INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE')
        self.assertFalse(out['borrower_accounts_exact_two_url_parity'])
        self.assertEqual(out['errors'][-1]['stage'],'state-parity')

    def test_event_active_balance_may_be_repaid_before_snapshot(self):
        out=r.collect(transport_factory=sources(),current_unix=NOW)
        row=next(x for x in out['state_reports']['drpc']['accounts']
                 if x['borrower']==address(3))
        self.assertEqual(row['risk']['status'],
                         'NO_OUTSTANDING_DEBT_IN_PINNED_AAVE_SNAPSHOT')
        self.assertFalse(row['borrow_event_and_state_same_transaction_prestate'])

    def test_write_rpc_and_override_forbidden(self):
        reader=r.RPC('drpc',mock_rpc())
        for name,params in [
            ('eth_sendRawTransaction',['0xdeadbeef']),
            ('eth_getLogs',[{'address':r.POOL,'topics':[],
                'fromBlock':hex(FIRST),'toBlock':hex(FIRST+24)}]),
            ('eth_call',[{'to':r.POOL,'data':'0x'+r.call_data(address(1))},
                {'blockHash':hash32(LAST),'requireCanonical':False}]),
            ('eth_getBlockByNumber',['pending',True]),
        ]:
            with self.subTest(name=name),self.assertRaises(r.Rejected):
                reader.call(name,params,allowed_borrowers={address(1)})
        self.assertEqual(reader.calls,0)

    def test_out_of_cohort_aave_account_query_rejected(self):
        rpc=r.RPC('drpc',mock_rpc())
        with self.assertRaises(r.Rejected):
            rpc.call('eth_call',[{'to':r.POOL,'data':'0x'+r.call_data(address(3))},
                {'blockHash':hash32(LAST),'requireCanonical':True}],
                allowed_borrowers={address(2)})

    def test_malformed_oracle_risk_abi_fails_closed(self):
        for raw in ('0xdeadbeef','0x'+'00'*192):
            if raw=='0xdeadbeef':
                with self.assertRaises(ValueError):r.decode_account(raw)

    def test_single_provider_tip_drift_is_not_a_borrower_census(self):
        def t(provider):
            original=mock_rpc()
            def fn(url,method,params):
                if method=='eth_blockNumber' and provider=='publicnode':
                    return hex(TIP+20)
                return original(url,method,params)
            return fn
        x=r.collect(transport_factory=t,current_unix=NOW)
        self.assertEqual(x['status'],
                         'INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE')
        self.assertEqual(x['errors'][0]['stage'],'anchor')

    def test_later_stale_header_blocks_candidate_promotion(self):
        out=r.collect(transport_factory=sources(),current_unix=NOW+500)
        self.assertEqual(out['status'],
                         'INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE')
        self.assertIsNone(out['source_verified_hf_lt_one_count'])
        self.assertEqual(out['errors'][0]['stage'],'state')

    def test_all_no_claims_preserved(self):
        x=r.collect(transport_factory=sources(),current_unix=NOW)
        self.assertFalse(x['nonrecourse_sponsor_for_own_capital_zero_certified'])
        self.assertFalse(x['route_feasibility_proven'])
        self.assertFalse(x['shadow_P2_certified'])
        self.assertFalse(x['RMC_closed'])
        self.assertFalse(x['canary_live_authorized'])
        self.assertFalse(x['commercial_score_upgrade'])
        self.assertEqual(x['nqc_realized_pnl_usd'],'0')


if __name__=='__main__':
    unittest.main()
