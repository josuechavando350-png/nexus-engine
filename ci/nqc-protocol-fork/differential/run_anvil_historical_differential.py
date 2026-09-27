#!/usr/bin/env python3
"""Execute one deterministic stateful differential scenario on an Anvil historical fork."""
import argparse
import json
import re
import subprocess
import urllib.request
from pathlib import Path

ANCHOR_NUMBER = 25_252_136
ANCHOR_HASH = "0x49edc621ec5fe843353be319ae1a307be4e37d2a51111ccc07a2c8aae3ff6470"
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
PAIR = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc"
HELPER = "0x1000000000000000000000000000000000000039"
CALLER_BALANCE = 10_000 * 10**18
SEED_WETH = 10 * 10**18
FLASH_WETH = 100 * 10**18
SWAP_WETH = 1 * 10**18
GAS_PRICE = 2_000_000_000
GAS_LIMIT = 8_000_000
V2_FEE_BPS = 30
GET_RESERVES = "0x0902f1ac"
TOKEN0 = "0x0dfe1681"
TOKEN1 = "0xd21220a7"
BALANCE_OF = "0x70a08231"


def rpc(url, method, params):
    payload=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req=urllib.request.Request(url,data=payload,headers={"content-type":"application/json"})
    with urllib.request.urlopen(req,timeout=120) as resp:
        body=json.loads(resp.read())
    if "error" in body:
        raise RuntimeError(f"{method}: {body['error']}")
    return body["result"]


def word_address(value):
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}",value):
        raise ValueError("invalid address ABI word")
    n=int(value,16)
    if n>=2**160:
        raise ValueError("address overflow")
    return f"0x{n:040x}"


def abi_address(value):
    value=value.lower()
    if not re.fullmatch(r"0x[0-9a-f]{40}",value):
        raise ValueError("invalid address")
    return value[2:].rjust(64,"0")


def decode_reserves(raw):
    if not re.fullmatch(r"0x[0-9a-fA-F]{192}",raw):
        raise ValueError("invalid getReserves ABI")
    words=[int(raw[i:i+64],16) for i in range(2,len(raw),64)]
    if words[0]>=2**112 or words[1]>=2**112 or words[2]>=2**32:
        raise ValueError("reserve domain mismatch")
    return words


def eth_call(url,to,data,block="latest"):
    return rpc(url,"eth_call",[{"to":to,"data":data},block])


def balance_of(url,token,account):
    raw=eth_call(url,token,BALANCE_OF+abi_address(account))
    return int(raw,16)


def calldata(signature,*args):
    return subprocess.check_output(
        ["cast","calldata",signature,*map(str,args)],text=True
    ).strip()


def cast_keccak_hex(raw_bytes):
    return subprocess.check_output(
        ["cast","keccak","0x"+raw_bytes.hex()],text=True
    ).strip().lower()


def normalized_logs(receipt):
    out=[]
    for log in receipt.get("logs",[]):
        out.append({
            "address":log["address"].lower(),
            "topics":[x.lower() for x in log["topics"]],
            "data":log["data"].lower(),
        })
    return out


def logs_digest(logs):
    buf=bytearray(b"NQC_PFT_LOGS_V1")
    for log in logs:
        buf.extend(bytes.fromhex(log["address"][2:]))
        buf.extend(len(log["topics"]).to_bytes(4,"big"))
        for topic in log["topics"]:
            buf.extend(bytes.fromhex(topic[2:]))
        data=bytes.fromhex(log["data"][2:])
        buf.extend(len(data).to_bytes(8,"big"))
        buf.extend(data)
    return cast_keccak_hex(bytes(buf))


def send(url,caller,nonce,to,data,value=0):
    return rpc(url,"eth_sendTransaction",[{
        "from":caller,
        "to":to,
        "nonce":hex(nonce),
        "gas":hex(GAS_LIMIT),
        "gasPrice":hex(GAS_PRICE),
        "value":hex(value),
        "data":data,
    }])


