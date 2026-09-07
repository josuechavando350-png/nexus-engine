import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FormSubmission, LeadDestination } from "./index.js";
import type { Cortex20Mode } from "./runtime-control.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DOMAIN = /^(?=.{3,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const SENSITIVE_FEATURE_NAMES = new Set(["age","birthDate","sex","gender","race","ethnicity","religion","health","disability","politicalAffiliation","sexualOrientation","preciseLocation","latitude","longitude","email","phone","name","address","ipAddress","fingerprint"]);
const SENSITIVE_ACTIONS = new Set<SalesRequestedAction>(["CUSTOM_PRICE","DISCOUNT","CONTRACT","PAYMENT_TERMS","LEGAL_COMMITMENT"]);

export type SalesChannel = "WHATSAPP" | "SMS";
export type SalesRequestedAction = "FOLLOW_UP" | "CUSTOM_PRICE" | "DISCOUNT" | "CONTRACT" | "PAYMENT_TERMS" | "LEGAL_COMMITMENT" | "HUMAN_HANDOFF";
export type SalesAutomationStatus = "PRIMARY_DELIVERED" | "AUTONOMOUS_SENT" | "HANDOFF_REQUIRED" | "NO_AUTOMATION" | "OBSERVED";

export interface ModelFeature {
  readonly source: "FORM" | "ENRICHMENT";
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly weight: number;
}
export interface PredictiveLeadModel {
  readonly modelId: string;
  readonly modelDigest: `sha256:${string}`;
  readonly intercept: number;
  readonly features: readonly ModelFeature[];
}
export interface PredictiveClvModel {
  readonly modelId: string;
  readonly modelDigest: `sha256:${string}`;
  readonly currency: string;
  readonly intercept: number;
  readonly features: readonly ModelFeature[];
  readonly minValue: number;
  readonly maxValue: number;
}
export interface FormSalesPolicy {
  readonly formId: string;
  readonly companyDomainField: string | null;
  readonly enrichmentEnabled: boolean;
  readonly allowedEnrichmentProviderIds: readonly string[];
  readonly leadModel: PredictiveLeadModel;
  readonly clvModel: PredictiveClvModel;
  readonly minLeadScoreForAutonomousFollowUp: number;
  readonly routes: readonly { readonly channel: SalesChannel; readonly contactField: string; readonly capabilityId: string }[];
  readonly llmBusinessContext: string;
}
export interface AutonomousSalesPolicy { readonly version: 1; readonly forms: readonly FormSalesPolicy[]; }

export interface B2bEnrichmentResult {
  readonly providerId: string;
  readonly evidenceId: string;
  readonly domain: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}
export interface B2bEnrichmentProvider { readonly providerId: string; enrich(domain: string, idempotencyKey: string): Promise<B2bEnrichmentResult>; }
export interface ConsentDecision {
  readonly decisionId: string;
  readonly status: "GRANTED" | "DENIED" | "REVOKED";
  readonly channel: SalesChannel;
  readonly contactHash: `sha256:${string}`;
  readonly expiresAt: string;
}
export interface ConsentRegistryProvider { resolve(contactHash: `sha256:${string}`, channel: SalesChannel): Promise<ConsentDecision>; }
export interface CapabilityDecision {
  readonly capabilityId: string;
  readonly mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
  readonly revision: number;
  readonly policyDigest: `sha256:${string}`;
}
export interface CapabilityGateProvider { read(capabilityId: string): Promise<CapabilityDecision>; }
export interface LocalSalesAssistantInput {
  readonly businessContext: string;
  readonly leadScore: number;
  readonly predictedClv: number;
  readonly clvCurrency: string;
  readonly enrichment: Readonly<Record<string, string | number | boolean>>;
}
export interface LocalSalesAssistantResult {
  readonly modelId: string;
  readonly modelDigest: `sha256:${string}`;
  readonly classification: string;
  readonly summary: string;
  readonly suggestedMessage: string;
  readonly requestedAction: SalesRequestedAction;
}
export interface LocalSalesAssistant { draft(input: LocalSalesAssistantInput): Promise<LocalSalesAssistantResult>; }
export interface ChannelDispatcher { send(input: { channel: SalesChannel; contact: string; message: string; idempotencyKey: string }): Promise<{ receiptId: string }>; }
export interface HumanHandoffDestination { handoff(input: { submissionId: string; formId: string; leadScore: number; predictedClv: number; clvCurrency: string; requestedAction: SalesRequestedAction; summary: string; idempotencyKey: string }): Promise<{ receiptId: string }>; }

