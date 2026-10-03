//! Exact unsigned 256-bit protocol arithmetic.
//!
//! Protocol state (reserves, indexes, balances, prices) is carried as EVM
//! words and never as floating point. Every operation is checked: overflow,
//! underflow and division by zero are errors, never wrap-around. `mul_div_*`
//! use a full 512-bit intermediate product, so they are exact whenever the
//! quotient fits in 256 bits.

use std::cmp::Ordering;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct U256([u64; 4]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    Underflow,
    DivisionByZero,
    InvalidDecimal,
}

impl Display for MathError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Overflow => "256-bit overflow",
            Self::Underflow => "256-bit underflow",
            Self::DivisionByZero => "division by zero",
            Self::InvalidDecimal => "invalid decimal integer",
        })
    }
}

impl std::error::Error for MathError {}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        for index in (0..4).rev() {
            match self.0[index].cmp(&other.0[index]) {
                Ordering::Equal => continue,
                unequal => return unequal,
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl U256 {
    pub const ZERO: Self = Self([0; 4]);
    pub const ONE: Self = Self([1, 0, 0, 0]);
    pub const MAX: Self = Self([u64::MAX; 4]);

    pub const fn from_u64(value: u64) -> Self {
        Self([value, 0, 0, 0])
    }

    pub const fn from_u128(value: u128) -> Self {
        Self([value as u64, (value >> 64) as u64, 0, 0])
    }

    /// Big-endian EVM word.
    pub fn from_word(word: &[u8; 32]) -> Self {
        let mut limbs = [0u64; 4];
        for (index, limb) in limbs.iter_mut().enumerate() {
            let start = 32 - 8 * (index + 1);
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&word[start..start + 8]);
            *limb = u64::from_be_bytes(bytes);
        }
        Self(limbs)
    }

    pub fn to_word(self) -> [u8; 32] {
        let mut word = [0u8; 32];
        for (index, limb) in self.0.iter().enumerate() {
            let start = 32 - 8 * (index + 1);
            word[start..start + 8].copy_from_slice(&limb.to_be_bytes());
        }
        word
    }

    pub fn is_zero(self) -> bool {
        self.0 == [0; 4]
    }

    /// Number of significant bits.
    pub fn bits(self) -> u32 {
        for index in (0..4).rev() {
            if self.0[index] != 0 {
                return 64 * index as u32 + (64 - self.0[index].leading_zeros());
            }
        }
        0
    }

    pub fn bit(self, position: u32) -> bool {
        position < 256 && (self.0[(position / 64) as usize] >> (position % 64)) & 1 == 1
    }

    pub fn to_u64(self) -> Option<u64> {
        (self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0).then_some(self.0[0])
    }

    pub fn to_u128(self) -> Option<u128> {
        (self.0[2] == 0 && self.0[3] == 0)
            .then_some(u128::from(self.0[0]) | (u128::from(self.0[1]) << 64))
    }

    /// Bits `[offset, offset + width)` as an integer (`width <= 64`).
    pub fn field(self, offset: u32, width: u32) -> u64 {
        let mut value = 0u64;
        for bit in 0..width.min(64) {
            if self.bit(offset + bit) {
                value |= 1 << bit;
            }
        }
        value
    }

    pub fn shift_right(self, shift: u32) -> Self {
        if shift >= 256 {
            return Self::ZERO;
        }
        let limbs = (shift / 64) as usize;
        let bits = shift % 64;
        let mut out = [0u64; 4];
        for (index, slot) in out.iter_mut().enumerate() {
            let source = index + limbs;
            if source < 4 {
                *slot = self.0[source] >> bits;
                if bits != 0 && source + 1 < 4 {
                    *slot |= self.0[source + 1] << (64 - bits);
                }
            }
        }
        Self(out)
    }

    pub fn checked_add(self, other: Self) -> Result<Self, MathError> {
        let mut out = [0u64; 4];
        let mut carry = false;
        for (index, slot) in out.iter_mut().enumerate() {
            let (sum, first) = self.0[index].overflowing_add(other.0[index]);
            let (sum, second) = sum.overflowing_add(u64::from(carry));
            *slot = sum;
            carry = first || second;
        }
        if carry {
            return Err(MathError::Overflow);
        }
        Ok(Self(out))
    }

    fn wrapping_sub(self, other: Self) -> (Self, bool) {
        let mut out = [0u64; 4];
        let mut borrow = false;
        for (index, slot) in out.iter_mut().enumerate() {
            let (difference, first) = self.0[index].overflowing_sub(other.0[index]);
            let (difference, second) = difference.overflowing_sub(u64::from(borrow));
            *slot = difference;
            borrow = first || second;
        }
        (Self(out), borrow)
    }

    pub fn checked_sub(self, other: Self) -> Result<Self, MathError> {
        match self.wrapping_sub(other) {
            (_, true) => Err(MathError::Underflow),
            (value, false) => Ok(value),
        }
    }

    fn full_mul(self, other: Self) -> [u64; 8] {
        let mut out = [0u64; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let current =
                    u128::from(out[i + j]) + u128::from(self.0[i]) * u128::from(other.0[j]) + carry;
                out[i + j] = current as u64;
                carry = current >> 64;
            }
            out[i + 4] = carry as u64;
        }
        out
    }

