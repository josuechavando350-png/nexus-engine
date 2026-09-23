import { calculateStructuralRobustness } from './structural-robustness.mjs';
import { reasonCrossDomainOntology } from './cross-domain-ontology.mjs';
import { planReverseIngestion } from './reverse-ingestion.mjs';
import { catalogDarkData } from './dark-data.mjs';
import { compileCertaintyContract, evaluateCertaintyContract } from './certainty-contract.mjs';
import { object, integer, id } from './shared.mjs';

/** Demonstration of five real APIs connected through machine-derived gate observations. */
export function auditIngestionWorkflow(input) {
  object(input,'workflow',['id','graph','ontology','reverseIngestion','catalog','maxChanges']);
  id(input.id,'workflow.id');
  integer(input.maxChanges,'workflow.maxChanges',0,256);
  const graph=calculateStructuralRobustness(input.graph);
  const ontology=reasonCrossDomainOntology(input.ontology);
  const reconciliation=planReverseIngestion(input.reverseIngestion);
  const catalog=catalogDarkData(input.catalog);
  // Pin the exact serialized dry-run plan digest, not an unverified live source.
  const contract=compileCertaintyContract({id:input.id,artifactSha256:reconciliation.planHash,predicates:[
    {metric:'connected',op:'EQ',value:1},{metric:'ontologyConsistent',op:'EQ',value:1},
    {metric:'catalogedDocuments',op:'GTE',value:1},{metric:'plannedChanges',op:'LTE',value:input.maxChanges},
  ]});
  const evaluation=evaluateCertaintyContract(contract,[
    {metric:'connected',value:Number(graph.connected)},
    {metric:'ontologyConsistent',value:Number(ontology.consistent)},
    {metric:'catalogedDocuments',value:catalog.documentCount},
    {metric:'plannedChanges',value:reconciliation.plan.operations.length},
  ]);
  return {engine:'NEMESIS_INGESTION_AUDIT_V1',status:evaluation.status,graph,ontology,reconciliation,catalog,contract,evaluation,
    note:'Five bounded engines chained in one in-memory audit. PASS only checks modeled predicates; no external ingestion, writes, deployment, or automatic source authenticity.'};
}
