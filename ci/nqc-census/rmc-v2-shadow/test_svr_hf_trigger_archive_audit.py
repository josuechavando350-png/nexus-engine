#!/usr/bin/env python3
"""Offline fail-closed cases; all transactions and price states are synthetic fixtures."""
from pathlib import Path
import tempfile
import unittest

import svr_archive_positive_controls as base
import svr_hf_trigger_archive_audit as gate


def h(n):
    return '0x' + format(n,'064x')


def word(n):
    return int(n).to_bytes(32,'big').hex()


def price(roundid,answer, block):
    return '0x'+''.join(word(q) for q in (roundid,answer,block*12-10,block*12-5,roundid))


class FakeRPC:
    def __init__(self,label,mode='normal',root=None):
        self.label=label;self.mode=mode;self.root=root
        self.calls=0;self.transcript=[];self.pins=set();self.seen=[]
    def call(self,method,args):
        if self.root is not None:
            assert (self.root/'causal-source-precommit.json').is_file(), 'missing source precommit'
        self.calls+=1;self.seen.append((method,args))
        if method=='eth_chainId':
            return '0x2' if self.mode=='other_chain' else '0x1'
        if method=='eth_getBlockByNumber':
            height=int(args[0],16)
            cases={q['block'] for q in gate.CAUSAL_CONTROLS}
            assert height in cases or height+1 in cases
            d={'number':hex(height),'hash':h(height),'parentHash':h(height-1),
               'stateRoot':'0x'+'a1'*32,'timestamp':hex(height*12)}
            if self.mode=='header_split':d['hash']='0x'+'dd'*32
            return d
        if method in ('eth_getTransactionReceipt','eth_getTransactionByHash'):
            case=next(q for q in gate.CAUSAL_CONTROLS if q['tx_hash']==args[0])
            if method=='eth_getTransactionReceipt':
                return {'transactionHash':case['tx_hash'], 'blockHash':h(case['block']),
                        'blockNumber':hex(case['block']),'transactionIndex':'0x0',
                        'status':'0x0' if self.mode=='reverted' else '0x1',
                        'logs':([{'address':base.WETH_AGGREGATOR,
                                  'topics':[base.SECONDARY_TOPIC],
                                  'transactionHash':case['tx_hash'],
                                  'blockHash':h(case['block']),
                                  'blockNumber':hex(case['block']),'removed':False}]
                                if self.mode!='no_topic' else [])}
            return {'hash':case['tx_hash'],'blockHash':h(case['block']),
                    'blockNumber':hex(case['block']),'transactionIndex':'0x0','input':'0x'}
        if method=='eth_call':
            block=int(args[1]['blockHash'][2:],16)
            before=block+1 in {q['block'] for q in gate.CAUSAL_CONTROLS}
            val=250000000000 if before or self.mode=='no_decrease' else 240000000000
            rid=100 if before else 101
            tx=args[0]
            if tx=={'to':base.WETH_PROXY,'data':base.AGGREGATOR_SELECTOR}:
                return '0x'+word(int(base.WETH_AGGREGATOR,16))
            if tx=={'to':base.AAVE_ORACLE,'data':base.AAVE_WETH_PRICE_CALL}:
                return '0x'+word(val)
            if tx=={'to':base.WETH_PROXY,'data':base.ROUND_SELECTOR}:
                return price(rid,val,block)
            if tx=={'to':base.WETH_AGGREGATOR,'data':base.ROUND_SELECTOR}:
                return price(97,250000000000,block)  # Deliberately stale direct aggregator
            raise AssertionError('unapproved simulated contract target')
        raise AssertionError('only read-only RPC allowed')


class FakeArchive:
    def __init__(self, archived=True, linked=False):
        self.archived=archived;self.linked=linked
        self.calls=0;self.log=[];self.received=[]
    def info(self):
        self.calls+=1
        return {'minBlock':0,'maxBlock':27000000,'maxLimit':400}
    def inspect(self,case,meta):
        self.calls+=1;self.received.append(case['block_number'])
        return {'status':('BOUNDED_PUBLIC_ARCHIVE_EXHAUSTED_NOT_PRIVATE_ACCESS'
                           if self.archived else 'INCOMPLETE_ARCHIVE_PAGINATION_CAP'),
                'archive_complete_in_bounded_range':self.archived,
                'hint_rows':120,'exact_double_hash_matches':1 if self.linked else 0,
                'matching_double_hash_with_decodable_target':1 if self.linked else 0,
                'matching_archive_source_timings':[
                    {'hint_price_matches_onchain_transmit_report':True}] if self.linked else []}


def fake_runner(out,*,controls,require_decrease,mode='normal',archived=True,linked=False,root=None):
    clients={name:FakeRPC(name,mode if name=='blast' else 'normal',root)
             for name in ('drpc','blast')}
    archive=FakeArchive(archived=archived,linked=linked)
    data=base.run(out,controls=controls,require_decrease=require_decrease,
                  rpc_clients=clients,archive=archive)
    return data,archive,clients


