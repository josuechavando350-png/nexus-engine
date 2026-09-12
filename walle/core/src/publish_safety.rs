use crate::is_valid_sha256;

pub const PAGE_CANDIDATE_SCHEMA_VERSION: u32 = 1;
pub const PPM: u32 = 1_000_000;
pub const MAX_FACTS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageType {
    Service,
    Location,
    Guide,
    CaseStudy,
    Faq,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalIntent<'a> {
    SelfCanonical,
    CanonicalTo(&'a str),
    NoIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchIntent {
    NoIndex,
    IndexCandidate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdsIntent {
    NotApplicable,
    DestinationCandidate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceFreshness {
    Current,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FactEvidence<'a> {
    pub fact_id: &'a str,
    pub source_id: &'a str,
    pub source_sha256: &'a str,
    pub claim_sha256: &'a str,
    pub freshness: EvidenceFreshness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCandidateContract<'a> {
    pub candidate_id: &'a str,
    pub site_id: &'a str,
    pub page_type: PageType,
    pub intended_user_need_id: &'a str,
    pub target_path: &'a str,
    pub source_revision: &'a str,
    pub template_revision: &'a str,
    pub fact_bundle_sha256: &'a str,
    pub rendered_html_sha256: &'a str,
    pub normalized_content_sha256: &'a str,
    pub generation_receipt_sha256: &'a str,
    pub canonical_intent: CanonicalIntent<'a>,
    pub search_intent: SearchIntent,
    pub ads_intent: AdsIntent,
    pub facts: &'a [FactEvidence<'a>],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateContractError {
    InvalidCandidateId,
    InvalidSiteId,
    InvalidUserNeedId,
    UnsafeTargetPath,
    InvalidSourceRevision,
    InvalidTemplateRevision,
    InvalidFactBundleSha256,
    InvalidRenderedHtmlSha256,
    InvalidNormalizedContentSha256,
    InvalidGenerationReceiptSha256,
    UnsafeCanonicalPath,
    IndexCandidateWithoutFacts,
    TooManyFacts,
    InvalidFactId,
    InvalidSourceId,
    InvalidFactSourceSha256,
    InvalidClaimSha256,
    FactOrderOrUniquenessViolation,
}

impl PageCandidateContract<'_> {
    pub fn validate(self) -> Result<(), CandidateContractError> {
        if !safe_token(self.candidate_id) {
            return Err(CandidateContractError::InvalidCandidateId);
        }
        if !safe_token(self.site_id) {
            return Err(CandidateContractError::InvalidSiteId);
        }
        if !safe_token(self.intended_user_need_id) {
            return Err(CandidateContractError::InvalidUserNeedId);
        }
        if !safe_path(self.target_path) {
            return Err(CandidateContractError::UnsafeTargetPath);
        }
        if !is_valid_sha256(self.source_revision) {
            return Err(CandidateContractError::InvalidSourceRevision);
        }
        if !is_valid_sha256(self.template_revision) {
            return Err(CandidateContractError::InvalidTemplateRevision);
        }
        if !is_valid_sha256(self.fact_bundle_sha256) {
            return Err(CandidateContractError::InvalidFactBundleSha256);
        }
        if !is_valid_sha256(self.rendered_html_sha256) {
            return Err(CandidateContractError::InvalidRenderedHtmlSha256);
        }
        if !is_valid_sha256(self.normalized_content_sha256) {
            return Err(CandidateContractError::InvalidNormalizedContentSha256);
        }
        if !is_valid_sha256(self.generation_receipt_sha256) {
            return Err(CandidateContractError::InvalidGenerationReceiptSha256);
        }
        if let CanonicalIntent::CanonicalTo(path) = self.canonical_intent {
            if !safe_path(path) {
                return Err(CandidateContractError::UnsafeCanonicalPath);
            }
        }
        if self.facts.len() > MAX_FACTS {
            return Err(CandidateContractError::TooManyFacts);
        }
        if self.search_intent == SearchIntent::IndexCandidate && self.facts.is_empty() {
            return Err(CandidateContractError::IndexCandidateWithoutFacts);
        }

        let mut previous = None;
        for fact in self.facts {
            if !safe_token(fact.fact_id) {
                return Err(CandidateContractError::InvalidFactId);
            }
            if !safe_token(fact.source_id) {
                return Err(CandidateContractError::InvalidSourceId);
            }
            if !is_valid_sha256(fact.source_sha256) {
                return Err(CandidateContractError::InvalidFactSourceSha256);
            }
            if !is_valid_sha256(fact.claim_sha256) {
                return Err(CandidateContractError::InvalidClaimSha256);
            }
            if previous.is_some_and(|value| value >= fact.fact_id) {
                return Err(CandidateContractError::FactOrderOrUniquenessViolation);
            }
            previous = Some(fact.fact_id);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorwayRisk {
    Low,
    Medium,
    High,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateSignal {
    Pass,
    Review,
    Blocked,
    InsufficientData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdsDestinationSignal {
    NotApplicable,
    Pass,
    Review,
    Blocked,
    InsufficientData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageQualitySignals {
    pub provenance_complete: bool,
    pub contradiction_free: bool,
    pub exact_duplicate_found: bool,
    pub near_duplicate_max_ppm: Option<u32>,
    pub information_gain_ppm: Option<u32>,
    pub doorway_risk: DoorwayRisk,
    pub search_policy: GateSignal,
    pub technical_indexability: GateSignal,
    pub ads_destination: AdsDestinationSignal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublicationPolicy<'a> {
    pub policy_id: &'a str,
    pub policy_sha256: &'a str,
    pub max_near_duplicate_ppm: u32,
    pub min_information_gain_ppm: u32,
    pub require_post_deploy_match_for_index: bool,
}

impl PublicationPolicy<'_> {
    pub fn validate(self) -> bool {
        safe_token(self.policy_id)
            && is_valid_sha256(self.policy_sha256)
            && self.max_near_duplicate_ppm <= PPM
            && self.min_information_gain_ppm <= PPM
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeployedArtifactObservation<'a> {
    pub rendered_html_sha256: &'a str,
    pub normalized_content_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactStatus {
    NotObserved,
    Match,
    Drift,
    Malformed,
}

impl ArtifactStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::NotObserved => "NOT_OBSERVED",
            Self::Match => "MATCH",
            Self::Drift => "DRIFT",
            Self::Malformed => "MALFORMED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicationDisposition {
    Hold,
    ReviewRequired,
    PublishNoIndex,
    Publish,
}

impl PublicationDisposition {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Hold => "HOLD",
            Self::ReviewRequired => "REVIEW_REQUIRED",
            Self::PublishNoIndex => "PUBLISH_NOINDEX",
            Self::Publish => "PUBLISH",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchIndexDisposition {
    Blocked,
    NoIndex,
    AwaitingArtifactVerification,
    Eligible,
}

impl SearchIndexDisposition {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "BLOCKED",
            Self::NoIndex => "NOINDEX",
            Self::AwaitingArtifactVerification => "AWAITING_ARTIFACT_VERIFICATION",
            Self::Eligible => "ELIGIBLE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdsDisposition {
    NotApplicable,
    Blocked,
    ReviewRequired,
    Eligible,
}

impl AdsDisposition {
    const fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "NOT_APPLICABLE",
            Self::Blocked => "BLOCKED",
            Self::ReviewRequired => "REVIEW_REQUIRED",
            Self::Eligible => "ELIGIBLE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionReason {
    InvalidCandidateContract,
    InvalidPublicationPolicy,
    StaleEvidence,
    EvidenceFreshnessUnknown,
    MissingProvenance,
    ConflictingEvidence,
    SearchPolicyBlocked,
    SearchPolicyInsufficient,
    ExactDuplicate,
    QualityEvidenceMissing,
    DoorwayRiskHigh,
    DoorwayRiskUnknown,
    NearDuplicateThresholdExceeded,
    InformationGainBelowPolicy,
    ReviewRequired,
    TechnicalIndexabilityBlocked,
    ExplicitNoIndexIntent,
    ArtifactMalformed,
    ArtifactDrift,
    AwaitingArtifactVerification,
    IndexEligible,
}

impl DecisionReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidCandidateContract => "INVALID_CANDIDATE_CONTRACT",
            Self::InvalidPublicationPolicy => "INVALID_PUBLICATION_POLICY",
            Self::StaleEvidence => "STALE_EVIDENCE",
            Self::EvidenceFreshnessUnknown => "EVIDENCE_FRESHNESS_UNKNOWN",
            Self::MissingProvenance => "MISSING_PROVENANCE",
            Self::ConflictingEvidence => "CONFLICTING_EVIDENCE",
            Self::SearchPolicyBlocked => "SEARCH_POLICY_BLOCKED",
            Self::SearchPolicyInsufficient => "SEARCH_POLICY_INSUFFICIENT",
            Self::ExactDuplicate => "EXACT_DUPLICATE",
            Self::QualityEvidenceMissing => "QUALITY_EVIDENCE_MISSING",
            Self::DoorwayRiskHigh => "DOORWAY_RISK_HIGH",
            Self::DoorwayRiskUnknown => "DOORWAY_RISK_UNKNOWN",
            Self::NearDuplicateThresholdExceeded => "NEAR_DUPLICATE_THRESHOLD_EXCEEDED",
            Self::InformationGainBelowPolicy => "INFORMATION_GAIN_BELOW_POLICY",
            Self::ReviewRequired => "REVIEW_REQUIRED",
            Self::TechnicalIndexabilityBlocked => "TECHNICAL_INDEXABILITY_BLOCKED",
            Self::ExplicitNoIndexIntent => "EXPLICIT_NOINDEX_INTENT",
            Self::ArtifactMalformed => "ARTIFACT_MALFORMED",
            Self::ArtifactDrift => "ARTIFACT_DRIFT",
            Self::AwaitingArtifactVerification => "AWAITING_ARTIFACT_VERIFICATION",
            Self::IndexEligible => "INDEX_ELIGIBLE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageSafetyDecision {
    pub publication: PublicationDisposition,
    pub search_index: SearchIndexDisposition,
    pub ads: AdsDisposition,
    pub sitemap_eligible: bool,
    pub artifact_status: ArtifactStatus,
    pub reason: DecisionReason,
}

impl PageSafetyDecision {
    pub fn canonical_json(self) -> String {
        format!(
            concat!(
                "{\"ads\":\"{}\",",
                "\"artifact_status\":\"{}\",",
                "\"publication\":\"{}\",",
                "\"reason\":\"{}\",",
                "\"schema_version\":{},",
                "\"search_index\":\"{}\",",
                "\"sitemap_eligible\":{}}}"
            ),
            self.ads.as_str(),
            self.artifact_status.as_str(),
            self.publication.as_str(),
            self.reason.as_str(),
            PAGE_CANDIDATE_SCHEMA_VERSION,
            self.search_index.as_str(),
            self.sitemap_eligible,
        )
    }
}

pub fn evaluate_page_safety(
    candidate: PageCandidateContract<'_>,
    quality: PageQualitySignals,
    policy: PublicationPolicy<'_>,
    deployed: Option<DeployedArtifactObservation<'_>>,
) -> PageSafetyDecision {
    if candidate.validate().is_err() {
        return blocked(
            DecisionReason::InvalidCandidateContract,
            AdsDisposition::Blocked,
        );
    }
    if !policy.validate() {
        return blocked(
            DecisionReason::InvalidPublicationPolicy,
            AdsDisposition::Blocked,
        );
    }

    let ads = ads_disposition(candidate.ads_intent, quality.ads_destination);

    if candidate
        .facts
        .iter()
        .any(|fact| fact.freshness == EvidenceFreshness::Stale)
    {
        return blocked(DecisionReason::StaleEvidence, ads);
    }
    if candidate
        .facts
        .iter()
        .any(|fact| fact.freshness == EvidenceFreshness::Unknown)
    {
        return blocked(DecisionReason::EvidenceFreshnessUnknown, ads);
    }
    if !quality.provenance_complete {
        return blocked(DecisionReason::MissingProvenance, ads);
    }
    if !quality.contradiction_free {
        return blocked(DecisionReason::ConflictingEvidence, ads);
    }
    if quality.search_policy == GateSignal::Blocked {
        return blocked(DecisionReason::SearchPolicyBlocked, ads);
    }
    if quality.search_policy == GateSignal::InsufficientData {
        return blocked(DecisionReason::SearchPolicyInsufficient, ads);
    }
    if quality.exact_duplicate_found {
        return noindex(DecisionReason::ExactDuplicate, ads);
    }

    let near_duplicate = match quality.near_duplicate_max_ppm {
        Some(value) if value <= PPM => value,
        _ => return blocked(DecisionReason::QualityEvidenceMissing, ads),
    };
    let information_gain = match quality.information_gain_ppm {
        Some(value) if value <= PPM => value,
        _ => return blocked(DecisionReason::QualityEvidenceMissing, ads),
    };

    match quality.doorway_risk {
        DoorwayRisk::High => return noindex(DecisionReason::DoorwayRiskHigh, ads),
        DoorwayRisk::Unknown => return blocked(DecisionReason::DoorwayRiskUnknown, ads),
        DoorwayRisk::Low | DoorwayRisk::Medium => {}
    }

    if near_duplicate > policy.max_near_duplicate_ppm {
        return noindex(DecisionReason::NearDuplicateThresholdExceeded, ads);
    }
    if information_gain < policy.min_information_gain_ppm {
        return noindex(DecisionReason::InformationGainBelowPolicy, ads);
    }

    if quality.search_policy == GateSignal::Review
        || quality.technical_indexability == GateSignal::Review
        || quality.technical_indexability == GateSignal::InsufficientData
        || quality.doorway_risk == DoorwayRisk::Medium
    {
        return review(ads);
    }
    if quality.technical_indexability == GateSignal::Blocked {
        return noindex(DecisionReason::TechnicalIndexabilityBlocked, ads);
    }
    if candidate.search_intent == SearchIntent::NoIndex
        || matches!(candidate.canonical_intent, CanonicalIntent::NoIndex)
    {
        return PageSafetyDecision {
            publication: PublicationDisposition::PublishNoIndex,
            search_index: SearchIndexDisposition::NoIndex,
            ads,
            sitemap_eligible: false,
            artifact_status: observe_artifact(candidate, deployed),
            reason: DecisionReason::ExplicitNoIndexIntent,
        };
    }

    let artifact_status = observe_artifact(candidate, deployed);
    match artifact_status {
        ArtifactStatus::Malformed => blocked_with_artifact(
            DecisionReason::ArtifactMalformed,
            ads,
            ArtifactStatus::Malformed,
        ),
        ArtifactStatus::Drift => {
            blocked_with_artifact(DecisionReason::ArtifactDrift, ads, ArtifactStatus::Drift)
        }
        ArtifactStatus::NotObserved if policy.require_post_deploy_match_for_index => {
            PageSafetyDecision {
                publication: PublicationDisposition::Publish,
                search_index: SearchIndexDisposition::AwaitingArtifactVerification,
                ads,
                sitemap_eligible: false,
                artifact_status,
                reason: DecisionReason::AwaitingArtifactVerification,
            }
        }
        ArtifactStatus::NotObserved | ArtifactStatus::Match => PageSafetyDecision {
            publication: PublicationDisposition::Publish,
            search_index: SearchIndexDisposition::Eligible,
            ads,
            sitemap_eligible: true,
            artifact_status,
            reason: DecisionReason::IndexEligible,
        },
    }
}

fn observe_artifact(
    candidate: PageCandidateContract<'_>,
    deployed: Option<DeployedArtifactObservation<'_>>,
) -> ArtifactStatus {
    let Some(observation) = deployed else {
        return ArtifactStatus::NotObserved;
    };
    if !is_valid_sha256(observation.rendered_html_sha256)
        || !is_valid_sha256(observation.normalized_content_sha256)
    {
        return ArtifactStatus::Malformed;
    }
    if observation.rendered_html_sha256 == candidate.rendered_html_sha256
        && observation.normalized_content_sha256 == candidate.normalized_content_sha256
    {
        ArtifactStatus::Match
    } else {
        ArtifactStatus::Drift
    }
}

const fn ads_disposition(intent: AdsIntent, signal: AdsDestinationSignal) -> AdsDisposition {
    match intent {
        AdsIntent::NotApplicable => AdsDisposition::NotApplicable,
        AdsIntent::DestinationCandidate => match signal {
            AdsDestinationSignal::Pass => AdsDisposition::Eligible,
            AdsDestinationSignal::Review => AdsDisposition::ReviewRequired,
            AdsDestinationSignal::NotApplicable
            | AdsDestinationSignal::Blocked
            | AdsDestinationSignal::InsufficientData => AdsDisposition::Blocked,
        },
    }
}

const fn blocked(reason: DecisionReason, ads: AdsDisposition) -> PageSafetyDecision {
    blocked_with_artifact(reason, ads, ArtifactStatus::NotObserved)
}

const fn blocked_with_artifact(
    reason: DecisionReason,
    ads: AdsDisposition,
    artifact_status: ArtifactStatus,
) -> PageSafetyDecision {
    PageSafetyDecision {
        publication: PublicationDisposition::Hold,
        search_index: SearchIndexDisposition::Blocked,
        ads,
        sitemap_eligible: false,
        artifact_status,
        reason,
    }
}

const fn noindex(reason: DecisionReason, ads: AdsDisposition) -> PageSafetyDecision {
    PageSafetyDecision {
        publication: PublicationDisposition::PublishNoIndex,
        search_index: SearchIndexDisposition::NoIndex,
        ads,
        sitemap_eligible: false,
        artifact_status: ArtifactStatus::NotObserved,
        reason,
    }
}

const fn review(ads: AdsDisposition) -> PageSafetyDecision {
    PageSafetyDecision {
        publication: PublicationDisposition::ReviewRequired,
        search_index: SearchIndexDisposition::NoIndex,
        ads,
        sitemap_eligible: false,
        artifact_status: ArtifactStatus::NotObserved,
        reason: DecisionReason::ReviewRequired,
    }
}

fn safe_token(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let bytes = value.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes.iter().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(*byte, b'-' | b'_' | b'.')
    })
}

fn safe_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 512 || !value.starts_with('/') {
        return false;
    }
    if value.contains('?') || value.contains('#') || value.contains("//") || value.contains('\\') {
        return false;
    }
    if value
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return false;
    }
    value.bytes().all(|byte| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'/' | b'-' | b'_' | b'.')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SHA_B: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const SHA_C: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const SHA_D: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

    const FACTS: [FactEvidence<'static>; 2] = [
        FactEvidence {
            fact_id: "fact-a",
            source_id: "official-source-a",
            source_sha256: SHA_A,
            claim_sha256: SHA_B,
            freshness: EvidenceFreshness::Current,
        },
        FactEvidence {
            fact_id: "fact-b",
            source_id: "first-party-source-b",
            source_sha256: SHA_C,
            claim_sha256: SHA_D,
            freshness: EvidenceFreshness::Current,
        },
    ];

    fn candidate() -> PageCandidateContract<'static> {
        PageCandidateContract {
            candidate_id: "page-candidate-001",
            site_id: "cano-penal",
            page_type: PageType::Service,
            intended_user_need_id: "defensa-delito-fiscal",
            target_path: "/defensa-delito-fiscal",
            source_revision: SHA_A,
            template_revision: SHA_B,
            fact_bundle_sha256: SHA_C,
            rendered_html_sha256: SHA_D,
            normalized_content_sha256: SHA_A,
            generation_receipt_sha256: SHA_B,
            canonical_intent: CanonicalIntent::SelfCanonical,
            search_intent: SearchIntent::IndexCandidate,
            ads_intent: AdsIntent::DestinationCandidate,
            facts: &FACTS,
        }
    }

    fn quality() -> PageQualitySignals {
        PageQualitySignals {
            provenance_complete: true,
            contradiction_free: true,
            exact_duplicate_found: false,
            near_duplicate_max_ppm: Some(200_000),
            information_gain_ppm: Some(800_000),
            doorway_risk: DoorwayRisk::Low,
            search_policy: GateSignal::Pass,
            technical_indexability: GateSignal::Pass,
            ads_destination: AdsDestinationSignal::Pass,
        }
    }

    fn policy() -> PublicationPolicy<'static> {
        PublicationPolicy {
            policy_id: "search-safety-v1",
            policy_sha256: SHA_C,
            max_near_duplicate_ppm: 450_000,
            min_information_gain_ppm: 600_000,
            require_post_deploy_match_for_index: true,
        }
    }

    #[test]
    fn valid_candidate_contract_passes() {
        assert_eq!(candidate().validate(), Ok(()));
    }

    #[test]
    fn exact_duplicate_is_not_index_eligible() {
        let quality = PageQualitySignals {
            exact_duplicate_found: true,
            ..quality()
        };
        let decision = evaluate_page_safety(candidate(), quality, policy(), None);
        assert_eq!(decision.search_index, SearchIndexDisposition::NoIndex);
        assert!(!decision.sitemap_eligible);
    }

    #[test]
    fn high_doorway_risk_is_not_index_eligible() {
        let quality = PageQualitySignals {
            doorway_risk: DoorwayRisk::High,
            ..quality()
        };
        let decision = evaluate_page_safety(candidate(), quality, policy(), None);
        assert_eq!(decision.reason, DecisionReason::DoorwayRiskHigh);
        assert_eq!(decision.search_index, SearchIndexDisposition::NoIndex);
    }

    #[test]
    fn indexability_waits_for_deployed_artifact_match() {
        let decision = evaluate_page_safety(candidate(), quality(), policy(), None);
        assert_eq!(decision.publication, PublicationDisposition::Publish);
        assert_eq!(
            decision.search_index,
            SearchIndexDisposition::AwaitingArtifactVerification
        );
        assert!(!decision.sitemap_eligible);
    }

    #[test]
    fn matching_deployed_artifact_can_become_index_eligible() {
        let observation = DeployedArtifactObservation {
            rendered_html_sha256: SHA_D,
            normalized_content_sha256: SHA_A,
        };
        let decision = evaluate_page_safety(candidate(), quality(), policy(), Some(observation));
        assert_eq!(decision.artifact_status, ArtifactStatus::Match);
        assert_eq!(decision.search_index, SearchIndexDisposition::Eligible);
        assert!(decision.sitemap_eligible);
    }

    #[test]
    fn deployed_artifact_drift_blocks_release() {
        let observation = DeployedArtifactObservation {
            rendered_html_sha256: SHA_C,
            normalized_content_sha256: SHA_A,
        };
        let decision = evaluate_page_safety(candidate(), quality(), policy(), Some(observation));
        assert_eq!(decision.artifact_status, ArtifactStatus::Drift);
        assert_eq!(decision.publication, PublicationDisposition::Hold);
        assert_eq!(decision.reason, DecisionReason::ArtifactDrift);
    }

    #[test]
    fn ads_and_search_verdicts_are_independent() {
        let quality = PageQualitySignals {
            ads_destination: AdsDestinationSignal::Blocked,
            ..quality()
        };
        let observation = DeployedArtifactObservation {
            rendered_html_sha256: SHA_D,
            normalized_content_sha256: SHA_A,
        };
        let decision = evaluate_page_safety(candidate(), quality, policy(), Some(observation));
        assert_eq!(decision.search_index, SearchIndexDisposition::Eligible);
        assert_eq!(decision.ads, AdsDisposition::Blocked);
    }

    #[test]
    fn internal_policy_thresholds_are_not_google_constants() {
        let strict = PublicationPolicy {
            min_information_gain_ppm: 900_000,
            ..policy()
        };
        let decision = evaluate_page_safety(candidate(), quality(), strict, None);
        assert_eq!(decision.search_index, SearchIndexDisposition::NoIndex);
    }

    #[test]
    fn decision_receipt_is_byte_stable() {
        let observation = DeployedArtifactObservation {
            rendered_html_sha256: SHA_D,
            normalized_content_sha256: SHA_A,
        };
        let decision = evaluate_page_safety(candidate(), quality(), policy(), Some(observation));
        assert_eq!(decision.canonical_json(), decision.canonical_json());
        assert!(decision
            .canonical_json()
            .contains("\"search_index\":\"ELIGIBLE\""));
    }
}
