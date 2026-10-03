//! Exact decoding of Aave V3 packed configuration words.
//!
//! `ReserveConfigurationMap` bit layout (Aave V3 `ReserveConfiguration`):
//!
//! | bits      | field                                              |
//! |-----------|----------------------------------------------------|
//! | 0-15      | LTV (bps)                                          |
//! | 16-31     | liquidation threshold (bps)                        |
//! | 32-47     | liquidation bonus (bps, 10000 + bonus)             |
//! | 48-55     | decimals                                           |
//! | 56        | active                                             |
//! | 57        | frozen                                             |
//! | 58        | borrowing enabled                                  |
//! | 59        | stable rate borrowing enabled (deprecated)         |
//! | 60        | paused                                             |
//! | 61        | borrowable in isolation                            |
//! | 62        | siloed borrowing                                   |
//! | 63        | flash loan enabled                                 |
//! | 64-79     | reserve factor (bps)                               |
//! | 80-115    | borrow cap (whole tokens, 0 = none)                |
//! | 116-151   | supply cap (whole tokens, 0 = none)                |
//! | 152-167   | liquidation protocol fee (bps)                     |
//! | 168-175   | eMode category (deprecated)                        |
//! | 176-211   | unbacked mint cap (whole tokens)                   |
//! | 212-251   | isolation-mode debt ceiling (2 decimals)           |
//! | 252       | virtual accounting enabled                         |
//! | 253-255   | unused (must be zero)                              |
//!
//! Every field is kept as an exact integer; nothing is normalized.

use crate::uint::U256;
use nqc_census_chain::json::Json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveConfiguration {
    pub raw: U256,
    pub ltv_bps: u64,
    pub liquidation_threshold_bps: u64,
    pub liquidation_bonus_bps: u64,
    pub decimals: u64,
    pub active: bool,
    pub frozen: bool,
    pub borrowing_enabled: bool,
    pub stable_borrowing_enabled_deprecated: bool,
    pub paused: bool,
    pub borrowable_in_isolation: bool,
    pub siloed_borrowing: bool,
    pub flash_loan_enabled: bool,
    pub reserve_factor_bps: u64,
    pub borrow_cap_whole_tokens: u64,
    pub supply_cap_whole_tokens: u64,
    pub liquidation_protocol_fee_bps: u64,
    pub emode_category_deprecated: u64,
    pub unbacked_mint_cap_whole_tokens: u64,
    pub debt_ceiling_centi_units: u64,
    pub virtual_accounting_enabled: bool,
    pub unused_high_bits: u64,
}

impl ReserveConfiguration {
    pub fn decode(raw: U256) -> Self {
        Self {
            raw,
            ltv_bps: raw.field(0, 16),
            liquidation_threshold_bps: raw.field(16, 16),
            liquidation_bonus_bps: raw.field(32, 16),
            decimals: raw.field(48, 8),
            active: raw.bit(56),
            frozen: raw.bit(57),
            borrowing_enabled: raw.bit(58),
            stable_borrowing_enabled_deprecated: raw.bit(59),
            paused: raw.bit(60),
            borrowable_in_isolation: raw.bit(61),
            siloed_borrowing: raw.bit(62),
            flash_loan_enabled: raw.bit(63),
            reserve_factor_bps: raw.field(64, 16),
            borrow_cap_whole_tokens: raw.field(80, 36),
            supply_cap_whole_tokens: raw.field(116, 36),
            liquidation_protocol_fee_bps: raw.field(152, 16),
            emode_category_deprecated: raw.field(168, 8),
            unbacked_mint_cap_whole_tokens: raw.field(176, 36),
            debt_ceiling_centi_units: raw.field(212, 40),
            virtual_accounting_enabled: raw.bit(252),
            unused_high_bits: raw.field(253, 3),
        }
    }

    /// Isolation-mode collateral: a non-zero debt ceiling.
    pub fn isolated_collateral(&self) -> bool {
        self.debt_ceiling_centi_units != 0
    }

