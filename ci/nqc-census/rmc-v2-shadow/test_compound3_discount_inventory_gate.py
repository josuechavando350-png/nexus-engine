"""NQC Compound III no-cost/read-only admission and fail-closed economic safeguards."""
import json,unittest,tempfile
from pathlib import Path
from unittest.mock import patch
import compound3_discount_inventory_gate as c

WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
FEED='0x'+'7'*40

def wd(x):return '0x'+format(x%(1<<256),'064x')
def asset(ix=0,asset=WETH,feed=FEED):
 vals=[ix,int(asset,16),int(feed,16),10**18,800000000000000000,850000000000000000,900000000000000000,1000*10**18]
 return '0x'+''.join(format(x,'064x') for x in vals)
def block(height=24000000,sha='0x'+'a'*64):
 return {'number':hex(height),'hash':sha,'parentHash':'0x'+'b'*64,
         'stateRoot':'0x'+'c'*64,'receiptsRoot':'0x'+'d'*64,'timestamp':'0x70abcdef'}
class Check(unittest.TestCase):
 def test_rpc_quantity_can_be_odd_hex_digits(self):
  self.assertEqual(c.hexi("0x1","CHAIN"),1)
  self.assertEqual(c.hexi("0xabc","HEIGHT"),2748)
 def test_signed_positive_negative(self):
  self.assertEqual(c.signed(wd(-123)),-123)
  self.assertEqual(c.signed(wd(456)),456)
 def test_bad_word_rejected(self):
  for val in ('0x0','hello',True,None,'0x'+'g'*64):
   with self.assertRaises(c.Incomplete):c.uint_word(val,'bad')
 def test_selector_exact(self):
  self.assertEqual(c.selector('getReserves'),'0x0902f1ac')
  self.assertEqual(c.selector('targetReserves'),'0x32176c49')
  self.assertEqual(c.selector('getAssetInfo',1),'0xc8c7fe6b'+format(1,'064x'))
 def test_selector_rejects_mutating(self):
  for bad in ('buyCollateral','absorb','supply','eth_sendRawTransaction','unapproved'):
   with self.assertRaises(c.Incomplete):c.selector(bad)
 def test_quote_fixed_size_only(self):
  with self.assertRaises(c.Incomplete):c.selector('quoteCollateral',WETH,2000000)
 def test_asset_info_exact(self):
  x=c.asset_info(asset(),0)
  self.assertEqual(x['asset'],WETH)
  self.assertEqual(x['scale'],10**18)
 def test_asset_index_mismatch(self):
  with self.assertRaises(c.Incomplete):c.asset_info(asset(ix=1),0)
 def test_asset_wrong_scale(self):
  raw='0x'+''.join(format(n,'064x') for n in [0,int(WETH,16),int(FEED,16),12345,1,1,1,1])
  with self.assertRaises(c.Incomplete):c.asset_info(raw,0)
 def test_asset_invalid_factor(self):
  raw='0x'+''.join(format(n,'064x') for n in [0,int(WETH,16),int(FEED,16),10**18,10**18,1,1,1])
  with self.assertRaises(c.Incomplete):c.asset_info(raw,0)
 def test_no_purchase_above_target_even_with_collateral(self):
  a=[{'asset':WETH,'reserves_raw':'1000000000'}]
  for res in [1000,1001]:
   self.assertFalse(c.gate(res,1000,False,a)['candidate_discount_purchase_allowed_on_snapshot'])
 def test_below_target_paused(self):
  self.assertFalse(c.gate(100,1000,True,[{'asset':WETH,'reserves_raw':'100'}])['candidate_discount_purchase_allowed_on_snapshot'])
 def test_below_target_without_collateral(self):
  self.assertFalse(c.gate(100,1000,False,[{'asset':WETH,'reserves_raw':'0'}])['candidate_discount_purchase_allowed_on_snapshot'])
 def test_below_target_with_collateral(self):
  out=c.gate(100,1000,False,[{'asset':WETH,'reserves_raw':'100'}])
  self.assertTrue(out['candidate_discount_purchase_allowed_on_snapshot'])
 def test_blocks_diverge(self):
  with self.assertRaises(c.Incomplete):c.block_identity(block(),block(24000001))
  with self.assertRaises(c.Incomplete):c.block_identity(block(),block(24000000,'0x'+'e'*64))
 def test_quorum_wrong_oracle(self):
  with self.assertRaises(c.Incomplete):c.source_value_quorum('0x0011','0x0012','test')
 def test_providers_restricted(self):
  with self.assertRaises(c.Incomplete):c.Provider('http://private.provider')
 def test_rpc_mutation_denied_without_network(self):
  p=c.Provider(c.PROVIDERS[0]);n=p.n
  with self.assertRaises(c.Incomplete):p.ask('eth_sendRawTransaction',['0xabc'])
  self.assertEqual(p.n,n)
 def test_head_gap_and_limit(self):
  self.assertLess(c.MAX_RPC_CALLS,100)
  self.assertLessEqual(c.MAX_ASSETS,24)
 def test_no_hypothetical_profit_upgrade(self):
  self.assertFalse(c.gate(100,1000,False,[{'asset':WETH,'reserves_raw':'200'}]).get('nqc_pnl_proven',False))
 def test_simulate_two_rpc_pinned_success(self):
  class Fake:
   def __init__(self):self.n=0
   def ask(self,method,args):
    self.n+=1
    if method=='eth_chainId':return '0x1'
    if method=='eth_blockNumber':return hex(24000000)
    if method=='eth_getBlockByNumber':return block()
    if method=='eth_getCode':return '0x'+'abcdef'*40
    raise AssertionError(method)
   def block(self,height):return self.ask('eth_getBlockByNumber',[hex(height),False])
   def get(self,name,height,*args):
    self.n+=1
    vals={'getReserves':wd(1000_000000),'targetReserves':wd(10000_000000),
          'numAssets':wd(1),'baseToken':wd(int(c.USDC,16)),'isBuyPaused':wd(0),
          'getAssetInfo':asset(),'getCollateralReserves':wd(100*10**18),
          'quoteCollateral':wd(5*10**17)}
    return vals[name]
  with patch.object(c,'Provider',side_effect=[Fake(),Fake()]):result=c.attempt()
  self.assertEqual(result['status'],'SAME_BLOCK_COMET_DISCOUNT_RESERVE_GATE_SOURCE_ONLY')
  self.assertTrue(result['gate']['candidate_discount_purchase_allowed_on_snapshot'])
  self.assertEqual(result['quotes'][0]['collateral_out_raw_at_quoted_block'],str(5*10**17))
  self.assertFalse(result['current_dex_selling_quotes_proven'])
 def test_closed_global_gate_skips_large_market_without_zero_inventory_fiction(self):
  class Fake:
   def __init__(self):self.n=0
   def ask(self,method,args):
    self.n+=1
    if method=='eth_chainId':return '0x1'
    if method=='eth_blockNumber':return '0x16e3600'
    if method=='eth_getBlockByNumber':return block()
    if method=='eth_getCode':return '0x'+'abcdef'*40
    raise AssertionError('UNEXPECTED_RPC_METHOD:'+method)
   def block(self,height):return self.ask('eth_getBlockByNumber',[hex(height),False])
   def get(self,name,height,*args):
    self.n+=1
    vals={'getReserves':wd(22_000_000000), 'targetReserves':wd(20_000_000000),
          'numAssets':wd(200), 'baseToken':wd(int(c.USDC,16)),
          'isBuyPaused':wd(0)}
    if name not in vals:raise AssertionError('MUST_NOT_READ_INVENTORY_WHEN_GLOBAL_BLOCKED:'+name)
    return vals[name]
  with patch.object(c,'Provider',side_effect=[Fake(),Fake()]):result=c.attempt()
  self.assertEqual(result['status'],'SAME_BLOCK_COMET_GLOBAL_BUY_GATE_CLOSED_SOURCE_ONLY')
  self.assertEqual(result['asset_count'],200)
  self.assertFalse(result['collateral_inventory_was_fully_enumerated'])
  self.assertIsNone(result['gate']['inventory_positive_assets'])
  self.assertFalse(result['gate']['candidate_discount_purchase_allowed_on_snapshot'])
  self.assertTrue(result['gate']['source_global_gate_closed_without_inventory_claim'])
  self.assertEqual(result['quotes'],[])
 def test_24_asset_market_bounded_when_gate_open(self):
  self.assertEqual(c.MAX_ASSETS,24)
  self.assertEqual(c.MAX_RPC_CALLS,84)
  # Worst accepted scenario: all 24 assets have inventory + price quote,
  # and request two block headers plus final replay, no arbitrary RPCs.
  self.assertGreaterEqual(c.MAX_RPC_CALLS, 2+2+1+5+2*24+24+2)
  self.assertLess(c.MAX_RPC_CALLS,100)
 def test_source_incomplete_preserves_dual_rpc_global_gate_but_never_inventory(self):
  class Fake:
   def __init__(self):self.n=0
   def ask(self,method,args):
    self.n+=1
    if method=='eth_chainId':return '0x1'
    if method=='eth_blockNumber':return hex(24000000)
    if method=='eth_getBlockByNumber':return block()
    if method=='eth_getCode':return '0x'+'abcdef'*40
    raise AssertionError('UNKNOWN_RPC:'+method)
   def block(self,height):return self.ask('eth_getBlockByNumber',[hex(height),False])
   def get(self,name,height,*args):
    self.n+=1
    vals={'getReserves':wd(1_000_000000), 'targetReserves':wd(20_000_000000),
          'numAssets':wd(12),'baseToken':wd(int(c.USDC,16)), 'isBuyPaused':wd(0)}
    if name=='getAssetInfo':raise c.Incomplete('CALL_getAssetInfo_RPC_NULL_OR_ERROR_eth_call')
    if name not in vals:raise AssertionError('Unexpected call '+name)
    return vals[name]
  with patch.object(c,'Provider',side_effect=[Fake(),Fake()]):
   with self.assertRaises(c.Incomplete) as exc:c.attempt()
  ckp=exc.exception.global_gate_checkpoint
  self.assertTrue(ckp['certified_global_gate_only'])
  self.assertTrue(ckp['global_buy_gate_open'])
  self.assertEqual(ckp['num_assets'],12)
  self.assertFalse(ckp['full_collateral_inventory_certified'])
  self.assertEqual(ckp['nqc_realized_profit_usd'],'0')
 def test_main_writes_checkpoint_without_fabricating_full_sale(self):
  exc=c.Incomplete('CALL_getAssetInfo_RPC_NULL_OR_ERROR_eth_call')
  exc.global_gate_checkpoint={'certified_global_gate_only':True,
                              'global_buy_gate_open':True,
                              'full_collateral_inventory_certified':False}
  with tempfile.TemporaryDirectory() as d:
   with patch.object(c,'attempt',side_effect=exc):c.main(['--out',d])
   out=json.loads((Path(d)/'discount-reserves.json').read_text())
   self.assertEqual(out['status'],'INCOMPLETE_COMPOUND_READONLY_RESERVES')
   self.assertTrue(out['certified_global_gate']['global_buy_gate_open'])
   self.assertFalse(out['commercial_promotion_allowed'])
 def test_source_error_fail_closed_integrated(self):
  with tempfile.TemporaryDirectory() as tmp:
   with patch.object(c,'attempt',side_effect=c.Incomplete('RPC_HTTP_403_eth_call')):
    self.assertEqual(c.main(['--out',tmp]),0)
   r=json.loads((Path(tmp)/'discount-reserves.json').read_text())
   self.assertEqual(r['status'],'INCOMPLETE_COMPOUND_READONLY_RESERVES')
   self.assertEqual(r['source_blocker'],'RPC_HTTP_403_eth_call')
 def test_original_mainnet_contract_constants(self):
  self.assertEqual(c.COMET,'0xc3d688b66703497daa19211eedff47f25384cdc3')
  self.assertEqual(c.USDC,'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
 def test_never_assume_snapshot_equals_route_profit(self):
  with patch.object(c,'attempt',return_value={'status':'SAME_BLOCK_COMET_DISCOUNT_RESERVE_GATE_SOURCE_ONLY',
         'current_dex_selling_quotes_proven':False,'morpho_usdc_flash_capacity_proven':False,
         'realized_nqc_pnl_usd':'0','commercial_promotion_allowed':False}):
   with tempfile.TemporaryDirectory() as d:
    c.main(['--out',d]);r=json.loads((Path(d)/'discount-reserves.json').read_text())
    self.assertEqual(r['realized_nqc_pnl_usd'],'0')
    self.assertFalse(r['commercial_promotion_allowed'])
if __name__=='__main__':unittest.main()