    pub fn checked_mul(self, other: Self) -> Result<Self, MathError> {
        let product = self.full_mul(other);
        if product[4..].iter().any(|limb| *limb != 0) {
            return Err(MathError::Overflow);
        }
        Ok(Self([product[0], product[1], product[2], product[3]]))
    }

    /// `(quotient, remainder)` of a 512-bit numerator by a 256-bit divisor.
    fn div_rem_wide(numerator: [u64; 8], divisor: Self) -> Result<([u64; 8], Self), MathError> {
        if divisor.is_zero() {
            return Err(MathError::DivisionByZero);
        }
        let top = (0..8)
            .rev()
            .find(|index| numerator[*index] != 0)
            .map_or(0, |index| {
                64 * index as u32 + (64 - numerator[index].leading_zeros())
            });
        let mut quotient = [0u64; 8];
        let mut remainder = Self::ZERO;
        for position in (0..top).rev() {
            let carry = remainder.bit(255);
            // remainder = remainder << 1 | numerator bit
            let mut shifted = [0u64; 4];
            for (index, slot) in shifted.iter_mut().enumerate() {
                *slot = remainder.0[index] << 1;
                if index > 0 {
                    *slot |= remainder.0[index - 1] >> 63;
                }
            }
            shifted[0] |= (numerator[(position / 64) as usize] >> (position % 64)) & 1;
            remainder = Self(shifted);
            if carry || remainder >= divisor {
                // The true value is below 2 * divisor, so the wrapped
                // difference is exact.
                remainder = remainder.wrapping_sub(divisor).0;
                quotient[(position / 64) as usize] |= 1 << (position % 64);
            }
        }
        Ok((quotient, remainder))
    }

    fn narrow(wide: [u64; 8]) -> Result<Self, MathError> {
        if wide[4..].iter().any(|limb| *limb != 0) {
            return Err(MathError::Overflow);
        }
        Ok(Self([wide[0], wide[1], wide[2], wide[3]]))
    }

    pub fn checked_div(self, divisor: Self) -> Result<Self, MathError> {
        let mut wide = [0u64; 8];
        wide[..4].copy_from_slice(&self.0);
        Self::narrow(Self::div_rem_wide(wide, divisor)?.0)
    }

    pub fn checked_rem(self, divisor: Self) -> Result<Self, MathError> {
        let mut wide = [0u64; 8];
        wide[..4].copy_from_slice(&self.0);
        Ok(Self::div_rem_wide(wide, divisor)?.1)
    }

    /// `floor(a * b / d)`.
    pub fn mul_div_floor(a: Self, b: Self, d: Self) -> Result<Self, MathError> {
        Self::narrow(Self::div_rem_wide(a.full_mul(b), d)?.0)
    }

