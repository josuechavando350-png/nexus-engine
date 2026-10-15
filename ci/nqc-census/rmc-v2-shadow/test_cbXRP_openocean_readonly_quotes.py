"""Offline unit tests: no public request permitted in this test suite."""
import unittest
import cbXRP_openocean_readonly_quotes as q
def token(addr):return {"address":addr,"decimals":6}
def ok(amount,out):
 return {"code":200,"data":{"inToken":token(q.CBXRP),"outToken":token(q.USDC),
 "inAmount":str(amount),"outAmount":str(out),"estimatedGas":"100000","dexes":[]}}
class Checks(unittest.TestCase):
 def test_allowlisted_quote_sizes(self):
  self.assertEqual(len(q.AMOUNTS_RAW),4)
  with self.assertRaises(q.Refused):q.quote_url(10**9+1)
 def test_url_only_quote(self):
  u=q.quote_url(q.AMOUNTS_RAW[0])
  self.assertTrue(u.startswith("https://open-api.openocean.finance/v4/8453/quote?"))
  self.assertNotIn("swap",u)
 def test_good_quote(self):
  row=q.strict_quote(ok(q.AMOUNTS_RAW[0],2_000_000_000),q.AMOUNTS_RAW[0])
  self.assertEqual(row["usdc_output_raw"],"2000000000")
 def test_bad_output_zero(self):
  with self.assertRaises(q.Refused):q.strict_quote(ok(q.AMOUNTS_RAW[0],0),q.AMOUNTS_RAW[0])
 def test_wrong_token(self):
  p=ok(q.AMOUNTS_RAW[0],1);p["data"]["outToken"]["address"]=q.CBXRP
  with self.assertRaises(q.Refused):q.strict_quote(p,q.AMOUNTS_RAW[0])
 def test_wrong_decimals(self):
  p=ok(q.AMOUNTS_RAW[0],1);p["data"]["inToken"]["decimals"]=18
  with self.assertRaises(q.Refused):q.strict_quote(p,q.AMOUNTS_RAW[0])
 def test_changed_size(self):
  with self.assertRaises(q.Refused):q.strict_quote(ok(q.AMOUNTS_RAW[0],1),q.AMOUNTS_RAW[1])
 def test_bad_response(self):
  with self.assertRaises(q.Refused):q.strict_quote({"code":429},q.AMOUNTS_RAW[0])
 def test_bad_gas(self):
  p=ok(q.AMOUNTS_RAW[0],1);p["data"]["estimatedGas"]="x"
  with self.assertRaises(q.Refused):q.strict_quote(p,q.AMOUNTS_RAW[0])
 def test_envelope_slippage(self):
  rows=[q.strict_quote(ok(n,n*2 if i==0 else n*19//10),n) for i,n in enumerate(q.AMOUNTS_RAW)]
  res=q.envelope(rows)
  self.assertEqual(res["status"],"FOUR_CURRENT_ROUTE_QUOTES_NOT_HISTORICAL_EXECUTION")
  self.assertEqual(res["quotes"][0]["relative_unit_price_deterioration_bps_vs_1000_cbxrp"],0)
  self.assertGreater(res["quotes"][3]["relative_unit_price_deterioration_bps_vs_1000_cbxrp"],0)
 def test_envelope_invalid_count(self):
  with self.assertRaises(q.Refused):q.envelope([])
 def test_no_quotes_are_profit(self):
  self.assertEqual(q.GAS_WEI,100000000)
  self.assertEqual(q.AMOUNTS_RAW[-1],123660088593)
 def test_integer_denies_negative(self):
  with self.assertRaises(q.Refused):q.uint("-1")
 def test_allowlist_http_no_data(self):
  with self.assertRaises(q.Refused):q.strict_quote(None,100)
if __name__=="__main__":unittest.main()
