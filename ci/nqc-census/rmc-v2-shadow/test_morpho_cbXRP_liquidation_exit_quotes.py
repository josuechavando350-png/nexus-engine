"""Adversarial source/quote tests; mock third-party APIs, no network calls."""
import copy
import json
from pathlib import Path
import unittest
import urllib.parse
import morpho_cbXRP_liquidation_exit_quotes as m

SOURCE=Path(__file__).resolve().parent/'morpho_base_cbXRP_economics.py'

def kyber(amount,output):
    return {'code':1,'data':{'routeSummary':{'tokenIn':m.COLLATERAL,
      'tokenOut':m.LOAN,'amountIn':str(amount),'amountOut':str(output),
      'gasUsd':'0.25','route':[[{'exchange':'uniswap'}]]}}}

def lifi(amount,output):
    return {'tool':'mock-routing','action':{'fromChainId':8453,'toChainId':8453,
       'fromToken':{'address':m.COLLATERAL,'decimals':6},
       'toToken':{'address':m.LOAN,'decimals':6},'fromAmount':str(amount)},
       'estimate':{'toAmount':str(output),'toAmountMin':str(output-100),
        'gasCosts':[]}}

class QuoteGateTests(unittest.TestCase):
    def test_exact_pinned_source(self):
        z=m.source_admission(SOURCE)
        self.assertEqual(z['original_parent_blob_sha1'],m.PARENT_SOURCE_GIT_BLOB)
        self.assertEqual(z['sample_count'],3)
    def test_wrong_source_bytes_fail(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as d:
            p=Path(d)/'source.py';p.write_bytes(SOURCE.read_bytes()+b'\n# tampered')
            with self.assertRaisesRegex(m.Rejected,'PINNED_SOURCE_BLOB_MISMATCH'):m.source_admission(p)
    def test_zero_or_bool_uint_denied(self):
        for val in [None,True,False,3.5,'-1','00','01','1.3','1e6','',1]:
            with self.subTest(val=val):
                with self.assertRaises(m.Rejected):m.uint(val,'bad')
    def test_unsigned_max(self):
        self.assertEqual(m.uint(str(2**256-1),'big'),2**256-1)
        with self.assertRaises(m.Rejected):m.uint(str(2**256),'big')
    def test_three_sample_exact_source(self):
        self.assertEqual(len(m.SAMPLES),3)
        self.assertEqual(sum(v[2] for v in m.SAMPLES),213378650404)
    def test_only_quote_get_domains(self):
        for name in ('kyberswap','lifi'):
            url=m.quote_url(name,165653805)
            q=urllib.parse.urlparse(url)
            self.assertEqual(q.scheme,'https')
            self.assertIn(q.netloc,('li.quest','aggregator-api.kyberswap.com'))
            self.assertNotIn('key=',url.lower())
        with self.assertRaises(m.Rejected):m.quote_url('wallet-signer',165653805)
        with self.assertRaises(m.Rejected):m.quote_url('lifi',0)
    def test_quote_get_is_not_transaction(self):
        urls=[m.quote_url(p,165653805) for p in ('kyberswap','lifi')]
        self.assertNotIn('eth_send',str(urls))
        self.assertIn('skipSimulation=true',urls[1])
        self.assertIn('0x000000000000000000000000000000000000dEaD',urls[1])
    def test_kyber_exact(self):
        a=m.validate_kyber(kyber(5_000,7_000),5_000)
        self.assertEqual(a['amount_out_usdc_raw'],'7000')
    def test_kyber_wrong_pair(self):
        v=kyber(5000,7000);v['data']['routeSummary']['tokenOut']='0x'+'f'*40
        with self.assertRaises(m.Rejected):m.validate_kyber(v,5000)
    def test_kyber_wrong_input(self):
        with self.assertRaises(m.Rejected):m.validate_kyber(kyber(5001,7000),5000)
    def test_kyber_no_route(self):
        with self.assertRaises(m.Rejected):m.validate_kyber({'code':1,'data':{}},5000)
    def test_lifi_exact(self):
        a=m.validate_lifi(lifi(10_000,20_000),10_000)
        self.assertEqual(a['amount_out_usdc_raw'],'20000')
        self.assertTrue(a['quote_uses_placeholder_sender'])
    def test_lifi_bad_chain(self):
        v=lifi(10000,20000);v['action']['toChainId']=1
        with self.assertRaises(m.Rejected):m.validate_lifi(v,10000)
    def test_lifi_bad_decimals(self):
        v=lifi(10000,20000);v['action']['toToken']['decimals']=18
        with self.assertRaises(m.Rejected):m.validate_lifi(v,10000)
    def test_lifi_bad_min(self):
        v=lifi(10000,20000);v['estimate']['toAmountMin']='21000'
        with self.assertRaises(m.Rejected):m.validate_lifi(v,10000)
    def test_lifi_bad_input(self):
        with self.assertRaises(m.Rejected):m.validate_lifi(lifi(10001,20000),10000)
    def test_complete_mock_case_six_non_historical_quotes(self):
        seen=[]
        def fetch(p,amt):
            seen.append((p,amt))
            return (kyber(amt,amt*2) if p=='kyberswap' else lifi(amt,amt*2)),'0'*64
        r=m.produce(SOURCE,fetch)
        self.assertEqual(r['status'],'FRESH_QUOTE_SNAPSHOT_SOURCE_ONLY')
        self.assertEqual(r['quotes_admitted'],6)
        self.assertEqual(r['network_http_calls'],6)
        self.assertEqual(len(seen),6)
        self.assertFalse(r['native_gas_sponsor_proven'])
        self.assertEqual(r['realized_nqc_pnl_usd'],'0')
        self.assertFalse(r['historical_oracle_Dex_price_parity_proven'])
        for case in r['selected_historical_cases']:
            self.assertFalse(case['real_historical_dex_exit_proven'])
            for p in case['providers'].values():self.assertEqual(p['status'],'UNEXECUTED_FRESH_INDEXED_QUOTE_ONLY')
    def test_http403_provider_locked_no_retries(self):
        seen=[]
        def fetch(provider,amt):
            seen.append(provider)
            if provider=='kyberswap':raise m.SourceUnavailable('HTTP_403')
            return lifi(amt,amt+10000),'a'*64
        r=m.produce(SOURCE,fetch)
        self.assertEqual(seen.count('kyberswap'),1)
        self.assertEqual(seen.count('lifi'),3)
        self.assertEqual(r['network_http_calls'],4)
        self.assertEqual(r['quotes_admitted'],3)
        self.assertEqual(r['selected_historical_cases'][1]['providers']['kyberswap']['cause'],'PROVIDER_DENIED_EARLIER_IN_RUN')
    def test_two_sources_rate_denial_no_evasion(self):
        calls=[]
        def fetch(p,amt):
            calls.append(p);raise m.SourceUnavailable('HTTP_429')
        r=m.produce(SOURCE,fetch)
        self.assertEqual(r['network_http_calls'],2)
        self.assertEqual(r['quotes_admitted'],0)
        self.assertEqual(r['status'],'INCOMPLETE_PUBLIC_DEX_QUOTES')
        self.assertEqual(calls,['kyberswap','lifi'])
    def test_mock_negative_quotes_do_not_claim_profit(self):
        def fetch(p,amt):return (kyber(amt,1) if p=='kyberswap' else lifi(amt,200)), 'c'*64
        r=m.produce(SOURCE,fetch)
        self.assertTrue(all(int(y['quoted_spread_before_all_unmeasured_gas_mev_flash_costs_usdc_raw'])<0
            for x in r['selected_historical_cases'] for y in x['providers'].values()))
        self.assertEqual(r['realized_nqc_pnl_usd'],'0')
    def test_break_even_rational_exact(self):
        def fetch(p,amt):raise m.SourceUnavailable('QUOTE_UNAVAILABLE')
        r=m.produce(SOURCE,fetch)
        case=r['selected_historical_cases'][2]
        self.assertEqual(case['break_even_ratio_numerator_repaid_raw'],'154844072724')
        self.assertEqual(case['break_even_ratio_denominator_seized_raw'],'123660088593')
        self.assertEqual(case['historical_break_even_price_usdc_per_cbxrp_ex_costs'],'1.25217501')
    def test_tampered_http_success_not_accepted(self):
        def fetch(p,amt):
            if p=='kyberswap':return kyber(amt+1,amt*2), 'e'*64
            return lifi(amt,amt*2),'d'*64
        r=m.produce(SOURCE,fetch)
        self.assertEqual(r['quotes_admitted'],3)
        self.assertEqual(r['status'],'INCOMPLETE_PUBLIC_DEX_QUOTES')
        self.assertTrue(all(x['providers']['kyberswap']['status']=='NO_ADMITTED_QUOTE' for x in r['selected_historical_cases']))

if __name__=='__main__':unittest.main()
