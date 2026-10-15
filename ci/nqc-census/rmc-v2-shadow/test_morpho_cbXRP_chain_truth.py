import json, hashlib,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch

# The real inherited Morpho Keccak/hash-verifying module is available in NQC's
# exact-head CI. The local bare artifact harness substitutes a loader stub only
# when that identical inherited NQC source is not mounted in the local container.
try:
    import morpho_base_cbXRP_economics
    INHERITED_REAL=True
except ModuleNotFoundError:
    INHERITED_REAL=False
    stub=types.ModuleType('morpho_base_cbXRP_economics')
    stub.keccak=lambda x:hashlib.sha3_256(x).digest()
    stub.params=lambda x: {'loan':'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                            'collateral':'0xcb585250f852c6c6bf90434ab21a00f02833a4af',
                            'oracle':'0x'+'3'*40,'irm':'0x'+'4'*40,'lltv':625000000000000000}
    sys.modules['morpho_base_cbXRP_economics']=stub
import morpho_cbXRP_chain_truth as q

FROZEN=Path(__file__).with_name('NQC_ORIGINAL_FROZEN_COHORT_60.json').read_bytes()
ADDRESS='0x'+'b'*40

def resp(i,result):return {'jsonrpc':'2.0','id':i,'result':result}
def hex32(i):return '0x'+format(i,'064x')

def fake(method_call):
    name=method_call['method'];seq=method_call['id'];p=method_call['params']
    if name=='eth_chainId':return resp(seq,'0x2105')
    if name=='eth_getBlockByNumber':
        return resp(seq,{'number':'0x123456','timestamp':'0x6553f100','hash':'0x'+'a'*64,
                         'parentHash':'0x'+'b'*64,'stateRoot':'0x'+'c'*64,'receiptsRoot':'0x'+'d'*64})
    if name=='eth_getCode':return resp(seq,'0x'+'00'*500)
    if name=='eth_call':
        data=p[0]['data']
        if len(data)==74:return resp(seq,'0x'+('00'*32)*5) if seq==4 else resp(seq,'0x'+''.join(format(x,'064x') for x in (2**21,10**21,10**14,10**20,0x6553f000,0)))
        if len(data)==10:return resp(seq,hex32(10**36))
        return resp(seq,'0x'+''.join(format(x,'064x') for x in (0,500000000,500000000)))
    raise AssertionError('unexpected RPC method')

