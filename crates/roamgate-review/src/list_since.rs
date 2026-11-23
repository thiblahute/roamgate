//! A review list for a page that holds some of it already
//! (review/list-since.ts): each review comes with a stamp of its content,
//! `Bun.hash` (Zig's Wyhash, seed 0) of its JSON in base 36, so a page that
//! got its stamps from either server sends back what Rust recognises.

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value, json};

pub const REVIEW_LIST_PAGE_MAX: usize = 200;
pub const REVIEW_SUMMARY_PAGE_MAX: usize = 1000;

const SECRET: [u64; 4] = [
    0xa076_1d64_78bd_642f,
    0xe703_7ed1_a0b4_28db,
    0x8ebc_6af0_9c88_c6e3,
    0x5899_65cc_7537_4cc3,
];

fn mum(a: &mut u64, b: &mut u64) {
    let x = u128::from(*a) * u128::from(*b);
    *a = x as u64;
    *b = (x >> 64) as u64;
}

fn mix(mut a: u64, mut b: u64) -> u64 {
    mum(&mut a, &mut b);
    a ^ b
}

fn read8(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().unwrap())
}

fn read4(bytes: &[u8]) -> u64 {
    u64::from(u32::from_le_bytes(bytes[..4].try_into().unwrap()))
}

/// Zig's `std.hash.Wyhash.hash(seed, input)` (final v4), as `Bun.hash`.
pub fn wyhash(seed: u64, input: &[u8]) -> u64 {
    let start = seed ^ mix(seed ^ SECRET[0], SECRET[1]);
    let mut state = [start, start, start];
    let len = input.len();
    let (mut a, mut b);
    if len <= 16 {
        if len >= 4 {
            let end = len - 4;
            let quarter = (len >> 3) << 2;
            a = (read4(input) << 32) | read4(&input[quarter..]);
            b = (read4(&input[end..]) << 32) | read4(&input[end - quarter..]);
        } else if len > 0 {
            a = (u64::from(input[0]) << 16)
                | (u64::from(input[len >> 1]) << 8)
                | u64::from(input[len - 1]);
            b = 0;
        } else {
            a = 0;
            b = 0;
        }
    } else {
        let mut i = 0;
        if len >= 48 {
            while i + 48 < len {
                for lane in 0..3 {
                    let x = read8(&input[i + 16 * lane..]);
                    let y = read8(&input[i + 16 * lane + 8..]);
                    state[lane] = mix(x ^ SECRET[lane + 1], y ^ state[lane]);
                }
                i += 48;
            }
            state[0] ^= state[1] ^ state[2];
        }
        let rest = &input[i..];
        let mut j = 0;
        while j + 16 < rest.len() {
            state[0] = mix(
                read8(&rest[j..]) ^ SECRET[1],
                read8(&rest[j + 8..]) ^ state[0],
            );
            j += 16;
        }
        a = read8(&input[len - 16..]);
        b = read8(&input[len - 8..]);
    }
    a ^= SECRET[1];
    b ^= state[0];
    mum(&mut a, &mut b);
    mix(a ^ SECRET[0] ^ len as u64, b ^ SECRET[1])
}

