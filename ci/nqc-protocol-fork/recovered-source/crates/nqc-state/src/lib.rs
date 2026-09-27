use alloy::{
    eips::BlockId,
    primitives::{Address, B256, U256},
    providers::{DynProvider, IpcConnect, Provider, ProviderBuilder},
    rpc::types::{Filter, Log as RpcLog, TransactionReceipt},
};
use futures_util::StreamExt;
use std::{
    ops::ControlFlow,
    os::unix::fs::FileTypeExt,
    path::{Path, PathBuf},
};
use thiserror::Error;


#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CanonicalBlock {
    pub number: u64,
    pub hash: B256,
    pub timestamp: u64,
    pub base_fee_per_gas: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanonicalFeeState {
    pub anchor: CanonicalBlock,
    pub gas_used: u64,
    pub gas_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RethIpcConfig {
    path: PathBuf,
}

impl RethIpcConfig {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn validate(&self) -> Result<(), StateError> {
        if !self.path.is_absolute() {
            return Err(StateError::IpcPathNotAbsolute(self.path.clone()));
        }

        let metadata = std::fs::metadata(&self.path)
            .map_err(|source| StateError::IpcMetadata {
                path: self.path.clone(),
                source,
            })?;

        if !metadata.file_type().is_socket() {
            return Err(StateError::IpcPathNotSocket(self.path.clone()));
        }

        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum StateError {
    #[error("Reth IPC path must be absolute: {0}")]
    IpcPathNotAbsolute(PathBuf),
    #[error("failed to inspect Reth IPC path {path}: {source}")]
    IpcMetadata {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Reth IPC path is not a Unix domain socket: {0}")]
    IpcPathNotSocket(PathBuf),
    #[error("Alloy IPC transport error: {0}")]
    Transport(String),
    #[error("canonical block {0} is unavailable from local Reth")]
    BlockUnavailable(u64),
    #[error("Reth returned block {actual} for requested block {requested}")]
    BlockNumberMismatch { requested: u64, actual: u64 },
    #[error("canonical hash mismatch at block {block_number}: expected {expected}, got {actual}")]
    CanonicalHashMismatch {
        block_number: u64,
        expected: B256,
        actual: B256,
    },
    #[error("canonical snapshot mismatch: expected {expected:?}, got {actual:?}")]
    CanonicalSnapshotMismatch {
        expected: CanonicalBlock,
        actual: CanonicalBlock,
    },
    #[error("pending-transaction subscription ended unexpectedly")]
    PendingStreamEnded,
    #[error("log subscription ended unexpectedly")]
    LogStreamEnded,
}

#[derive(Clone)]
pub struct RethIpcSource {
    provider: DynProvider,
}

impl RethIpcSource {
    #[must_use]
    pub fn provider(&self) -> DynProvider {
        self.provider.clone()
    }

    pub async fn connect(config: &RethIpcConfig) -> Result<Self, StateError> {
        config.validate()?;
        let path = config.path().to_string_lossy().into_owned();
        let ipc = IpcConnect::new(path);
        let provider = ProviderBuilder::new()
            .connect_ipc(ipc)
            .await
            .map_err(|error| StateError::Transport(error.to_string()))?
            .erased();

        Ok(Self { provider })
    }

    pub async fn chain_id(&self) -> Result<u64, StateError> {
        self.provider
            .get_chain_id()
            .await
            .map_err(|error| StateError::Transport(error.to_string()))
    }

    pub async fn latest_block_number(&self) -> Result<u64, StateError> {
        self.provider
            .get_block_number()
            .await
            .map_err(|error| StateError::Transport(error.to_string()))
    }

    pub async fn canonical_block_at(&self, block_number: u64) -> Result<CanonicalBlock, StateError> {
        let block = self
            .provider
            .get_block(BlockId::number(block_number))
            .await
            .map_err(|error| StateError::Transport(error.to_string()))?
            .ok_or(StateError::BlockUnavailable(block_number))?;

        let actual_number = block.number();
        if actual_number != block_number {
            return Err(StateError::BlockNumberMismatch {
                requested: block_number,
                actual: actual_number,
            });
        }

        Ok(CanonicalBlock {
            number: actual_number,
            hash: block.hash(),
            timestamp: block.header.inner.timestamp,
            base_fee_per_gas: block.header.inner.base_fee_per_gas,
        })
    }

    pub async fn latest_canonical_block(&self) -> Result<CanonicalBlock, StateError> {
        let block_number = self.latest_block_number().await?;
        self.canonical_block_at(block_number).await
    }

    pub async fn ensure_canonical(&self, anchor: CanonicalBlock) -> Result<(), StateError> {
        let current = self.canonical_block_at(anchor.number).await?;
        if current.hash != anchor.hash {
            return Err(StateError::CanonicalHashMismatch {
                block_number: anchor.number,
                expected: anchor.hash,
                actual: current.hash,
            });
        }
        Ok(())
    }

    pub async fn account_nonce_at(
        &self,
        address: Address,
        anchor: CanonicalBlock,
    ) -> Result<u64, StateError> {
        self.ensure_canonical(anchor).await?;
        self.provider
            .get_transaction_count(address)
            .block_id(BlockId::hash_canonical(anchor.hash))
            .await
            .map_err(|error| StateError::Transport(error.to_string()))
    }

    pub async fn balance_at(
        &self,
        address: Address,
        anchor: CanonicalBlock,
    ) -> Result<U256, StateError> {
        self.ensure_canonical(anchor).await?;
        self.provider
            .get_balance(address)
            .block_id(BlockId::hash_canonical(anchor.hash))
            .await
            .map_err(|error| StateError::Transport(error.to_string()))
    }

    pub async fn pending_nonce(&self, address: Address) -> Result<u64, StateError> {
        self.provider
            .get_transaction_count(address)
            .block_id(BlockId::pending())
            .await
            .map_err(|error| StateError::Transport(error.to_string()))
    }

    pub async fn transaction_receipt(
        &self,
        tx_hash: B256,
    ) -> Result<Option<TransactionReceipt>, StateError> {
        self.provider
            .get_transaction_receipt(tx_hash)
            .await
            .map_err(|error| StateError::Transport(error.to_string()))
    }

    pub async fn canonical_fee_state(
        &self,
        anchor: CanonicalBlock,
    ) -> Result<CanonicalFeeState, StateError> {
        self.ensure_canonical(anchor).await?;
        let block = self
            .provider
            .get_block(BlockId::hash_canonical(anchor.hash))
            .await
            .map_err(|error| StateError::Transport(error.to_string()))?
            .ok_or(StateError::BlockUnavailable(anchor.number))?;

        let actual = CanonicalBlock {
            number: block.number(),
            hash: block.hash(),
            timestamp: block.header.inner.timestamp,
            base_fee_per_gas: block.header.inner.base_fee_per_gas,
        };
        if actual != anchor {
            return Err(StateError::CanonicalSnapshotMismatch {
                expected: anchor,
                actual,
            });
        }

        Ok(CanonicalFeeState {
            anchor,
            gas_used: block.header.inner.gas_used,
            gas_limit: block.header.inner.gas_limit,
        })
    }

    pub async fn run_pending_loop<F>(&self, mut on_hash: F) -> Result<(), StateError>
    where
        F: FnMut(B256) -> ControlFlow<()>,
    {
        let subscription = self
            .provider
            .subscribe_pending_transactions()
            .await
            .map_err(|error| StateError::Transport(error.to_string()))?;
        let mut stream = subscription.into_stream();

        while let Some(hash) = stream.next().await {
            if let ControlFlow::Break(()) = on_hash(hash) {
                return Ok(());
            }
        }

        Err(StateError::PendingStreamEnded)
    }

    pub async fn run_log_loop<F>(
        &self,
        filter: &Filter,
        mut on_log: F,
    ) -> Result<(), StateError>
    where
        F: FnMut(RpcLog) -> ControlFlow<()>,
    {
        let subscription = self
            .provider
            .subscribe_logs(filter)
            .await
            .map_err(|error| StateError::Transport(error.to_string()))?;
        let mut stream = subscription.into_stream();

        while let Some(log) = stream.next().await {
            if let ControlFlow::Break(()) = on_log(log) {
                return Ok(());
            }
        }

        Err(StateError::LogStreamEnded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_ipc_path_is_rejected_before_io() {
        let config = RethIpcConfig::new("reth.ipc");
        assert!(matches!(
            config.validate(),
            Err(StateError::IpcPathNotAbsolute(_))
        ));
    }

    #[test]
    fn missing_absolute_path_is_rejected() {
        let config = RethIpcConfig::new("/definitely/not/a/real/nqc/reth.ipc");
        assert!(matches!(
            config.validate(),
            Err(StateError::IpcMetadata { .. })
        ));
    }
}