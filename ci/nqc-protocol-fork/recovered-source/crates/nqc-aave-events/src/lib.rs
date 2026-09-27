use alloy::{
    primitives::{Address, U256},
    rpc::types::Log,
    sol,
    sol_types::SolEvent,
};
use nqc_aave_sync::AaveImpact;
use std::collections::HashMap;
use thiserror::Error;

sol! {
    event Supply(
        address indexed reserve,
        address user,
        address indexed on_behalf_of,
        uint256 amount,
        uint16 indexed referral_code
    );
    event Withdraw(
        address indexed reserve,
        address indexed user,
        address indexed to,
        uint256 amount
    );
    event Borrow(
        address indexed reserve,
        address user,
        address indexed on_behalf_of,
        uint256 amount,
        uint8 interest_rate_mode,
        uint256 borrow_rate,
        uint16 indexed referral_code
    );
    event Repay(
        address indexed reserve,
        address indexed user,
        address indexed repayer,
        uint256 amount,
        bool use_atokens
    );
    event LiquidationCall(
        address indexed collateral_asset,
        address indexed debt_asset,
        address indexed user,
        uint256 debt_to_cover,
        uint256 liquidated_collateral_amount,
        address liquidator,
        bool receive_atoken
    );
    event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user);
    event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user);
    event UserEModeSet(address indexed user, uint8 category_id);
    event ReserveDataUpdated(
        address indexed reserve,
        uint256 liquidity_rate,
        uint256 stable_borrow_rate,
        uint256 variable_borrow_rate,
        uint256 liquidity_index,
        uint256 variable_borrow_index
    );
    event Transfer(address indexed from, address indexed to, uint256 value);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveRuntimeEvent {
    pub asset: Address,
    pub liquidity_rate_ray: U256,
    pub variable_borrow_rate_ray: U256,
    pub liquidity_index_ray: U256,
    pub variable_borrow_index_ray: U256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AaveDecodedPayload {
    Impact(AaveImpact),
    ReserveRuntime(ReserveRuntimeEvent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AaveDecodedEvent {
    pub payload: AaveDecodedPayload,
    pub block_number: Option<u64>,
    pub block_timestamp: Option<u64>,
    pub removed: bool,
}

#[derive(Debug, Clone)]
pub struct AaveEventDecoder {
    pool: Address,
    atoken_to_asset: HashMap<Address, Address>,
}

impl AaveEventDecoder {
    pub fn new(pool: Address) -> Result<Self, DecodeError> {
        if pool == Address::ZERO {
            return Err(DecodeError::ZeroPoolAddress);
        }
        Ok(Self {
            pool,
            atoken_to_asset: HashMap::new(),
        })
    }

    #[must_use]
    pub fn pool(&self) -> Address {
        self.pool
    }

    pub fn register_atoken(
        &mut self,
        asset: Address,
        atoken: Address,
    ) -> Result<(), DecodeError> {
        if asset == Address::ZERO || atoken == Address::ZERO {
            return Err(DecodeError::ZeroReserveAddress);
        }
        if let Some(existing) = self.atoken_to_asset.get(&atoken) {
            if *existing != asset {
                return Err(DecodeError::ATokenAlias {
                    atoken,
                    existing_asset: *existing,
                    new_asset: asset,
                });
            }
        }
        self.atoken_to_asset.insert(atoken, asset);
        Ok(())
    }

    #[must_use]
    pub fn tracked_atokens(&self) -> usize {
        self.atoken_to_asset.len()
    }

    pub fn decode(&self, log: &Log) -> Result<Option<AaveDecodedEvent>, DecodeError> {
        let payload = if log.address() == self.pool {
            self.decode_pool(log)?
        } else if let Some(asset) = self.atoken_to_asset.get(&log.address()).copied() {
            self.decode_atoken(log, asset)?
        } else {
            None
        };

        Ok(payload.map(|payload| AaveDecodedEvent {
            payload,
            block_number: log.block_number,
            block_timestamp: log.block_timestamp,
            removed: log.removed,
        }))
    }

    fn decode_pool(&self, log: &Log) -> Result<Option<AaveDecodedPayload>, DecodeError> {
        let Some(topic0) = log.topic0().copied() else {
            return Ok(None);
        };
        let payload = if topic0 == Supply::SIGNATURE_HASH {
            let event = decode::<Supply>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::Supply {
                asset: event.reserve,
                on_behalf_of: event.on_behalf_of,
            })
        } else if topic0 == Withdraw::SIGNATURE_HASH {
            let event = decode::<Withdraw>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::Withdraw {
                asset: event.reserve,
                user: event.user,
            })
        } else if topic0 == Borrow::SIGNATURE_HASH {
            let event = decode::<Borrow>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::Borrow {
                asset: event.reserve,
                on_behalf_of: event.on_behalf_of,
            })
        } else if topic0 == Repay::SIGNATURE_HASH {
            let event = decode::<Repay>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::Repay {
                asset: event.reserve,
                user: event.user,
            })
        } else if topic0 == LiquidationCall::SIGNATURE_HASH {
            let event = decode::<LiquidationCall>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::Liquidation {
                collateral_asset: event.collateral_asset,
                debt_asset: event.debt_asset,
                borrower: event.user,
            })
        } else if topic0 == ReserveUsedAsCollateralEnabled::SIGNATURE_HASH {
            let event = decode::<ReserveUsedAsCollateralEnabled>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::CollateralEnabled {
                asset: event.reserve,
                user: event.user,
            })
        } else if topic0 == ReserveUsedAsCollateralDisabled::SIGNATURE_HASH {
            let event = decode::<ReserveUsedAsCollateralDisabled>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::CollateralDisabled {
                asset: event.reserve,
                user: event.user,
            })
        } else if topic0 == UserEModeSet::SIGNATURE_HASH {
            let event = decode::<UserEModeSet>(log)?;
            AaveDecodedPayload::Impact(AaveImpact::UserEModeChanged { user: event.user })
        } else if topic0 == ReserveDataUpdated::SIGNATURE_HASH {
            let event = decode::<ReserveDataUpdated>(log)?;
            AaveDecodedPayload::ReserveRuntime(ReserveRuntimeEvent {
                asset: event.reserve,
                liquidity_rate_ray: event.liquidity_rate,
                variable_borrow_rate_ray: event.variable_borrow_rate,
                liquidity_index_ray: event.liquidity_index,
                variable_borrow_index_ray: event.variable_borrow_index,
            })
        } else {
            return Ok(None);
        };
        Ok(Some(payload))
    }

    fn decode_atoken(
        &self,
        log: &Log,
        asset: Address,
    ) -> Result<Option<AaveDecodedPayload>, DecodeError> {
        if log.topic0().copied() != Some(Transfer::SIGNATURE_HASH) {
            return Ok(None);
        }
        let event = decode::<Transfer>(log)?;
        Ok(Some(AaveDecodedPayload::Impact(
            AaveImpact::ATokenBalanceTransfer {
                asset,
                from: event.from,
                to: event.to,
            },
        )))
    }
}