    /// `ceil(a * b / d)`.
    pub fn mul_div_ceil(a: Self, b: Self, d: Self) -> Result<Self, MathError> {
        let (quotient, remainder) = Self::div_rem_wide(a.full_mul(b), d)?;
        let quotient = Self::narrow(quotient)?;
        if remainder.is_zero() {
            Ok(quotient)
        } else {
            quotient.checked_add(Self::ONE)
        }
    }

    /// `floor((a * b + floor(d / 2)) / d)` — Aave `WadRayMath` half-up.
    pub fn mul_div_half_up(a: Self, b: Self, d: Self) -> Result<Self, MathError> {
        let half = d.shift_right(1);
        let mut product = a.full_mul(b);
        let mut carry = 0u128;
        for (index, limb) in product.iter_mut().enumerate() {
            let addend = if index < 4 { half.0[index] } else { 0 };
            let sum = u128::from(*limb) + u128::from(addend) + carry;
            *limb = sum as u64;
            carry = sum >> 64;
        }
        if carry != 0 {
            return Err(MathError::Overflow);
        }
        Self::narrow(Self::div_rem_wide(product, d)?.0)
    }

    pub fn pow10(exponent: u32) -> Result<Self, MathError> {
        let mut value = Self::ONE;
        for _ in 0..exponent {
            value = value.checked_mul(Self::from_u64(10))?;
        }
        Ok(value)
    }

    pub fn parse_decimal(text: &str) -> Result<Self, MathError> {
        if text.is_empty() || (text.len() > 1 && text.starts_with('0')) {
            return Err(MathError::InvalidDecimal);
        }
        let mut value = Self::ZERO;
        for byte in text.bytes() {
            if !byte.is_ascii_digit() {
                return Err(MathError::InvalidDecimal);
            }
            value = value
                .checked_mul(Self::from_u64(10))?
                .checked_add(Self::from_u64(u64::from(byte - b'0')))?;
        }
        Ok(value)
    }

    pub fn to_decimal(self) -> String {
        if self.is_zero() {
            return "0".into();
        }
        let mut digits = Vec::new();
        let mut value = self;
        let ten_pow_19 = Self::from_u64(10_000_000_000_000_000_000);
        while !value.is_zero() {
            let mut wide = [0u64; 8];
            wide[..4].copy_from_slice(&value.0);
            // ten_pow_19 is non-zero, so division cannot fail.
            let (quotient, remainder) = match Self::div_rem_wide(wide, ten_pow_19) {
                Ok(result) => result,
                Err(_) => return String::new(),
            };
            value = Self([quotient[0], quotient[1], quotient[2], quotient[3]]);
            let mut chunk = remainder.0[0];
            for _ in 0..19 {
                digits.push(b'0' + (chunk % 10) as u8);
                chunk /= 10;
                if value.is_zero() && chunk == 0 {
                    break;
                }
            }
        }
        while digits.len() > 1 && digits.last() == Some(&b'0') {
            digits.pop();
        }
        digits.reverse();
        String::from_utf8(digits).unwrap_or_default()
    }
}

impl Display for U256 {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_decimal())
    }
}

/// `10^27`.
pub fn ray() -> U256 {
    U256::from_u128(1_000_000_000_000_000_000_000_000_000)
}