def decode_event_words(log,count):
    data=log["data"]
    if not re.fullmatch(r"0x[0-9a-fA-F]{"+str(64*count)+r"}",data):
        raise ValueError("event data shape mismatch")
    return [int(data[i:i+64],16) for i in range(2,len(data),64)]


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--rpc",required=True)
    ap.add_argument("--provider-id",required=True)
    ap.add_argument("--runtime",type=Path,required=True)
    ap.add_argument("--out",type=Path,required=True)
    args=ap.parse_args()
    args.out.parent.mkdir(parents=True,exist_ok=True)

    anchor=rpc(args.rpc,"eth_getBlockByNumber",[hex(ANCHOR_NUMBER),False])
    if anchor is None or anchor["hash"].lower()!=ANCHOR_HASH:
        raise ValueError("historical fork anchor mismatch")
    if int(anchor["number"],16)!=ANCHOR_NUMBER:
        raise ValueError("historical fork number mismatch")

    accounts=rpc(args.rpc,"eth_accounts",[])
    if not accounts:
        raise ValueError("anvil exposes no unlocked account")
    caller=accounts[0].lower()
    runtime=args.runtime.read_text().strip().lower()
    if not re.fullmatch(r"0x[0-9a-f]+",runtime) or len(runtime)<=4:
        raise ValueError("invalid helper runtime bytecode")

    rpc(args.rpc,"anvil_setBalance",[caller,hex(CALLER_BALANCE)])
    rpc(args.rpc,"anvil_setNonce",[caller,"0x0"])
    rpc(args.rpc,"anvil_setCode",[caller,"0x"])
    rpc(args.rpc,"anvil_setCode",[HELPER,runtime])
    rpc(args.rpc,"anvil_setNonce",[HELPER,"0x0"])
    rpc(args.rpc,"anvil_setBalance",[HELPER,"0x0"])
    rpc(args.rpc,"anvil_setAutomine",[False])

    token0=word_address(eth_call(args.rpc,PAIR,TOKEN0)).lower()
    token1=word_address(eth_call(args.rpc,PAIR,TOKEN1)).lower()
    if token0!=USDC or token1!=WETH:
        raise ValueError(f"pair identity mismatch: {token0} {token1}")
    reserve0,reserve1,pair_ts_before=decode_reserves(
        eth_call(args.rpc,PAIR,GET_RESERVES)
    )
    amount_in_with_fee=SWAP_WETH*(10_000-V2_FEE_BPS)
    swap_out=amount_in_with_fee*reserve0//(reserve1*10_000+amount_in_with_fee)
    if swap_out<=0 or swap_out>=reserve0:
        raise ValueError("invalid deterministic swap quote")

    next_timestamp=int(anchor["timestamp"],16)+12
    rpc(args.rpc,"evm_setNextBlockTimestamp",[next_timestamp])
    rpc(args.rpc,"anvil_setNextBlockBaseFeePerGas",[hex(1_000_000_000)])

    txs=[]
    txs.append(("setup_deposit",send(
        args.rpc,caller,0,WETH,"0xd0e30db0",SEED_WETH
    )))
    txs.append(("setup_seed_helper",send(
        args.rpc,caller,1,WETH,calldata("transfer(address,uint256)",HELPER,SEED_WETH)
    )))
    txs.append(("flash_roundtrip",send(
        args.rpc,caller,2,HELPER,calldata("flashRoundTrip(address,uint256)",WETH,FLASH_WETH)
    )))
    txs.append(("v2_swap",send(
        args.rpc,caller,3,HELPER,calldata(
            "swapExact(address,address,address,uint256,uint256)",
            PAIR,WETH,USDC,SWAP_WETH,swap_out
        )
    )))
    txs.append(("v2_revert",send(
        args.rpc,caller,4,HELPER,calldata(
            "swapExact(address,address,address,uint256,uint256)",
            PAIR,WETH,USDC,SWAP_WETH,reserve0
        )
    )))

    rpc(args.rpc,"anvil_mine",["0x1"])

    receipts=[]
    for name,tx_hash in txs:
        receipt=rpc(args.rpc,"eth_getTransactionReceipt",[tx_hash])
        if receipt is None:
            raise ValueError(f"missing receipt {name}")
        logs=normalized_logs(receipt)
        receipts.append({
            "name":name,
            "transaction_hash":tx_hash.lower(),
            "status":int(receipt["status"],16),
            "gas_used":int(receipt["gasUsed"],16),
            "logs":logs,
            "ordered_logs_digest":logs_digest(logs),
        })

    expected_status=[1,1,1,1,0]
    actual_status=[x["status"] for x in receipts]
    if actual_status!=expected_status:
        raise ValueError(f"unexpected tx statuses: {actual_status}")
    block_number=int(rpc(args.rpc,"eth_blockNumber",[]),16)
    mined=rpc(args.rpc,"eth_getBlockByNumber",[hex(block_number),False])
    if any(int(rpc(args.rpc,"eth_getTransactionReceipt",[h])["blockNumber"],16)!=block_number for _,h in txs):
        raise ValueError("differential txs were not mined in one block")

    flash_topic=subprocess.check_output(
        ["cast","keccak","FlashSettled(address,uint256,uint256,uint256,uint256)"],text=True
    ).strip().lower()
    flash_logs=[
        log for log in receipts[2]["logs"]
        if log["address"]==HELPER and log["topics"] and log["topics"][0]==flash_topic
    ]
    if len(flash_logs)!=1:
        raise ValueError("missing unique FlashSettled event")
    amount,premium,before_flash,after_flash=decode_event_words(flash_logs[0],4)
    if amount!=FLASH_WETH or before_flash-after_flash!=premium:
        raise ValueError("flash repayment accounting mismatch")
    if premium<=0:
        raise ValueError("zero flash premium")

    swap_topic=subprocess.check_output(
        ["cast","keccak","SwapSettled(address,address,address,uint256,uint256,uint256,uint256)"],text=True
    ).strip().lower()
    swap_logs=[
        log for log in receipts[3]["logs"]
        if log["address"]==HELPER and log["topics"] and log["topics"][0]==swap_topic
    ]
    if len(swap_logs)!=1:
        raise ValueError("missing unique SwapSettled event")
    amount_in,amount_out,before_out,after_out=decode_event_words(swap_logs[0],4)
    if amount_in!=SWAP_WETH or amount_out!=swap_out or after_out-before_out!=swap_out:
        raise ValueError("swap event accounting mismatch")

    reserve0_after,reserve1_after,pair_ts_after=decode_reserves(
        eth_call(args.rpc,PAIR,GET_RESERVES)
    )
    if reserve0_after!=reserve0-swap_out or reserve1_after!=reserve1+SWAP_WETH:
        raise ValueError("pair final reserve mismatch")
    helper_weth=balance_of(args.rpc,WETH,HELPER)
    helper_usdc=balance_of(args.rpc,USDC,HELPER)
    if helper_weth!=SEED_WETH-premium-SWAP_WETH:
        raise ValueError("helper WETH final balance mismatch")
    if helper_usdc!=swap_out:
        raise ValueError("helper USDC final balance mismatch")

    probe_calldata=calldata("stateProbe(address,address,address)",WETH,USDC,PAIR)
    final_probe_output=eth_call(args.rpc,HELPER,probe_calldata)
    if not re.fullmatch(r"0x[0-9a-fA-F]{320}",final_probe_output):
        raise ValueError("final stateProbe ABI shape mismatch")
    probe_words=[int(final_probe_output[i:i+64],16) for i in range(2,len(final_probe_output),64)]
    if probe_words != [helper_weth,helper_usdc,reserve0_after,reserve1_after,pair_ts_after]:
        raise ValueError("stateProbe disagrees with direct final-state reads")

    evidence={
        "schema_version":1,
        "classification":"SYNTHETIC_TRANSACTIONS_OVER_IMMUTABLE_HISTORICAL_MAINNET_STATE",
        "provider_id":args.provider_id,
        "anchor":{
            "number":ANCHOR_NUMBER,
            "hash":ANCHOR_HASH,
            "timestamp":int(anchor["timestamp"],16),
        },
        "execution_block":{
            "number":int(mined["number"],16),
            "timestamp":int(mined["timestamp"],16),
            "gas_limit":int(mined["gasLimit"],16),
            "base_fee_per_gas":int(mined["baseFeePerGas"],16),
            "beneficiary":mined["miner"].lower(),
            "difficulty":int(mined["difficulty"],16),
            "prevrandao":(mined.get("mixHash") or mined.get("prevRandao")),
            "excess_blob_gas":(
                int(mined["excessBlobGas"],16)
                if mined.get("excessBlobGas") is not None else None
            ),
        },
        "caller":caller,
        "caller_initial_balance":CALLER_BALANCE,
        "helper":HELPER,
        "helper_runtime":runtime,
        "gas_price":GAS_PRICE,
        "gas_limit_per_tx":GAS_LIMIT,
        "addresses":{"weth":WETH,"usdc":USDC,"pair":PAIR},
        "inputs":{
            "seed_weth":SEED_WETH,
            "flash_weth":FLASH_WETH,
            "swap_weth":SWAP_WETH,
            "swap_usdc_out":swap_out,
            "impossible_usdc_out":reserve0,
        },
        "pair_before":{
            "reserve0":reserve0,"reserve1":reserve1,
            "block_timestamp_last":pair_ts_before,
        },
        "transactions":receipts,
        "flash":{
            "amount":amount,
            "premium":premium,
            "repayment":amount+premium,
            "balance_before":before_flash,
            "balance_after":after_flash,
        },
        "swap":{
            "amount_in":amount_in,"amount_out":amount_out,
            "balance_out_before":before_out,"balance_out_after":after_out,
        },
        "final_state":{
            "helper_weth":helper_weth,
            "helper_usdc":helper_usdc,
            "pair_reserve0":reserve0_after,
            "pair_reserve1":reserve1_after,
            "pair_timestamp_last":pair_ts_after,
            "probe_calldata":probe_calldata.lower(),
            "probe_output":final_probe_output.lower(),
        },
        "protocol_fork_truth":"NOT_CLOSED",
        "real_market_evidence":False,
    }
    args.out.write_text(json.dumps(evidence,indent=2,sort_keys=True)+"\n")
    print(
        f"ANVIL_HISTORICAL_DIFFERENTIAL_CAPTURE_PASS provider={args.provider_id} "
        f"flash_premium={premium} swap_out={swap_out} "
        f"success_gas={receipts[2]['gas_used']},{receipts[3]['gas_used']} "
        f"revert_gas={receipts[4]['gas_used']}",
        flush=True,
    )


if __name__=="__main__":
    main()