/// A number in base 36, as `BigInt#toString(36)`.
pub fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(digits[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// The stamp of an item: `Bun.hash(JSON.stringify(item)).toString(36)`.
pub fn stamp<T: Serialize>(item: &T) -> String {
    let text = serde_json::to_string(item).unwrap_or_default();
    base36(wyhash(0, text.as_bytes()))
}

/// What a page of the list is.
#[derive(Debug, Clone, PartialEq)]
pub struct ListPage<T> {
    pub items: Vec<T>,
    pub stamps: IndexMap<String, String>,
    pub unchanged: Option<Vec<String>>,
    pub remaining: Option<usize>,
}

fn list_since<T: Serialize + Clone>(
    items: &[(String, T)],
    known: Option<&Value>,
    limit: Option<&Value>,
    max: usize,
    echo: bool,
) -> ListPage<T> {
    let page = limit
        .and_then(crate::js::integer)
        .filter(|limit| *limit > 0)
        .map(|limit| (limit as usize).min(max));
    let held = known.and_then(Value::as_object);
    let mut sent = Vec::new();
    let mut unchanged = Vec::new();
    let mut stamps = IndexMap::new();
    let mut remaining = 0;
    for (id, item) in items {
        let stamp = stamp(item);
        if held.and_then(|held| held.get(id)).and_then(Value::as_str) == Some(stamp.as_str()) {
            unchanged.push(id.clone());
            if !echo {
                continue;
            }
        } else if page.is_some_and(|page| sent.len() >= page) {
            remaining += 1;
            continue;
        } else {
            sent.push(item.clone());
        }
        stamps.insert(id.clone(), stamp);
    }
    if page.is_some() {
        return ListPage {
            items: sent,
            stamps,
            unchanged: Some(if echo || remaining == 0 {
                unchanged
            } else {
                Vec::new()
            }),
            remaining: Some(remaining),
        };
    }
    ListPage {
        items: sent,
        stamps,
        unchanged: held.map(|_| unchanged),
        remaining: None,
    }
}

fn answer<T: Serialize>(name: &str, page: ListPage<T>) -> Value {
    let mut map = Map::new();
    map.insert(
        name.into(),
        serde_json::to_value(&page.items).unwrap_or(Value::Null),
    );
    map.insert("stamps".into(), json!(page.stamps));
    if let Some(unchanged) = page.unchanged {
        map.insert("unchanged".into(), json!(unchanged));
    }
    if let Some(remaining) = page.remaining {
        map.insert("remaining".into(), json!(remaining));
    }
    Value::Object(map)
}

/// The whole snapshots (`{sessions, stamps, unchanged?, remaining?}`).
pub fn list_reviews_since<T: Serialize + Clone>(
    snapshots: &[(String, T)],
    known: Option<&Value>,
    limit: Option<&Value>,
) -> Value {
    answer(
        "sessions",
        list_since(snapshots, known, limit, REVIEW_LIST_PAGE_MAX, true),
    )
}

/// The summaries (`{summaries, stamps, unchanged?, remaining?}`).
pub fn list_summaries_since<T: Serialize + Clone>(
    summaries: &[(String, T)],
    known: Option<&Value>,
    limit: Option<&Value>,
) -> Value {
    answer(
        "summaries",
        list_since(summaries, known, limit, REVIEW_SUMMARY_PAGE_MAX, false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_buns_hash() {
        let check = |input: &str, expected: &str| {
            assert_eq!(base36(wyhash(0, input.as_bytes())), expected, "{input:?}");
        };
        check("", "27k1wwwhf13t");
        check("a", "mcie3cqm6cz5");
        check("abc", "1g45uqqks6lu");
        check("abcd", "13w92m5xe651v");
        check("hello world!!", "3puahe1vqm34i");
        check("0123456789abcdef0", "3u7gojn9s87lc");
        check(&"x".repeat(47), "16b8axjufujzc");
        check(&"y".repeat(48), "237s00wcblgxm");
        check(&"z".repeat(49), "1sypvccoya5gm");
        check(&"é漢😀".repeat(9), "g6cl7rel8w4q");
    }

    fn snapshot(id: &str, title: &str) -> (String, Value) {
        (
            id.into(),
            json!({"session": {"id": id, "title": title}, "threads": []}),
        )
    }

    #[test]
    fn a_review_list_sends_again_only_the_reviews_the_page_does_not_hold() {
        let items = vec![snapshot("a", "A"), snapshot("b", "B")];
        let first = list_reviews_since(&items, None, None);
        assert_eq!(first["sessions"].as_array().unwrap().len(), 2);
        assert!(first.get("unchanged").is_none());
        let known = json!({"a": first["stamps"]["a"], "b": "stale"});
        let again = list_reviews_since(&items, Some(&known), None);
        assert_eq!(again["sessions"], json!([items[1].1]));
        assert_eq!(again["unchanged"], json!(["a"]));
        assert_eq!(again["stamps"]["a"], first["stamps"]["a"]);
    }

    #[test]
    fn a_list_read_in_pages_sends_the_most_recent_reviews_first_then_the_rest() {
        let items = vec![snapshot("a", "A"), snapshot("b", "B"), snapshot("c", "C")];
        let page = list_reviews_since(&items, Some(&json!({})), Some(&json!(2)));
        assert_eq!(page["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(page["remaining"], json!(1));
        let known = page["stamps"].clone();
        let next = list_reviews_since(&items, Some(&known), Some(&json!(2)));
        assert_eq!(next["sessions"], json!([items[2].1]));
        assert_eq!(next["remaining"], json!(0));
        assert_eq!(next["unchanged"], json!(["a", "b"]));
    }

    #[test]
    fn summaries_come_in_larger_pages_than_whole_snapshots() {
        let items: Vec<_> = (0..1200).map(|n| snapshot(&format!("s{n}"), "x")).collect();
        let snapshots = list_reviews_since(&items, None, Some(&json!(5000)));
        assert_eq!(
            snapshots["sessions"].as_array().unwrap().len(),
            REVIEW_LIST_PAGE_MAX
        );
        let summaries = list_summaries_since(&items, None, Some(&json!(5000)));
        assert_eq!(
            summaries["summaries"].as_array().unwrap().len(),
            REVIEW_SUMMARY_PAGE_MAX
        );
        assert_eq!(summaries["remaining"], json!(200));
        // Held ones are not named again on a page with more to come.
        let known = summaries["stamps"].clone();
        let rest = list_summaries_since(&items, Some(&known), Some(&json!(100)));
        assert_eq!(rest["summaries"].as_array().unwrap().len(), 100);
        assert_eq!(rest["unchanged"], json!([]));
    }
}
