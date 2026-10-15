"""NQC Atlas native-bond onchain/source gate adversarial tests (no live network)."""
from __future__ import annotations
import json
import tempfile
from pathlib import Path
import unittest
import atlas_bond_truth as gate

H='0x'+'ab'*32
P='0x'+'cd'*32
ROOT='0x'+'ef'*32

class Fixture:
    def __init__(self,chain, source, mode='ok'):
        self.chain=chain;self.source=source
        self.calls=[];self.mode=mode
        self.tip=100000
        self.expect_code={'atlas':'0x60016000', 'control':'0x60026000'}
    def __call__(self,url,method,params):
        self.calls.append((url,method,params))
        data=gate.SOURCES[self.chain]
        if url!=data['endpoints'][self.source]:raise AssertionError('wrong host')
        if method=='eth_chainId':
            return hex(data['chain_id']+1 if self.mode=='wrong_chain' else data['chain_id'])
        if method=='eth_blockNumber':
            return hex(self.tip+50 if self.mode=='lag' else self.tip)
        if method=='eth_getBlockByNumber':
            result={'number':params[0], 'hash':H, 'parentHash':P,
                    'stateRoot':ROOT,'timestamp':'0x77359400'}
            if self.mode=='fork':result['hash']='0x'+'aa'*32
            return result
        if method=='eth_getCode':
            if params[0].lower()==data['atlas'].lower():return '0x' if self.mode=='no_code' else self.expect_code['atlas']
            if params[0].lower()==data['control'].lower():return '0x60036000' if self.mode=='bytecode_diverged' else self.expect_code['control']
            raise AssertionError('non-pinned code')
        if method=='eth_call':
            to=params[0]['to'].lower(); sig=params[0]['data'][:10]
            if to==data['control'].lower() and sig==gate.CALLS['getSolverGasLimit()']:
                value=900000 if self.mode=='different_limit' else 1100000
            elif sig==gate.CALLS['balanceOfBonded(address)']:
                value=0
            elif sig==gate.CALLS['bondedTotalSupply()']:
                value=7000000000000000000
            elif sig==gate.CALLS['ESCROW_DURATION()']:
                value=100
            else:raise AssertionError('unknown read function')
            return '0x'+format(value,'064x')
        raise AssertionError('not a read method')

def construct(chain,modeA='ok',modeB='ok'):
    f=[Fixture(chain,0,modeA),Fixture(chain,1,modeB)]
    z=[gate.Readonly(chain,i,transport=f[i],wait=lambda _:None,
                     monotonic=lambda:0.1) for i in range(2)]
    return z,f

