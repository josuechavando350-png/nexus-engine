#!/usr/bin/env python3
"""Pure-local negative/positive tests. Block 26183880+ data below are SYNTHETIC.

Do NOT present mock results as mainnet observation, competing liquidations,
shadow capture, capital capacity, or an authenticated provider transcript.
"""
import copy
import importlib.util
import json
import pathlib
import unittest

ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('under_test', ROOT/'quorum_block_intake.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SEED=ROOT/'fixtures'/'RUN07-immutable-seven-snapshot-ledger.jsonl'
SEED_RAW=SEED.read_bytes()
HASH_879='0x37e62b4a4f40b25f00e7c52c9c62eb7fcd7af62e1a62aa8e79f5bb1d1fed4745'
H_880='0x'+'01'*32
H_881='0x'+'02'*32
H_882='0x'+'03'*32
H_883='0x'+'04'*32
P=[{'operator_id':'operatorA','url':'https://provider-a.example/rpc'},
   {'operator_id':'operatorB','url':'https://provider-b.example/rpc'}]
WORDS=[676016197304638,621727339020612,0,9199,8999,1000333820000000047]

def raw_abi(vals):
    return '0x'+''.join(f'{v:064x}' for v in vals)

class Fake:
    def __init__(self, perturb=None): self.calls=[];self.perturb=perturb
    def __call__(self,url,method,params):
        op='A' if 'provider-a' in url else 'B'
        self.calls.append((op,method,copy.deepcopy(params)))
        if method=='eth_chainId': result='0x1'
        elif method=='eth_blockNumber': result=hex(26183883)
        elif method=='eth_getBlockByNumber':
            h=int(params[0],16)
            assert h in (26183880,26183881,26183882,26183883)
            hashes={26183879:HASH_879,26183880:H_880,26183881:H_881,26183882:H_882,26183883:H_883}
            result={'number':hex(h),'hash':hashes[h],
                    'parentHash':hashes[h-1],
                    'timestamp':hex(1791902411+(h-26183880)*12),'baseFeePerGas':'0x12a05f200'}
        elif method=='eth_call':
            h=params[1]['blockHash']
            assert h.startswith('0x') and len(h)==66
            assert params[0]['to'].lower()==m.POOL
            assert params[0]['data']==m.CALLDATA
            assert params[1]['requireCanonical'] is True
            vals=WORDS.copy()
            if h==H_881: vals[5]-=100
            elif h==H_882: vals[5]-=200
            elif h==H_883: vals[5]-=300
            result=raw_abi(vals)
        else:raise AssertionError(method)
        if self.perturb:
            result=self.perturb(op,method,params,copy.deepcopy(result))
        return {'jsonrpc':'2.0','id':1,'result':result}

def capture():return '2026-10-13T14:50:00Z'

def go(fake=None, **kw):
    return m.run(SEED_RAW,P,fake or Fake(),capture_clock=capture,**kw)

class QuorumRegression(unittest.TestCase):
    def test_seed_hash(self): self.assertEqual(m.sha(SEED_RAW),m.PRIOR_SHA)
    def test_seed_wrong_hash(self):
        with self.assertRaises(m.Rejected):m.validate_seed(SEED_RAW+b' ')
    def test_seed_missing_newline(self):
        with self.assertRaises(m.Rejected):m.validate_seed(SEED_RAW[:-1])
    def test_seed_forged_profit(self):
        altered=SEED_RAW.replace(b'"realized_nqc_pnl_usd":"0"',b'"realized_nqc_pnl_usd":"1"',1)
        with self.assertRaises(m.Rejected):m.validate_seed(altered)
    def test_two_blocks_append_exact_prefix(self):
        output, manifest, witnesses=go()
        self.assertTrue(output.startswith(SEED_RAW))
        self.assertEqual(len(output.splitlines()),9)
        self.assertEqual(manifest['new_blocks'],2)
        self.assertEqual(manifest['new_ledger_sha256'],m.sha(output))
        self.assertEqual(manifest['real_providers_contacted'],False)
        self.assertEqual(len(witnesses),2)
        for r in map(json.loads,output.splitlines()[-2:]):
            self.assertEqual(r['declared_distinct_operator_ids_count'],2)
            self.assertFalse(r['execution_eligible'])
            self.assertFalse(r['prospective_signal'])
            self.assertFalse(r['formal_shadow_admitted'])
            self.assertEqual(r['realized_nqc_pnl_usd'],'0')
    def test_output_contains_exact_wad(self):
        data,_,_=go()
        row=json.loads(data.splitlines()[-2])
        self.assertEqual(row['health_factor_wad'],str(WORDS[-1]))
    def test_eip1898_hash_pinned_call(self):
        f=Fake();go(f)
        for _,method,params in f.calls:
            if method=='eth_call':
                self.assertIn('blockHash',params[1]); self.assertTrue(params[1]['requireCanonical'])
    def test_single_block(self):
        d,mf,_=go(max_blocks=1)
        self.assertEqual(len(d.splitlines()),8);self.assertEqual(mf['new_blocks'],1)
    def test_zero_lookahead_claims(self):
        d,mf,_=go()
        self.assertEqual(set(mf['claims'].values()),{False,'0'})
    def test_zero_gap_hf_trigger_still_not_eligible(self):
        def low(op,meth,params,r):
            if meth=='eth_call':
                vals=WORDS.copy();vals[-1]=10**18-1;return raw_abi(vals)
            return r
        d,_,_=go(Fake(low),max_blocks=1)
        row=json.loads(d.splitlines()[-1]);self.assertTrue(row['candidate_hf_below_one'])
        self.assertEqual(row['decision'],'CANDIDATE_UNPRICED_NOT_EXECUTABLE')
        self.assertFalse(row['execution_eligible'])
    def test_provider_header_mismatch(self):
        def mutate(op,meth,params,r):
            if op=='B' and meth=='eth_getBlockByNumber':r['hash']='0x'+'be'*32
            return r
        with self.assertRaisesRegex(m.Rejected,'RPC_HEADER_DIVERGENCE'):go(Fake(mutate))
    def test_provider_raw_state_mismatch(self):
        def mutate(op,meth,params,r):
            if op=='B' and meth=='eth_call':return raw_abi(WORDS[:-1]+[WORDS[-1]+1])
            return r
        with self.assertRaisesRegex(m.Rejected,'RPC_STATE_DIVERGENCE'):go(Fake(mutate))
    def test_bad_parent(self):
        def mutate(op,meth,params,r):
            if meth=='eth_getBlockByNumber' and params[0]==hex(26183880):r['parentHash']='0x'+'ff'*32
            return r
        with self.assertRaisesRegex(m.Rejected,'REORG_OR_GAP'):go(Fake(mutate))
    def test_link_second_parent(self):
        def mutate(op,meth,params,r):
            if meth=='eth_getBlockByNumber' and params[0]==hex(26183881):r['parentHash']='0x'+'ff'*32
            return r
        with self.assertRaisesRegex(m.Rejected,'REORG_OR_GAP'):go(Fake(mutate))
    def test_wrong_chain(self):
        def mutate(op,meth,params,r):return '0xa' if meth=='eth_chainId' else r
        with self.assertRaisesRegex(m.Rejected,'wrong chain'):go(Fake(mutate))
    def test_forged_abi_json_number(self):
        def mutate(op,meth,params,r):return WORDS if meth=='eth_call' else r
        with self.assertRaisesRegex(m.Rejected,'ABI must be EXACT'):go(Fake(mutate))
    def test_forged_abi_short_word(self):
        def mutate(op,meth,params,r):return r[:-1] if meth=='eth_call' else r
        with self.assertRaisesRegex(m.Rejected,'ABI must be EXACT'):go(Fake(mutate))
    def test_forged_abi_extra_word(self):
        def mutate(op,meth,params,r):return r+('0'*64) if meth=='eth_call' else r
        with self.assertRaisesRegex(m.Rejected,'ABI must be EXACT'):go(Fake(mutate))
    def test_forged_abi_bad_char(self):
        def mutate(op,meth,params,r):return r[:-2]+'zz' if meth=='eth_call' else r
        with self.assertRaisesRegex(m.Rejected,'ABI must be EXACT'):go(Fake(mutate))
    def test_wrong_height(self):
        def mutate(op,meth,params,r):
            if meth=='eth_getBlockByNumber':r['number']='0x1'
            return r
        with self.assertRaisesRegex(m.Rejected,'unexpected block height'):go(Fake(mutate))
    def test_negative_time(self):
        with self.assertRaisesRegex(m.Rejected,'observation before block'):m.run(SEED_RAW,P,Fake(),capture_clock=lambda:'2026-10-12T00:00:00Z')
    def test_bad_rpc_id(self):
        def bad(url,method,params):return {'jsonrpc':'2.0','id':2,'result':'0x1'}
        with self.assertRaisesRegex(m.Rejected,'envelope'):go(bad)
    def test_rpc_failure_explicit(self):
        def bad(url,method,params):return {'jsonrpc':'2.0','id':1,'error':{'code':-1}}
        with self.assertRaisesRegex(m.Rejected,'RPC_REJECTED'):go(bad)
    def test_rpc_missing_result(self):
        def bad(url,method,params):return {'jsonrpc':'2.0','id':1}
        with self.assertRaisesRegex(m.Rejected,'missing RPC result'):go(bad)
    def test_duplicate_operator(self):
        with self.assertRaisesRegex(m.Rejected,'duplicate operator'):m.check_providers(P+[dict(P[0])])
    def test_duplicate_url(self):
        with self.assertRaisesRegex(m.Rejected,'duplicate provider URL'):m.check_providers(P+[{'operator_id':'third','url':P[0]['url']}])
    def test_only_one_provider(self):
        with self.assertRaisesRegex(m.Rejected,'two RPC'):m.check_providers(P[:1])
    def test_plain_http_forbidden(self):
        with self.assertRaisesRegex(m.Rejected,'HTTPS'):m.check_providers([{'operator_id':'opA','url':'http://public.example'},{'operator_id':'opB','url':'https://other.example'}])
    def test_url_credentials_forbidden(self):
        with self.assertRaisesRegex(m.Rejected,'HTTPS'):m.check_providers([{'operator_id':'opA','url':'https://alice:secret@example.org'},{'operator_id':'opB','url':'https://other.example'}])
    def test_bool_max_blocks_forbidden(self):
        with self.assertRaisesRegex(m.Rejected,'max_blocks'):go(max_blocks=True)
    def test_max_blocks_limited(self):
        with self.assertRaisesRegex(m.Rejected,'max_blocks'):go(max_blocks=129)
    def test_confirmation_negative(self):
        with self.assertRaisesRegex(m.Rejected,'confirmation depth'):go(depth=-1)
    def test_fork_tip_gap(self):
        with self.assertRaisesRegex(m.Rejected,'no new block'):go(depth=5)
    def test_no_unbacked_pos_net(self):
        d,_,_=go();rows=[json.loads(x) for x in d.splitlines()[-2:]]
        self.assertTrue(all(x['route_economics']=='NOT_VERIFIED' for x in rows))

    def test_incremental_two_batch_continuation(self):
        first,mf,_=go()
        second,mf2,_=m.run(first,P,Fake(),max_blocks=2,capture_clock=capture,
                            expected_seed_sha=m.sha(first))
        self.assertEqual(len(first.splitlines()),9)
        self.assertEqual(len(second.splitlines()),11)
        self.assertTrue(second.startswith(first))
        self.assertEqual(mf2['first_height'],26183882)
        self.assertEqual(mf2['last_height'],26183883)
        self.assertEqual(mf2['seed_sha256'],mf['new_ledger_sha256'])
        self.assertEqual(mf2['new_ledger_sha256'],m.sha(second))
    def test_incremental_requires_previous_digest(self):
        first,_,_=go()
        with self.assertRaisesRegex(m.Rejected,'previous ledger SHA-256'):
            m.run(first,P,Fake(),max_blocks=1,capture_clock=capture)
    def test_incremental_cannot_trust_forged_authority_with_new_digest(self):
        first,_,_=go()
        bad=first.replace(b'"prospective_signal":false',b'"prospective_signal":true',1)
        # If first record (RUN07) changed, root anchor alone must reject it.
        with self.assertRaisesRegex(m.Rejected,'immutable RUN07 root'):
            m.validate_seed(bad,required_sha=m.sha(bad))
        # Tamper a newly appended row AND recompute digest: semantics must reject.
        bad=first.replace(b'"prospective_signal":false',b'"prospective_signal":true',0)
        lines=first.splitlines(keepends=True)
        lines[7]=lines[7].replace(b'"prospective_signal":false',b'"prospective_signal":true')
        bad=b''.join(lines)
        with self.assertRaisesRegex(m.Rejected,'forged historical commercial'):
            m.validate_seed(bad,required_sha=m.sha(bad))
    def test_manifest_binds_raw_evidence_bytes(self):
        _,mf,ev=go()
        self.assertEqual(mf['raw_evidence_sha256'],m.sha(m.canonical(ev)+b'\n'))
    def test_older_provider_tip_limits_batch(self):
        # The minimum verified height bounds progress (no lookahead).
        _,mf,_=go(depth=1)
        self.assertEqual(mf['latest_safe_common_tip'],26183882)
    def test_second_batch_seed_cannot_reorg(self):
        first,_,_=go()
        def mutate(op,meth,params,r):
            if meth=='eth_getBlockByNumber' and params[0]==hex(26183882):
                r['parentHash']='0x'+'ee'*32
            return r
        with self.assertRaisesRegex(m.Rejected,'REORG_OR_GAP'):
            m.run(first,P,Fake(mutate),max_blocks=2,capture_clock=capture,
                  expected_seed_sha=m.sha(first))

    def test_bogus_boolean_rpc_id(self):
        def bad(url,method,params):return {'jsonrpc':'2.0','id':True,'result':'0x1'}
        with self.assertRaisesRegex(m.Rejected,'envelope'):go(bad)
    def test_tampered_source_ids_rejected_on_continuation(self):
        first,_,_=go()
        chunks=first.splitlines(keepends=True)
        entry=json.loads(chunks[7]);entry['source_operator_ids']=['operatorA','operatorA']
        chunks[7]=m.canonical(entry)+b'\n'
        bad=b''.join(chunks)
        with self.assertRaisesRegex(m.Rejected,'operator identities inconsistent'):
            m.validate_seed(bad,required_sha=m.sha(bad))
    def test_tampered_raw_digest_schema_on_continuation(self):
        first,_,_=go()
        chunks=first.splitlines(keepends=True)
        entry=json.loads(chunks[7]);entry['raw_abi_sha256']='blatantly wrong'
        chunks[7]=m.canonical(entry)+b'\n'
        bad=b''.join(chunks)
        with self.assertRaisesRegex(m.Rejected,'historical raw ABI digest'):
            m.validate_seed(bad,required_sha=m.sha(bad))
    def test_only_synthetic_provider_fixture(self):
        self.assertIn('example',P[0]['url'])
        self.assertEqual(m.sha(SEED_RAW),m.PRIOR_SHA)

if __name__=='__main__': unittest.main()
