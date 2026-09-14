use std::collections::{BTreeMap, BTreeSet};

use crate::is_valid_sha256;

pub const ATTRIBUTION_SCHEMA_VERSION: u32 = 1;
pub const PPM: u32 = 1_000_000;
pub const DOUBLE_TARGET_PPM: u32 = 2_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AcquisitionChannel {
    GoogleAds,
    OrganicSearch,
    GoogleMaps,
    Referral,
    Direct,
    Other,
    Unknown,
}

impl AcquisitionChannel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GoogleAds => "GOOGLE_ADS",
            Self::OrganicSearch => "ORGANIC_SEARCH",
            Self::GoogleMaps => "GOOGLE_MAPS",
            Self::Referral => "REFERRAL",
            Self::Direct => "DIRECT",
            Self::Other => "OTHER",
            Self::Unknown => "UNKNOWN",
        }
    }

    const fn is_attributed(self) -> bool {
        !matches!(self, Self::Unknown)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FunnelStage {
    Contact,
    QualifiedLead,
    Consultation,
    SignedClient,
}

impl FunnelStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Contact => "CONTACT",
            Self::QualifiedLead => "QUALIFIED_LEAD",
            Self::Consultation => "CONSULTATION",
            Self::SignedClient => "SIGNED_CLIENT",
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Contact => 1,
            Self::QualifiedLead => 2,
            Self::Consultation => 3,
            Self::SignedClient => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrowthEvent<'a> {
    pub event_id: &'a str,
    pub site_id: &'a str,
    pub journey_sha256: &'a str,
    pub occurred_at_unix_ms: u64,
    pub channel: AcquisitionChannel,
    pub stage: FunnelStage,
    pub landing_path: &'a str,
    pub ads_click_sha256: Option<&'a str>,
    pub search_query_sha256: Option<&'a str>,
    pub campaign_id: Option<&'a str>,
    pub revenue_minor: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrowthEventError {
    InvalidEventId,
    InvalidSiteId,
    InvalidJourneySha256,
    ZeroTimestamp,
    UnsafeLandingPath,
    InvalidAdsClickSha256,
    InvalidSearchQuerySha256,
    InvalidCampaignId,
    RevenueBeforeSignedClient,
}

impl GrowthEvent<'_> {
    pub fn validate(self) -> Result<(), GrowthEventError> {
        if !safe_token(self.event_id) {
            return Err(GrowthEventError::InvalidEventId);
        }
        if !safe_token(self.site_id) {
            return Err(GrowthEventError::InvalidSiteId);
        }
        if !is_valid_sha256(self.journey_sha256) {
            return Err(GrowthEventError::InvalidJourneySha256);
        }
        if self.occurred_at_unix_ms == 0 {
            return Err(GrowthEventError::ZeroTimestamp);
        }
        if !safe_path(self.landing_path) {
            return Err(GrowthEventError::UnsafeLandingPath);
        }
        if self
            .ads_click_sha256
            .is_some_and(|value| !is_valid_sha256(value))
        {
            return Err(GrowthEventError::InvalidAdsClickSha256);
        }
        if self
            .search_query_sha256
            .is_some_and(|value| !is_valid_sha256(value))
        {
            return Err(GrowthEventError::InvalidSearchQuerySha256);
        }
        if self.campaign_id.is_some_and(|value| !safe_token(value)) {
            return Err(GrowthEventError::InvalidCampaignId);
        }
        if self.revenue_minor.is_some() && self.stage != FunnelStage::SignedClient {
            return Err(GrowthEventError::RevenueBeforeSignedClient);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerValidationError {
    InvalidSiteId,
    InvalidEvent,
    MixedSiteIds,
    EventOrderViolation,
    DuplicateEventId,
    JourneyChannelChanged,
    JourneyLandingChanged,
    DuplicateJourneyStage,
    JourneyStageRegression,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrowthLedger<'a> {
    pub site_id: &'a str,
    pub events: &'a [GrowthEvent<'a>],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct JourneyState<'a> {
    channel: AcquisitionChannel,
    landing_path: &'a str,
    last_stage: FunnelStage,
}

impl GrowthLedger<'_> {
    pub fn validate(self) -> Result<(), LedgerValidationError> {
        if !safe_token(self.site_id) {
            return Err(LedgerValidationError::InvalidSiteId);
        }

        let mut previous_time = 0_u64;
        let mut previous_event_id = "";
        let mut seen_event_ids = BTreeSet::new();
        let mut journeys = BTreeMap::new();

        for event in self.events {
            event
                .validate()
                .map_err(|_| LedgerValidationError::InvalidEvent)?;
            if event.site_id != self.site_id {
                return Err(LedgerValidationError::MixedSiteIds);
            }
            if event.occurred_at_unix_ms < previous_time
                || (event.occurred_at_unix_ms == previous_time
                    && event.event_id <= previous_event_id)
            {
                return Err(LedgerValidationError::EventOrderViolation);
            }
            previous_time = event.occurred_at_unix_ms;
            previous_event_id = event.event_id;

            if !seen_event_ids.insert(event.event_id) {
                return Err(LedgerValidationError::DuplicateEventId);
            }

            match journeys.get_mut(event.journey_sha256) {
                None => {
                    journeys.insert(
                        event.journey_sha256,
                        JourneyState {
                            channel: event.channel,
                            landing_path: event.landing_path,
                            last_stage: event.stage,
                        },
                    );
                }
                Some(state) => {
                    if state.channel != event.channel {
                        return Err(LedgerValidationError::JourneyChannelChanged);
                    }
                    if state.landing_path != event.landing_path {
                        return Err(LedgerValidationError::JourneyLandingChanged);
                    }
                    if state.last_stage == event.stage {
                        return Err(LedgerValidationError::DuplicateJourneyStage);
                    }
                    if event.stage.rank() < state.last_stage.rank() {
                        return Err(LedgerValidationError::JourneyStageRegression);
                    }
                    state.last_stage = event.stage;
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelSummary {
    pub contacts: u32,
    pub qualified_leads: u32,
    pub consultations: u32,
    pub signed_clients: u32,
    pub revenue_minor: u64,
}

impl ChannelSummary {
    const fn zero() -> Self {
        Self {
            contacts: 0,
            qualified_leads: 0,
            consultations: 0,
            signed_clients: 0,
            revenue_minor: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrowthPeriodSummary {
    pub observation_complete: bool,
    pub unique_journeys: u32,
    pub contacts: u32,
    pub qualified_leads: u32,
    pub consultations: u32,
    pub signed_clients: u32,
    pub attributed_signed_clients: u32,
    pub attribution_completeness_ppm: u32,
    pub revenue_minor: u64,
    pub ads_spend_minor: u64,
    pub by_channel: BTreeMap<AcquisitionChannel, ChannelSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryError {
    InvalidLedger,
    CountOverflow,
    RevenueOverflow,
}

pub fn summarize_growth_period(
    ledger: GrowthLedger<'_>,
    ads_spend_minor: u64,
    observation_complete: bool,
) -> Result<GrowthPeriodSummary, SummaryError> {
    ledger.validate().map_err(|_| SummaryError::InvalidLedger)?;

    let mut max_stage = BTreeMap::new();
    let mut channels = BTreeMap::new();
    let mut revenue = BTreeMap::new();

    for event in ledger.events {
        max_stage.insert(event.journey_sha256, event.stage);
        channels.insert(event.journey_sha256, event.channel);
        if let Some(value) = event.revenue_minor {
            revenue.insert(event.journey_sha256, value);
        }
    }

    let unique_journeys =
        u32::try_from(max_stage.len()).map_err(|_| SummaryError::CountOverflow)?;
    let mut summary = GrowthPeriodSummary {
        observation_complete,
        unique_journeys,
        contacts: 0,
        qualified_leads: 0,
        consultations: 0,
        signed_clients: 0,
        attributed_signed_clients: 0,
        attribution_completeness_ppm: PPM,
        revenue_minor: 0,
        ads_spend_minor,
        by_channel: BTreeMap::new(),
    };

    for (journey, stage) in max_stage {
        let channel = *channels
            .get(journey)
            .expect("validated journey channel must exist");
        let channel_summary = summary
            .by_channel
            .entry(channel)
            .or_insert_with(ChannelSummary::zero);

        summary.contacts = checked_inc(summary.contacts)?;
        channel_summary.contacts = checked_inc(channel_summary.contacts)?;

        if stage.rank() >= FunnelStage::QualifiedLead.rank() {
            summary.qualified_leads = checked_inc(summary.qualified_leads)?;
            channel_summary.qualified_leads = checked_inc(channel_summary.qualified_leads)?;
        }
        if stage.rank() >= FunnelStage::Consultation.rank() {
            summary.consultations = checked_inc(summary.consultations)?;
            channel_summary.consultations = checked_inc(channel_summary.consultations)?;
        }
        if stage == FunnelStage::SignedClient {
            summary.signed_clients = checked_inc(summary.signed_clients)?;
            channel_summary.signed_clients = checked_inc(channel_summary.signed_clients)?;
            if channel.is_attributed() {
                summary.attributed_signed_clients = checked_inc(summary.attributed_signed_clients)?;
            }

            let journey_revenue = *revenue.get(journey).unwrap_or(&0);
            summary.revenue_minor = summary
                .revenue_minor
                .checked_add(journey_revenue)
                .ok_or(SummaryError::RevenueOverflow)?;
            channel_summary.revenue_minor = channel_summary
                .revenue_minor
                .checked_add(journey_revenue)
                .ok_or(SummaryError::RevenueOverflow)?;
        }
    }

    summary.attribution_completeness_ppm = if summary.signed_clients == 0 {
        PPM
    } else {
        ratio_ppm(summary.attributed_signed_clients, summary.signed_clients)
    };

    Ok(summary)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrowthTarget {
    pub baseline_signed_clients: u32,
    pub target_multiplier_ppm: u32,
    pub minimum_attribution_completeness_ppm: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrowthTargetError {
    ZeroBaseline,
    MultiplierBelowOne,
    InvalidAttributionThreshold,
    TargetOverflow,
}

impl GrowthTarget {
    pub fn validate(self) -> Result<(), GrowthTargetError> {
        if self.baseline_signed_clients == 0 {
            return Err(GrowthTargetError::ZeroBaseline);
        }
        if self.target_multiplier_ppm < PPM {
            return Err(GrowthTargetError::MultiplierBelowOne);
        }
        if self.minimum_attribution_completeness_ppm > PPM {
            return Err(GrowthTargetError::InvalidAttributionThreshold);
        }
        self.target_signed_clients().map(|_| ())
    }

    pub fn target_signed_clients(self) -> Result<u32, GrowthTargetError> {
        let numerator = u64::from(self.baseline_signed_clients)
            .checked_mul(u64::from(self.target_multiplier_ppm))
            .ok_or(GrowthTargetError::TargetOverflow)?;
        let rounded_up = numerator
            .checked_add(u64::from(PPM - 1))
            .ok_or(GrowthTargetError::TargetOverflow)?
            / u64::from(PPM);
        u32::try_from(rounded_up).map_err(|_| GrowthTargetError::TargetOverflow)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrowthOutcomeStatus {
    InsufficientData,
    BelowTarget,
    TargetMet,
}

impl GrowthOutcomeStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::InsufficientData => "INSUFFICIENT_DATA",
            Self::BelowTarget => "BELOW_TARGET",
            Self::TargetMet => "TARGET_MET",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrowthOutcomeReason {
    InvalidTarget,
    ObservationWindowIncomplete,
    AttributionIncomplete,
    SignedClientTargetNotMet,
    SignedClientTargetMet,
}

impl GrowthOutcomeReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidTarget => "INVALID_TARGET",
            Self::ObservationWindowIncomplete => "OBSERVATION_WINDOW_INCOMPLETE",
            Self::AttributionIncomplete => "ATTRIBUTION_INCOMPLETE",
            Self::SignedClientTargetNotMet => "SIGNED_CLIENT_TARGET_NOT_MET",
            Self::SignedClientTargetMet => "SIGNED_CLIENT_TARGET_MET",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrowthOutcome {
    pub status: GrowthOutcomeStatus,
    pub reason: GrowthOutcomeReason,
    pub baseline_signed_clients: u32,
    pub target_signed_clients: u32,
    pub observed_signed_clients: u32,
    pub attribution_completeness_ppm: u32,
}

impl GrowthOutcome {
    pub fn canonical_json(self) -> String {
        format!(
            concat!(
                "{{\"attribution_completeness_ppm\":{},",
                "\"baseline_signed_clients\":{},",
                "\"observed_signed_clients\":{},",
                "\"reason\":\"{}\",",
                "\"schema_version\":{},",
                "\"status\":\"{}\",",
                "\"target_signed_clients\":{}}}"
            ),
            self.attribution_completeness_ppm,
            self.baseline_signed_clients,
            self.observed_signed_clients,
            self.reason.as_str(),
            ATTRIBUTION_SCHEMA_VERSION,
            self.status.as_str(),
            self.target_signed_clients,
        )
    }
}

pub fn evaluate_growth_target(
    summary: &GrowthPeriodSummary,
    target: GrowthTarget,
) -> GrowthOutcome {
    let target_signed_clients = match target.target_signed_clients() {
        Ok(value) if target.validate().is_ok() => value,
        _ => {
            return outcome(
                GrowthOutcomeStatus::InsufficientData,
                GrowthOutcomeReason::InvalidTarget,
                target.baseline_signed_clients,
                0,
                summary,
            );
        }
    };

    if !summary.observation_complete {
        return outcome(
            GrowthOutcomeStatus::InsufficientData,
            GrowthOutcomeReason::ObservationWindowIncomplete,
            target.baseline_signed_clients,
            target_signed_clients,
            summary,
        );
    }
    if summary.attribution_completeness_ppm < target.minimum_attribution_completeness_ppm {
        return outcome(
            GrowthOutcomeStatus::InsufficientData,
            GrowthOutcomeReason::AttributionIncomplete,
            target.baseline_signed_clients,
            target_signed_clients,
            summary,
        );
    }
    if summary.signed_clients >= target_signed_clients {
        outcome(
            GrowthOutcomeStatus::TargetMet,
            GrowthOutcomeReason::SignedClientTargetMet,
            target.baseline_signed_clients,
            target_signed_clients,
            summary,
        )
    } else {
        outcome(
            GrowthOutcomeStatus::BelowTarget,
            GrowthOutcomeReason::SignedClientTargetNotMet,
            target.baseline_signed_clients,
            target_signed_clients,
            summary,
        )
    }
}

const fn outcome(
    status: GrowthOutcomeStatus,
    reason: GrowthOutcomeReason,
    baseline_signed_clients: u32,
    target_signed_clients: u32,
    summary: &GrowthPeriodSummary,
) -> GrowthOutcome {
    GrowthOutcome {
        status,
        reason,
        baseline_signed_clients,
        target_signed_clients,
        observed_signed_clients: summary.signed_clients,
        attribution_completeness_ppm: summary.attribution_completeness_ppm,
    }
}

fn checked_inc(value: u32) -> Result<u32, SummaryError> {
    value.checked_add(1).ok_or(SummaryError::CountOverflow)
}

fn ratio_ppm(numerator: u32, denominator: u32) -> u32 {
    if denominator == 0 {
        return PPM;
    }
    let scaled = u64::from(numerator) * u64::from(PPM);
    u32::try_from(scaled / u64::from(denominator)).unwrap_or(PPM)
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

    const J1: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const J2: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const J3: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const CLICK: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const QUERY: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn event(
        event_id: &'static str,
        journey: &'static str,
        time: u64,
        channel: AcquisitionChannel,
        stage: FunnelStage,
    ) -> GrowthEvent<'static> {
        GrowthEvent {
            event_id,
            site_id: "cano-penal",
            journey_sha256: journey,
            occurred_at_unix_ms: time,
            channel,
            stage,
            landing_path: "/defensa-penal",
            ads_click_sha256: None,
            search_query_sha256: None,
            campaign_id: None,
            revenue_minor: None,
        }
    }

    #[test]
    fn event_uses_pseudonymous_hashes_not_raw_identity() {
        let event = GrowthEvent {
            ads_click_sha256: Some(CLICK),
            search_query_sha256: Some(QUERY),
            campaign_id: Some("penal-search-01"),
            ..event(
                "event-001",
                J1,
                1_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::Contact,
            )
        };
        assert_eq!(event.validate(), Ok(()));
    }

    #[test]
    fn revenue_cannot_be_attached_before_signed_client() {
        let event = GrowthEvent {
            revenue_minor: Some(100_000),
            ..event(
                "event-001",
                J1,
                1_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::Consultation,
            )
        };
        assert_eq!(
            event.validate(),
            Err(GrowthEventError::RevenueBeforeSignedClient)
        );
    }

    #[test]
    fn ledger_rejects_stage_regression() {
        let events = [
            event(
                "event-001",
                J1,
                1_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::Consultation,
            ),
            event(
                "event-002",
                J1,
                2_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::QualifiedLead,
            ),
        ];
        let ledger = GrowthLedger {
            site_id: "cano-penal",
            events: &events,
        };
        assert_eq!(
            ledger.validate(),
            Err(LedgerValidationError::JourneyStageRegression)
        );
    }

    #[test]
    fn ledger_rejects_channel_rewrite_mid_journey() {
        let events = [
            event(
                "event-001",
                J1,
                1_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::Contact,
            ),
            event(
                "event-002",
                J1,
                2_000,
                AcquisitionChannel::OrganicSearch,
                FunnelStage::QualifiedLead,
            ),
        ];
        let ledger = GrowthLedger {
            site_id: "cano-penal",
            events: &events,
        };
        assert_eq!(
            ledger.validate(),
            Err(LedgerValidationError::JourneyChannelChanged)
        );
    }

    #[test]
    fn period_summary_counts_journeys_not_events() {
        let signed = GrowthEvent {
            revenue_minor: Some(250_000),
            ..event(
                "event-004",
                J1,
                4_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::SignedClient,
            )
        };
        let events = [
            event(
                "event-001",
                J1,
                1_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::Contact,
            ),
            event(
                "event-002",
                J1,
                2_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::QualifiedLead,
            ),
            event(
                "event-003",
                J1,
                3_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::Consultation,
            ),
            signed,
            event(
                "event-005",
                J2,
                5_000,
                AcquisitionChannel::OrganicSearch,
                FunnelStage::Contact,
            ),
        ];
        let summary = summarize_growth_period(
            GrowthLedger {
                site_id: "cano-penal",
                events: &events,
            },
            1_000_000,
            true,
        )
        .expect("valid summary");

        assert_eq!(summary.unique_journeys, 2);
        assert_eq!(summary.contacts, 2);
        assert_eq!(summary.qualified_leads, 1);
        assert_eq!(summary.consultations, 1);
        assert_eq!(summary.signed_clients, 1);
        assert_eq!(summary.revenue_minor, 250_000);
        assert_eq!(summary.ads_spend_minor, 1_000_000);
    }

    #[test]
    fn incomplete_month_cannot_claim_target_result() {
        let events = [GrowthEvent {
            revenue_minor: Some(100_000),
            ..event(
                "event-001",
                J1,
                1_000,
                AcquisitionChannel::GoogleAds,
                FunnelStage::SignedClient,
            )
        }];
        let summary = summarize_growth_period(
            GrowthLedger {
                site_id: "cano-penal",
                events: &events,
            },
            0,
            false,
        )
        .expect("valid summary");
        let result = evaluate_growth_target(
            &summary,
            GrowthTarget {
                baseline_signed_clients: 1,
                target_multiplier_ppm: PPM,
                minimum_attribution_completeness_ppm: 900_000,
            },
        );
        assert_eq!(result.status, GrowthOutcomeStatus::InsufficientData);
        assert_eq!(
            result.reason,
            GrowthOutcomeReason::ObservationWindowIncomplete
        );
    }

    #[test]
    fn unknown_source_prevents_high_confidence_growth_claim() {
        let events = [GrowthEvent {
            revenue_minor: Some(100_000),
            ..event(
                "event-001",
                J1,
                1_000,
                AcquisitionChannel::Unknown,
                FunnelStage::SignedClient,
            )
        }];
        let summary = summarize_growth_period(
            GrowthLedger {
                site_id: "cano-penal",
                events: &events,
            },
            0,
            true,
        )
        .expect("valid summary");
        let result = evaluate_growth_target(
            &summary,
            GrowthTarget {
                baseline_signed_clients: 1,
                target_multiplier_ppm: PPM,
                minimum_attribution_completeness_ppm: 900_000,
            },
        );
        assert_eq!(result.status, GrowthOutcomeStatus::InsufficientData);
        assert_eq!(result.reason, GrowthOutcomeReason::AttributionIncomplete);
    }

    #[test]
    fn double_target_turns_five_baseline_clients_into_ten() {
        let target = GrowthTarget {
            baseline_signed_clients: 5,
            target_multiplier_ppm: DOUBLE_TARGET_PPM,
            minimum_attribution_completeness_ppm: 900_000,
        };
        assert_eq!(target.target_signed_clients(), Ok(10));
    }

    #[test]
    fn target_is_measured_on_signed_clients_not_raw_leads() {
        let events = [
            GrowthEvent {
                revenue_minor: Some(100_000),
                ..event(
                    "event-001",
                    J1,
                    1_000,
                    AcquisitionChannel::GoogleAds,
                    FunnelStage::SignedClient,
                )
            },
            GrowthEvent {
                revenue_minor: Some(100_000),
                ..event(
                    "event-002",
                    J2,
                    2_000,
                    AcquisitionChannel::OrganicSearch,
                    FunnelStage::SignedClient,
                )
            },
            event(
                "event-003",
                J3,
                3_000,
                AcquisitionChannel::GoogleMaps,
                FunnelStage::Contact,
            ),
        ];
        let summary = summarize_growth_period(
            GrowthLedger {
                site_id: "cano-penal",
                events: &events,
            },
            1_000_000,
            true,
        )
        .expect("valid summary");
        let result = evaluate_growth_target(
            &summary,
            GrowthTarget {
                baseline_signed_clients: 1,
                target_multiplier_ppm: DOUBLE_TARGET_PPM,
                minimum_attribution_completeness_ppm: 900_000,
            },
        );
        assert_eq!(result.status, GrowthOutcomeStatus::TargetMet);
        assert_eq!(result.observed_signed_clients, 2);
    }

    #[test]
    fn outcome_receipt_is_byte_stable() {
        let outcome = GrowthOutcome {
            status: GrowthOutcomeStatus::TargetMet,
            reason: GrowthOutcomeReason::SignedClientTargetMet,
            baseline_signed_clients: 5,
            target_signed_clients: 10,
            observed_signed_clients: 11,
            attribution_completeness_ppm: 950_000,
        };
        assert_eq!(outcome.canonical_json(), outcome.canonical_json());
        assert!(outcome
            .canonical_json()
            .contains("\"target_signed_clients\":10"));
    }
}
