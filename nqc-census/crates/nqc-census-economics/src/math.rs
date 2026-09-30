use crate::EconomicsError;
use nqc_census_capital::Amount256;
use std::cmp::Ordering;

pub const PPB_ONE: u32 = 1_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProbabilityPpb(u32);

impl ProbabilityPpb {
    pub const ZERO: Self = Self(0);
    pub const ONE: Self = Self(PPB_ONE);

    pub fn new(parts_per_billion: u32) -> Result<Self, EconomicsError> {
        if parts_per_billion > PPB_ONE {
            return Err(EconomicsError::ProbabilityOutOfRange);
        }
        Ok(Self(parts_per_billion))
    }

    pub const fn get(self) -> u32 {
        self.0
    }

    pub const fn complement(self) -> Self {
        Self(PPB_ONE - self.0)
    }

    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedValue {
    negative: bool,
    magnitude: Amount256,
}

impl SignedValue {
    pub const ZERO: Self = Self {
        negative: false,
        magnitude: Amount256::ZERO,
    };

    pub fn positive(magnitude: Amount256) -> Self {
        Self {
            negative: false,
            magnitude,
        }
    }

    pub fn negative(magnitude: Amount256) -> Self {
        Self {
            negative: !magnitude.is_zero(),
            magnitude,
        }
    }

    pub fn from_difference(
        positive: Amount256,
        negative: Amount256,
    ) -> Result<Self, EconomicsError> {
        if positive >= negative {
            Ok(Self::positive(
                positive
                    .checked_sub(negative)
                    .map_err(|_| EconomicsError::ArithmeticOverflow)?,
            ))
        } else {
            Ok(Self::negative(
                negative
                    .checked_sub(positive)
                    .map_err(|_| EconomicsError::ArithmeticOverflow)?,
            ))
        }
    }

    pub const fn is_negative(self) -> bool {
        self.negative
    }

    pub fn is_positive(self) -> bool {
        !self.negative && !self.magnitude.is_zero()
    }

    pub const fn magnitude(self) -> Amount256 {
        self.magnitude
    }

    pub fn subtract_unsigned(self, rhs: Amount256) -> Result<Self, EconomicsError> {
        if self.negative {
            return Ok(Self::negative(
                self.magnitude
                    .checked_add(rhs)
                    .map_err(|_| EconomicsError::ArithmeticOverflow)?,
            ));
        }
        Self::from_difference(self.magnitude, rhs)
    }

    pub fn checked_add(self, rhs: Self) -> Result<Self, EconomicsError> {
        match (self.negative, rhs.negative) {
            (false, false) => Ok(Self::positive(
                self.magnitude
                    .checked_add(rhs.magnitude)
                    .map_err(|_| EconomicsError::ArithmeticOverflow)?,
            )),
            (true, true) => Ok(Self::negative(
                self.magnitude
                    .checked_add(rhs.magnitude)
                    .map_err(|_| EconomicsError::ArithmeticOverflow)?,
            )),
            (false, true) => Self::from_difference(self.magnitude, rhs.magnitude),
            (true, false) => Self::from_difference(rhs.magnitude, self.magnitude),
        }
    }

    pub fn scale(self, probability: ProbabilityPpb) -> Result<Self, EconomicsError> {
        let magnitude = scale_probability(self.magnitude, probability)?;
        Ok(if self.negative {
            Self::negative(magnitude)
        } else {
            Self::positive(magnitude)
        })
    }
}

impl Ord for SignedValue {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => self.magnitude.cmp(&other.magnitude),
            (true, true) => other.magnitude.cmp(&self.magnitude),
        }
    }
}

impl PartialOrd for SignedValue {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn scale_probability(
    amount: Amount256,
    probability: ProbabilityPpb,
) -> Result<Amount256, EconomicsError> {
    mul_div_floor(
        amount,
        Amount256::from_u128(u128::from(probability.get())),
        u64::from(PPB_ONE),
    )
}

/// Compute floor(left * right / denominator) with a full 512-bit intermediate.
///
/// The input/output representation remains the repository's exact uint256
/// Amount256. Overflow is rejected rather than truncated.
pub fn mul_div_floor(
    left: Amount256,
    right: Amount256,
    denominator: u64,
) -> Result<Amount256, EconomicsError> {
    if denominator == 0 {
        return Err(EconomicsError::ZeroDenominator);
    }

    // Base-256 little-endian accumulator. A 256x256 product needs at most
    // 512 bits; u64 cells have ample room before carry normalization.
    let mut product = [0_u64; 64];
    for i in 0..32 {
        let a = u64::from(left.as_be_bytes()[31 - i]);
        for j in 0..32 {
            let b = u64::from(right.as_be_bytes()[31 - j]);
            product[i + j] = product[i + j]
                .checked_add(a.saturating_mul(b))
                .ok_or(EconomicsError::ArithmeticOverflow)?;
        }
    }

    for index in 0..63 {
        let carry = product[index] >> 8;
        product[index] &= 0xff;
        product[index + 1] = product[index + 1]
            .checked_add(carry)
            .ok_or(EconomicsError::ArithmeticOverflow)?;
    }
    if product[63] > 0xff {
        return Err(EconomicsError::ArithmeticOverflow);
    }

    let mut product_be = [0_u8; 64];
    for (index, cell) in product.iter().enumerate() {
        product_be[63 - index] =
            u8::try_from(*cell).map_err(|_| EconomicsError::ArithmeticOverflow)?;
    }

    let divisor = u128::from(denominator);
    let mut remainder = 0_u128;
    let mut quotient = [0_u8; 64];
    for (index, byte) in product_be.iter().enumerate() {
        let expanded = remainder
            .checked_mul(256)
            .and_then(|value| value.checked_add(u128::from(*byte)))
            .ok_or(EconomicsError::ArithmeticOverflow)?;
        quotient[index] =
            u8::try_from(expanded / divisor).map_err(|_| EconomicsError::ArithmeticOverflow)?;
        remainder = expanded % divisor;
    }

    if quotient[..32].iter().any(|byte| *byte != 0) {
        return Err(EconomicsError::ArithmeticOverflow);
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(&quotient[32..]);
    Ok(Amount256::from_be_bytes(out))
}