class HistoricalCausalArchiveTests(unittest.TestCase):
    def test_two_distinct_immutable_index_zero_causal_cases(self):
        self.assertEqual([c['block'] for c in gate.CAUSAL_CONTROLS],[26142067,26149038])
        self.assertEqual([c['index'] for c in gate.CAUSAL_CONTROLS],[0,0])
        self.assertTrue(all(base.HEX32.fullmatch(c['tx_hash']) for c in gate.CAUSAL_CONTROLS))
        self.assertEqual(len({c['tx_hash'] for c in gate.CAUSAL_CONTROLS}),2)

    def test_old_certified_controls_not_mutated(self):
        self.assertEqual([c['block'] for c in base.POSITIVE],[26193643,26193944])
        self.assertNotEqual(set(c['tx_hash'] for c in base.POSITIVE),
                            set(c['tx_hash'] for c in gate.CAUSAL_CONTROLS))

    def test_historical_blast_fallback_is_explicit_not_a_publicnode_pass(self):
        self.assertEqual(base.BLAST_PUBLIC_URL,"https://eth-mainnet.public.blastapi.io")
        rpc=base.RPC("blast",controls=gate.CAUSAL_CONTROLS,transport=lambda *a:None)
        self.assertEqual(rpc.url,base.BLAST_PUBLIC_URL)
        self.assertEqual(base.RPC("publicnode").url,
                         "https://ethereum-rpc.publicnode.com")
        self.assertNotEqual(rpc.url,base.RPC("publicnode").url)

    def test_new_rpc_rejects_old_or_arbitrary_transaction(self):
        rpc=base.RPC('drpc',controls=gate.CAUSAL_CONTROLS,transport=lambda *args:None)
        for bad in (base.POSITIVE[0]['tx_hash'],'0x'+'11'*32):
            with self.assertRaises(base.Rejected):
                rpc.call('eth_getTransactionByHash',[bad])
        with self.assertRaises(base.Rejected):
            rpc.call('eth_sendRawTransaction',[])
        self.assertEqual(rpc.calls,0)

    def test_raw_receipt_dissent_is_recorded_not_normalized_to_pass(self):
        a={"transactionHash":"0x"+"11"*32,"blockHash":"0x"+"22"*32,
           "blockNumber":"0x1","transactionIndex":"0x0","status":"0x1",
           "gasUsed":"0x5208","effectiveGasPrice":"0x5",
           "logs":[{"logIndex":"0x0","address":base.WETH_AGGREGATOR}]}
        b=dict(a)
        b["effectiveGasPrice"]="0x6"
        b["logs"]=[dict(a["logs"][0],removed=False)]
        mismatch=base.sanitized_mismatch("eth_getTransactionReceipt",a,b)
        self.assertIn("effectiveGasPrice",mismatch["changed_shared_fields"])
        self.assertIn("logs",mismatch["changed_shared_fields"])
        self.assertEqual(mismatch["log_field_deltas"][0]["only_secondary_provider_keys"],["removed"])
        self.assertFalse(mismatch["canonical_authority_promoted"])
        self.assertFalse(mismatch["required_receipt_fields_identical"])

    def test_new_archive_denies_old_scope_and_foreign_host(self):
        calls=[]
        def fake(*args,**kwargs):
            calls.append(args);raise AssertionError('transport called')
        arc=base.Archive(opener=fake,controls=gate.CAUSAL_CONTROLS,max_pages=8)
        with self.assertRaises(base.Rejected):
            arc.get(base.HISTORY+'?blockStart=26193936&blockEnd=26193945&limit=400&offset=0')
        with self.assertRaises(base.Rejected):
            arc.get('https://evil.invalid/api/v1/history?blockStart=26142059&blockEnd=26142068&limit=400&offset=0')
        self.assertEqual(calls,[])

    def test_effective_aave_path_does_not_substitute_aggregator_round(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,_,clients=fake_runner(Path(directory)/'attempt',
                controls=gate.CAUSAL_CONTROLS,require_decrease=True)
            self.assertEqual(evidence['source_errors'],[])
            self.assertTrue(all(c['effective_Aave_WETH_proxy_price_verified']
                                for c in evidence['positive_controls']))
            observed=[params[0] for method,params in clients['drpc'].seen
                      if method=='eth_call']
            self.assertIn({'to':base.WETH_PROXY,'data':base.ROUND_SELECTOR},observed)
            self.assertIn({'to':base.AAVE_ORACLE,'data':base.AAVE_WETH_PRICE_CALL},observed)
            self.assertNotIn({'to':base.WETH_AGGREGATOR,'data':base.ROUND_SELECTOR},observed)

    def test_archive_pagination_cannot_be_unlimited(self):
        with self.assertRaises(base.Rejected):
            base.Archive(controls=gate.CAUSAL_CONTROLS,max_pages=99)

    def test_price_decrease_and_receipts_from_two_mocked_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,archive,clients=fake_runner(Path(directory)/'attempt',
                controls=gate.CAUSAL_CONTROLS,require_decrease=True)
            self.assertEqual(len(evidence['positive_controls']),2)
            self.assertEqual(evidence['source_errors'],[])
            self.assertEqual([r['price_before']['answer_raw'] for r in evidence['positive_controls']],
                             ['250000000000','250000000000'])
            self.assertTrue(all(int(r['price_after']['answer_raw'])<int(r['price_before']['answer_raw'])
                                for r in evidence['positive_controls']))
            self.assertEqual(archive.received,[26142067,26149038])
            self.assertLessEqual(clients['drpc'].calls,28)

    def test_no_price_decrease_rejects_without_archive_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,arc,_=fake_runner(Path(directory)/'attempt',
               controls=gate.CAUSAL_CONTROLS,require_decrease=True,mode='no_decrease')
            self.assertEqual(evidence['status'],'INCOMPLETE_SOURCE_CONTROLS')
            self.assertEqual(arc.calls,0)
            self.assertEqual(len(evidence['positive_controls']),0)

    def test_wrong_chain_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,arc,_=fake_runner(Path(directory)/'attempt',
                 controls=gate.CAUSAL_CONTROLS,require_decrease=True,mode='other_chain')
            self.assertEqual(evidence['status'],'INCOMPLETE_SOURCE_CONTROLS')
            self.assertEqual(arc.calls,0)

    def test_missing_topic_censored_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,arc,_=fake_runner(Path(directory)/'attempt',
              controls=gate.CAUSAL_CONTROLS,require_decrease=True,mode='no_topic')
            self.assertEqual(evidence['status'],'INCOMPLETE_SOURCE_CONTROLS')
            self.assertEqual(arc.calls,0)

    def test_archive_out_of_range_never_claims_zero_market(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,arc,_=fake_runner(Path(directory)/'attempt',
                 controls=gate.CAUSAL_CONTROLS,require_decrease=True,archived=False)
            self.assertEqual(evidence['status'],'INCOMPLETE_ARCHIVE_COVERAGE_NOT_ABSENCE')
            self.assertEqual(gate.classification(evidence),'INCOMPLETE_CAUSAL_SOURCE_OR_ARCHIVE')

    def test_complete_but_no_exact_link_is_not_private_access_denial(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,_,_=fake_runner(Path(directory)/'attempt',
                controls=gate.CAUSAL_CONTROLS,require_decrease=True)
            self.assertEqual(gate.classification(evidence),
                'NO_COMPLETE_HINT_LINK_IN_TWO_BOUNDED_HISTORICAL_WINDOWS')
            self.assertEqual(evidence['nqc_realized_pnl_usd'],'0')

    def test_synthetic_two_matched_hints_still_not_prospective(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence,_,_=fake_runner(Path(directory)/'attempt',
                controls=gate.CAUSAL_CONTROLS,require_decrease=True,linked=True)
            self.assertEqual(gate.classification(evidence),
                'TWO_HISTORICAL_HF_TRIGGER_ORACLE_HINT_LINKS_NO_CAPTURE_AUTHORITY')
            self.assertFalse(evidence['private_first_seen_proven'])
            self.assertFalse(evidence['builder_cutoff_proven'])
            self.assertFalse(evidence['nonrecourse_native_gas_funded'])

    def test_end_to_end_precommit_before_any_source_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'audit'
            def runner(out,*,controls,require_decrease):
                data,_,_=fake_runner(out,controls=controls,
                         require_decrease=require_decrease,root=root)
                return data
            result=gate.audit(root,source_runner=runner)
            self.assertTrue((root/'causal-source-precommit.json').is_file())
            self.assertEqual(len(result['authenticated_price_drops']),2)
            self.assertEqual(result['status'],
                             'NO_COMPLETE_HINT_LINK_IN_TWO_BOUNDED_HISTORICAL_WINDOWS')
            self.assertFalse(result['actual_NQC_process_first_seen_proven'])
            self.assertEqual(result['realized_NQC_profit_USD'],'0')

    def test_malformed_or_missing_runner_artifact_censored(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'audit'
            result=gate.audit(root,source_runner=lambda *a,**k:{'status':'NOT_REAL'})
            self.assertEqual(result['status'],'INCOMPLETE_SOURCE_EXCEPTION_NO_CAPTURE_AUTHORITY')
            self.assertTrue(result['source_errors'])

    def test_status_wont_upgrade_on_unverified_new_source(self):
        source={'status':'INCOMPLETE_SOURCE_CONTROLS','positive_controls':[],
                'archive':[{'archive_complete_in_bounded_range':True}]}
        self.assertEqual(gate.classification(source),'INCOMPLETE_CAUSAL_SOURCE_OR_ARCHIVE')
        self.assertFalse(gate.EXTERNAL_CAUSAL_EVIDENCE['prior_crossing_replay_newly_run_in_this_gate'])

if __name__=='__main__': unittest.main()
