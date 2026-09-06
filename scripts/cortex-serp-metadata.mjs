#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { createGoogleOAuthRefreshTokenProvider } from "../packages/ontology/dist/cortex/bidding-supervisor/google-ads-rest.js";
import { HttpPageInventoryProvider } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/http-page-inventory-provider.js";
import { JsonFileMetadataPublisher } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/json-file-metadata-publisher.js";
import { SearchConsoleRestClient } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/search-console-rest.js";
import { createSerpProductionRuntime, parseSerpProductionConfig } from "../packages/ontology/dist/cortex/serp-metadata-optimizer/production-runtime.js";

process.umask(0o077);
const MAX_CONFIG_BYTES=1024*1024;
function required(name){const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;}
function config(path){if(!isAbsolute(path))throw new Error("NEXUS_CORTEX_SERP_CONFIG must be an absolute path");const stat=statSync(path);if(!stat.isFile()||stat.size<2||stat.size>MAX_CONFIG_BYTES)throw new Error(`SERP config must be a regular file <= ${MAX_CONFIG_BYTES} bytes`);return parseSerpProductionConfig(JSON.parse(readFileSync(path,"utf8")));}
function durablePath(name){const value=required(name);if(value===":memory:"||!isAbsolute(value))throw new Error(`${name} must be an absolute durable path`);return value;}
function port(value){const parsed=Number(value??"8792");if(!Number.isSafeInteger(parsed)||parsed<1||parsed>65535)throw new Error("PORT must be 1..65535");return parsed;}

if(process.env.NEXUS_CORTEX_PERSISTENCE_ACK!=="durable-volume")throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const stateDb=durablePath("NEXUS_CORTEX_STATE_DB");
const manifestPath=durablePath("NEXUS_CORTEX_SERP_MANIFEST");
const productionConfig=config(required("NEXUS_CORTEX_SERP_CONFIG"));
const accessTokenProvider=createGoogleOAuthRefreshTokenProvider({clientId:required("GOOGLE_SEARCH_CONSOLE_CLIENT_ID"),clientSecret:required("GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET"),refreshToken:required("GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN")});
const inventory=new HttpPageInventoryProvider({endpoint:required("NEXUS_CORTEX_SERP_INVENTORY_ENDPOINT"),bearerToken:required("NEXUS_CORTEX_SERP_INVENTORY_TOKEN")});
const performance=new SearchConsoleRestClient({accessTokenProvider});
const publisher=new JsonFileMetadataPublisher({manifestPath});
const store=new SqliteOntologyTransactionStore(stateDb,{onTelemetryError:(error)=>process.stderr.write(`${JSON.stringify({component:"cortex-serp-store",level:"error",code:"TELEMETRY_SINK_FAILURE",message:error instanceof Error?error.message:"unknown"})}\n`)});
const runtime=createSerpProductionRuntime({transactions:store,config:productionConfig,inventory,performance,publisher,runToken:required("NEXUS_CORTEX_SERP_RUN_TOKEN"),controlToken:required("NEXUS_CORTEX_SERP_CONTROL_TOKEN"),metadataToken:required("NEXUS_CORTEX_SERP_METADATA_TOKEN"),onTelemetry:(event)=>process.stdout.write(`${JSON.stringify({component:"cortex-serp-metadata",...event})}\n`),onTelemetryError:(error)=>process.stderr.write(`${JSON.stringify({component:"cortex-serp-metadata",level:"error",code:"TELEMETRY_SINK_FAILURE",message:error instanceof Error?error.message:"unknown"})}\n`)});
const host=process.env.NEXUS_CORTEX_HOST?.trim()||"0.0.0.0";const listenPort=port(process.env.PORT);let shuttingDown=false;
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;process.stdout.write(`${JSON.stringify({component:"cortex-serp-metadata",operation:"SHUTDOWN",signal})}\n`);try{await runtime.close();}finally{store.close();}}
process.once("SIGINT",()=>{void shutdown("SIGINT").finally(()=>process.exit(0));});process.once("SIGTERM",()=>{void shutdown("SIGTERM").finally(()=>process.exit(0));});
runtime.server.listen(listenPort,host,()=>{process.stdout.write(`${JSON.stringify({component:"cortex-serp-metadata",operation:"LISTEN",host,port:listenPort,pages:productionConfig.pages.length})}\n`);runtime.start(true);});