export interface AutonomousSalesDependencies {
  readonly primaryDestination: LeadDestination;
  readonly enrichment: B2bEnrichmentProvider | null;
  readonly consentRegistry: ConsentRegistryProvider;
  readonly capabilityGate: CapabilityGateProvider;
  readonly assistant: LocalSalesAssistant;
  readonly channelDispatcher: ChannelDispatcher;
  readonly humanHandoff: HumanHandoffDestination;
  readonly contactHashSecret: string;
  readonly readMode: () => Cortex20Mode;
  readonly now?: () => number;
}

export interface SalesAutomationAuditRecord {
  readonly eventId: string;
  readonly submissionHash: `sha256:${string}`;
  readonly formId: string;
  readonly leadModelDigest: `sha256:${string}`;
  readonly clvModelDigest: `sha256:${string}`;
  readonly leadScore: number;
  readonly predictedClv: number;
  readonly clvCurrency: string;
  readonly enrichmentProviderId: string | null;
  readonly enrichmentEvidenceId: string | null;
  readonly assistantModelDigest: `sha256:${string}` | null;
  readonly requestedAction: SalesRequestedAction | null;
  readonly channel: SalesChannel | null;
  readonly consentDecisionId: string | null;
  readonly capabilityPolicyDigest: `sha256:${string}` | null;
  readonly status: SalesAutomationStatus;
  readonly remoteReceiptId: string;
  readonly createdAt: string;
}

export class Cortex40Error extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "REMOTE_FAILURE" | "CONSENT_BLOCKED" | "CAPABILITY_BLOCKED" | "MODE_BLOCKED" | "INTEGRITY_FAILURE" | "CONFLICT", message: string) { super(message); this.name = "Cortex40Error"; }
}

