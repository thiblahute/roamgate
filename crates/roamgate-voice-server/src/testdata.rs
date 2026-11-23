//! Voice prints made up for tests (server/src/voice/testdata/prints.ts).

use crate::profiles::{cosine, unit};

/// One of a few voices that score about 0 against each other.
pub fn person(n: usize) -> Vec<f64> {
    unit(
        &(0..256)
            .map(|i| if i % 8 == n { 1.0 } else { 0.05 })
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

/// A print `noise` away from `base`, made from a seed.
pub fn near(base: &[f64], noise: f64, seed: u64) -> Vec<f64> {
    let mut state = (seed.wrapping_mul(2_654_435_761).wrapping_add(1) & 0xffff_ffff) as u32;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (f64::from(state) / f64::from(u32::MAX)) * 2.0 - 1.0
    };
    unit(
        &base
            .iter()
            .map(|value| value + noise * next())
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

/// A print scoring about `score` against `a`, the rest towards `b`.
pub fn between(a: &[f64], b: &[f64], score: f64) -> Vec<f64> {
    let ab = cosine(a, b);
    let other = unit(
        &b.iter()
            .enumerate()
            .map(|(i, value)| value - ab * a[i])
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let rest = (1.0 - score * score).sqrt();
    unit(
        &a.iter()
            .enumerate()
            .map(|(i, value)| value * score + other[i] * rest)
            .collect::<Vec<_>>(),
    )
    .unwrap()
}
