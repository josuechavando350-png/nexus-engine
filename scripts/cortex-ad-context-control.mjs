#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { AdContextRuntimeController } from "../packages/ontology/dist/cortex/ad-context-control.js";
import { createAdContextControlServer } from "../packages/ontology/dist/cortex/ad-context-control-server.js";

process.umask(0o077);
const IDENTIFIER=/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MODES=new Set(["ACTIVE","OBSERVE_ONLY","KILLED"]);
function required(name){const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;}
function id(value,field){if(!IDENTIFIER.test(value))throw new Error(`${field} is malformed`);return value;}
function port(value){const parsed=Number(value??"8790");if(!Number.isSafeInteger(parsed)||parsed<1||parsed>65535)throw new Error("PORT must be 1..65535");return parsed;}
const db=required("NEXUS_CORTEX_STATE_DB");
if(db===":memory:"||!isAbsolute(db))throw new Error("NEXUS_CORTEX_STATE_DB must be an absolute path on a durable mounted volume");
if(process.env.NEXUS_CORTEX_PERSISTENCE_ACK!=="durable-volume")throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const tenantId=id(required("NEXUS_TENANT_ID"),"NEXUS_TENANT_ID");
const organizationId=id(required("NEXUS_ORGANIZATION_ID"),"NEXUS_ORGANIZATION_ID");
const brandRaw=process.env.NEXUS_BRAND_ID?.trim();
const scope=Object.freeze({tenantId,organizationId,...(brandRaw?{brandId:id(brandRaw,"NEXUS_BRAND_ID")}:{})});
const key=id(required("NEXUS_AD_CONTEXT_CONTROL_KEY"),"NEXUS_AD_CONTEXT_CONTROL_KEY");
const policyId=id(required("NEXUS_AD_CONTEXT_POLICY_ID"),"NEXUS_AD_CONTEXT_POLICY_ID");
const configuredMode=required("NEXUS_AD_CONTEXT_CONFIGURED_MODE").toUpperCase();
if(!MODES.has(configuredMode))throw new Error("NEXUS_AD_CONTEXT_CONFIGURED_MODE is invalid");
const store=new SqliteOntologyTransactionStore(db,{onTelemetryError:(error)=>process.stderr.write(`${JSON.stringify({component:"cortex-ad-context-store",level:"error",code:"TELEMETRY_SINK_FAILURE",message:error instanceof Error?error.message:"unknown"})}\n`)});
const controller=new AdContextRuntimeController(store,scope,key,policyId,configuredMode);
const production=createAdContextControlServer({controller,edgeToken:required("NEXUS_AD_CONTEXT_EDGE_TOKEN"),controlToken:required("NEXUS_AD_CONTEXT_CONTROL_TOKEN"),onOperationalEvent:(event)=>process.stdout.write(`${JSON.stringify({component:"cortex-ad-context-control",...event})}\n`)});
const host=process.env.NEXUS_CORTEX_HOST?.trim()||"0.0.0.0";
const listenPort=port(process.env.PORT);
let shuttingDown=false;
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;process.stdout.write(`${JSON.stringify({component:"cortex-ad-context-control",operation:"SHUTDOWN",signal})}\n`);try{await production.close();}finally{store.close();}}
process.once("SIGINT",()=>{void shutdown("SIGINT").finally(()=>process.exit(0));});
process.once("SIGTERM",()=>{void shutdown("SIGTERM").finally(()=>process.exit(0));});
production.server.listen(listenPort,host,()=>process.stdout.write(`${JSON.stringify({component:"cortex-ad-context-control",operation:"LISTEN",host,port:listenPort,policyId})}\n`));
