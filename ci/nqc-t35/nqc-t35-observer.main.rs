//! NQC T35 physical Reth observer.
//!
//! Evidence-only instrumentation: P2P and ExEx signals are recognized by the exact
//! NQC Sensor Fabric source snapshot and never acquire canonical or live authority.

use alloy_consensus::BlockHeader;
use alloy_primitives::{keccak256, B256};
use futures_util::TryStreamExt;
use nqc_sensor_fabric::{
    ClockStamp, SensorEpochKey, SensorFabric, SensorFabricPolicy, SensorIdentity,
    SensorObservation, SensorSourceClass, SignalKey, SignalKind,
};
use reth_exex::{ExExContext, ExExEvent, ExExNotification};
use reth_node_api::FullNodeComponents;
use reth_node_ethereum::EthereumNode;
use std::io::Write as _;

fn monotonic_ns() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let origin = START.get_or_init(std::time::Instant::now);
    u64::try_from(origin.elapsed().as_nanos())
        .unwrap_or(u64::MAX)
        .saturating_add(1)
}

fn seed_hash(label: &[u8], env_name: &str) -> B256 {
    let seed = std::env::var(env_name).unwrap_or_else(|_| "UNSET".to_string());
    let mut bytes = Vec::with_capacity(label.len() + seed.len() + 1);
    bytes.extend_from_slice(label);
    bytes.push(0);
    bytes.extend_from_slice(seed.as_bytes());
    keccak256(bytes)
}

fn sensor_policy() -> SensorFabricPolicy {
    SensorFabricPolicy {
        max_signals: 8192,
        max_observations_per_signal: 8,
        max_comparable_clock_error_ns: 100_000,
        hard_max_clock_error_ns: 1_000_000,
        min_regions_for_cross_region_claim: 2,
        recognition_shards: 64,
        wave_capacity: 8192,
        max_per_chain: 8192,
        max_per_kind: 8192,
    }
}