function safeMode(provider:()=>Cortex20Mode):Cortex20Mode{try{const m=provider();return m==="ACTIVE"||m==="OBSERVE_ONLY"||m==="KILLED"?m:"KILLED";}catch{return "KILLED";}}
function finite(value:unknown,label:string,min:number,max:number):number{if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)throw new Cortex40Error("INVALID_CONFIG",`${label} is out of range`);return value;}
function modelFeature(feature:ModelFeature,label:string):ModelFeature{if(!(feature.source==="FORM"||feature.source==="ENRICHMENT")||!ID.test(feature.name)||SENSITIVE_FEATURE_NAMES.has(feature.name)||feature.max<=feature.min||!Number.isFinite(feature.min)||!Number.isFinite(feature.max)||!Number.isFinite(feature.weight)||Math.abs(feature.weight)>100)throw new Cortex40Error("INVALID_CONFIG",`${label} is invalid or sensitive`);return Object.freeze({...feature});}
function predictiveModel(model:PredictiveLeadModel):PredictiveLeadModel{if(!ID.test(model.modelId)||!SHA256.test(model.modelDigest)||!Number.isFinite(model.intercept)||!Array.isArray(model.features)||model.features.length<1||model.features.length>64)throw new Cortex40Error("INVALID_CONFIG","lead model is invalid");const features=model.features.map((f,i)=>modelFeature(f,`lead feature ${i}`));if(new Set(features.map(f=>`${f.source}:${f.name}`)).size!==features.length)throw new Cortex40Error("INVALID_CONFIG","lead model features are duplicated");return Object.freeze({...model,features:Object.freeze(features)});}
function clvModel(model:PredictiveClvModel):PredictiveClvModel{if(!ID.test(model.modelId)||!SHA256.test(model.modelDigest)||!/^[A-Z]{3}$/u.test(model.currency)||!Number.isFinite(model.intercept)||!Number.isFinite(model.minValue)||!Number.isFinite(model.maxValue)||model.minValue<0||model.maxValue<model.minValue||!Array.isArray(model.features)||model.features.length<1||model.features.length>64)throw new Cortex40Error("INVALID_CONFIG","CLV model is invalid");const features=model.features.map((f,i)=>modelFeature(f,`CLV feature ${i}`));if(new Set(features.map(f=>`${f.source}:${f.name}`)).size!==features.length)throw new Cortex40Error("INVALID_CONFIG","CLV model features are duplicated");return Object.freeze({...model,features:Object.freeze(features)});}
function secret(value:string):string{if(typeof value!=="string"||value.length<32||value.length>4096||/[\r\n\0]/u.test(value))throw new Cortex40Error("INVALID_CONFIG","contact hash secret is invalid");return value;}
function contactHash(value:string,hmacSecret:string):`sha256:${string}`{if(typeof value!=="string"||value.trim().length<3||value.length>1024||/[\r\n\0]/u.test(value))throw new Cortex40Error("INVALID_INPUT","contact value is malformed");return `sha256:${createHmac("sha256",secret(hmacSecret)).update(value.trim().toLocaleLowerCase("en-US"),"utf8").digest("hex")}`;}
function parseNumeric(value:string|number|boolean|undefined,label:string):number{if(typeof value==="boolean")return value?1:0;const parsed=typeof value==="number"?value:Number(value);if(!Number.isFinite(parsed))throw new Cortex40Error("INVALID_INPUT",`${label} is not numeric`);return parsed;}
function featureValue(feature:ModelFeature,submission:FormSubmission,enrichment:Readonly<Record<string,string|number|boolean>>):number{const raw=feature.source==="FORM"?submission.fields[feature.name]:enrichment[feature.name];const value=parseNumeric(raw,`${feature.source}.${feature.name}`);const clipped=Math.min(feature.max,Math.max(feature.min,value));return (clipped-feature.min)/(feature.max-feature.min);}
function leadScore(model:PredictiveLeadModel,submission:FormSubmission,enrichment:Readonly<Record<string,string|number|boolean>>):number{const z=model.features.reduce((sum,f)=>sum+featureValue(f,submission,enrichment)*f.weight,model.intercept);const p=1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));return Math.round(p*1e6)/1e6;}
function predictedClv(model:PredictiveClvModel,submission:FormSubmission,enrichment:Readonly<Record<string,string|number|boolean>>):number{const raw=model.features.reduce((sum,f)=>sum+featureValue(f,submission,enrichment)*f.weight,model.intercept);return Math.round(Math.min(model.maxValue,Math.max(model.minValue,raw))*100)/100;}

export function createAutonomousSalesPolicy(input:AutonomousSalesPolicy):AutonomousSalesPolicy{if(input.version!==1||!Array.isArray(input.forms)||input.forms.length<1||input.forms.length>256)throw new Cortex40Error("INVALID_CONFIG","sales automation policy is invalid");const seen=new Set<string>();const forms=input.forms.map(form=>{if(!ID.test(form.formId)||seen.has(form.formId))throw new Cortex40Error("INVALID_CONFIG","form policy is malformed or duplicated");seen.add(form.formId);if(form.companyDomainField!==null&&(!ID.test(form.companyDomainField)||SENSITIVE_FEATURE_NAMES.has(form.companyDomainField)))throw new Cortex40Error("INVALID_CONFIG","company domain field is invalid");if(!Array.isArray(form.allowedEnrichmentProviderIds)||form.allowedEnrichmentProviderIds.some(v=>!ID.test(v))||new Set(form.allowedEnrichmentProviderIds).size!==form.allowedEnrichmentProviderIds.length)throw new Cortex40Error("INVALID_CONFIG","enrichment provider allowlist is invalid");if(form.enrichmentEnabled&&form.allowedEnrichmentProviderIds.length<1)throw new Cortex40Error("INVALID_CONFIG","enabled enrichment requires provider allowlist");const routes=form.routes.map(route=>{if(!(route.channel==="WHATSAPP"||route.channel==="SMS")||!ID.test(route.contactField)||!ID.test(route.capabilityId))throw new Cortex40Error("INVALID_CONFIG","contact route is invalid");return Object.freeze({...route});});if(routes.length>2||new Set(routes.map(r=>r.channel)).size!==routes.length)throw new Cortex40Error("INVALID_CONFIG","contact routes are duplicated or excessive");if(typeof form.llmBusinessContext!=="string"||form.llmBusinessContext.length<1||form.llmBusinessContext.length>8000)throw new Cortex40Error("INVALID_CONFIG","LLM business context is invalid");return Object.freeze({...form,allowedEnrichmentProviderIds:Object.freeze([...form.allowedEnrichmentProviderIds]),leadModel:predictiveModel(form.leadModel),clvModel:clvModel(form.clvModel),minLeadScoreForAutonomousFollowUp:finite(form.minLeadScoreForAutonomousFollowUp,"minLeadScoreForAutonomousFollowUp",0,1),routes:Object.freeze(routes)});});return Object.freeze({version:1,forms:Object.freeze(forms)});}

