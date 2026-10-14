import copy
import unittest
import postwindow_oracle_causality as oc


def sample_tx():
    inner = bytes.fromhex(oc.INNER_SELECTOR) + b'\x12'*132
    padded = inner + b'\x00' * ((-len(inner))%32)
    calldata = bytes.fromhex(oc.FORWARD_SELECTOR) + bytes.fromhex('00'*12 + oc.AGGREGATOR[2:]) + (64).to_bytes(32,'big') + len(inner).to_bytes(32,'big') + padded
    case = {'witness':{'winner_block':{'hash':'0x'+'ab'*32,'number':26142067}},
            'prefix_transactions':['0x'+'cd'*32]}
    tx={'hash':case['prefix_transactions'][0], 'blockHash':case['witness']['winner_block']['hash'],
        'blockNumber':hex(26142067), 'transactionIndex':'0x0',
        'chainId':'0x1', 'to':'0x'+'ee'*20,'input':'0x'+calldata.hex()}
    return tx,case


def fake_metrics():
    return {'NQC_ORACLE_PRICE_BEFORE':250000000000,
            'NQC_ORACLE_PRICE_AFTER':245000000000,
            'NQC_FEED_ANSWER_BEFORE':250000000000,
            'NQC_FEED_ANSWER_AFTER':245000000000,
            'NQC_HF_BEFORE_TX0':1001000000000000000,
            'NQC_HF_AFTER_TX0':996000000000000000,
            'NQC_HF_PRICE_FROZEN':1001000000000000000,
            'NQC_HF_AFTER_CLEAR':996000000000000000,
            'NQC_PRICE_FREEZE_REVERTS_TRIGGER':1}


def fork_log(changes=None):
    m={**fake_metrics(),**(changes or {})}
    return ('[PASS] testFirstOracleUpdatePriceFreeze()\n'
            'Suite result: ok. 1 passed; 0 failed; 0 skipped\n'+
            ''.join(f'  {k}: {v}\n' for k,v in m.items()))


class OracleGateTests(unittest.TestCase):
    def test_canonical_forward_to_aggregator(self):
        tx,case=sample_tx()
        result=oc.decode_forward_transaction(tx,case)
        self.assertEqual(result['target'],oc.AGGREGATOR)
        self.assertEqual(result['index'],0)
        self.assertEqual(result['inner_method_id'],'0x'+oc.INNER_SELECTOR)

    def test_wrong_target_is_rejected(self):
        tx,case=sample_tx()
        tx['input']=tx['input'][:34]+'aa'*20+tx['input'][74:]
        with self.assertRaises(ValueError): oc.decode_forward_transaction(tx,case)

    def test_nonfirst_transaction_is_rejected(self):
        tx,case=sample_tx();tx['transactionIndex']='0x1'
        with self.assertRaises(ValueError): oc.decode_forward_transaction(tx,case)

    def test_other_chain_and_hash_rejected(self):
        for key,value in [('chainId','0x89'),('blockHash','0x'+'fe'*32),('hash','0x'+'00'*32)]:
            tx,case=sample_tx();tx[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):
                oc.decode_forward_transaction(tx,case)

    def test_malformed_offsets_padding_and_selector_rejected(self):
        base,case=sample_tx()
        mods=[]
        tx=copy.deepcopy(base);tx['input']='0xdeadbeef'+tx['input'][10:];mods.append(tx)
        tx=copy.deepcopy(base);raw=bytearray.fromhex(tx['input'][2:]);raw[4+63]=0x60;tx['input']='0x'+raw.hex();mods.append(tx)
        tx=copy.deepcopy(base);raw=bytearray.fromhex(tx['input'][2:]);raw[-1]=1;tx['input']='0x'+raw.hex();mods.append(tx)
        tx=copy.deepcopy(base);raw=bytearray.fromhex(tx['input'][2:]);raw[4+96]=0xaa;tx['input']='0x'+raw.hex();mods.append(tx)
        tx=copy.deepcopy(base);tx['input']=tx['input'][:-2];mods.append(tx)
        for tx in mods:
            with self.subTest(tx=tx['input'][:40]),self.assertRaises(ValueError):
                oc.decode_forward_transaction(tx,case)

    def test_producer_first_prefix_crossing_is_valid(self):
        m={'prefix_hf_wad':[996000000000000000],
           'NQC_TIME_ONLY_HF':1001000000000000000,
           'NQC_FIRST_PREFIX_CROSSING_INDEX':0,
           'NQC_PREFIX_ACCOUNT_PARITY':1,'NQC_WINNER_EVENT_PARITY':1,
           'NQC_REFERENCE_PRESTATE_HF':996000000000000000}
        self.assertEqual(oc.validate_attribution_metrics(m),(1001000000000000000,996000000000000000))

    def test_time_already_liquidatable_is_rejected(self):
        m={'prefix_hf_wad':[996000000000000000],
           'NQC_TIME_ONLY_HF':990000000000000000,
           'NQC_FIRST_PREFIX_CROSSING_INDEX':0,
           'NQC_PREFIX_ACCOUNT_PARITY':1,'NQC_WINNER_EVENT_PARITY':1,
           'NQC_REFERENCE_PRESTATE_HF':996000000000000000}
        with self.assertRaises(ValueError):oc.validate_attribution_metrics(m)

    def test_fork_log_accepts_exact_causality(self):
        case={'hf_before_tx0':fake_metrics()['NQC_HF_BEFORE_TX0'],
              'hf_after_tx0':fake_metrics()['NQC_HF_AFTER_TX0']}
        self.assertEqual(oc.parse_fork_log(fork_log(),case)['NQC_PRICE_FREEZE_REVERTS_TRIGGER'],1)

    def test_inconsistent_result_is_rejected(self):
        case={'hf_before_tx0':fake_metrics()['NQC_HF_BEFORE_TX0'],
              'hf_after_tx0':fake_metrics()['NQC_HF_AFTER_TX0']}
        mutations=[{'NQC_HF_PRICE_FROZEN':996000000000000000},
                   {'NQC_HF_AFTER_CLEAR':1001000000000000000},
                   {'NQC_ORACLE_PRICE_AFTER':250000000000},
                   {'NQC_FEED_ANSWER_AFTER':250000000000},
                   {'NQC_HF_AFTER_TX0':1001000000000000000},
                   {'NQC_PRICE_FREEZE_REVERTS_TRIGGER':0}]
        for c in mutations:
            with self.subTest(c=c),self.assertRaises(ValueError):
                oc.parse_fork_log(fork_log(c),case)

    def test_duplicate_missing_and_wrong_pass_rejected(self):
        case={'hf_before_tx0':fake_metrics()['NQC_HF_BEFORE_TX0'],
              'hf_after_tx0':fake_metrics()['NQC_HF_AFTER_TX0']}
        for s in (fork_log()+'  NQC_HF_AFTER_TX0: 996000000000000000\n',
                  fork_log().replace('1 passed; 0 failed','0 passed; 1 failed'),
                  fork_log().replace('testFirstOracleUpdatePriceFreeze','unrelatedTest'),
                  fork_log().replace('NQC_HF_PRICE_FROZEN','UNKNOWN_HF')):
            with self.assertRaises(ValueError):oc.parse_fork_log(s,case)


if __name__=='__main__':
    unittest.main()