fn decode<E: SolEvent>(log: &Log) -> Result<E, DecodeError> {
    E::decode_log_data(log.data())
        .map_err(|error| DecodeError::Abi(error.to_string()))
}

#[derive(Debug, Error)]
pub enum DecodeError {
    #[error("configured Aave pool address is zero")]
    ZeroPoolAddress,
    #[error("reserve/aToken addresses cannot be zero")]
    ZeroReserveAddress,
    #[error("aToken {atoken} is already mapped to {existing_asset}, cannot remap to {new_asset}")]
    ATokenAlias {
        atoken: Address,
        existing_asset: Address,
        new_asset: Address,
    },
    #[error("failed to decode validated Aave event: {0}")]
    Abi(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::Log as PrimitiveLog;

    fn addr(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    fn rpc_log<E: SolEvent>(address: Address, event: E) -> Log {
        Log {
            inner: PrimitiveLog {
                address,
                data: event.encode_log_data(),
            },
            block_hash: None,
            block_number: Some(42),
            block_timestamp: Some(1_700_000_000),
            transaction_hash: None,
            transaction_index: None,
            log_index: None,
            removed: false,
        }
    }

    #[test]
    fn decodes_pool_borrow_into_refresh_impact() -> Result<(), DecodeError> {
        let pool = addr(1);
        let reserve = addr(2);
        let user = addr(3);
        let decoder = AaveEventDecoder::new(pool)?;
        let log = rpc_log(
            pool,
            Borrow {
                reserve,
                user: addr(4),
                on_behalf_of: user,
                amount: U256::from(500u64),
                interest_rate_mode: 2,
                borrow_rate: U256::from(9u64),
                referral_code: 0,
            },
        );
        let decoded = decoder.decode(&log)?;
        assert_eq!(
            decoded.map(|event| event.payload),
            Some(AaveDecodedPayload::Impact(AaveImpact::Borrow {
                asset: reserve,
                on_behalf_of: user,
            }))
        );
        Ok(())
    }

    #[test]
    fn decodes_atoken_transfer_and_preserves_removed_flag() -> Result<(), DecodeError> {
        let pool = addr(1);
        let asset = addr(2);
        let atoken = addr(3);
        let from = addr(4);
        let to = addr(5);
        let mut decoder = AaveEventDecoder::new(pool)?;
        decoder.register_atoken(asset, atoken)?;
        let mut log = rpc_log(
            atoken,
            Transfer {
                from,
                to,
                value: U256::from(1u64),
            },
        );
        log.removed = true;
        let decoded = decoder.decode(&log)?;
        assert_eq!(decoded.map(|event| event.removed), Some(true));
        assert_eq!(
            decoded.map(|event| event.payload),
            Some(AaveDecodedPayload::Impact(
                AaveImpact::ATokenBalanceTransfer { asset, from, to }
            ))
        );
        Ok(())
    }

    #[test]
    fn unrelated_emitter_is_ignored() -> Result<(), DecodeError> {
        let decoder = AaveEventDecoder::new(addr(1))?;
        let log = Log {
            inner: PrimitiveLog::empty(),
            block_hash: None,
            block_number: None,
            block_timestamp: None,
            transaction_hash: None,
            transaction_index: None,
            log_index: None,
            removed: false,
        };
        assert!(decoder.decode(&log)?.is_none());
        Ok(())
    }
}