fn write_exex(
    fabric: &mut SensorFabric,
    sequence: &mut u64,
    kind: &str,
    number: u64,
    hash: B256,
) -> eyre::Result<()> {
    let Some(path) = std::env::var_os("NQC_T35_EXEX_RAW") else {
        return Ok(());
    };

    let first_useful = monotonic_ns();
    let decoded = monotonic_ns();
    *sequence = sequence.saturating_add(1);

    let chain_id = std::env::var("NQC_T35_CHAIN_ID")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1337);
    let region_hash = seed_hash(b"NQC_T35_REGION", "NQC_T35_REGION_SEED");
    let instance_hash = seed_hash(b"NQC_T35_INSTANCE", "NQC_T35_INSTANCE_SEED");
    let boot_hash = seed_hash(b"NQC_T35_BOOT", "NQC_T35_BOOT_SEED");
    let source_epoch_hash = seed_hash(b"NQC_T35_EXEX_SOURCE_EPOCH", "NQC_T35_BOOT_SEED");
    let clock_epoch_hash = seed_hash(b"NQC_T35_CLOCK_EPOCH", "NQC_T35_BOOT_SEED");
    let network_path_hash = keccak256(b"RETH_EXEX_CANON_STATE_NOTIFICATION_CHANNEL_V1");

    let mut notification_bytes = Vec::with_capacity(96);
    notification_bytes.extend_from_slice(kind.as_bytes());
    notification_bytes.extend_from_slice(&number.to_be_bytes());
    notification_bytes.extend_from_slice(hash.as_slice());
    let notification_hash = keccak256(notification_bytes);

    let signal = SignalKey {
        chain_id,
        kind: SignalKind::CanonicalBlock,
        payload_hash: hash,
        subject_hash: hash,
    };
    let observation = SensorObservation {
        sensor_epoch: SensorEpochKey {
            sensor: SensorIdentity {
                region_hash,
                instance_hash,
                source_class: SensorSourceClass::LocalRethExEx,
            },
            boot_hash,
            source_epoch_hash,
            clock_epoch_hash,
        },
        sequence: *sequence,
        signal,
        clock: ClockStamp {
            monotonic_ns: first_useful,
            disciplined_ns: None,
            max_error_ns: 0,
            traceable: false,
        },
        network_path_hash,
        raw_evidence_hash: notification_hash,
    };
    let sensor_observation_hash = observation.fingerprint();

    fabric.ingest(observation)?;
    let sensor_ingested = monotonic_ns();
    let wave = fabric.plan_recognition_wave()?;
    let ticket = wave
        .shards
        .iter()
        .flat_map(|shard| shard.tickets.iter())
        .find(|ticket| ticket.key == signal)
        .copied()
        .ok_or_else(|| eyre::eyre!("EXEX recognition ticket missing"))?;
    let recognition_ticket_hash = ticket.fingerprint();
    let recognized = monotonic_ns();

    let mut source_identity_bytes = Vec::with_capacity(96);
    source_identity_bytes.extend_from_slice(b"NQC_T35_EXEX_SENSOR_SOURCE_V1");
    source_identity_bytes.extend_from_slice(region_hash.as_slice());
    source_identity_bytes.extend_from_slice(instance_hash.as_slice());
    let source_identity_hash = keccak256(source_identity_bytes);
    let timestamp_source_hash = keccak256(b"RUST_STD_INSTANT_PROCESS_LOCAL_V1");

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(
        file,
        "{{\"schema_version\":3,\"lane\":\"EXEX\",\"capture_point\":\"RETH_EXEX_CANON_STATE_NOTIFICATION\",\"source_identity_hash\":\"{:#x}\",\"source_epoch_hash\":\"{:#x}\",\"clock_epoch_hash\":\"{:#x}\",\"signal_hash\":\"{:#x}\",\"raw_evidence_hash\":\"{:#x}\",\"timestamp_source_hash\":\"{:#x}\",\"sequence\":{},\"receive_monotonic_ns\":{},\"decoded_ns\":{},\"sensor_ingested_ns\":{},\"recognized_ns\":{},\"traceable\":true,\"timestamp_provenance_traceable\":true,\"sensor_clock_traceable\":false,\"clock_scope\":\"LOCAL_MONOTONIC\",\"monotonic_clock\":\"RUST_STD_INSTANT\",\"disciplined_ns\":null,\"global_max_error_ns\":null,\"recognition_stage\":\"NQC_SENSOR_FABRIC\",\"sensor_observation_hash\":\"{:#x}\",\"recognition_ticket_hash\":\"{:#x}\",\"notification_kind\":\"{}\",\"canonical_block_number\":{},\"canonical_block_hash\":\"{:#x}\",\"notification_hash\":\"{:#x}\"}}",
        source_identity_hash,
        source_epoch_hash,
        clock_epoch_hash,
        signal.fingerprint(),
        notification_hash,
        timestamp_source_hash,
        *sequence,
        first_useful,
        decoded,
        sensor_ingested,
        recognized,
        sensor_observation_hash,
        recognition_ticket_hash,
        kind,
        number,
        hash,
        notification_hash,
    )?;
    Ok(())
}

async fn observer<Node: FullNodeComponents>(mut ctx: ExExContext<Node>) -> eyre::Result<()> {
    let mut fabric = SensorFabric::new(sensor_policy())?;
    let mut sequence = 0u64;

    while let Some(notification) = ctx.notifications.try_next().await? {
        match &notification {
            ExExNotification::ChainCommitted { new } => {
                write_exex(
                    &mut fabric,
                    &mut sequence,
                    "ChainCommitted",
                    new.tip().number(),
                    new.tip().hash(),
                )?;
            }
            ExExNotification::ChainReorged { new, .. } => {
                write_exex(
                    &mut fabric,
                    &mut sequence,
                    "ChainReorged",
                    new.tip().number(),
                    new.tip().hash(),
                )?;
            }
            ExExNotification::ChainReverted { old } => {
                write_exex(
                    &mut fabric,
                    &mut sequence,
                    "ChainReverted",
                    old.tip().number(),
                    old.tip().hash(),
                )?;
            }
        }

        if let Some(committed) = notification.committed_chain() {
            ctx.events
                .send(ExExEvent::FinishedHeight(committed.tip().num_hash()))?;
        }
    }
    Ok(())
}

fn main() -> eyre::Result<()> {
    reth::cli::Cli::parse_args().run(async move |builder, _| {
        let handle = builder
            .node(EthereumNode::default())
            .install_exex("NQC-T35-Observer", async move |ctx| Ok(observer(ctx)))
            .launch_with_debug_capabilities()
            .await?;
        handle.wait_for_node_exit().await
    })
}
