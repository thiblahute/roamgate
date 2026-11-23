//! JavaScript's number semantics where the TS voice code leans on them:
//! `Math.round`, `toFixed`, and JSON text as `JSON.stringify` writes it
//! (roamgate-agents' [`roamgate_agents::js`], shared, not copied).

pub use roamgate_agents::js::{
    len16, number, number_text, parse, quote, slice16, stringify, stringify_pretty, trim,
};

/// `Math.round(value)`: halves go up, towards positive infinity.
pub fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Math.round(value * 10^digits) / 10^digits`, as the TS writes it.
pub fn round_to(value: f64, scale: f64) -> f64 {
    round(value * scale) / scale
}

/// `value.toFixed(digits)`: the decimal closest to the exact value, a tie
/// going to the larger magnitude (Rust's formatter goes to even).
pub fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return number_text(value);
    }
    if value.abs() >= 1e21 {
        return number_text(value);
    }
    let negative = value < 0.0;
    let magnitude = value.abs();
    // The exact binary value, written out far enough to see a tie.
    let exact = format!("{magnitude:.1100}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    let rest = &fraction.as_bytes()[digits.min(fraction.len())..];
    let round_up = match rest.first() {
        Some(b'5') => true, // exactly half or more: both go up
        Some(&digit) => digit > b'5',
        None => false,
    };
    if round_up {
        let mut index = digits_kept.len();
        loop {
            if index == 0 {
                digits_kept.insert(0, b'1');
                break;
            }
            index -= 1;
            if digits_kept[index] == b'9' {
                digits_kept[index] = b'0';
            } else {
                digits_kept[index] += 1;
                break;
            }
        }
    }
    let whole_len = digits_kept.len() - digits;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(std::str::from_utf8(&digits_kept[..whole_len]).unwrap_or("0"));
    if digits > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&digits_kept[whole_len..]).unwrap_or(""));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_as_javascript_does() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(0.835, 2), "0.83");
        assert_eq!(to_fixed(-0.125, 2), "-0.13");
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(0.999, 2), "1.00");
        assert_eq!(to_fixed(12.0, 0), "12");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
    }
}
