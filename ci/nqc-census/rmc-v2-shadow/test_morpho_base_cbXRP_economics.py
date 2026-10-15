import unittest
import morpho_base_cbXRP_economics as m
class Check(unittest.TestCase):
 def test_keccak_transfer(self):self.assertEqual(m.XFER,"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
 def test_keccak_empty(self):self.assertEqual(m.keccak(b"").hex(),"c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
 def test_method_selection(self):
  with self.assertRaises(m.Incomplete):m.Provider("http://127.0.0.1").ask("eth_sendRawTransaction",[])
 def test_limit(self):
  p=m.Provider("http://127.0.0.1");p.n=30
  with self.assertRaises(m.Incomplete):p.ask("eth_call",[])
 def test_lif(self):self.assertTrue(10**18<m.lif(86*10**16)<115*10**16)
 def test_wrong_lltv(self):
  with self.assertRaises(m.Incomplete):m.lif(0)
 def test_block_conflict(self):
  with self.assertRaises(m.Incomplete):m.quorum({"hash":"a"},{"hash":"b"},("hash",),"HEADER")
 def test_market_short(self):
  with self.assertRaises(m.Incomplete):m.params("0xab")
 def test_market_wrong_id(self):
  raw="0x"+("0"*24+"1"*40)*4+("0"*63+"1")
  with self.assertRaises(m.Incomplete):m.params(raw)
 def test_topic_bad(self):
  with self.assertRaises(m.Incomplete):m.ad("0x"+"f"*64)
 def test_samples_exact(self):
  self.assertEqual(len(m.S),3)
  self.assertEqual(sum(row[1] for row in m.S["0x049327359c7be3409a6f0d2f2f0d1d41b32ba7d109d583be0bfe6c696932c0aa"][3]),154844072724)
 def test_profit_claim_absent(self):self.assertEqual(m.SOURCE,"f65c2b526fe93d105b096716515b4eac7b98698cb331048d3c6a8cf936b65ce4")
if __name__=="__main__":unittest.main()