/// `10^18`.
pub fn wad() -> U256 {
    U256::from_u64(1_000_000_000_000_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(text: &str) -> Result<U256, MathError> {
        U256::parse_decimal(text)
    }

    #[test]
    fn decimal_round_trip_and_extremes() -> Result<(), MathError> {
        for text in [
            "0",
            "1",
            "10",
            "10000000000000000000",
            "18446744073709551615",
            "18446744073709551616",
            "1000000000000000000000000000",
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        ] {
            assert_eq!(dec(text)?.to_decimal(), text);
        }
        assert_eq!(
            U256::MAX.to_decimal(),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
        assert_eq!(
            dec("115792089237316195423570985008687907853269984665640564039457584007913129639936"),
            Err(MathError::Overflow)
        );
        assert_eq!(dec("01"), Err(MathError::InvalidDecimal));
        assert_eq!(dec(""), Err(MathError::InvalidDecimal));
        assert_eq!(dec("1a"), Err(MathError::InvalidDecimal));
        Ok(())
    }

    #[test]
    fn checked_arithmetic_never_wraps() -> Result<(), MathError> {
        assert_eq!(U256::MAX.checked_add(U256::ONE), Err(MathError::Overflow));
        assert_eq!(U256::ZERO.checked_sub(U256::ONE), Err(MathError::Underflow));
        assert_eq!(
            U256::MAX.checked_mul(U256::from_u64(2)),
            Err(MathError::Overflow)
        );
        assert_eq!(
            U256::ONE.checked_div(U256::ZERO),
            Err(MathError::DivisionByZero)
        );
        let a = dec("340282366920938463463374607431768211457")?; // 2^128 + 1
        let b = dec("340282366920938463463374607431768211455")?; // 2^128 - 1
        assert_eq!(a.checked_mul(b)?, U256::MAX);
        assert_eq!(a.checked_mul(b)?.checked_div(b)?, a);
        assert_eq!(a.checked_rem(U256::from_u64(7))?.to_decimal(), "5");
        Ok(())
    }

    #[test]
    fn mul_div_rounding_modes_are_exact_beyond_256_bits() -> Result<(), MathError> {
        let ray = ray();
        // Intermediate product exceeds 2^256; the quotient does not.
        let a = dec("100000000000000000000000000000000000000000000000000")?; // 1e50
        let b = dec("3000000000000000000000000000000000000")?; // 3e36
        let product_quotient = U256::mul_div_floor(a, b, ray)?;
        assert_eq!(
            product_quotient.to_decimal(),
            "300000000000000000000000000000000000000000000000000000000000"
        );
        assert_eq!(
            U256::mul_div_floor(U256::from_u64(7), U256::from_u64(3), U256::from_u64(2))?,
            U256::from_u64(10)
        );
        assert_eq!(
            U256::mul_div_ceil(U256::from_u64(7), U256::from_u64(3), U256::from_u64(2))?,
            U256::from_u64(11)
        );
        assert_eq!(
            U256::mul_div_half_up(U256::from_u64(7), U256::from_u64(3), U256::from_u64(2))?,
            U256::from_u64(11)
        );
        assert_eq!(
            U256::mul_div_half_up(U256::from_u64(5), U256::from_u64(1), U256::from_u64(4))?,
            U256::from_u64(1)
        );
        assert_eq!(
            U256::mul_div_half_up(U256::from_u64(6), U256::from_u64(1), U256::from_u64(4))?,
            U256::from_u64(2)
        );
        assert_eq!(
            U256::mul_div_ceil(U256::from_u64(8), U256::from_u64(1), U256::from_u64(4))?,
            U256::from_u64(2)
        );
        assert_eq!(
            U256::mul_div_floor(U256::MAX, U256::from_u64(2), U256::ONE),
            Err(MathError::Overflow)
        );
        assert_eq!(
            U256::mul_div_floor(U256::MAX, U256::MAX, U256::MAX)?,
            U256::MAX
        );
        assert_eq!(
            U256::mul_div_floor(U256::ONE, U256::ONE, U256::ZERO),
            Err(MathError::DivisionByZero)
        );
        Ok(())
    }

    #[test]
    fn words_fields_and_shifts() -> Result<(), MathError> {
        let mut word = [0u8; 32];
        word[31] = 0x34;
        word[30] = 0x12;
        word[0] = 0x80;
        let value = U256::from_word(&word);
        assert_eq!(value.to_word(), word);
        assert!(value.bit(255));
        assert_eq!(value.field(0, 16), 0x1234);
        assert_eq!(value.field(4, 8), 0x23);
        assert_eq!(value.shift_right(255), U256::ONE);
        assert_eq!(value.bits(), 256);
        assert_eq!(U256::from_u64(0x1234).shift_right(4), U256::from_u64(0x123));
        assert_eq!(U256::pow10(27)?, ray());
        assert_eq!(U256::pow10(18)?, wad());
        assert_eq!(U256::pow10(78), Err(MathError::Overflow));
        Ok(())
    }
}
