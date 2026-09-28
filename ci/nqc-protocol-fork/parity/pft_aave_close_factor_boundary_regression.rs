use alloy::primitives::U256;
use nqc_aave_math::{
    max_liquidatable_debt, LiquidationSizingInput, FULL_CLOSE_HF_WAD,
};

const WAD_U64: u64 = 1_000_000_000_000_000_000;
const MIN_BASE_CLOSE_THRESHOLD_USD: u64 = 2_000;

fn wad() -> U256 {
    U256::from(WAD_U64)
}

fn usd(value: u64) -> U256 {
    U256::from(value) * wad()
}

fn sizing(
    health_factor_wad: u64,
    total_debt_usd: u64,
    reserve_debt_amount_usd: u64,
    reserve_debt_base_usd: u64,
    reserve_collateral_base_usd: u64,
) -> LiquidationSizingInput {
    LiquidationSizingInput {
        health_factor_wad: U256::from(health_factor_wad),
        total_debt_base_wad: usd(total_debt_usd),
        reserve_debt_amount: usd(reserve_debt_amount_usd),
        reserve_debt_base_wad: usd(reserve_debt_base_usd),
        reserve_collateral_base_wad: usd(reserve_collateral_base_usd),
        debt_asset_price_base_wad: wad(),
        debt_asset_unit: wad(),
        min_base_max_close_factor_threshold_wad: usd(MIN_BASE_CLOSE_THRESHOLD_USD),
    }
}

fn max_debt(input: LiquidationSizingInput) -> U256 {
    max_liquidatable_debt(input).expect("recovered Aave close-factor math must evaluate")
}

#[test]
fn pft_aave_default_close_factor_caps_at_half_total_debt() {
    let input = sizing(FULL_CLOSE_HF_WAD + 1, 10_000, 8_000, 8_000, 10_000);
    assert_eq!(max_debt(input), usd(5_000));
}

#[test]
fn pft_aave_full_close_switch_is_exact_at_point_95() {
    let exact_boundary = sizing(FULL_CLOSE_HF_WAD, 10_000, 8_000, 8_000, 10_000);
    let one_wei_above = sizing(FULL_CLOSE_HF_WAD + 1, 10_000, 8_000, 8_000, 10_000);

    assert_eq!(max_debt(exact_boundary), usd(8_000));
    assert_eq!(max_debt(one_wei_above), usd(5_000));
}

#[test]
fn pft_aave_collateral_base_threshold_is_inclusive() {
    let at_threshold = sizing(
        FULL_CLOSE_HF_WAD + 1,
        10_000,
        8_000,
        8_000,
        MIN_BASE_CLOSE_THRESHOLD_USD,
    );
    let below_threshold = sizing(
        FULL_CLOSE_HF_WAD + 1,
        10_000,
        8_000,
        8_000,
        MIN_BASE_CLOSE_THRESHOLD_USD - 1,
    );

    assert_eq!(max_debt(at_threshold), usd(5_000));
    assert_eq!(max_debt(below_threshold), usd(8_000));
}

#[test]
fn pft_aave_debt_base_threshold_is_inclusive() {
    let at_threshold = sizing(
        FULL_CLOSE_HF_WAD + 1,
        3_000,
        MIN_BASE_CLOSE_THRESHOLD_USD,
        MIN_BASE_CLOSE_THRESHOLD_USD,
        3_000,
    );
    let below_threshold = sizing(
        FULL_CLOSE_HF_WAD + 1,
        3_000,
        MIN_BASE_CLOSE_THRESHOLD_USD - 1,
        MIN_BASE_CLOSE_THRESHOLD_USD - 1,
        3_000,
    );

    assert_eq!(max_debt(at_threshold), usd(1_500));
    assert_eq!(max_debt(below_threshold), usd(MIN_BASE_CLOSE_THRESHOLD_USD - 1));
}
