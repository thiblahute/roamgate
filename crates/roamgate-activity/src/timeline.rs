//! The timeline's date helpers (server/src/activity/timeline.ts); the
//! timeline itself moves here with the activity family (S13).

/// A real calendar date written `YYYY-MM-DD` (`isDate`): ASCII digits, a
/// year JavaScript's `new Date(y, m, d)` keeps as written (100 or later).
pub fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let number = |range: std::ops::Range<usize>| value[range].parse::<i16>().unwrap_or(-1);
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    year >= 100 && jiff::civil::Date::new(year, month as i8, day as i8).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_real_calendar_days() {
        for good in ["2026-11-03", "2024-02-29", "0100-01-01", "9999-12-31"] {
            assert!(is_date(good), "{good}");
        }
        for bad in [
            "today",
            "2026-11-3",
            "2026-13-01",
            "2025-02-29",
            "2026-11-31",
            "0099-01-01",
            "2026-11-03T00:00",
            "２０２６-11-03",
            "2026/11/03",
        ] {
            assert!(!is_date(bad), "{bad}");
        }
    }
}
