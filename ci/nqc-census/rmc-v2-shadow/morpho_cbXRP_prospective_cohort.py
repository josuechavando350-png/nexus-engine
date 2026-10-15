#!/usr/bin/env python3
"""NQC V2, bounded no-lookahead Morpho cbXRP/USDC API borrower cohort: READ ONLY.

The API is NOT canonical EVM state and two observations do NOT prove a usable
liquidation or capture advantage. Strictly no signed Ethereum RPC operations.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

API = "https://api.morpho.org/graphql"
MARKET = "0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109"
CHAIN = 8453
PARENT_HEAD = "ea2c7137cf8330e5d463ad0b56d01219aa87ebfc"
POS_RE = re.compile(r"0x[0-9a-fA-F]{40}\Z")
ID_RE = re.compile(r"0x[0-9a-fA-F]{64}\Z")
MAX_ROWS = 30
MAX_UNION = 60
RISK_CUTOFF = Decimal("1.08")
QUERY = """query NqcCandidates($first: Int!, $market: [String!], $near: Float, $users: [String!]) {
  marketPositions(
    first: $first
    orderBy: BorrowShares
    orderDirection: Desc
    where: {chainId_in: [8453], marketUniqueKey_in: $market, userAddress_in: $users, healthFactor_lte: $near}
  ) {
    pageInfo { count countTotal }
    items {
      user { address }
      market { marketId }
      state { borrowShares borrowAssets borrowAssetsUsd collateral collateralUsd }
    }
  }
}"""
# The optional $near/$users filters are omitted via GraphQL nulls. We must not
# mistake an ignored filter for valid filtered discovery; fetched rows are
# checked for market/chain and source count, but HF threshold remains API-only.

class Rejected(ValueError):
    pass


def need(cond: bool, why: str):
    if not cond:
        raise Rejected(why)


def now():
    return datetime.now(timezone.utc).isoformat()


def stable(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(obj):
    return sha256(stable(obj).encode("utf-8")).hexdigest()


def valid_decimal(v, name, *, nonnegative=True):
    need(type(v) in (str, int, float), "UNSUPPORTED_" + name)
    try:
        d = Decimal(str(v))
    except InvalidOperation as ex:
        raise Rejected("INVALID_" + name) from ex
    need(d.is_finite() and (not nonnegative or d >= 0), "INVALID_" + name)
    return d


def validate_graphql(body, label, first=MAX_ROWS):
    need(type(body) is dict and not body.get("errors"), label + "_GRAPHQL_ERROR")
    res = body.get("data", {}).get("marketPositions")
    need(type(res) is dict, label + "_NO_MARKET_POSITIONS")
    page = res.get("pageInfo")
    rows = res.get("items")
    need(type(page) is dict and type(rows) is list and len(rows) <= first, label + "_BAD_PAGE")
    count = page.get("count")
    total = page.get("countTotal")
    need(type(count) is int and type(total) is int and 0 <= count <= total and count == len(rows), label + "_COUNT_DRIFT")
    seen=set()
    result=[]
    for raw in rows:
        need(type(raw) is dict, label + "_BAD_ROW")
        market = (raw.get("market") or {}).get("marketId")
        addr = (raw.get("user") or {}).get("address")
        need(type(market) is str and bool(ID_RE.fullmatch(market)) and market.lower() == MARKET,
             label + "_WRONG_MARKET")
        need(type(addr) is str and bool(POS_RE.fullmatch(addr)), label + "_BAD_BORROWER")
        addr=addr.lower()
        need(addr not in seen, label + "_DUPLICATE_BORROWER")
        seen.add(addr)
        state=raw.get("state")
        need(type(state) is dict, label + "_BAD_STATE")
        shares=state.get("borrowShares")
        loan=state.get("borrowAssets")
        collateral=state.get("collateral")
        for name, value in (("SHARES",shares),("LOAN",loan),("COLLATERAL",collateral)):
            need(type(value) is str and bool(re.fullmatch(r"(0|[1-9][0-9]*)",value)) and len(value)<80,
                 label+"_BAD_"+name)
        usd=state.get("borrowAssetsUsd")
        colusd=state.get("collateralUsd")
        usd=valid_decimal(usd, "USD") if usd is not None else None
        colusd=valid_decimal(colusd,"COLLATERAL_USD") if colusd is not None else None
        result.append({"borrower":addr,"borrow_shares":shares,"debt_raw":loan,
                       "collateral_raw":collateral,"borrow_usd_api":str(usd) if usd is not None else None,
                       "collateral_usd_api":str(colusd) if colusd is not None else None})
    return {"count_total":total,"rows":result,"rows_returned":len(rows),"complete_page":total<=first,
            "source":"MORPHO_SINGLE_API_GRAPHQL_ONLY"}


def freeze(first, near):
    # The first row IDs are frozen before the second time step. A lender with
    # no collateral or zero borrows is ignored, never a liquidation candidate.
    candidates = []
    by_addr={}
    for tag,src in (("top_debt",first),("near_hf_indexer",near)):
        for row in src["rows"]:
            if int(row["borrow_shares"]) <= 0 or int(row["collateral_raw"]) <= 0:
                continue
            addr=row["borrower"]
            if addr not in by_addr:
                if len(candidates) >= MAX_UNION:
                    continue
                obj=dict(row);obj["cohort_sources"]=[tag]
                by_addr[addr]=obj;candidates.append(obj)
            elif tag not in by_addr[addr]["cohort_sources"]:
                by_addr[addr]["cohort_sources"].append(tag)
    need(all(bool(POS_RE.fullmatch(x["borrower"])) for x in candidates),"FREEZE_MALFORMED_ADDRESS")
    return {"market_id":MARKET,"chain_id":CHAIN,"frozen_at_utc":now(),
            "top_borrower_page":{"count_total":first["count_total"],"rows_returned":first["rows_returned"],"fully_enumerated":first["complete_page"]},
            "near_hf_page":{"count_total":near["count_total"],"rows_returned":near["rows_returned"],"fully_enumerated":near["complete_page"],"api_hf_lte":str(RISK_CUTOFF)},
            "cohort":candidates,"cohort_size":len(candidates)}


def compare(frozen, followup):
    need(type(frozen) is dict and type(followup) is dict,"INVALID_COMPARISON")
    freeze_set={p["borrower"] for p in frozen["cohort"]}
    late_set={p["borrower"] for p in followup["rows"]}
    need(late_set <= freeze_set,"POST_FREEZE_BORROWER_LEAKAGE")
    after={x["borrower"]:x for x in followup["rows"]}
    changes=[]
    for p in frozen["cohort"]:
        b=p["borrower"]
        later=after.get(b)
        if later is None:
            changes.append({"borrower":b,"status":"ABSENT_IN_SECOND_INDEXER_RESPONSE_NOT_PROOF_OF_LIQUIDATION"})
            continue
        changes.append({"borrower":b,"status":"TWO_INDEXER_OBSERVATIONS_ONLY",
                        "debt_raw_first":p["debt_raw"],"debt_raw_second":later["debt_raw"],
                        "debt_delta_raw":str(int(later["debt_raw"])-int(p["debt_raw"])),
                        "collateral_raw_first":p["collateral_raw"],"collateral_raw_second":later["collateral_raw"],
                        "collateral_delta_raw":str(int(later["collateral_raw"])-int(p["collateral_raw"]))})
    return {"cohort_size":len(freeze_set),"observed_twice":len(late_set),
            "missing_in_followup":len(freeze_set-late_set),"changes":changes,
            "onchain_liquidatability_proven":False,"network_first_seen_before_competitor_proven":False,
            "gas_sponsor_proven":False,"nqc_realized_pnl_usd":"0"}


class Client:
    def __init__(self, transport=None, raw_dir=None):
        self.transport=transport or self._http
        self.calls=0
        self.raw_dir=raw_dir
    @staticmethod
    def _http(body):
        data=json.dumps(body,separators=(",", ":")).encode()
        req=Request(API,data=data,headers={"Content-Type":"application/json","Accept":"application/json","User-Agent":"NQC-v2-prospective-risk-no-trade/1"},method="POST")
        try:
            with urlopen(req,timeout=15) as response:
                need(response.status==200,"API_HTTP_DENIED")
                raw=response.read(750000)
                need(len(raw)<750000,"API_OVERSIZE")
                return json.loads(raw)
        except HTTPError as e:
            raise Rejected("API_HTTP_"+str(e.code)) from e
        except (URLError,TimeoutError,OSError,ValueError) as e:
            raise Rejected("API_TRANSPORT_"+type(e).__name__) from e
    def query(self, label, first=50, near=None, users=None):
        self.calls+=1
        need(self.calls<=4,"SOURCE_CALL_BUDGET_EXHAUSTED")
        vars={"first":first,"market":[MARKET],"near":near,"users":users}
        query=(QUERY.replace("orderBy: BorrowShares", "orderBy: HealthFactor").replace("orderDirection: Desc", "orderDirection: Asc") if label=="NEAR_RISK" else QUERY)
        raw=self.transport({"operationName":"NqcCandidates","query":query,"variables":vars})
        # Immutable API JSON before parsing. Do not lose original source if a
        # numeric scalar has a different schema from our fail-closed assumption.
        if self.raw_dir is not None:
            file_write(self.raw_dir/("raw-"+label.lower()+".json"),raw)
        return validate_graphql(raw,label,first)


def file_write(path,obj):
    path.write_text(json.dumps(obj,sort_keys=True,indent=2)+"\n",encoding="utf-8")


def run(out, wait_seconds=35, client=None, sleeper=None):
    need(type(wait_seconds) is int and 0 <= wait_seconds <=60,"INVALID_WAIT")
    out.mkdir(parents=True,exist_ok=True)
    client=client or Client(raw_dir=out)
    sleeper=sleeper or time.sleep
    context={"scope":"Base-Morpho-cbXRP-USDC", "market":MARKET,"chain_id":CHAIN,
            "parent_PR743_head":PARENT_HEAD,"source":"official_public_morpho_graphql_single_indexer",
            "prospective_test_started_utc":now(),"queries_executed":0,
            "canonical_base_rpc_verified":False,"pnl_reconciled":False,"own_capital_spent_usd":"0"}
    file_write(out/"context.json",context)
    try:
        top=client.query("TOP_DEBT",first=MAX_ROWS)
        file_write(out/"first-top-debt.json",top)
        near=client.query("NEAR_RISK",first=MAX_ROWS,near=float(RISK_CUTOFF))
        file_write(out/"first-risk.json",near)
        frozen=freeze(top,near)
        file_write(out/"frozen-cohort.json",frozen)
        signed=digest(frozen)
        file_write(out/"frozen-cohort-commitment.json",{"sha256":signed,"committed_before_followup":True,"utc":now()})
        # Only now may time progress and the later API observation happen.
        sleeper(wait_seconds)
        if frozen["cohort"]:
            addresses=[p["borrower"] for p in frozen["cohort"]]
            follow=client.query("SECOND_FIXED_COHORT",first=MAX_UNION,users=addresses)
        else:
            follow={"rows":[],"rows_returned":0,"count_total":0,"complete_page":True}
        file_write(out/"second-fixed-cohort.json",follow)
        need(digest(json.loads((out/"frozen-cohort.json").read_text()))==signed,"FREEZE_MUTATED_AFTER_SECOND")
        need(follow["complete_page"] and follow["count_total"]<=len(frozen["cohort"]),"SECOND_SNAPSHOT_INCOMPLETE_OR_LEAKAGE")
        evidence=compare(frozen,follow)
        status="TWO_TIME_ORDERED_MORPHO_API_SNAPSHOTS_INDEXER_ONLY"
        if not top["complete_page"] or not near["complete_page"]:
            status="SOURCE_CENSORED_UNIVERSE_BUT_FIXED_COHORT_VALID"
        report={**context,"status":status,"cohort_commitment_sha256":signed,
                "second_sample_time_utc":now(),"wait_requested_seconds":wait_seconds,
                "queries_executed":client.calls,"first_top_page_total":top["count_total"],
                "first_risk_page_total":near["count_total"],"observations":evidence,
                "single_indexer_only":True,"zero_new_external_chain_calls":True,
                "nqc_realized_pnl_usd":"0","shadow_p2_certified":False,
                "canary_authorized":False,"commercial_score_not_automatically_promoted":True}
    except Rejected as e:
        report={**context,"status":"INCOMPLETE_MORPHO_PROSPECTIVE_SOURCE",
                "failure_reason":str(e),"queries_executed":client.calls,
                "nqc_realized_pnl_usd":"0","shadow_p2_certified":False,
                "canary_authorized":False,"commercial_score_not_automatically_promoted":True}
    file_write(out/"decision.json",report)
    return report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--out",required=True)
    parser.add_argument("--wait-seconds",type=int,default=35)
    opts=parser.parse_args()
    try:
        result=run(Path(opts.out),opts.wait_seconds)
    except Exception as ex:
        path=Path(opts.out);path.mkdir(parents=True,exist_ok=True)
        result={"status":"UNCERTIFIED_RUNTIME_FAILURE","failure_reason":type(ex).__name__,
                "nqc_realized_pnl_usd":"0","gas_sponsor_proven":False}
        file_write(path/"decision.json",result)
    print(stable({"status":result["status"],"queries_executed":result.get("queries_executed",0),
                  "cohort_size":result.get("observations",{}).get("cohort_size"),
                  "failure_reason":result.get("failure_reason")}))
    # CLI returns success for fail-closed source censoring to preserve artifact;
    # CI separately checks allowable statuses, no bogus opportunity claim.
    return 0 if result["status"]!="UNCERTIFIED_RUNTIME_FAILURE" else 1
if __name__=="__main__":
    raise SystemExit(main())