    pub fn json(&self) -> Json {
        let flag = Json::Bool;
        Json::object([
            ("raw", Json::string(self.raw.to_decimal())),
            ("ltv_bps", Json::uint(self.ltv_bps)),
            (
                "liquidation_threshold_bps",
                Json::uint(self.liquidation_threshold_bps),
            ),
            (
                "liquidation_bonus_bps",
                Json::uint(self.liquidation_bonus_bps),
            ),
            ("decimals", Json::uint(self.decimals)),
            ("active", flag(self.active)),
            ("frozen", flag(self.frozen)),
            ("borrowing_enabled", flag(self.borrowing_enabled)),
            (
                "stable_borrowing_enabled_deprecated",
                flag(self.stable_borrowing_enabled_deprecated),
            ),
            ("paused", flag(self.paused)),
            (
                "borrowable_in_isolation",
                flag(self.borrowable_in_isolation),
            ),
            ("siloed_borrowing", flag(self.siloed_borrowing)),
            ("flash_loan_enabled", flag(self.flash_loan_enabled)),
            ("reserve_factor_bps", Json::uint(self.reserve_factor_bps)),
            (
                "borrow_cap_whole_tokens",
                Json::uint(self.borrow_cap_whole_tokens),
            ),
            (
                "supply_cap_whole_tokens",
                Json::uint(self.supply_cap_whole_tokens),
            ),
            (
                "liquidation_protocol_fee_bps",
                Json::uint(self.liquidation_protocol_fee_bps),
            ),
            (
                "emode_category_deprecated",
                Json::uint(self.emode_category_deprecated),
            ),
            (
                "unbacked_mint_cap_whole_tokens",
                Json::uint(self.unbacked_mint_cap_whole_tokens),
            ),
            (
                "debt_ceiling_centi_units",
                Json::uint(self.debt_ceiling_centi_units),
            ),
            ("isolated_collateral", flag(self.isolated_collateral())),
            (
                "virtual_accounting_enabled",
                flag(self.virtual_accounting_enabled),
            ),
            ("unused_high_bits", Json::uint(self.unused_high_bits)),
        ])
    }
}

/// Aave `UserConfigurationMap`: bit `2 * id` borrowing, `2 * id + 1`
/// collateral, for reserve ids `0..128`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserConfiguration(pub U256);

impl UserConfiguration {
    pub fn borrowing(self, reserve_id: u16) -> bool {
        reserve_id < 128 && self.0.bit(2 * u32::from(reserve_id))
    }

    pub fn collateral(self, reserve_id: u16) -> bool {
        reserve_id < 128 && self.0.bit(2 * u32::from(reserve_id) + 1)
    }

    pub fn borrowing_any(self) -> bool {
        (0..128).any(|id| self.borrowing(id))
    }

    pub fn collateral_any(self) -> bool {
        (0..128).any(|id| self.collateral(id))
    }

    pub fn is_empty(self) -> bool {
        self.0.is_zero()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(bits: &[(u32, u64, u32)]) -> U256 {
        // (offset, value, width) -> packed word, built bit by bit.
        let mut bytes = [0u8; 32];
        for (offset, value, width) in bits {
            for bit in 0..*width {
                if (value >> bit) & 1 == 1 {
                    let position = offset + bit;
                    bytes[31 - (position / 8) as usize] |= 1 << (position % 8);
                }
            }
        }
        U256::from_word(&bytes)
    }

    #[test]
    fn every_field_decodes_at_its_offset() {
        let raw = word(&[
            (0, 7_500, 16),
            (16, 8_000, 16),
            (32, 10_500, 16),
            (48, 6, 8),
            (56, 1, 1),
            (58, 1, 1),
            (61, 1, 1),
            (63, 1, 1),
            (64, 1_000, 16),
            (80, 0xF_FFFF_FFFF, 36),
            (116, 123_456_789, 36),
            (152, 1_000, 16),
            (168, 3, 8),
            (176, 5, 36),
            (212, 0xFF_FFFF_FFFF, 40),
            (252, 1, 1),
        ]);
        let config = ReserveConfiguration::decode(raw);
        assert_eq!(config.ltv_bps, 7_500);
        assert_eq!(config.liquidation_threshold_bps, 8_000);
        assert_eq!(config.liquidation_bonus_bps, 10_500);
        assert_eq!(config.decimals, 6);
        assert!(config.active && !config.frozen && config.borrowing_enabled);
        assert!(!config.stable_borrowing_enabled_deprecated && !config.paused);
        assert!(
            config.borrowable_in_isolation && !config.siloed_borrowing && config.flash_loan_enabled
        );
        assert_eq!(config.reserve_factor_bps, 1_000);
        assert_eq!(config.borrow_cap_whole_tokens, 0xF_FFFF_FFFF);
        assert_eq!(config.supply_cap_whole_tokens, 123_456_789);
        assert_eq!(config.liquidation_protocol_fee_bps, 1_000);
        assert_eq!(config.emode_category_deprecated, 3);
        assert_eq!(config.unbacked_mint_cap_whole_tokens, 5);
        assert_eq!(config.debt_ceiling_centi_units, 0xFF_FFFF_FFFF);
        assert!(config.isolated_collateral());
        assert!(config.virtual_accounting_enabled);
        assert_eq!(config.unused_high_bits, 0);
        assert_eq!(
            ReserveConfiguration::decode(word(&[(253, 5, 3)])).unused_high_bits,
            5
        );
    }

    #[test]
    fn user_configuration_pairs() {
        let raw = word(&[(0, 1, 1), (3, 1, 1), (255, 1, 1)]);
        let user = UserConfiguration(raw);
        assert!(user.borrowing(0) && !user.collateral(0));
        assert!(!user.borrowing(1) && user.collateral(1));
        assert!(user.collateral(127) && !user.borrowing(127));
        assert!(!user.borrowing(128));
        assert!(user.borrowing_any() && user.collateral_any());
        assert!(UserConfiguration(U256::ZERO).is_empty());
    }
}
