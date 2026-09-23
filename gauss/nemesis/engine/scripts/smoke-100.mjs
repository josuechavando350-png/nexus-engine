import {readFileSync,writeFileSync} from 'node:fs';
import {runMotor,verifyFiniteSystem} from '../src/index.mjs';
const named={1:'safe-finite-system',2:'causal-confounding',3:'game-matching-pennies',4:'qaoa-two-vertices',5:'hmm-two-hidden-states',6:'quantum-walk-discrete',7:'kalman-rts',8:'zk-public-proof',9:'bayes-event-stream',10:'mirrored-agent',11:'selection-conditioning',12:'finite-tail-risk',13:'clock-intervals',14:'finite-fuzzy',15:'grammar-repair',16:'structural-chain',17:'cross-domain-ontology',18:'reverse-ingestion',19:'dark-data-catalog',20:'certainty-contract',21:'information-simplex',22:'lorenz96-equilibrium',23:'ensemble-kalman',24:'pinn-poisson',25:'information-diffusion',26:'stackelberg-three-stage',27:'persistent-square',28:'causal-irl',29:'multivariate-transfer-entropy',30:'scenario-robust',31:'local-contract',32:'dynamic-graph',33:'empirical-mode',34:'dynamic-bayes',35:'stochastic-dp',36:'cross-map',37:'spatiotemporal-field',38:'constrained-swarm',39:'paillier-public',40:'invariant-safe'};
const accepted=new Set(['CONSISTENT','PASS','REPAIRED','ALREADY_PASSING','DRY_RUN','APPLIED_IN_MEMORY','OPTIMAL_FINITE','FEASIBLE_CANDIDATE','QUORUM_CERTIFIED','CONVERGED']);
const results=[];
for(let n=1;n<=100;n++){
 const file=`examples/${named[n]??`motor-${n}`}.json`;
 try{const input=JSON.parse(readFileSync(new URL('../'+file,import.meta.url))),output=await(n===1?verifyFiniteSystem(input):runMotor(String(n).padStart(2,'0'),input));
 const successful=output.verified!==false&&output.valid!==false&&output.converged!==false&&(!output.status||accepted.has(output.status));
 const expectedNegative=n===12&&output.status==='BREACH'&&output.conditionalValueAtRisk==='55/1'&&output.withinLimit===false;
 results.push({id:n,example:file,executed:true,successful,expectedNegative,matchedExpected:successful||expectedNegative,status:output.status??null,output});
 }catch(e){results.push({id:n,example:file,executed:false,successful:false,error:e.message});}
}
const report={project:'NEMESIS',version:'17.0.0',node:process.version,executed:results.filter(r=>r.executed).length,successful:results.filter(r=>r.successful).length,matchedExpected:results.filter(r=>r.matchedExpected).length,expectedNegative:results.filter(r=>r.expectedNegative).length,meaning:'Only execution of the supplied examples; not closure of original scope',results};
writeFileSync(new URL('../evidence/smoke-100-v17.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({executed:report.executed,successful:report.successful,matchedExpected:report.matchedExpected,expectedNegative:report.expectedNegative,failures:results.filter(r=>!r.matchedExpected).map(({output,...r})=>r)},null,2));
if(report.matchedExpected!==100)process.exitCode=1;