export class SqliteSalesAutomationAudit {
 private readonly db:DatabaseSync;
 constructor(databasePath:string){if(!databasePath)throw new Cortex40Error("INVALID_CONFIG","audit databasePath is required");this.db=new DatabaseSync(databasePath);this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");this.db.exec(`CREATE TABLE IF NOT EXISTS cortex40_sales_audit(event_id TEXT PRIMARY KEY,submission_hash TEXT NOT NULL,form_id TEXT NOT NULL,lead_model_digest TEXT NOT NULL,clv_model_digest TEXT NOT NULL,lead_score REAL NOT NULL,predicted_clv REAL NOT NULL,clv_currency TEXT NOT NULL,enrichment_provider_id TEXT,enrichment_evidence_id TEXT,assistant_model_digest TEXT,requested_action TEXT,channel TEXT,consent_decision_id TEXT,capability_policy_digest TEXT,status TEXT NOT NULL,remote_receipt_id TEXT NOT NULL,created_at TEXT NOT NULL);`);}
 close():void{this.db.close();}
 get(eventId:string):SalesAutomationAuditRecord|undefined{const row=this.db.prepare("SELECT * FROM cortex40_sales_audit WHERE event_id=?").get(eventId) as Record<string,unknown>|undefined;if(!row)return undefined;return Object.freeze({eventId:String(row.event_id),submissionHash:String(row.submission_hash) as `sha256:${string}`,formId:String(row.form_id),leadModelDigest:String(row.lead_model_digest) as `sha256:${string}`,clvModelDigest:String(row.clv_model_digest) as `sha256:${string}`,leadScore:Number(row.lead_score),predictedClv:Number(row.predicted_clv),clvCurrency:String(row.clv_currency),enrichmentProviderId:row.enrichment_provider_id===null?null:String(row.enrichment_provider_id),enrichmentEvidenceId:row.enrichment_evidence_id===null?null:String(row.enrichment_evidence_id),assistantModelDigest:row.assistant_model_digest===null?null:String(row.assistant_model_digest) as `sha256:${string}`,requestedAction:row.requested_action===null?null:String(row.requested_action) as SalesRequestedAction,channel:row.channel===null?null:String(row.channel) as SalesChannel,consentDecisionId:row.consent_decision_id===null?null:String(row.consent_decision_id),capabilityPolicyDigest:row.capability_policy_digest===null?null:String(row.capability_policy_digest) as `sha256:${string}`,status:String(row.status) as SalesAutomationStatus,remoteReceiptId:String(row.remote_receipt_id),createdAt:String(row.created_at)});}
 commit(record:SalesAutomationAuditRecord):SalesAutomationAuditRecord{const existing=this.get(record.eventId);if(existing){if(JSON.stringify(existing)!==JSON.stringify(record))throw new Cortex40Error("CONFLICT","sales audit eventId is already bound to different content");return existing;}this.db.prepare("INSERT INTO cortex40_sales_audit VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(record.eventId,record.submissionHash,record.formId,record.leadModelDigest,record.clvModelDigest,record.leadScore,record.predictedClv,record.clvCurrency,record.enrichmentProviderId,record.enrichmentEvidenceId,record.assistantModelDigest,record.requestedAction,record.channel,record.consentDecisionId,record.capabilityPolicyDigest,record.status,record.remoteReceiptId,record.createdAt);return record;}
}

export class AutonomousSalesLeadDestination implements LeadDestination {
 private readonly policy:AutonomousSalesPolicy;private readonly now:()=>number;
 constructor(policy:AutonomousSalesPolicy,private readonly audit:SqliteSalesAutomationAudit,private readonly deps:AutonomousSalesDependencies){this.policy=createAutonomousSalesPolicy(policy);this.now=deps.now??Date.now;secret(deps.contactHashSecret);}
 async deliver(submission:FormSubmission,idempotencyKey:string):Promise<{receiptId:string}>{if(!ID.test(idempotencyKey))throw new Cortex40Error("INVALID_INPUT","idempotencyKey is malformed");const mode=safeMode(this.deps.readMode);if(mode==="KILLED")throw new Cortex40Error("MODE_BLOCKED","sales automation is killed");const primary=await this.deps.primaryDestination.deliver(submission,idempotencyKey);const eventId=`sales-${createHash("sha256").update(idempotencyKey,"utf8").digest("hex").slice(0,32)}`;const existing=this.audit.get(eventId);if(existing)return {receiptId:existing.remoteReceiptId};const formPolicy=this.policy.forms.find(f=>f.formId===submission.formId);if(!formPolicy){const record=this.record(eventId,submission,null,null,null,null,null,null,"NO_AUTOMATION",primary.receiptId,null,null);this.audit.commit(record);return {receiptId:primary.receiptId};}
  let enrichmentResult:B2bEnrichmentResult|null=null;let enrichment:Readonly<Record<string,string|number|boolean>>=Object.freeze({});
  if(formPolicy.enrichmentEnabled&&this.deps.enrichment&&formPolicy.companyDomainField){if(!formPolicy.allowedEnrichmentProviderIds.includes(this.deps.enrichment.providerId))throw new Cortex40Error("CAPABILITY_BLOCKED","configured enrichment provider is not allowlisted");const domain=submission.fields[formPolicy.companyDomainField]?.trim().toLowerCase();if(domain){if(!DOMAIN.test(domain))throw new Cortex40Error("INVALID_INPUT","company domain is malformed");enrichmentResult=await this.deps.enrichment.enrich(domain,eventId);if(enrichmentResult.providerId!==this.deps.enrichment.providerId||enrichmentResult.domain!==domain||!ID.test(enrichmentResult.evidenceId))throw new Cortex40Error("INTEGRITY_FAILURE","enrichment receipt identity mismatch");enrichment=enrichmentResult.attributes;}}
  const score=leadScore(formPolicy.leadModel,submission,enrichment),clv=predictedClv(formPolicy.clvModel,submission,enrichment);const assistant=await this.deps.assistant.draft({businessContext:formPolicy.llmBusinessContext,leadScore:score,predictedClv:clv,clvCurrency:formPolicy.clvModel.currency,enrichment});if(!ID.test(assistant.modelId)||!SHA256.test(assistant.modelDigest)||!ID.test(assistant.classification)||typeof assistant.summary!=="string"||assistant.summary.length>4000||typeof assistant.suggestedMessage!=="string"||assistant.suggestedMessage.length<1||assistant.suggestedMessage.length>4000||!(assistant.requestedAction==="FOLLOW_UP"||assistant.requestedAction==="CUSTOM_PRICE"||assistant.requestedAction==="DISCOUNT"||assistant.requestedAction==="CONTRACT"||assistant.requestedAction==="PAYMENT_TERMS"||assistant.requestedAction==="LEGAL_COMMITMENT"||assistant.requestedAction==="HUMAN_HANDOFF"))throw new Cortex40Error("INTEGRITY_FAILURE","local assistant output is invalid");
  const mustHandoff=SENSITIVE_ACTIONS.has(assistant.requestedAction)||assistant.requestedAction==="HUMAN_HANDOFF"||score<formPolicy.minLeadScoreForAutonomousFollowUp||formPolicy.routes.length===0;
  if(mode==="OBSERVE_ONLY"){const record=this.record(eventId,submission,formPolicy,enrichmentResult,assistant,null,null,null,"OBSERVED",primary.receiptId,score,clv);this.audit.commit(record);return {receiptId:primary.receiptId};}
  if(mustHandoff){if(safeMode(this.deps.readMode)!=="ACTIVE")throw new Cortex40Error("MODE_BLOCKED","sales automation disabled before human handoff");const handoff=await this.deps.humanHandoff.handoff({submissionId:submission.submissionId,formId:submission.formId,leadScore:score,predictedClv:clv,clvCurrency:formPolicy.clvModel.currency,requestedAction:assistant.requestedAction,summary:assistant.summary,idempotencyKey:`${eventId}-handoff`});const record=this.record(eventId,submission,formPolicy,enrichmentResult,assistant,null,null,null,"HANDOFF_REQUIRED",handoff.receiptId,score,clv);this.audit.commit(record);return {receiptId:handoff.receiptId};}
  const route=formPolicy.routes[0]!;const contact=submission.fields[route.contactField];if(!contact)throw new Cortex40Error("INVALID_INPUT","configured contact field is missing");const hash=contactHash(contact,this.deps.contactHashSecret);const consent=await this.deps.consentRegistry.resolve(hash,route.channel);if(consent.contactHash!==hash||consent.channel!==route.channel||!ID.test(consent.decisionId)||!Number.isFinite(Date.parse(consent.expiresAt)))throw new Cortex40Error("INTEGRITY_FAILURE","consent registry response identity is invalid");if(consent.status!=="GRANTED"||Date.parse(consent.expiresAt)<=this.now())throw new Cortex40Error("CONSENT_BLOCKED","contact channel consent is not currently granted");const capability=await this.deps.capabilityGate.read(route.capabilityId);if(capability.capabilityId!==route.capabilityId||!SHA256.test(capability.policyDigest)||!Number.isSafeInteger(capability.revision)||capability.revision<0)throw new Cortex40Error("INTEGRITY_FAILURE","capability gate response is invalid");if(capability.mode!=="ACTIVE")throw new Cortex40Error("CAPABILITY_BLOCKED","contact capability is not ACTIVE");
  // Last boundary: recheck consent, capability and kill switch immediately before external messaging.
  const finalConsent=await this.deps.consentRegistry.resolve(hash,route.channel);const finalCapability=await this.deps.capabilityGate.read(route.capabilityId);if(finalConsent.decisionId!==consent.decisionId||finalConsent.status!=="GRANTED"||Date.parse(finalConsent.expiresAt)<=this.now())throw new Cortex40Error("CONSENT_BLOCKED","consent changed before messaging boundary");if(finalCapability.mode!=="ACTIVE"||finalCapability.policyDigest!==capability.policyDigest||finalCapability.revision!==capability.revision)throw new Cortex40Error("CAPABILITY_BLOCKED","capability changed before messaging boundary");if(safeMode(this.deps.readMode)!=="ACTIVE")throw new Cortex40Error("MODE_BLOCKED","sales automation killed before messaging boundary");const sent=await this.deps.channelDispatcher.send({channel:route.channel,contact,message:assistant.suggestedMessage,idempotencyKey:`${eventId}-${route.channel.toLowerCase()}`});const record=this.record(eventId,submission,formPolicy,enrichmentResult,assistant,route.channel,consent.decisionId,capability.policyDigest,"AUTONOMOUS_SENT",sent.receiptId,score,clv);this.audit.commit(record);return {receiptId:sent.receiptId};}
 private record(eventId:string,submission:FormSubmission,formPolicy:FormSalesPolicy|null,enrichment:B2bEnrichmentResult|null,assistant:LocalSalesAssistantResult|null,channel:SalesChannel|null,consentDecisionId:string|null,capabilityPolicyDigest:`sha256:${string}`|null,status:SalesAutomationStatus,receipt:string,score:number|null,clv:number|null):SalesAutomationAuditRecord{const leadDigest=formPolicy?.leadModel.modelDigest??(`sha256:${"0".repeat(64)}` as const),clvDigest=formPolicy?.clvModel.modelDigest??(`sha256:${"0".repeat(64)}` as const);return Object.freeze({eventId,submissionHash:`sha256:${createHash("sha256").update(submission.submissionId,"utf8").digest("hex")}`,formId:submission.formId,leadModelDigest:leadDigest,clvModelDigest:clvDigest,leadScore:score??0,predictedClv:clv??0,clvCurrency:formPolicy?.clvModel.currency??"XXX",enrichmentProviderId:enrichment?.providerId??null,enrichmentEvidenceId:enrichment?.evidenceId??null,assistantModelDigest:assistant?.modelDigest??null,requestedAction:assistant?.requestedAction??null,channel,consentDecisionId,capabilityPolicyDigest,status,remoteReceiptId:receipt,createdAt:new Date(this.now()).toISOString()});}
}