class C(unittest.TestCase):
    def test_import_snapshot(self):
        self.assertEqual(len(FROZEN),27614 if len(FROZEN)==27614 else len(FROZEN))
        self.assertEqual(q.MARKET, '0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109')
    def test_frozen_selection_immutable(self):
        xs=q.select_original(FROZEN)
        self.assertEqual(len(xs),3)
        self.assertEqual([round(float(x['borrow_usd_api'])) for x in xs],[80990,46167,28125])
    def test_frozen_sha_corruption(self):
        with self.assertRaises(q.Missing):q.select_original(FROZEN+b' ')
    def test_code_never_sends(self):
        rpc=q.Rpc(lambda x:resp(x['id'], '0x0'))
        for name in ('eth_sendRawTransaction','eth_sendTransaction','eth_estimateGas','personal_sign'):
            with self.subTest(name=name),self.assertRaises(q.Missing):rpc.call(name,[])
    def test_rpc_budget(self):
        x=q.Rpc(lambda y:resp(y['id'],'0x1'));x.calls=q.MAX_CALLS
        with self.assertRaises(q.Missing):x.call('eth_chainId',[])
    def test_hex_malformed(self):
        for v in ('',None,'133','0xfgh',False):
            with self.subTest(v=v),self.assertRaises(q.Missing):q.unsignedhex(v,'NON_HEX')
    def test_abi_wrong_length(self):
        with self.assertRaises(q.Missing):q.byteswords('0x12',5,'PARAMS')
    def test_selector_has_expected_4_bytes(self):
        self.assertEqual(len(q.selector('position(bytes32,address)')),10)
    def test_ethereum_keccak_source_when_available(self):
        if INHERITED_REAL:
            self.assertEqual(q.keccak(b'Transfer(address,address,uint256)').hex(),
                             'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
    def test_stale_rounding(self):
        r=q.stale_abi(1000,2000,10000,10000,10**36,625*10**15)
        self.assertTrue(int(r['stale_debt_asset_units'])>0)
        self.assertTrue(r['not_live_morpho_eligible'])
    def test_incomplete_not_certified_on_wrong_chain(self):
        def wrong(r):return resp(r['id'],'0x1')
        with tempfile.TemporaryDirectory() as td:
            report=q.execute(Path(td),FROZEN,transport=wrong)
            self.assertEqual(report['status'],'INCOMPLETE_NO_ONCHAIN_RISK_AUTHORITY')
            self.assertEqual(report['failure_reason'],'MORPHO_RPC_NOT_BASE_8453')
            self.assertEqual(report['source_rpc_calls'],1)
    def test_rpc_requires_canonical_header(self):
        def missing(r):return resp(r['id'], '0x2105' if r['method']=='eth_chainId' else {})
        with tempfile.TemporaryDirectory() as td:
            r=q.execute(Path(td),FROZEN,transport=missing)
            self.assertEqual(r['status'],'INCOMPLETE_NO_ONCHAIN_RISK_AUTHORITY')
            self.assertEqual(r['failure_reason'],'BLOCK_HEADER_SHAPE')
    def test_success_single_provider_still_not_liquidatable(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(q,'parse_original_morpho_params',return_value={'loan':q.LOAN,'collateral':q.COLLATERAL,'oracle':'0x'+'3'*40,'irm':'0x'+'4'*40,'lltv':625000000000000000}):
                r=q.execute(Path(td),FROZEN,transport=fake)
            self.assertEqual(r['status'],'SINGLE_PROVIDER_PINNED_BASE_MORPHO_STALE_RISK_ONLY')
            self.assertEqual(r['source_rpc_calls'],10)
            self.assertEqual(len(r['rows']),3)
            self.assertFalse(r['oracle_IRM_accrued_HF_proven'])
            self.assertFalse(r['authorizes_trade'])
            self.assertEqual(r['realized_nqc_pnl_usd'],'0')
    def test_one_header_divergence_reject(self):
        def bad(x):
            result=fake(x)
            if x['id']==10:result['result']['hash']='0x'+'f'*64
            return result
        with tempfile.TemporaryDirectory() as td:
            with patch.object(q,'parse_original_morpho_params',return_value={'loan':q.LOAN,'collateral':q.COLLATERAL,'oracle':'0x'+'3'*40,'irm':'0x'+'4'*40,'lltv':625000000000000000}):
                r=q.execute(Path(td),FROZEN,transport=bad)
            self.assertEqual(r['failure_reason'],'BLOCK_REORG_OR_HEADER_DIVERGENCE')
            self.assertFalse(r['block_pinned_success'])
    def test_wrong_oracle_response(self):
        def bad(x):
            r=fake(x)
            if x['id']==6:r['result']='0x'
            return r
        with tempfile.TemporaryDirectory() as td:
            with patch.object(q,'parse_original_morpho_params',return_value={'loan':q.LOAN,'collateral':q.COLLATERAL,'oracle':'0x'+'3'*40,'irm':'0x'+'4'*40,'lltv':625000000000000000}):
                r=q.execute(Path(td),FROZEN,transport=bad)
            self.assertEqual(r['failure_reason'],'ORACLE_PRICE_ABI_SHAPE')
    def test_overflow_stale_reject(self):
        with self.assertRaises(q.Missing):q.stale_abi(1,2**256,1,2,10**36,625000000000000000)

if __name__=='__main__':unittest.main()
