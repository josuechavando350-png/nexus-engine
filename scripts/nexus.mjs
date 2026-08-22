#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

function usage() {
  console.error('Usage: nexus modify <scene.json> <json-pointer> <json-value>');
  console.error('Example: nexus modify apps/client/scene.json /sections/0/title ' + "'\"Nuevo título\"'");
  process.exit(2);
}
function decodePointerPart(value) { return value.replaceAll("~1", "/").replaceAll("~0", "~"); }
function applyJsonPointer(document, pointer, value) {
  if (!pointer.startsWith("/")) throw new Error("json-pointer must start with /");
  const parts=pointer.slice(1).split("/").map(decodePointerPart); if(!parts.length) throw new Error("root replacement is not supported");
  let cursor=document;
  for(let i=0;i<parts.length-1;i+=1){const part=parts[i];if(cursor===null||typeof cursor!=="object"||!(part in cursor))throw new Error(`json-pointer segment not found: ${parts.slice(0,i+1).join("/")}`);cursor=cursor[part];}
  const leaf=parts.at(-1); if(cursor===null||typeof cursor!=="object"||!(leaf in cursor))throw new Error(`json-pointer target not found: ${pointer}`); cursor[leaf]=value;
}
function runGate(name,args){const started=performance.now();execFileSync("pnpm",args,{stdio:"inherit",env:process.env});return {name,elapsedMs:Math.round(performance.now()-started)};}

const [command, sceneArg, pointer, rawValue] = process.argv.slice(2);
if (command !== "modify" || !sceneArg || !pointer || rawValue === undefined) usage();
const scenePath=resolve(sceneArg); if(!scenePath.includes(`${resolve("apps")}/`))throw new Error("scene changes must target a client/app file under apps/");
const started=performance.now(); const original=readFileSync(scenePath,"utf8"); let scene;
try{scene=JSON.parse(original);}catch(error){throw new Error(`nexus modify currently requires a JSON scene document: ${sceneArg}`,{cause:error});}
let value; try{value=JSON.parse(rawValue);}catch{value=rawValue;}
applyJsonPointer(scene,pointer,value); writeFileSync(scenePath,`${JSON.stringify(scene,null,2)}\n`);
const patchElapsedMs=Math.round(performance.now()-started); const gates=[];
try{
  gates.push(runGate("assets",["verify:assets"]));
  gates.push(runGate("tests",["test"]));
  gates.push(runGate("build",["build"]));
  gates.push(runGate("quality",["quality-gates"]));
}catch(error){writeFileSync(scenePath,original);console.error(JSON.stringify({authority:"NEXUS_MODIFY_V1",status:"FAIL",scene:sceneArg,pointer,patchElapsedMs,totalElapsedMs:Math.round(performance.now()-started),gates,rolledBack:true},null,2));throw error;}
console.log(JSON.stringify({authority:"NEXUS_MODIFY_V1",status:"PASS",scene:sceneArg,pointer,patchElapsedMs,totalElapsedMs:Math.round(performance.now()-started),gates,rolledBack:false},null,2));
