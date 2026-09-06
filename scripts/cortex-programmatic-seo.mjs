#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { HttpProgrammaticSeoCatalogProvider } from "../packages/ontology/dist/cortex/headless-programmatic-seo/http-catalog-provider.js";
import { JsonFileProgrammaticSeoPublisher } from "../packages/ontology/dist/cortex/headless-programmatic-seo/json-file-page-bundle-publisher.js";
import { createProgrammaticSeoProductionRuntime, parseProgrammaticSeoProductionConfig } from "../packages/ontology/dist/cortex/headless-programmatic-seo/production-runtime.js";

process.umask(0o077);
const MAX_CONFIG_BYTES=1024*1024;
function required(name){const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;}
function config(path){if(!isAbsolute(path))throw new Error("NEXUS_CORTEX_PROGRAMMATIC_SEO_CONFIG must be an absolute path");const stat=statSync(path);if(!stat.isFile()||stat.size<2||stat.size>MAX_CONFIG_BYTES)throw new Error(`programmatic SEO config must be a regular file <= ${MAX_CONFIG_BYTES} bytes`);return parseProgrammaticSeoProductionConfig(JSON.parse(readFileSync(path,"utf8")));}
function durablePath(name){const value=required(name);if(value===":memory:"||!isAbsolute(value))throw new Error(`${name} must be an absolute durable path`);return value;}
function port(value){const parsed=Number(value??"8793");if(!Number.isSafeInteger(parsed)||parsed<1||parsed>65535)throw new Error("PORT must be 1..65535");return parsed;}

if(process.env.NEXUS_CORTEX_PERSISTENCE_ACK!=="durable-volume")throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const stateDb=durablePath("NEXUS_CORTEX_STATE_DB");
const manifestPath=durablePath("NEXUS_CORTEX_PROGRAMMATIC_SEO_MANIFEST");
const productionConfig=config(required("NEXUS_CORTEX_PROGRAMMATIC_SEO_CONFIG"));
const catalog=new HttpProgrammaticSeoCatalogProvider({endpoint:required("NEXUS_CORTEX_PROGRAMMATIC_SEO_CATALOG_ENDPOINT"),bearerToken:required("NEXUS_CORTEX_PROGRAMMATIC_SEO_CATALOG_TOKEN"),maxRouteDepth:productionConfig.policy.maxRouteDepth});
const publisher=new JsonFileProgrammaticSeoPublisher({manifestPath});
const store=new SqliteOntologyTransactionStore(stateDb,{onTelemetryError:(error)=>process.stderr.write(`${JSON.stringify({component:"cortex-programmatic-seo-store",level:"error",code:"TELEMETRY_SINK_FAILURE",message:error instanceof Error?error.message:"unknown"})}\n`)});
const runtime=createProgrammaticSeoProductionRuntime({transactions:store,config:productionConfig,catalog,publisher,runToken:required("NEXUS_CORTEX_PROGRAMMATIC_SEO_RUN_TOKEN"),controlToken:required("NEXUS_CORTEX_PROGRAMMATIC_SEO_CONTROL_TOKEN"),bundleToken:required("NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_TOKEN"),onTelemetry:(event)=>process.stdout.write(`${JSON.stringify({component:"cortex-programmatic-seo",...event})}\n`),onTelemetryError:(error)=>process.stderr.write(`${JSON.stringify({component:"cortex-programmatic-seo",level:"error",code:"TELEMETRY_SINK_FAILURE",message:error instanceof Error?error.message:"unknown"})}\n`)});
const host=process.env.NEXUS_CORTEX_HOST?.trim()||"0.0.0.0";const listenPort=port(process.env.PORT);let shuttingDown=false;
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;process.stdout.write(`${JSON.stringify({component:"cortex-programmatic-seo",operation:"SHUTDOWN",signal})}\n`);try{await runtime.close();}finally{store.close();}}
process.once("SIGINT",()=>{void shutdown("SIGINT").finally(()=>process.exit(0));});process.once("SIGTERM",()=>{void shutdown("SIGTERM").finally(()=>process.exit(0));});
runtime.server.listen(listenPort,host,()=>{process.stdout.write(`${JSON.stringify({component:"cortex-programmatic-seo",operation:"LISTEN",host,port:listenPort,siteId:productionConfig.siteId})}\n`);runtime.start(true);});