class AtlasTest(unittest.TestCase):
    def test_keccak_golden_signatures(self):
        self.assertEqual(gate.keccak256(b'').hex(),
         'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
        self.assertEqual(gate.selector('transfer(address,uint256)'),'0xa9059cbb')
        self.assertEqual(gate.CALLS['balanceOfBonded(address)'],'0x825ad607')
        self.assertEqual(gate.CALLS['getSolverGasLimit()'],'0x99218be5')

    def test_exact_official_contract_deployments_and_chains(self):
        self.assertEqual(gate.SOURCES['base']['chain_id'],8453)
        self.assertEqual(gate.SOURCES['arbitrum']['chain_id'],42161)
        self.assertEqual(gate.SOURCES['bnb']['chain_id'],56)
        self.assertEqual(gate.SOURCES['base']['atlas'].lower(),
                         '0x583dcfef0d240dc80753f0f0b26513fee27d9b77')
        self.assertEqual(gate.ATLAS_SORTER_BLOB,'517f0a39d0199091027702b29bcb697e04d0bcdb')

    def test_ledger_positive_gas_zero_bond_rejected(self):
        v=gate.positive_eligibility(0,1_000_000_000,300000,80000)
        self.assertTrue(v['positive_fee_zero_bond_ineligible'])
        self.assertEqual(v['simple_lower_bound_wei'],'380000000000000')
        self.assertFalse(v['meets_simple_lower_bound_not_full_atlas_eligibility'])
        self.assertFalse(v['full_deployed_verification_proven'])

    def test_nonzero_bond_passing_arithmetic_not_certified_economic_authority(self):
        v=gate.positive_eligibility(1_000_000_000_000_000_000,
                                   1_000_000_000,100000,20000)
        self.assertTrue(v['meets_simple_lower_bound_not_full_atlas_eligibility'])
        self.assertFalse(v['full_deployed_verification_proven'])

    def test_overflow_and_negative_fail_closed(self):
        for values in [(-1,10,20,30),(0,-1,1000,1),(0,2**200,2**100,500)]:
            with self.subTest(values=values):
                with self.assertRaises(gate.Reject):gate.positive_eligibility(*values)

    def test_source_obligation_report_never_claims_gas_sponsor(self):
        r=gate.source_assessment()
        self.assertTrue(r['zero_bond_source_guard_from_pinned_Sorter'])
        self.assertFalse(r['actual_third_party_sponsor_proven'])
        self.assertFalse(r['nonrecourse_gas_proven'])
        self.assertFalse(r['net_profit_verified'])

    def test_readonly_transport_denies_any_write_and_unbounded_read(self):
        rpc=gate.Readonly('base',0,transport=lambda *_:None)
        for method,params in [('eth_sendRawTransaction',['0x00']),
                 ('mev_sendBundle',[]),('eth_sign',[]),('eth_getLogs',[]),
                 ('eth_call',[{'to':gate.SOURCES['base']['atlas'],
                               'data':'0xdeadbeef'},'latest'])]:
            with self.subTest(method=method):
                with self.assertRaises(gate.Reject):rpc.call(method,params)
        self.assertEqual(rpc.calls,0)

    def test_pinned_state_no_arbitrary_address_method(self):
        r=gate.Readonly('base',0,transport=lambda *_:None)
        r.pinned_height=100
        wrong={'to':gate.SOURCES['base']['atlas'],
               'data':gate.encode_address_call('balanceOfBonded(address)',
                                                '0x'+'12'*20)}
        with self.assertRaises(gate.Reject):r.call('eth_call',[wrong,hex(100)])
        with self.assertRaises(gate.Reject):r.call('eth_getCode',['0x'+'ff'*20,hex(100)])
        with self.assertRaises(gate.Reject):r.call('eth_getBlockByNumber',['latest',False])
        self.assertEqual(r.calls,0)

    def test_three_chains_nominal_parity_and_gas_limit(self):
        for name in gate.SOURCES:
            with self.subTest(chain=name):
                clients,fixtures=construct(name)
                result=gate.snapshot(name,clients)
                self.assertEqual(result['deployed_solver_gas_limit'],1100000)
                self.assertEqual(result['escrow_duration_in_blocks'],100)
                self.assertEqual(result['source_bonded_balance_zero_address_wei'],'0')
                self.assertEqual(len(result['contracts']),2)
                self.assertTrue(result['status'].startswith('TWO_PUBLIC_SOURCE_PINNED'))
                self.assertTrue(all(len(f.calls)==10 for f in fixtures))
                self.assertFalse(result['deployed_bytecode_equivalent_to_pinned_source_proven'])

    def test_wrong_chain_does_not_promote(self):
        c,_=construct('base',modeB='wrong_chain')
        with self.assertRaises(gate.Reject):gate.snapshot('base',c)

    def test_tip_divergence_is_censored(self):
        c,_=construct('arbitrum',modeB='lag')
        with self.assertRaises(gate.Reject):gate.snapshot('arbitrum',c)

    def test_headers_diverge(self):
        c,_=construct('bnb',modeB='fork')
        with self.assertRaises(gate.Reject):gate.snapshot('bnb',c)

    def test_bytecode_divergence_censored(self):
        c,_=construct('base',modeB='bytecode_diverged')
        with self.assertRaises(gate.Reject):gate.snapshot('base',c)

    def test_control_gas_limit_divergence_censored(self):
        c,_=construct('arbitrum',modeB='different_limit')
        with self.assertRaises(gate.Reject):gate.snapshot('arbitrum',c)

    def test_zero_bond_is_not_proof_of_user_account(self):
        self.assertEqual(gate.ZERO_ADDRESS,'0x'+'0'*40)
        self.assertNotIn('user_email',gate.source_assessment())

    def test_fail_close_one_chain_preserve_other_source_results(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp)/'test'
            peers={name:construct(name,'ok','wrong_chain' if name=='bnb' else 'ok')[0]
                   for name in gate.SOURCES}
            result=gate.run(base,clients=peers)
            self.assertEqual(result['status'],'INCOMPLETE_MULTI_CHAIN_SOURCE')
            self.assertTrue(result['chains']['base']['status'].startswith('TWO_PUBLIC_SOURCE'))
            self.assertTrue(result['chains']['arbitrum']['status'].startswith('TWO_PUBLIC_SOURCE'))
            self.assertEqual(result['chains']['bnb']['status'],'INCOMPLETE_CHAIN_SOURCE')
            self.assertEqual(result['NQC_realized_pnl_USD'],'0')
            self.assertFalse(result['atlas_sponsored_own_capital_zero_proven'])
            self.assertEqual(len(result['errors']),1)
            self.assertEqual(json.loads((base/'atlas-bond-viability.json').read_text())['status'],
                             'INCOMPLETE_MULTI_CHAIN_SOURCE')

if __name__=='__main__':unittest.main()
