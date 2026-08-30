import { validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "./index.js";
import { hash } from "./chatbot-knowledge-types.js";
import { BANDIT_DECISION_TYPE, BANDIT_STATE_TYPE, BDP, BSP, type BanditMutationPlan } from "./chatbot-bandit-types.js";
import type { TransactionOperation } from "./transaction.js";

function property(
  id: string,
  name: string,
  valueKind: "STRING" | "NUMBER" | "BOOLEAN" | "DATETIME" | "JSON",
  cardinality: "REQUIRED" | "OPTIONAL",
  options: { unique?: boolean; immutable?: boolean } = {},
) {
  return {
    id,
    name,
    valueKind,
    cardinality,
    unique: options.unique ?? false,
    immutable: options.immutable ?? false,
  } as const;
}

export function chatbotContextualBanditSchema(scope: OntologyScope): ValidatedSchema {
  const schema: SchemaVersion = {
    version: "chatbot-contextual-bandit-v1",
    scope,
    properties: [
      property(BSP.banditId, "BanditId", "STRING", "REQUIRED", { immutable: true }),
      property(BSP.armId, "BanditArmId", "STRING", "REQUIRED", { immutable: true }),
      property(BSP.contextKey, "BanditContextKey", "STRING", "REQUIRED", { immutable: true }),
      property(BSP.pulls, "BanditPulls", "NUMBER", "REQUIRED"),
      property(BSP.rewardSum, "BanditRewardSum", "NUMBER", "REQUIRED"),
      property(BSP.rewardSquareSum, "BanditRewardSquareSum", "NUMBER", "REQUIRED"),
      property(BSP.createdAt, "BanditStateCreatedAt", "DATETIME", "REQUIRED", { immutable: true }),
      property(BSP.updatedAt, "BanditStateUpdatedAt", "DATETIME", "REQUIRED"),
      property(BSP.recordDigest, "BanditStateDigest", "STRING", "REQUIRED"),
      property(BDP.banditId, "DecisionBanditId", "STRING", "REQUIRED", { immutable: true }),
      property(BDP.interactionId, "BanditInteractionId", "STRING", "REQUIRED", { immutable: true }),
      property(BDP.armId, "DecisionArmId", "STRING", "REQUIRED", { immutable: true }),
      property(BDP.contextKey, "DecisionContextKey", "STRING", "REQUIRED", { immutable: true }),
      property(BDP.contextDigest, "DecisionContextDigest", "STRING", "REQUIRED", { immutable: true }),
      property(BDP.policyDigest, "DecisionPolicyDigest", "STRING", "REQUIRED", { immutable: true }),
      property(BDP.guardrailContextDigest, "DecisionGuardrailContextDigest", "STRING", "REQUIRED", { immutable: true }),
      property(BDP.issuedAt, "DecisionIssuedAt", "DATETIME", "REQUIRED", { immutable: true }),
      property(BDP.status, "DecisionStatus", "STRING", "REQUIRED"),
      property(BDP.reward, "DecisionReward", "NUMBER", "OPTIONAL"),
      property(BDP.outcomeAt, "DecisionOutcomeAt", "DATETIME", "OPTIONAL"),
      property(BDP.recordDigest, "DecisionDigest", "STRING", "REQUIRED"),
    ],
    interfaces: [],
    objects: [
      {
        id: BANDIT_STATE_TYPE,
        name: "ContextualBanditState",
        propertyIds: [
          BSP.banditId, BSP.armId, BSP.contextKey, BSP.pulls, BSP.rewardSum, BSP.rewardSquareSum,
          BSP.createdAt, BSP.updatedAt, BSP.recordDigest,
        ],
        interfaceIds: [],
      },
      {
        id: BANDIT_DECISION_TYPE,
        name: "ContextualBanditDecision",
        propertyIds: [
          BDP.banditId, BDP.interactionId, BDP.armId, BDP.contextKey, BDP.contextDigest,
          BDP.policyDigest, BDP.guardrailContextDigest, BDP.issuedAt, BDP.status, BDP.reward,
          BDP.outcomeAt, BDP.recordDigest,
        ],
        interfaceIds: [],
      },
    ],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(schema);
}

export function banditPlan(scope: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): BanditMutationPlan {
  const core = {
    scope,
    schemaId: schema.schemaId,
    requiredPermission: "chatbot.bandit.write" as const,
    noop: operations.length === 0,
    operations,
  };
  return { ...core, digest: hash("cbplan", core) };
}
