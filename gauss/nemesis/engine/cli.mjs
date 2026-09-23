#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createVerifiedAgent, verifyFiniteSystem, verifyFiniteProgram, createVerifiedProgramAgent, runMotor, runMotorPipeline } from './src/index.mjs';

async function main() {
  const [mode, file, ...actions] = process.argv.slice(2);
  if (!['verify', 'agent', 'program', 'program-agent', 'motor', 'pipeline'].includes(mode) || !file || (!['agent', 'program-agent', 'motor', 'pipeline'].includes(mode) && actions.length)) {
    console.error('Usage: node cli.mjs pipeline <spec.json> | node cli.mjs motor <spec.json> <02..100> | node cli.mjs verify <spec.json> | node cli.mjs program <spec.json> | node cli.mjs program-agent <spec.json> [action ...] | node cli.mjs agent <spec.json> [action ...]');
    process.exitCode = 2;
    return;
  }
  try {
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    if (mode === 'pipeline') {
      if(actions.length)throw new TypeError('pipeline accepts no extra arguments');
      const result=await runMotorPipeline(spec);console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='PASS'?0:1;
    } else if (mode === 'motor') {
      if (actions.length !== 1) throw new TypeError('Usage: node cli.mjs pipeline <spec.json> | node cli.mjs motor <spec.json> <02..100>');
      if (actions[0] === '08' && spec.action === 'commit') throw new TypeError('Refusing to print a private Pedersen opening to stdout; use createPedersenCommitment() in a private process');
      const result = await runMotor(actions[0], spec);
      console.log(JSON.stringify(result, null, 2));
      if (result.status && !['CONSISTENT','PASS','REPAIRED','ALREADY_PASSING','DRY_RUN','APPLIED_IN_MEMORY','OPTIMAL_FINITE','FEASIBLE_CANDIDATE','QUORUM_CERTIFIED','CONVERGED'].includes(result.status)) process.exitCode = 1;
      if (result.verified === false || result.valid === false || result.converged === false) process.exitCode = 1;
    } else if (mode === 'verify' || mode === 'program') {
      const result = mode === 'verify' ? verifyFiniteSystem(spec) : verifyFiniteProgram(spec);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === 'PASS' ? 0 : 1;
    } else {
      const agent = mode === 'program-agent' ? createVerifiedProgramAgent(spec) : createVerifiedAgent(spec);
      const steps = actions.map(action => agent.execute(action));
      console.log(JSON.stringify({ verification: agent.verification, steps, finalState: agent.state(), ...(mode === 'program-agent' ? { finalValuation: agent.valuation() } : {}), availableActions: agent.availableActions() }, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ engine: mode === 'motor' ? 'NEMESIS_MOTOR' : ['program', 'program-agent'].includes(mode) ? 'NEMESIS_FINITE_PROGRAM_CTL_V2' : 'NEMESIS_FORMAL_FINITE_CTL_V1', status: 'ERROR', error: error.message, verification: error.verification ?? null }, null, 2));
    process.exitCode = 2;
  }
}
await main();
