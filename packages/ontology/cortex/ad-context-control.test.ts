import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "./sqlite-transaction-store";
import { AdContextRuntimeController } from "./ad-context-control";
import { createAdContextControlServer } from "./ad-context-control-server";

const scope=Object.freeze({tenantId:"cano",organizationId:"nexus",brandId:"cano-penal"});
const edgeToken="edge-token-0000000000000000000000000000000001";
const controlToken="control-token-00000000000000000000000000000001";
const dirs:string[]=[];
afterEach(()=>{while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});});
async function listen(server: ReturnType<typeof createAdContextControlServer>["server"]):Promise<string>{await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const address=server.address();if(!address||typeof address==="string")throw new Error("no tcp address");return `http://127.0.0.1:${address.port}`;}

describe("CORTEX ad-context durable control plane",()=>{
  it("persists kill across restart, separates privileges and aggregates safe decisions",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"nexus-ad-context-"));dirs.push(dir);const db=join(dir,"state.sqlite");let now=Date.parse("2026-09-05T23:45:00.000Z");
    const store=new SqliteOntologyTransactionStore(db);const controller=new AdContextRuntimeController(store,scope,"cano-edge","cano-paid-landing-v1","ACTIVE",()=>now);const production=createAdContextControlServer({controller,edgeToken,controlToken});const base=await listen(production.server);
    const runtime=await fetch(`${base}/v1/ad-context/runtime`,{headers:{authorization:`Bearer ${edgeToken}`}});expect(runtime.status).toBe(200);expect(await runtime.json()).toMatchObject({policyId:"cano-paid-landing-v1",mode:"ACTIVE",revision:0});
    expect((await fetch(`${base}/v1/ad-context/control`,{headers:{authorization:`Bearer ${edgeToken}`}})).status).toBe(401);
    const killed=await fetch(`${base}/v1/ad-context/control`,{method:"POST",headers:{authorization:`Bearer ${controlToken}`,"content-type":"application/json"},body:JSON.stringify({expectedRevision:0,mode:"KILLED",reason:"incident containment"})});expect(killed.status).toBe(200);expect(await killed.json()).toMatchObject({state:{mode:"KILLED",revision:1},effectiveMode:"KILLED"});
    const observe=await fetch(`${base}/v1/ad-context/observe`,{method:"POST",headers:{authorization:`Bearer ${edgeToken}`,"content-type":"application/json"},body:JSON.stringify({policyId:"cano-paid-landing-v1",mode:"KILLED",channel:"DIRECT_OR_UNKNOWN",reason:"KILL_SWITCH",applied:false,observedAt:new Date(now).toISOString()})});expect(observe.status).toBe(202);expect(await observe.json()).toMatchObject({accepted:true,day:"2026-09-05"});
    await production.close();store.close();
    const reopenedStore=new SqliteOntologyTransactionStore(db);const reopened=new AdContextRuntimeController(reopenedStore,scope,"cano-edge","cano-paid-landing-v1","ACTIVE",()=>now+1000);expect(reopened.effectiveMode()).toBe("KILLED");expect(reopened.current().revision).toBe(1);expect(reopened.history()).toHaveLength(1);reopenedStore.close();
  });

  it("refuses policy-config weakening and unknown telemetry fields",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"nexus-ad-context-"));dirs.push(dir);const store=new SqliteOntologyTransactionStore(join(dir,"state.sqlite"));const controller=new AdContextRuntimeController(store,scope,"cano-edge","cano-paid-landing-v1","OBSERVE_ONLY");expect(()=>controller.set({expectedRevision:0,mode:"ACTIVE",reason:"unsafe weakening"})).toThrow(/cannot weaken/i);
    const production=createAdContextControlServer({controller,edgeToken,controlToken});const base=await listen(production.server);const response=await fetch(`${base}/v1/ad-context/observe`,{method:"POST",headers:{authorization:`Bearer ${edgeToken}`,"content-type":"application/json"},body:JSON.stringify({policyId:"cano-paid-landing-v1",mode:"OBSERVE_ONLY",channel:"PAID_SEARCH",reason:"OBSERVE_ONLY_MATCH",applied:false,observedAt:new Date().toISOString(),gclid:"forbidden"})});expect(response.status).toBe(400);await production.close();store.close();
  });
});
