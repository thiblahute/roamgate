//! The calendar arithmetic of shared/agentProfiles.ts's parseResetTime:
//! JavaScript's `Date.UTC`, `new Date(y, m, d)` in the local zone and
//! `Intl.DateTimeFormat`'s offset of a named zone, month and day overflow
//! carried as JavaScript carries them. Months count from 0.

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1 to 12).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day count (year, month 0 to 11, day).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month - 1, day)
}

/// `Date.UTC(year, month, day)`: month (from 0) and day overflow carried.
fn utc_day(year: i64, month: i64, day: i64) -> i64 {
    let year = year + month.div_euclid(12);
    let month = month.rem_euclid(12);
    days_from_civil(year, month + 1, 1) + day - 1
}

fn zone(name: &str) -> Option<TimeZone> {
    TimeZone::get(name).ok()
}

/// The UTC offset (ms) of a time zone at an instant; None when unknown.
pub fn zone_offset_ms(name: &str, at: i64) -> Option<i64> {
    let zone = zone(name)?;
    let instant = Timestamp::from_millisecond(at).ok()?;
    Some(i64::from(zone.to_offset(instant).seconds()) * 1000)
}

/// The local midnight of a (carried) date, in ms.
fn local_midnight(year: i64, month: i64, day: i64) -> Option<i64> {
    let (year, month, day) = civil_from_days(utc_day(year, month, day));
    let date = Date::new(
        i16::try_from(year).ok()?,
        i8::try_from(month + 1).ok()?,
        i8::try_from(day).ok()?,
    )
    .ok()?;
    let zoned = date.to_zoned(TimeZone::system()).ok()?;
    Some(zoned.timestamp().as_millisecond())
}

/// The wall time in a zone (or the local zone) as an instant.
pub fn zoned_time(
    year: i64,
    month: i64,
    day: i64,
    minutes: i64,
    zone: Option<&str>,
) -> Option<i64> {
    let wall = utc_day(year, month, day) * DAY_MS + minutes * 60_000;
    let Some(zone) = zone else {
        return Some(local_midnight(year, month, day)? + minutes * 60_000);
    };
    // Two passes settle a DST change between the guess and the answer.
    let mut guess = wall;
    for _ in 0..2 {
        guess = wall - zone_offset_ms(zone, guess)?;
    }
    Some(guess)
}

/// Today's date in a zone (or the local one): year, month 0 to 11, day.
pub fn zone_date(at: i64, zone: Option<&str>) -> (i64, i64, i64) {
    match zone {
        None => {
            let Ok(instant) = Timestamp::from_millisecond(at) else {
                return civil_from_days(at.div_euclid(DAY_MS));
            };
            let date = instant.to_zoned(TimeZone::system()).date();
            (
                i64::from(date.year()),
                i64::from(date.month()) - 1,
                i64::from(date.day()),
            )
        }
        Some(zone) => {
            let offset = zone_offset_ms(zone, at).unwrap_or(0);
            civil_from_days((at + offset).div_euclid(DAY_MS))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_counts_round_trip_and_carry_like_date_utc() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(0), (1970, 0, 1));
        assert_eq!(civil_from_days(utc_day(2026, 1, 30)), (2026, 2, 2));
        assert_eq!(civil_from_days(utc_day(2026, 12, 1)), (2027, 0, 1));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 1, 29));
    }
}
