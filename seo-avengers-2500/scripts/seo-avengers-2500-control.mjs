#!/usr/bin/env node
import {
  readTenantControl,
  setTenantEnabled,
  setTenantKillSwitch,
} from "../control-plane/tenant-control.mjs";

function usage(message = null) {
  if (message) console.error(message);
  console.error("usage: seo-avengers-2500-control.mjs <status|enable|disable|kill|unkill> --root <control-root> --site <site-id>");
  process.exit(2);
}

function parseArgs(argv) {
  if (argv.length < 1) usage();
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage("invalid arguments");
    options[key.slice(2)] = value;
  }
  if (!options.root || !options.site) usage("--root and --site are required");
  return { command, controlRoot: options.root, siteId: options.site };
}

async function mutate(command, controlRoot, siteId) {
  const current = await readTenantControl({ controlRoot, siteId });
  if (!current.integrityOk) throw new Error(`control state is fail-closed: ${current.reason}`);

  if (command === "enable") {
    return setTenantEnabled({ controlRoot, siteId, enabled: true, expectedGeneration: current.generation });
  }
  if (command === "disable") {
    return setTenantEnabled({ controlRoot, siteId, enabled: false, expectedGeneration: current.generation });
  }
  if (command === "kill") {
    return setTenantKillSwitch({ controlRoot, siteId, active: true, expectedGeneration: current.generation });
  }
  if (command === "unkill") {
    return setTenantKillSwitch({ controlRoot, siteId, active: false, expectedGeneration: current.generation });
  }
  throw new Error(`unsupported command: ${command}`);
}

async function main() {
  const { command, controlRoot, siteId } = parseArgs(process.argv.slice(2));
  if (command === "status") {
    console.log(JSON.stringify(await readTenantControl({ controlRoot, siteId })));
    return;
  }
  if (!["enable", "disable", "kill", "unkill"].includes(command)) usage("unsupported command");
  const state = await mutate(command, controlRoot, siteId);
  console.log(JSON.stringify(state));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
